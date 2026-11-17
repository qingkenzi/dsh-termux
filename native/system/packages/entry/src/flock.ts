/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSystemErrorName } from 'node:util'

interface FlockBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
}

let binding: FlockBinding | undefined

/**
 * Candidate Android addon paths in load order: the published platform package,
 * then the entry package's source-compatible copy.
 * @returns Absolute candidate paths, including candidates that do not exist so
 *   load failures name every location that was tried.
 */
function androidAddonCandidates(): string[] {
  const candidates: string[] = []
  try {
    const manifest = createRequire(import.meta.url)
      .resolve('@deepseek-ai/node-addon-system-android-arm64/package.json')
    candidates.push(join(dirname(manifest), 'bin/bionic/system.node'))
  } catch (cause: unknown) {
    // A missing optional platform package falls back to the source copy; a
    // resolution failure for an installed package stays visible.
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== 'MODULE_NOT_FOUND') throw cause
  }
  candidates.push(fileURLToPath(new URL('../bin/bionic/system.node', import.meta.url)))
  return candidates
}

/**
 * Load the Android addon from the first candidate that registers.
 * @returns The loaded flock binding.
 */
function loadAndroidBinding(): FlockBinding {
  const require = createRequire(import.meta.url)
  const candidates = androidAddonCandidates()
  let cause: unknown
  for (const addon of candidates) {
    try {
      return require(addon) as FlockBinding
    } catch (error: unknown) {
      cause = error
    }
  }
  throw Object.assign(
    new Error(`flock addon for ${process.platform}-${process.arch} is missing or unloadable at `
      + `${candidates.join(' or ')}; run pnpm run build:native-system, or sh scripts/setup-android.sh `
      + 'to restore the prebuilt copy'),
    { code: 'ERR_FLOCK_ADDON_MISSING', cause },
  )
}

function loadBinding(): FlockBinding {
  if (binding) return binding
  const { platform, arch } = process
  // Termux/Android (bionic) implements flock(2). The published platform package
  // carries the addon; the entry copy remains for source-only builds and
  // scripts/setup-android.sh.
  if (platform === 'android') {
    binding = loadAndroidBinding()
    return binding
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    })
  }

  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
  return binding
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const errno = await new Promise<number>((resolve) => {
    loadBinding().tryLock(fd, resolve)
  })
  if (errno === 0) return
  const code = getSystemErrorName(-errno)
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  })
}
