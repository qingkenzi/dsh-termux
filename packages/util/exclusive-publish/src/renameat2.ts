/**
 * `renameat2(2)` with `RENAME_NOREPLACE`, the zero-copy step between a refused hard link and an
 * exclusive copy. Node exposes no binding for it, so koffi calls libc's `renameat2` symbol, or the
 * raw syscall where libc omits the symbol. A host with neither capability reports `ENOSYS`, which
 * callers treat as "publish by copying instead".
 * @module @deepseek-ai/dsh-util-exclusive-publish/renameat2
 */

import { getSystemErrorName } from 'node:util'

/** `AT_FDCWD`: resolve both paths against the process working directory. */
const AT_FDCWD = -100
/** `RENAME_NOREPLACE`: refuse an existing target with EEXIST instead of replacing it. */
const RENAME_NOREPLACE = 1
/** Linux `renameat2` syscall numbers for architectures whose libc may omit the symbol. */
const RENAMEAT2_SYSCALL: Readonly<Partial<Record<NodeJS.Architecture, number>>> = { arm64: 276, x64: 316 }

/** A no-replace rename that rejects with `EEXIST` when the target already exists. */
export type RenameNoReplace = (source: string, target: string) => Promise<void>

/** One native rename call and the errno it reports on failure. */
export interface NativeRename {
  /** Rename `source` onto `target` without replacing it; returns 0 on success and -1 on failure. */
  rename(source: string, target: string): number
  /** errno from this binding's most recent native call. */
  errno(): number
}

/** The koffi entries this module uses, narrowed so tests can supply a fake binding. */
export interface KoffiBindings {
  /** Load a shared library; `null` reads the running process's global symbols. */
  load(path: string | null): { func(definition: string): (...args: unknown[]) => number }
  /** errno from the most recent native call. */
  errno(): number
}

/**
 * Declare the native rename binding for one architecture.
 * @param koffi - Loaded koffi module.
 * @param arch - Process architecture that selects the raw syscall number.
 * @returns The binding, or undefined when this libc and architecture expose neither symbol.
 */
export function createNativeRename(koffi: KoffiBindings, arch: NodeJS.Architecture): NativeRename | undefined {
  const libc = koffi.load(null)
  const errno = (): number => koffi.errno()
  try {
    const call = libc.func('int renameat2(int dirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)')
    return { rename: (source, target) => call(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE), errno }
  } catch (error: unknown) {
    // A libc without the symbol may still expose the raw syscall below; any
    // declaration failure leaves this candidate unusable.
    void error
  }
  const syscallNumber = RENAMEAT2_SYSCALL[arch]
  if (syscallNumber === undefined) return undefined
  try {
    const call = libc.func('long syscall(long number, ...)')
    return {
      rename: (source, target) => call(syscallNumber, 'int', AT_FDCWD, 'str', source, 'int', AT_FDCWD, 'str', target, 'uint', RENAME_NOREPLACE),
      errno,
    }
  } catch (error: unknown) {
    // Both names come from the same libc; without either, no zero-copy path exists.
    void error
    return undefined
  }
}

/**
 * Whether this platform's ABI defines `renameat2`, `AT_FDCWD`, and the syscall numbers below.
 * @param platform - Platform to classify.
 * @returns True for Linux and Android.
 */
export function supportsRenameat2(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'android'
}

/** Dynamically import koffi; injectable so host capability loading is testable. */
export type KoffiImport = () => Promise<{ default: KoffiBindings }>

/**
 * Build the process-wide native binding loader.
 * @param platform - Platform whose ABI decides whether `renameat2` exists.
 * @param importKoffi - koffi importer; a rejection means the host has no usable prebuilt.
 * @returns A lazy loader that reads the binding once and caches the promise.
 */
export function createNativeRenameLoader(
  platform: NodeJS.Platform,
  importKoffi: KoffiImport,
): () => Promise<NativeRename | null> {
  let cached: Promise<NativeRename | null> | undefined
  return () => {
    cached ??= (async () => {
      // Another host's `syscall` symbol would interpret these numbers differently.
      if (!supportsRenameat2(platform)) return null
      try {
        const koffi = (await importKoffi()).default
        return createNativeRename(koffi, process.arch) ?? null
      } catch (error: unknown) {
        // koffi ships no prebuilt library for every host and architecture; the
        // caller falls back to the exclusive copy in that case.
        void error
        return null
      }
    })()
    return cached
  }
}

/** The process-wide loader used by {@link renameNoReplace}. */
const loadNativeRename = createNativeRenameLoader(process.platform, () => import('koffi'))

function unavailable(): Error {
  return Object.assign(new Error('renameat2(RENAME_NOREPLACE) is unavailable on this host'), { code: 'ENOSYS' })
}

function nativeFailure(errno: number): Error {
  // libc reports a positive errno while Node's name lookup takes libuv's negative form.
  const code = errno > 0 ? getSystemErrorName(-errno) : 'EIO'
  return Object.assign(new Error(`renameat2(RENAME_NOREPLACE) failed: ${code}`), { code, errno })
}

/**
 * Build the default no-replace rename.
 * @param load - Binding loader; omission reads koffi once per process.
 * @returns A function that rejects with `ENOSYS` when no binding exists, otherwise with the
 *   native errno, including `EEXIST` for an existing target.
 */
export function createRenameNoReplace(
  load: () => Promise<NativeRename | null> = loadNativeRename,
): RenameNoReplace {
  return async (source, target) => {
    const binding = await load()
    if (binding === null) throw unavailable()
    if (binding.rename(source, target) === 0) return
    throw nativeFailure(binding.errno())
  }
}

/** The process-wide no-replace rename used by {@link publishExclusive}. */
export const renameNoReplace: RenameNoReplace = createRenameNoReplace()
