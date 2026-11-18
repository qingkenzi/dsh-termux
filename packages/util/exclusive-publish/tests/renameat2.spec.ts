/**
 * Native no-replace rename declaration and errno mapping. Fake koffi bindings stand in for libc so
 * the symbol path, the raw-syscall fallback, and an unsupported host are all exercised everywhere.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeRename,
  createNativeRenameLoader,
  createRenameNoReplace,
  renameNoReplace,
  supportsRenameat2,
  type KoffiBindings,
  type NativeRename,
} from '../src/renameat2.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-renameat2-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A koffi stand-in whose libc exposes only the named functions. */
function fakeKoffi(
  functions: { renameat2?: (...args: unknown[]) => number; syscall?: (...args: unknown[]) => number },
  errno = 0,
): KoffiBindings {
  return {
    load: () => ({
      func: (definition: string) => {
        const fn = definition.includes('renameat2') ? functions.renameat2 : functions.syscall
        if (fn === undefined) throw new Error(`missing native symbol in ${JSON.stringify(definition)}`)
        return fn
      },
    }),
    errno: () => errno,
  }
}

describe('supportsRenameat2', () => {
  it.each(['linux', 'android'] as const)('recognizes %s as a renameat2 host', (platform) => {
    expect(supportsRenameat2(platform)).toBe(true)
  })

  it.each(['darwin', 'win32', 'freebsd'] as const)('excludes %s from the Linux ABI', (platform) => {
    expect(supportsRenameat2(platform)).toBe(false)
  })
})

describe('createNativeRename', () => {
  it('prefers the libc renameat2 symbol and pins RENAME_NOREPLACE', () => {
    const call = vi.fn(() => 0)
    const binding = createNativeRename(fakeKoffi({ renameat2: call }, 17), 'x64')

    expect(binding?.rename('/staged', '/published')).toBe(0)
    expect(call).toHaveBeenCalledWith(-100, '/staged', -100, '/published', 1)
    // The errno accessor reads the binding's own process-wide errno.
    expect(binding?.errno()).toBe(17)
  })

  it.each([['arm64', 276], ['x64', 316]] as const)(
    '%s falls back to syscall %i when the symbol is missing',
    (arch, number) => {
      const call = vi.fn(() => 0)
      const binding = createNativeRename(fakeKoffi({ syscall: call }), arch)

      expect(binding?.rename('/staged', '/published')).toBe(0)
      expect(call).toHaveBeenCalledWith(
        number, 'int', -100, 'str', '/staged', 'int', -100, 'str', '/published', 'uint', 1,
      )
    },
  )

  it('reports the capability unavailable when no architecture syscall number exists', () => {
    expect(createNativeRename(fakeKoffi({}), 'ia32')).toBeUndefined()
  })

  it('reports the capability unavailable when neither symbol resolves', () => {
    expect(createNativeRename(fakeKoffi({}), 'arm64')).toBeUndefined()
  })
})

describe('createNativeRenameLoader', () => {
  it('does not import koffi on a platform without the renameat2 ABI', async () => {
    const importKoffi = vi.fn(async () => { throw new Error('must not import') })
    const load = createNativeRenameLoader('darwin', importKoffi)

    await expect(load()).resolves.toBeNull()
    expect(importKoffi).not.toHaveBeenCalled()
  })

  it('reports the capability unavailable when koffi has no prebuilt for this host', async () => {
    const load = createNativeRenameLoader('linux', async () => { throw new Error('no prebuilt') })

    await expect(load()).resolves.toBeNull()
  })

  it('reports the capability unavailable when the libc exposes no usable symbol', async () => {
    const load = createNativeRenameLoader('linux', async () => ({ default: fakeKoffi({}) }))

    await expect(load()).resolves.toBeNull()
  })

  it('caches the imported binding across calls', async () => {
    const call = vi.fn(() => 0)
    const importKoffi = vi.fn(async () => ({ default: fakeKoffi({ renameat2: call }) }))
    const load = createNativeRenameLoader('linux', importKoffi)

    const first = await load()
    const second = await load()
    expect(second).toBe(first)
    expect(first?.rename('/staged', '/published')).toBe(0)
    expect(importKoffi).toHaveBeenCalledTimes(1)
  })
})

describe('createRenameNoReplace', () => {
  it('reports ENOSYS when no native binding exists', async () => {
    const rename = createRenameNoReplace(async () => null)

    await expect(rename('/staged', '/published')).rejects.toMatchObject({ code: 'ENOSYS' })
  })

  it('resolves when the native rename succeeds', async () => {
    const native: NativeRename = { rename: () => 0, errno: () => 0 }
    const rename = createRenameNoReplace(async () => native)

    await expect(rename('/staged', '/published')).resolves.toBeUndefined()
  })

  it('maps the native errno onto the Node error code', async () => {
    const native: NativeRename = { rename: () => -1, errno: () => 17 }
    const rename = createRenameNoReplace(async () => native)

    await expect(rename('/staged', '/published')).rejects.toMatchObject({ code: 'EEXIST', errno: 17 })
  })

  it('falls back to EIO when a failed call reports no errno', async () => {
    const native: NativeRename = { rename: () => -1, errno: () => 0 }
    const rename = createRenameNoReplace(async () => native)

    await expect(rename('/staged', '/published')).rejects.toMatchObject({ code: 'EIO', errno: 0 })
  })

  it('reports the host capability or its absence without touching another name', async () => {
    const root = await tempRoot()
    const source = join(root, 'staged')
    const target = join(root, 'published')
    await writeFile(source, 'native bytes\n')

    try {
      await renameNoReplace(source, target)
      expect(await readFile(target, 'utf8')).toBe('native bytes\n')
    } catch (error: unknown) {
      // A host or filesystem without the capability reports one of these refusals.
      expect(['ENOSYS', 'EINVAL', 'EOPNOTSUPP']).toContain((error as NodeJS.ErrnoException).code)
      expect(await readFile(source, 'utf8')).toBe('native bytes\n')
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})
