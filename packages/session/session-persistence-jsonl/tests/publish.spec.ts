/**
 * Exclusive publication behavior: a hard link when the filesystem allows one,
 * and a flushed copy when it refuses. The refusals are injected because the
 * fallback must run exactly once whether the host supports link(2) (Linux) or
 * denies it (Android app data under SELinux), so no case depends on the host.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishExclusive } from '../src/publish.ts'

const faults = vi.hoisted(() => ({
  /** Next link() call fails with this errno code, then clears. */
  linkFailure: undefined as string | undefined,
  /** Next read-write open of a published copy fails with this errno code, then clears. */
  writableOpenFailure: undefined as string | undefined,
  /** Next read-write open of a published copy fails its flush, then clears. */
  syncFailure: undefined as Error | undefined,
  /** Next read-write open of a published copy fails its close, then clears. */
  closeFailure: undefined as Error | undefined,
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
      const writableOpenFailure = faults.writableOpenFailure
      if (writableOpenFailure !== undefined && args[1] === 'r+') {
        faults.writableOpenFailure = undefined
        throw Object.assign(new Error(`${writableOpenFailure}: injected writable open refusal`), {
          code: writableOpenFailure,
        })
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-publish-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  faults.linkFailure = undefined
  faults.writableOpenFailure = undefined
  faults.syncFailure = undefined
  faults.closeFailure = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('publishExclusive', () => {
  it('publishes a byte-identical copy when hard links are denied', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    const content = '{"type":"session","version":4}\n'
    await writeFile(source, content)
    faults.linkFailure = 'EACCES'

    await publishExclusive(source, destination)

    expect(await readFile(destination, 'utf8')).toBe(content)
    // The injected refusal was consumed, so the copy fallback produced this target.
    expect(faults.linkFailure).toBeUndefined()
  })

  it('flushes a copy through a read-only descriptor when the writable open is refused', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    await writeFile(source, 'durable source\n')
    faults.linkFailure = 'EACCES'
    faults.writableOpenFailure = 'EACCES'

    await publishExclusive(source, destination)

    expect(faults.writableOpenFailure).toBeUndefined()
    expect(await readFile(destination, 'utf8')).toBe('durable source\n')
  })

  it('keeps the existing target when a second publication collides', async () => {
    const root = await tempRoot()
    const destination = join(root, 'session.v4.jsonl')
    const first = join(root, 'first.jsonl')
    const second = join(root, 'second.jsonl')
    await writeFile(first, 'first\n')
    await writeFile(second, 'second\n')
    await publishExclusive(first, destination)

    await expect(publishExclusive(second, destination)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destination, 'utf8')).toBe('first\n')
  })

  it('removes an unsynced copy and rethrows the flush failure', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    await writeFile(source, 'durable source\n')
    const flushFailure = Object.assign(new Error('injected flush failure'), { code: 'EIO' })
    faults.linkFailure = 'EPERM'
    faults.syncFailure = flushFailure

    await expect(publishExclusive(source, destination)).rejects.toBe(flushFailure)

    expect(faults.syncFailure).toBeUndefined()
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('durable source\n')
  })

  it('keeps a flushed copy when closing it fails', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    await writeFile(source, 'durable source\n')
    const closeFailure = Object.assign(new Error('injected close failure'), { code: 'EIO' })
    faults.linkFailure = 'EPERM'
    faults.closeFailure = closeFailure

    await expect(publishExclusive(source, destination)).rejects.toBe(closeFailure)

    // The bytes were flushed before close failed, so the publication stays.
    expect(faults.closeFailure).toBeUndefined()
    expect(await readFile(destination, 'utf8')).toBe('durable source\n')
  })

  it('keeps the collision code and the refused hard-link cause', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    await writeFile(source, 'new\n')
    await writeFile(destination, 'existing\n')
    faults.linkFailure = 'EACCES'

    await expect(publishExclusive(source, destination)).rejects.toMatchObject({
      code: 'EEXIST',
      cause: { code: 'EACCES' },
    })
    expect(await readFile(destination, 'utf8')).toBe('existing\n')
  })

  it.skipIf(process.platform === 'win32')('publishes a read-only staged file with owner-only mode', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged.jsonl')
    const destination = join(root, 'session.v4.jsonl')
    await writeFile(source, 'read-only source\n')
    await chmod(source, 0o400)
    faults.linkFailure = 'EACCES'

    await publishExclusive(source, destination)

    expect(await readFile(destination, 'utf8')).toBe('read-only source\n')
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
  })
})
