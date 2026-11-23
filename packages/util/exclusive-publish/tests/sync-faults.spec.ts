/**
 * Descriptor faults on the synchronous copy path: a close failure after a durable flush keeps the
 * publication, while a descriptor that cannot be opened for the flush discards the unproven copy.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishExclusiveSync } from '../src/index.ts'

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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], flags: string | number) => {
      const writableOpenFailure = faults.writableOpenFailure
      if (writableOpenFailure !== undefined && flags === 'r+') {
        faults.writableOpenFailure = undefined
        throw Object.assign(new Error(`${writableOpenFailure}: injected writable open refusal`), {
          code: writableOpenFailure,
        })
      }
      const readOpenFailure = faults.readOpenFailure
      if (readOpenFailure !== undefined && flags === 'r') {
        throw Object.assign(new Error(`${readOpenFailure}: injected read-only open refusal`), {
          code: readOpenFailure,
        })
      }
      return actual.openSync(path, flags)
    }) as typeof actual.openSync,
    fsyncSync: ((descriptor: number) => {
      const syncFailure = faults.syncFailure
      if (syncFailure !== undefined) {
        faults.syncFailure = undefined
        throw syncFailure
      }
      actual.fsyncSync(descriptor)
    }) as typeof actual.fsyncSync,
    closeSync: ((descriptor: number) => {
      // Close the descriptor for real so the temporary root stays removable,
      // then report the close failure the publication must not clean up after.
      actual.closeSync(descriptor)
      const closeFailure = faults.closeFailure
      if (closeFailure !== undefined) {
        faults.closeFailure = undefined
        throw closeFailure
      }
    }) as typeof actual.closeSync,
  }
})

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-exclusive-publish-sync-faults-'))
  roots.push(root)
  return root
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

const refusedLink = (): void => {
  throw errnoError('link refused', 'EACCES')
}

function capture(publish: () => void): unknown {
  try {
    publish()
  } catch (error: unknown) {
    return error
  }
  throw new Error('the publication must fail')
}

beforeEach(() => {
  faults.writableOpenFailure = undefined
  faults.readOpenFailure = undefined
  faults.syncFailure = undefined
  faults.closeFailure = undefined
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('synchronous copy flush descriptor faults', () => {
  it('keeps a flushed copy when closing it fails', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'durable bytes\n')
    const closeFailure = errnoError('injected close failure', 'EIO')
    faults.closeFailure = closeFailure

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink }))).toBe(closeFailure)

    // The bytes were flushed before close failed, so the publication stays.
    expect(faults.closeFailure).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe('durable bytes\n')
  })

  it('discards the copy when the default flush fails to sync', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'unsynced bytes\n')
    const syncFailure = errnoError('injected sync failure', 'EIO')
    faults.syncFailure = syncFailure

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink }))).toBe(syncFailure)

    expect(() => statSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(readFileSync(source, 'utf8')).toBe('unsynced bytes\n')
  })

  it('reports the sync failure when closing the descriptor also fails', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'unsynced bytes\n')
    const syncFailure = errnoError('injected sync failure', 'EIO')
    faults.syncFailure = syncFailure
    faults.closeFailure = errnoError('injected close failure', 'EIO')

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink }))).toBe(syncFailure)

    expect(faults.closeFailure).toBeUndefined()
    expect(() => statSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('discards the copy when opening it for the flush fails for another reason', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'unflushable bytes\n')
    faults.writableOpenFailure = 'EIO'

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink })))
      .toMatchObject({ code: 'EIO', cause: { code: 'EACCES' } })

    expect(() => statSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('discards the copy when closing it fails with a non-Error value', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'flushed bytes\n')
    faults.closeFailure = 'close refused'

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink }))).toBe('close refused')

    expect(() => statSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })

  it('falls back to a read-only descriptor when the writable open is refused', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'durable bytes\n')
    faults.writableOpenFailure = 'EACCES'

    expect(publishExclusiveSync(source, target, { link: refusedLink })).toBe('copied')

    expect(faults.writableOpenFailure).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe('durable bytes\n')
  })

  it('discards the copy when no descriptor can flush it', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'unflushable bytes\n')
    faults.writableOpenFailure = 'EACCES'
    faults.readOpenFailure = 'EACCES'

    expect(capture(() => publishExclusiveSync(source, target, { link: refusedLink })))
      .toMatchObject({ code: 'EACCES', cause: { code: 'EACCES' } })

    expect(() => statSync(target)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    expect(readFileSync(source, 'utf8')).toBe('unflushable bytes\n')
  })
})
