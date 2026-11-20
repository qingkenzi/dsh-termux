/** Durability walk behavior when a host ancestor cannot be opened for fsync. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishImmutableObject } from '../src/store.ts'

const fsFaults = vi.hoisted(() => ({
  codes: new Map<string, string>(),
  readOnlyOpens: [] as string[],
  /** Ancestors that still accept writes despite refusing the fsync open. */
  writable: new Set<string>(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const path = String(args[0])
      if (args[1] === constants.O_RDONLY) {
        fsFaults.readOnlyOpens.push(path)
        const code = fsFaults.codes.get(path)
        if (code !== undefined) throw Object.assign(new Error(`${code}: open '${path}'`), { code, path })
      }
      return actual.open(...args)
    },
    async access(...args: Parameters<typeof actual.access>): ReturnType<typeof actual.access> {
      const path = String(args[0])
      if (fsFaults.codes.has(path) && !fsFaults.writable.has(path)) {
        throw Object.assign(new Error(`EACCES: access '${path}'`), { code: 'EACCES', path })
      }
      return actual.access(...args)
    },
  }
})

const OBJECT = Uint8Array.of(7, 7, 7)
const DIGEST = createHash('sha256').update(OBJECT).digest('hex')
const bases: string[] = []

/**
 * Build a storage root inside a fresh DSH_HOME whose parent stands in for a
 * host ancestor the app sandbox exposes without read permission.
 * @returns storage root and the ancestor that refuses fsync.
 */
async function sandboxedStorage(): Promise<{ root: string; ancestor: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-attachment-boundary-'))
  bases.push(base)
  return { root: join(base, 'home', 'attachments', 'v1'), ancestor: base }
}

function objectPath(root: string): string {
  return join(root, 'objects', DIGEST.slice(0, 2), DIGEST)
}

afterEach(async () => {
  fsFaults.codes.clear()
  fsFaults.readOnlyOpens.length = 0
  fsFaults.writable.clear()
  await Promise.all(bases.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('attachment durability across unreadable ancestors', () => {
  it.skipIf(process.platform === 'win32')('publishes when an ancestor refuses fsync with EACCES or EPERM', async () => {
    for (const code of ['EACCES', 'EPERM']) {
      const { root, ancestor } = await sandboxedStorage()
      fsFaults.readOnlyOpens.length = 0
      fsFaults.codes.set(ancestor, code)

      await publishImmutableObject(root, objectPath(root), OBJECT, DIGEST)

      // The walk began at DSH_HOME's parent and stopped there instead of
      // failing the whole publication.
      expect(fsFaults.readOnlyOpens[0]).toBe(ancestor)
      expect(new Uint8Array(await readFile(objectPath(root)))).toEqual(OBJECT)
    }
  })

  it.skipIf(process.platform === 'win32')('rejects publication when an ancestor fsync fails for another reason', async () => {
    const { root, ancestor } = await sandboxedStorage()
    fsFaults.codes.set(ancestor, 'EIO')

    // Only access refusals mark the persistence boundary; a storage fault
    // still reaches the caller.
    await expect(publishImmutableObject(root, objectPath(root), OBJECT, DIGEST))
      .rejects.toMatchObject({ code: 'EIO' })
    await expect(readFile(objectPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('rejects a refused fsync when the ancestor accepts writes', async () => {
    const { root, ancestor } = await sandboxedStorage()
    fsFaults.codes.set(ancestor, 'EACCES')
    fsFaults.writable.add(ancestor)

    // A writable ancestor that refuses the sync is a storage fault, not a
    // sandbox boundary: the publication must fail instead of claiming durability.
    await expect(publishImmutableObject(root, objectPath(root), OBJECT, DIGEST))
      .rejects.toMatchObject({ code: 'EACCES' })
  })
})
