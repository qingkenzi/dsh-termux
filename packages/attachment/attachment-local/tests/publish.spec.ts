/**
 * Exclusive attachment publication: a hard link when the filesystem allows one,
 * and a flushed copy when it refuses. The refusals are injected because the
 * fallback must be proven on hosts that support link(2) (Linux) as well as on
 * hosts that deny it (Android app data under SELinux), so no case depends on the
 * test filesystem's own answer.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishExclusive } from '../src/publish.ts'

const faults = vi.hoisted(() => ({
  /** Next link() call fails with this errno code, then clears. */
  linkFailure: undefined as string | undefined,
  /** Next read-write open of a published copy fails its flush, then clears. */
  syncFailure: undefined as Error | undefined,
  /** Next read-write open of a published copy fails its close, then clears. */
  closeFailure: undefined as Error | undefined,
  /** Every open fails with this errno code until cleared. */
  openRefusal: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: (async (existingPath: string, newPath: string) => {
      const code = faults.linkFailure
      if (code !== undefined) {
        faults.linkFailure = undefined
        throw Object.assign(new Error(`${code}: injected hard-link refusal`), { code })
      }
      await actual.link(existingPath, newPath)
    }) as typeof actual.link,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const refusal = faults.openRefusal
      if (refusal !== undefined) {
        throw Object.assign(new Error(`${refusal}: injected open refusal`), { code: refusal })
      }
      const handle = await actual.open(...args)
      const syncFailure = faults.syncFailure
      // The copy path reopens its fresh publication read-write to flush bytes.
      if (syncFailure !== undefined && args[1] === 'r+') {
        faults.syncFailure = undefined
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(syncFailure)
      }
      const closeFailure = faults.closeFailure
      if (closeFailure !== undefined && args[1] === 'r+') {
        faults.closeFailure = undefined
        const close = handle.close.bind(handle)
        // Close the descriptor for real so the temporary root stays removable,
        // then report the close failure the product must not clean up after.
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close()
          throw closeFailure
        })
      }
      return handle
    }) as typeof actual.open,
  }
})

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-publish-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  faults.linkFailure = undefined
  faults.syncFailure = undefined
  faults.closeFailure = undefined
  faults.openRefusal = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('publishExclusive', () => {
  it('publishes byte-identical content when hard links are denied', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const destination = join(root, 'object')
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0xff])
    await writeFile(source, content)
    faults.linkFailure = 'EACCES'

    await publishExclusive(source, destination)

    expect(await readFile(destination)).toEqual(content)
    // The injected refusal was consumed, so the copy fallback produced this target.
    expect(faults.linkFailure).toBeUndefined()
  })

  it('keeps the existing object when a second publication collides', async () => {
    const root = await tempRoot()
    const destination = join(root, 'object')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeFile(first, 'first object\n')
    await writeFile(second, 'second object\n')
    await publishExclusive(first, destination)

    await expect(publishExclusive(second, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destination, 'utf8')).toBe('first object\n')
  })

  it.skipIf(process.platform === 'win32')('publishes a read-only source through a read-only flush descriptor', async () => {
    const root = await tempRoot()
    const source = join(root, 'object-0400')
    const destination = join(root, 'alias')
    const content = Buffer.from('read-only object bytes\n')
    await writeFile(source, content)
    // A published object is mode 0400, so a copy of it can only be flushed
    // through a read-only descriptor.
    await chmod(source, 0o400)
    faults.linkFailure = 'EPERM'

    await publishExclusive(source, destination)

    expect(await readFile(destination)).toEqual(content)
    expect(faults.linkFailure).toBeUndefined()
  })

  it('removes an unflushed copy and rethrows the flush failure', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const destination = join(root, 'object')
    await writeFile(source, 'durable source bytes\n')
    const flushFailure = Object.assign(new Error('injected flush failure'), { code: 'EIO' })
    faults.linkFailure = 'EPERM'
    faults.syncFailure = flushFailure

    await expect(publishExclusive(source, destination)).rejects.toBe(flushFailure)

    expect(faults.syncFailure).toBeUndefined()
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('durable source bytes\n')
  })

  it('keeps a flushed copy when closing it fails', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const destination = join(root, 'object')
    await writeFile(source, 'flushed source bytes\n')
    const closeFailure = Object.assign(new Error('injected close failure'), { code: 'EIO' })
    faults.linkFailure = 'EPERM'
    faults.closeFailure = closeFailure

    await expect(publishExclusive(source, destination)).rejects.toBe(closeFailure)

    // The bytes were flushed before close failed, so the publication stays.
    expect(faults.closeFailure).toBeUndefined()
    expect(await readFile(destination, 'utf8')).toBe('flushed source bytes\n')
  })

  it('surfaces a hard-link failure that does not mean "unsupported"', async () => {
    const root = await tempRoot()
    const source = join(root, 'vanished')
    const destination = join(root, 'object')
    // A source that disappeared is unrecoverable: only a refused capability
    // degrades to the copy fallback.
    faults.linkFailure = 'ENOENT'

    await expect(publishExclusive(source, destination)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(faults.linkFailure).toBeUndefined()
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards the copy and reports the refusal when no descriptor can flush it', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const destination = join(root, 'object')
    await writeFile(source, 'unflushable copy bytes\n')
    faults.linkFailure = 'EACCES'
    faults.openRefusal = 'EACCES'

    await expect(publishExclusive(source, destination)).rejects.toMatchObject({
      code: 'EACCES',
      cause: { code: 'EACCES' },
    })

    // An unflushed copy must not survive as a published object.
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('unflushable copy bytes\n')
  })
})
