/** Packaged ripgrep resolution and subprocess execution, independent of tool or Remote consumers. */
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

let rgPathPromise: Promise<string> | undefined

/** Ripgrep could not be resolved from any packaged, bundled, or PATH candidate. */
export class RipgrepUnavailableError extends Error {
  /** Stable code consumed by the search tool error vocabulary. */
  readonly code = 'RIPGREP_UNAVAILABLE'

  /**
   * @param message - diagnostic naming every candidate that was tried.
   * @param options - standard error options, including the resolver failure cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RipgrepUnavailableError'
  }
}

/**
 * The Android prebuild shipped beside this package in a source checkout.
 * @returns the executable path when the file exists, otherwise undefined.
 */
function androidVendorRipgrep(): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidate = join(moduleDirectory, '../../../../vendor/android-prebuilds/rg')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * The first `rg` on PATH, matching Node's own PATH delimiter on this host.
 * @returns the executable path when an entry exists, otherwise undefined.
 */
function pathRipgrep(): string | undefined {
  const path = process.env.PATH
  if (path === undefined) return undefined
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, 'rg')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve ripgrep lazily, once per process. Single-file runtimes use an existing
 * `-rg` sidecar; Android source checkouts use the bundled Android prebuild;
 * Electron uses the unpacked ASAR path; ordinary installs use the packaged
 * `@vscode/ripgrep` platform package. Android also accepts an explicit
 * `DSH_RG_PATH` from the CLI bootstrap, and every platform falls back to a
 * system `rg` on PATH when the packaged module is unavailable. The first
 * resolved path is cached for the process lifetime.
 * @returns the resolved executable's absolute path.
 * @throws {RipgrepUnavailableError} No candidate executable exists.
 */
export function resolveRgPath(): Promise<string> {
  rgPathPromise ??= Promise.resolve().then(async () => {
    const executable = parse(process.execPath)
    const executableSidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    if ('pkg' in process && existsSync(executableSidecar)) return executableSidecar
    if (process.platform === 'android') {
      const configured = process.env.DSH_RG_PATH
      if (configured !== undefined && existsSync(configured)) return configured
      const bundled = androidVendorRipgrep()
      if (bundled !== undefined) return bundled
    }
    let dependencyError: unknown
    try {
      const dependency = (await import('@vscode/ripgrep')).rgPath
      return process.versions.electron === undefined
        ? dependency
        : dependency.replace(/\.asar(?=[\\/])/u, '.asar.unpacked')
    } catch (error) {
      dependencyError = error
    }
    const system = pathRipgrep()
    if (system !== undefined) return system
    throw new RipgrepUnavailableError(
      `Could not resolve ripgrep for ${process.platform}/${process.arch}; tried `
      + `DSH_RG_PATH, vendor/android-prebuilds/rg, @vscode/ripgrep, and PATH. `
      + 'On Termux/Android run `sh scripts/setup-android.sh` or install the Termux `ripgrep` package.',
      dependencyError === undefined ? undefined : { cause: dependencyError },
    )
  })
  return rgPathPromise
}

/**
 * Start packaged ripgrep with explicit subprocess settings. `spec.argv` contains
 * only rg arguments, without an executable. This function prepends the resolved
 * rg executable path and `--no-config`, so ambient configuration cannot enable a
 * preprocessor. The caller owns exit classification and process cleanup.
 * @param subprocess - the composed subprocess service.
 * @param spec - cwd, rg arguments (without the executable), stdio, signal and termination grace.
 * @returns the live subprocess handle; resolution and synchronous spawn failures reject.
 */
export async function spawnRipgrep(subprocess: Pick<SubprocessRuntime, 'spawn'>, spec: SubprocessSpawnSpec): Promise<SubprocessHandle> {
  const executable = await resolveRgPath()
  return subprocess.spawn({ ...spec, argv: [executable, '--no-config', ...spec.argv] })
}

/** Exit facts and whether the line consumer requested early termination. */
export interface RipgrepLinesResult {
  readonly outcome: SubprocessOutcome
  readonly stopped: boolean
}

/**
 * Read UTF-8 stdout records without retaining the complete output. A false
 * callback return terminates the process and suppresses remaining records.
 * Completion, callback failure and stream failure all await process quiescence;
 * provider failures reject. Exit codes and cancellation remain consumer-owned.
 * @param handle - an owned ripgrep process spawned with piped stdout.
 * Records are decoded as UTF-8, so bytes of a name that is not valid UTF-8
 * arrive replaced with U+FFFD.
 * @param separator - newline for text output, or NUL for file paths that may contain newlines.
 * @param onLine - synchronous record consumer; false requests early termination.
 * @returns exit facts after stdout and the managed process range settle.
 */
export async function readRipgrepLines(
  handle: SubprocessHandle,
  separator: '\n' | '\0',
  onLine: (line: string) => boolean,
): Promise<RipgrepLinesResult> {
  const stdout = handle.stdout
  if (stdout === undefined) {
    handle.terminate()
    await Promise.allSettled([handle.done, handle.waitForExit()])
    throw new Error('ripgrep requires piped stdout')
  }
  stdout.setEncoding('utf8')
  let stopped = false
  let completed = false
  const reading = (async () => {
    let pending = ''
    for await (const chunk of stdout as AsyncIterable<string>) {
      if (stopped) continue
      pending += chunk
      let end: number
      while ((end = pending.indexOf(separator)) !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!onLine(line)) {
          stopped = true
          pending = ''
          handle.terminate()
          break
        }
      }
    }
    if (pending.length > 0 && !onLine(pending)) {
      stopped = true
      handle.terminate()
    }
  })()
  try {
    const [, outcome] = await Promise.all([reading, handle.done])
    completed = true
    return { outcome, stopped }
  } finally {
    if (!completed) {
      handle.terminate()
      stdout.destroy()
    }
    await Promise.allSettled([reading, handle.done])
    await handle.waitForExit()
  }
}
