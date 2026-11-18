/**
 * Exclusive publication across its three capabilities: a hard link, a no-replace rename, and a
 * flushed exclusive copy. The primitives are injected so each path runs on every host, including
 * hosts that support link(2) and hosts that deny it.
 */

import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishExclusive } from '../src/index.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-publish-'))
  roots.push(root)
  return root
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A rename primitive that reports the capability as absent. */
const unsupportedRename = async (): Promise<void> => { throw errnoError('renameat2 unsupported', 'ENOSYS') }

describe('link publication', () => {
  it('returns linked without touching the staged name', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'linked bytes\n')
    const linkPrimitive = vi.fn(async (from: string, to: string) => { await copyFile(from, to) })

    await expect(publishExclusive(source, target, {
      link: linkPrimitive,
      rename: async () => { throw new Error('the rename must not run') },
      fsync: async () => { throw new Error('the copy must not run') },
    })).resolves.toBe('linked')

    expect(linkPrimitive).toHaveBeenCalledWith(source, target)
    expect(await readFile(target, 'utf8')).toBe('linked bytes\n')
    expect(await readFile(source, 'utf8')).toBe('linked bytes\n')
  })

  it('publishes through the default hard link or the copy fallback', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'default bytes\n')

    const method = await publishExclusive(source, target, { rename: null })

    expect(['linked', 'copied']).toContain(method)
    expect(await readFile(target, 'utf8')).toBe('default bytes\n')
    expect(await readFile(source, 'utf8')).toBe('default bytes\n')
  })

  it('propagates a hard-link failure that does not mean "unsupported"', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    const failure = errnoError('source vanished', 'ENOENT')

    await expect(publishExclusive(source, target, {
      link: async () => { throw failure },
      rename: async () => { throw new Error('the rename must not run for ENOENT') },
    })).rejects.toBe(failure)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('no-replace rename publication', () => {
  it.each(['EACCES', 'EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP'] as const)(
    'falls back to renameat2 when link is refused with %s', async (code) => {
      const root = await tempRoot()
      const source = join(root, 'staged')
      const target = join(root, 'published')
      await writeFile(source, 'renamed bytes\n')
      const renamePrimitive = vi.fn(async (from: string, to: string) => { await rename(from, to) })
      const fsync = vi.fn(async () => { throw new Error('the copy must not run') })

      await expect(publishExclusive(source, target, {
        link: async () => { throw errnoError('link refused', code) },
        rename: renamePrimitive,
        fsync,
      })).resolves.toBe('renamed')

      expect(renamePrimitive).toHaveBeenCalledWith(source, target)
      expect(fsync).not.toHaveBeenCalled()
      expect(await readFile(target, 'utf8')).toBe('renamed bytes\n')
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.each(['ENOSYS', 'EINVAL', 'EOPNOTSUPP'] as const)(
    'falls back to an exclusive copy when renameat2 reports %s', async (code) => {
      const root = await tempRoot()
      const source = join(root, 'staged')
      const target = join(root, 'published')
      await writeFile(source, 'copied bytes\n')
      const fsync = vi.fn(async () => {})

      await expect(publishExclusive(source, target, {
        link: async () => { throw errnoError('link refused', 'EACCES') },
        rename: async () => { throw errnoError('rename unsupported', code) },
        fsync,
      })).resolves.toBe('copied')

      expect(fsync).toHaveBeenCalledWith(target)
      expect(await readFile(target, 'utf8')).toBe('copied bytes\n')
      expect(await readFile(source, 'utf8')).toBe('copied bytes\n')
    },
  )

  it('uses the default no-replace rename when the host refuses hard links', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'native bytes\n')

    const method = await publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
    })

    expect(['renamed', 'copied']).toContain(method)
    expect(await readFile(target, 'utf8')).toBe('native bytes\n')
    if (method === 'renamed') await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(source, 'utf8')).toBe('native bytes\n')
  })

  it('copies when the caller disables the rename', async () => {
    const root = await tempRoot()
    const source = join(root, 'object')
    const target = join(root, 'alias')
    await writeFile(source, 'aliased bytes\n')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: null,
    })).resolves.toBe('copied')

    expect(await readFile(target, 'utf8')).toBe('aliased bytes\n')
    expect(await readFile(source, 'utf8')).toBe('aliased bytes\n')
  })

  it('propagates EXDEV instead of copying across a device boundary', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const crossDevice = errnoError('cross-device rename', 'EXDEV')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: async () => { throw crossDevice },
    })).rejects.toMatchObject({ code: 'EXDEV', cause: { code: 'EACCES' } })
    expect(await readFile(source, 'utf8')).toBe('staged bytes\n')
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates ENOENT instead of copying when the target cannot be named', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'missing-parent', 'published')
    await writeFile(source, 'staged bytes\n')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: async () => { throw errnoError('missing parent', 'ENOENT') },
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the competitor when the rename loses the create race', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'ours\n')
    await writeFile(target, 'theirs\n')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: async () => { throw errnoError('target exists', 'EEXIST') },
      fsync: async () => { throw new Error('the copy must not run') },
    })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('theirs\n')
  })
})

describe('exclusive copy publication', () => {
  it('keeps a competitor that won the copy race and reports EEXIST', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'ours\n')
    await writeFile(target, 'theirs\n')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
    })).rejects.toMatchObject({ code: 'EEXIST', cause: { code: 'EACCES' } })
    expect(await readFile(target, 'utf8')).toBe('theirs\n')
    expect(await readFile(source, 'utf8')).toBe('ours\n')
  })

  it('removes a partially written copy and rethrows the copy failure', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const copyFailure = errnoError('copy failed', 'EIO')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      exclusive: async (_from, to) => {
        await writeFile(to, 'partial')
        throw copyFailure
      },
    })).rejects.toMatchObject({ code: 'EIO', cause: { code: 'EACCES' } })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('staged bytes\n')
  })

  it('propagates a non-Error copy failure and still removes the copy', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const failure = 'copy refused'

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      exclusive: async (_from, to) => {
        await writeFile(to, 'partial')
        throw failure
      },
    })).rejects.toBe(failure)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a copy whose flush failed', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const flushFailure = errnoError('flush failed', 'EIO')

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      fsync: async () => { throw flushFailure },
    })).rejects.toBe(flushFailure)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aggregates a failed copy cleanup while keeping the copy failure first', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    // A non-empty directory at the target path makes the non-recursive cleanup fail.
    await mkdir(target)
    await writeFile(join(target, 'occupant'), 'kept')
    const copyFailure = errnoError('copy failed', 'EIO')

    const failure = await publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      exclusive: async () => { throw copyFailure },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(copyFailure)
    expect(await readFile(join(target, 'occupant'), 'utf8')).toBe('kept')
  })

  it('applies a requested mode before flushing the copy', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const fsync = vi.fn(async (path: string) => {
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    })

    await publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      mode: 0o600,
      fsync,
    })

    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(fsync).toHaveBeenCalledWith(target)
  })

  it.skipIf(process.platform === 'win32')('preserves the source mode when none is requested', async () => {
    const root = await tempRoot()
    const source = join(root, 'object-0400')
    const target = join(root, 'alias')
    await writeFile(source, 'read-only bytes\n')
    await chmod(source, 0o400)

    await publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
    })

    expect(await readFile(target, 'utf8')).toBe('read-only bytes\n')
    // The default flush opens the read-only copy through a read-only descriptor.
    expect((await stat(target)).mode & 0o777).toBe(0o400)
  })

  it('uses a caller-supplied exclusive copy primitive', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'staged bytes\n')
    const exclusive = vi.fn(async (from: string, to: string) => {
      await copyFile(from, to, constants.COPYFILE_EXCL)
    })

    await expect(publishExclusive(source, target, {
      link: async () => { throw errnoError('link refused', 'EACCES') },
      rename: unsupportedRename,
      exclusive,
      fsync: async () => {},
    })).resolves.toBe('copied')
    expect(exclusive).toHaveBeenCalledWith(source, target)
  })
})
