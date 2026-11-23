/**
 * Synchronous exclusive publication across its two capabilities: a hard link and a flushed
 * exclusive copy. The primitives are injected so each path runs on every host, including hosts
 * that support linkSync and hosts that deny it.
 */

import {
  chmodSync, copyFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishExclusiveSync } from '../src/index.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-exclusive-publish-sync-'))
  roots.push(root)
  return root
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Run one publication that must fail and return the thrown value. */
function capture(publish: () => void): unknown {
  try {
    publish()
  } catch (error: unknown) {
    return error
  }
  throw new Error('the publication must fail')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('synchronous link publication', () => {
  it('returns linked without touching the staged name', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'linked bytes\n')
    const linkPrimitive = vi.fn((from: string, to: string) => { copyFileSync(from, to) })

    expect(publishExclusiveSync(source, target, {
      link: linkPrimitive,
      fsync: () => { throw new Error('the copy must not run') },
    })).toBe('linked')

    expect(linkPrimitive).toHaveBeenCalledWith(source, target)
    expect(readFileSync(target, 'utf8')).toBe('linked bytes\n')
    expect(readFileSync(source, 'utf8')).toBe('linked bytes\n')
  })

  it('publishes through the default hard link or the copy fallback', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'default bytes\n')

    expect(['linked', 'copied']).toContain(publishExclusiveSync(source, target))
    expect(readFileSync(target, 'utf8')).toBe('default bytes\n')
    expect(readFileSync(source, 'utf8')).toBe('default bytes\n')
  })

  it('propagates a hard-link failure that does not mean "unsupported"', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    const failure = errnoError('source vanished', 'ENOENT')

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw failure },
    }))).toBe(failure)
    expect(existsSync(target)).toBe(false)
  })

  it('propagates a hard-link failure that carries no errno code', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    const failure = new Error('link primitive gave up')

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw failure },
    }))).toBe(failure)
    expect(existsSync(target)).toBe(false)
  })
})

describe('synchronous exclusive copy publication', () => {
  it('keeps a competitor that won the copy race and reports EEXIST', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'ours\n')
    writeFileSync(target, 'theirs\n')

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
    }))).toMatchObject({ code: 'EEXIST', cause: { code: 'EACCES' } })
    expect(readFileSync(target, 'utf8')).toBe('theirs\n')
    expect(readFileSync(source, 'utf8')).toBe('ours\n')
  })

  it('removes a partially written copy and rethrows the copy failure', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const copyFailure = errnoError('copy failed', 'EIO')

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      exclusive: (_from, to) => {
        writeFileSync(to, 'partial')
        throw copyFailure
      },
    }))).toMatchObject({ code: 'EIO', cause: { code: 'EACCES' } })
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(source, 'utf8')).toBe('staged bytes\n')
  })

  it('propagates a non-Error copy failure and still removes the copy', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const failure = 'copy refused'

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      exclusive: (_from, to) => {
        writeFileSync(to, 'partial')
        throw failure
      },
    }))).toBe(failure)
    expect(existsSync(target)).toBe(false)
  })

  it('keeps a copy failure that already carries a cause', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const original = errnoError('disk gave up', 'EIO')
    const copyFailure = Object.assign(errnoError('copy failed', 'EIO'), { cause: original })

    const failure = capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      exclusive: () => { throw copyFailure },
    }))

    expect(failure).toBe(copyFailure)
    expect((failure as Error).cause).toBe(original)
  })

  it('removes a copy whose flush failed', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const flushFailure = errnoError('flush failed', 'EIO')

    expect(capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      fsync: () => { throw flushFailure },
    }))).toBe(flushFailure)
    expect(existsSync(target)).toBe(false)
  })

  it('aggregates a failed copy cleanup while keeping the copy failure first', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    // A non-empty directory at the target path makes the non-recursive cleanup fail.
    mkdirSync(target)
    writeFileSync(join(target, 'occupant'), 'kept')
    const copyFailure = errnoError('copy failed', 'EIO')

    const failure = capture(() => publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      exclusive: () => { throw copyFailure },
    }))

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(copyFailure)
    expect(readFileSync(join(target, 'occupant'), 'utf8')).toBe('kept')
  })

  it('applies a requested mode before flushing the copy', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const fsync = vi.fn((path: string) => {
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    })

    expect(publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      mode: 0o600,
      fsync,
    })).toBe('copied')

    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(fsync).toHaveBeenCalledWith(target)
  })

  it.skipIf(process.platform === 'win32')('preserves the source mode when none is requested', () => {
    const root = tempRoot()
    const source = join(root, 'object-0400')
    const target = join(root, 'alias')
    writeFileSync(source, 'read-only bytes\n')
    chmodSync(source, 0o400)

    expect(publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
    })).toBe('copied')

    expect(readFileSync(target, 'utf8')).toBe('read-only bytes\n')
    // The default flush opens the read-only copy through a read-only descriptor.
    expect(statSync(target).mode & 0o777).toBe(0o400)
  })

  it('uses a caller-supplied exclusive copy primitive', () => {
    const root = tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    writeFileSync(source, 'staged bytes\n')
    const exclusive = vi.fn((from: string, to: string) => {
      copyFileSync(from, to, constants.COPYFILE_EXCL)
    })

    expect(publishExclusiveSync(source, target, {
      link: () => { throw errnoError('link refused', 'EACCES') },
      exclusive,
      fsync: () => {},
    })).toBe('copied')
    expect(exclusive).toHaveBeenCalledWith(source, target)
  })
})
