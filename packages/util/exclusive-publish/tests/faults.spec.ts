/**
 * Descriptor faults on the copy path: a close failure after a durable flush keeps the publication,
 * while a descriptor that cannot be opened for the flush discards the unproven copy.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishExclusive } from '../src/index.ts'

const faults = vi.hoisted(() => ({
  /** Next read-write open of a published copy fails with this errno code, then clears. */
  writableOpenFailure: undefined as string | undefined,
  /** Every read-only open of a published copy fails with this errno code until cleared. */
  readOpenFailure: undefined as string | undefined,
  /** Next read-write open of a published copy fails its sync, then clears. */
  syncFailure: undefined as Error | undefined,
  /** Next read-write open of a published copy fails its close, then clears. */
  closeFailure: undefined as Error | string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const writableOpenFailure = faults.writableOpenFailure
      if (writableOpenFailure !== undefined && args[1] === 'r+') {
        faults.writableOpenFailure = undefined
        throw Object.assign(new Error(`${writableOpenFailure}: injected writable open refusal`), {
          code: writableOpenFailure,
        })
      }
      const readOpenFailure = faults.readOpenFailure
      if (readOpenFailure !== undefined && args[1] === 'r') {
        throw Object.assign(new Error(`${readOpenFailure}: injected read-only open refusal`), {
          code: readOpenFailure,
        })
      }
      const handle = await actual.open(...args)
      const syncFailure = faults.syncFailure
      if (syncFailure !== undefined && args[1] === 'r+') {
        faults.syncFailure = undefined
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(syncFailure)
      }
      const closeFailure = faults.closeFailure
      // The copy path reopens its fresh publication read-write to flush bytes.
      if (closeFailure !== undefined && args[1] === 'r+') {
        faults.closeFailure = undefined
        const close = handle.close.bind(handle)
        // Close the descriptor for real so the temporary root stays removable,
        // then report the close failure the publication must not clean up after.
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-publish-faults-'))
  roots.push(root)
  return root
}

const refusedLink = async (): Promise<void> => {
  throw Object.assign(new Error('link refused'), { code: 'EACCES' })
}
const unavailableRename = async (): Promise<void> => {
  throw Object.assign(new Error('renameat2 unsupported'), { code: 'ENOSYS' })
}

beforeEach(() => {
  faults.writableOpenFailure = undefined
  faults.readOpenFailure = undefined
  faults.syncFailure = undefined
  faults.closeFailure = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('copy flush descriptor faults', () => {
  it('keeps a flushed copy when closing it fails', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'durable bytes\n')
    const closeFailure = Object.assign(new Error('injected close failure'), { code: 'EIO' })
    faults.closeFailure = closeFailure

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toBe(closeFailure)

    // The bytes were flushed before close failed, so the publication stays.
    expect(faults.closeFailure).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('durable bytes\n')
  })

  it('discards the copy when the default flush fails to sync', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'unsynced bytes\n')
    const syncFailure = Object.assign(new Error('injected sync failure'), { code: 'EIO' })
    faults.syncFailure = syncFailure

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toBe(syncFailure)

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('unsynced bytes\n')
  })

  it('reports the sync failure when closing the descriptor also fails', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'unsynced bytes\n')
    const syncFailure = Object.assign(new Error('injected sync failure'), { code: 'EIO' })
    faults.syncFailure = syncFailure
    faults.closeFailure = Object.assign(new Error('injected close failure'), { code: 'EIO' })

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toBe(syncFailure)

    expect(faults.closeFailure).toBeUndefined()
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards the copy when opening it for the flush fails for another reason', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'unflushable bytes\n')
    faults.writableOpenFailure = 'EIO'

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toMatchObject({ code: 'EIO', cause: { code: 'EACCES' } })

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards the copy when closing it fails with a non-Error value', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'flushed bytes\n')
    faults.closeFailure = 'close refused'

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toBe('close refused')

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to a read-only descriptor when the writable open is refused', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'durable bytes\n')
    faults.writableOpenFailure = 'EACCES'

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).resolves.toBe('copied')

    expect(faults.writableOpenFailure).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('durable bytes\n')
  })

  it('discards the copy when no descriptor can flush it', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'unflushable bytes\n')
    faults.writableOpenFailure = 'EACCES'
    faults.readOpenFailure = 'EACCES'

    await expect(publishExclusive(source, target, {
      link: refusedLink,
      rename: unavailableRename,
    })).rejects.toMatchObject({ code: 'EACCES', cause: { code: 'EACCES' } })

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('unflushable bytes\n')
  })
})
