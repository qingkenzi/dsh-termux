/**
 * Boot-time Android W^X/exec probe. DSH runs under the Termux app uid, where
 * Android permits executing binaries from app data only while the app targets
 * API 28 or lower. A Termux build that raises targetSdk stops node, sh, and
 * every exec-based tool from starting children. One probe at application boot
 * converts that platform change into a typed startup diagnostic instead of
 * unrelated tool failures later.
 * @module @deepseek-ai/dsh-android-exec
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable error code for a platform that refuses to execute a requested program. */
export const PLATFORM_EXEC_BLOCKED = 'PLATFORM_EXEC_BLOCKED'

/**
 * Probe failure classes, ordered by precedence when both commands fail:
 * - `PLATFORM_EXEC_BLOCKED` — the platform denied execution (`EACCES`/`EPERM`); exec-based tools are unavailable.
 * - `INTERPRETER_MISSING` — the probed interpreter does not exist (`ENOENT`).
 * - `PROBE_TIMEOUT` — a probe did not settle within its bound; exec remains undiagnosed.
 * - `PROBE_FAILED` — the probe exited nonzero or failed for another reason.
 */
export const ANDROID_EXEC_FAILURE_REASONS = [
  'PLATFORM_EXEC_BLOCKED',
  'INTERPRETER_MISSING',
  'PROBE_TIMEOUT',
  'PROBE_FAILED',
] as const

/** One probe failure class from {@link ANDROID_EXEC_FAILURE_REASONS}. */
export type AndroidExecFailureReason = typeof ANDROID_EXEC_FAILURE_REASONS[number]

/** Default per-command bound for one boot probe; a blocked platform reports quickly, a hung supervisor does not. */
export const DEFAULT_ANDROID_EXEC_TIMEOUT_MS = 2_000

/** One boot-time Android exec probe outcome. */
export interface AndroidExecProbeResult {
  /** Whether both the runtime interpreter and the shell start a child process successfully. */
  readonly available: boolean
  /** Failure class when `available` is false; undefined when available. */
  readonly reason: AndroidExecFailureReason | undefined
  /** Failed command and platform detail when unavailable; undefined when available. */
  readonly detail: string | undefined
}

/**
 * The subset of `ChildProcess` one probe observes. Node's `ChildProcess`
 * satisfies it; tests supply an EventEmitter with `kill`.
 */
export interface AndroidExecChild {
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Starts one probe child with ignored stdio. */
export type AndroidExecSpawn = (
  command: string,
  args: string[],
  options: { readonly stdio: 'ignore' },
) => AndroidExecChild

/** Inputs for {@link probeAndroidExec}. */
export interface ProbeAndroidExecOptions {
  /** Platform to probe; defaults to `process.platform`. Non-Android hosts start no process. */
  readonly platform?: NodeJS.Platform
  /** Runtime interpreter to execute; defaults to `process.execPath`. */
  readonly execPath?: string
  /** POSIX shell to execute; defaults to `$PREFIX/bin/sh`, else `/system/bin/sh`. */
  readonly shellPath?: string
  /** Probe child launcher; defaults to `node:child_process.spawn`. */
  readonly spawn?: AndroidExecSpawn
  /** Per-command bound; defaults to {@link DEFAULT_ANDROID_EXEC_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Environment used to resolve the default shell path; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/** Inputs for {@link installAndroidExec}. */
export interface InstallAndroidExecOptions {
  /** Probe owner providing the cached result; tests inject a deterministic probe. */
  readonly probe?: Pick<AndroidExecProbe, 'probe'>
}

/** A local platform refused to execute a requested program; `code` is `PLATFORM_EXEC_BLOCKED`. */
export class PlatformExecBlockedError extends HarnessError {
  /**
   * @param message - names the program and the actionable platform remedy.
   * @param options - original errno error, when one exists.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, PLATFORM_EXEC_BLOCKED, options)
    this.name = 'PlatformExecBlockedError'
  }
}

/**
 * Actionable remedy shared by every Android exec failure report.
 * @returns one sentence naming the targetSdk rule and the app-lib workaround.
 */
export function androidExecGuidance(): string {
  return 'Termux with targetSdk ≥ 29 cannot execute binaries from app data (Android W^X); '
    + 'keep Termux at targetSdk 28, or place the node and sh interpreters in the app lib directory, then restart dsh.'
}

/**
 * Render the typed message for a program that cannot start on this platform.
 * @param program - executable the caller asked to run.
 * @param detail - probe or errno detail explaining the platform denial.
 * @returns message for {@link PlatformExecBlockedError}.
 */
export function androidExecBlockedMessage(program: string, detail: string | undefined): string {
  return `cannot start ${JSON.stringify(program)}: ${detail ?? 'the platform denied execution'}. ${androidExecGuidance()}`
}

/**
 * Render the startup warning for an unavailable probe. The lines name the
 * failed commands; a blocked platform adds the targetSdk rule, the app-lib
 * remedy, and the surviving capabilities.
 * @param binName - application prefix on every line.
 * @param result - unavailable probe result.
 * @returns the warning text; empty when the probe reported available.
 */
export function androidExecDiagnostic(binName: string, result: AndroidExecProbeResult): string {
  if (result.available) return ''
  const reason = result.reason ?? 'PROBE_FAILED'
  const consequence = reason === PLATFORM_EXEC_BLOCKED
    ? `bash, terminal, LSP, and subprocess tools will fail with ${PLATFORM_EXEC_BLOCKED}; `
      + 'model requests, the Web UI, and file tools remain available.'
    : 'exec-based tools may fail until the missing interpreter or probe condition is resolved; '
      + 'model requests, the Web UI, and file tools remain available.'
  return `${binName}: warning: Android exec probe failed (${reason}): ${result.detail ?? 'no detail'}\n`
    + `${binName}: warning: ${reason === PLATFORM_EXEC_BLOCKED ? androidExecGuidance() : consequence}\n`
    + `${binName}: warning: ${reason === PLATFORM_EXEC_BLOCKED ? consequence : 'Android W^X details are in the Android/Termux guide.'}`
}

/**
 * Classify a local spawn rejection that arrived despite the boot-time probe.
 * Android converts `EACCES`/`EPERM` to {@link PlatformExecBlockedError} so
 * consumers report the platform failure instead of a generic spawn error.
 * @param error - rejection from the platform spawn call.
 * @param program - program the caller asked to start.
 * @returns a typed platform error, or the original value for other errno values.
 */
export function androidSpawnFailure(error: unknown, program: string): unknown {
  const code = errnoCode(error)
  if (code !== 'EACCES' && code !== 'EPERM') return error
  const message = error instanceof Error ? error.message : String(error)
  return new PlatformExecBlockedError(androidExecBlockedMessage(program, `${code}: ${message}`), { cause: error })
}

/**
 * Owner-scoped probe cache. The first call starts the probe and every later
 * call returns the same settled result, so one boot performs at most one
 * spawn pair. Create one cache per application boot.
 */
export class AndroidExecProbe {
  private pending: Promise<AndroidExecProbeResult> | undefined
  private settledResult: AndroidExecProbeResult | undefined

  /** @param options - probe configuration forwarded to {@link probeAndroidExec}. */
  constructor(private readonly options: ProbeAndroidExecOptions = {}) {}

  /**
   * Run the probe once and cache its settled result.
   * @returns the first settled probe result.
   */
  async probe(): Promise<AndroidExecProbeResult> {
    if (this.settledResult !== undefined) return this.settledResult
    this.pending ??= probeAndroidExec(this.options)
    const result = await this.pending
    this.settledResult = result
    return result
  }

  /**
   * Read the cached result without starting a probe.
   * @returns the settled result, or undefined before the first probe settles.
   */
  get settled(): AndroidExecProbeResult | undefined {
    return this.settledResult
  }
}

/** One command a probe executes. */
interface ProbeCommand {
  readonly file: string
  readonly args: readonly string[]
}

/** Successful probe of one command. */
interface ProbeSuccess {
  readonly available: true
}

/** Failed probe of one command. */
interface ProbeFailure {
  readonly available: false
  readonly reason: AndroidExecFailureReason
  readonly detail: string
}

/** Outcome of probing one command. */
type ProbeOutcome = ProbeSuccess | ProbeFailure

/** Default launcher: Node's spawn, whose ChildProcess satisfies {@link AndroidExecChild}. */
const defaultSpawn: AndroidExecSpawn = (command, args, options) => spawn(command, args, options)

/**
 * Probe whether this Android process can start child executables.
 *
 * Both `execPath -e 0` and `shellPath -c true` start with ignored stdio under
 * the same bound. Non-Android hosts return available without starting a
 * process. Failures are classified by errno: `EACCES`/`EPERM` mean the
 * platform blocks exec (`PLATFORM_EXEC_BLOCKED`), `ENOENT` means the
 * interpreter is missing, and a timeout or nonzero exit is a diagnostic
 * condition. A child failure never rejects the probe.
 * @param options - platform, executables, spawner, bound, and environment overrides.
 * @returns the classified outcome; available only when both commands exit 0.
 * @throws Error when `timeoutMs` is not a positive finite number.
 */
export async function probeAndroidExec(options: ProbeAndroidExecOptions = {}): Promise<AndroidExecProbeResult> {
  const platform = options.platform ?? process.platform
  if (platform !== 'android') return availableResult()
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANDROID_EXEC_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`android-exec: timeoutMs must be a positive finite number, got ${String(timeoutMs)}`)
  }
  const spawnProbe = options.spawn ?? defaultSpawn
  const shellPath = options.shellPath ?? defaultShellPath(options.env ?? process.env)
  const commands: readonly ProbeCommand[] = [
    { file: options.execPath ?? process.execPath, args: ['-e', '0'] },
    { file: shellPath, args: ['-c', 'true'] },
  ]
  const outcomes = await Promise.all(commands.map(command => probeCommand(spawnProbe, command, timeoutMs)))
  const failures = outcomes.filter((outcome): outcome is ProbeFailure => !outcome.available)
  if (failures.length === 0) return availableResult()
  const reason = ANDROID_EXEC_FAILURE_REASONS.find(candidate => failures.some(failure => failure.reason === candidate))
    ?? 'PROBE_FAILED'
  return { available: false, reason, detail: failures.map(failure => failure.detail).join('; ') }
}

/**
 * Install the boot-time Android exec probe into a booting context.
 *
 * The settled result is published as `ctx.androidExec` before any config-tree
 * entry mounts, and one structured warning is logged when execution is
 * unavailable. `PLATFORM_EXEC_BLOCKED` terminates exec-based tool capability:
 * subprocess providers reject each spawn with a typed error while model
 * requests, the Web UI, and file tools stay available. A second call returns
 * the published result without starting another probe.
 * @param ctx - booting application context.
 * @param binName - application prefix on the startup warning.
 * @param options - probe override for tests.
 * @returns the probe result published on the context.
 */
export async function installAndroidExec(
  ctx: Context, binName: string, options: InstallAndroidExecOptions = {},
): Promise<AndroidExecProbeResult> {
  const published = ctx.get('androidExec')
  if (published !== undefined) return published
  const result = await (options.probe ?? new AndroidExecProbe()).probe()
  ctx.provide('androidExec', result)
  if (!result.available) {
    ctx.logger.warn(androidExecDiagnostic(binName, result), {
      available: result.available, reason: result.reason, detail: result.detail,
    })
  }
  return result
}

/**
 * Resolve the Termux shell path without assuming the environment.
 * @param env - environment whose `PREFIX` names the Termux installation root.
 * @returns `$PREFIX/bin/sh` when `PREFIX` is nonempty, else the Android platform shell.
 */
function defaultShellPath(env: NodeJS.ProcessEnv): string {
  const prefix = env.PREFIX
  return prefix === undefined || prefix.length === 0 ? '/system/bin/sh' : join(prefix, 'bin', 'sh')
}

/** @returns a fresh available result so callers cannot mutate a shared value. */
function availableResult(): AndroidExecProbeResult {
  return { available: true, reason: undefined, detail: undefined }
}

/**
 * Start one command and classify its first terminal event or bound.
 * @param spawnProbe - launcher for the probe child.
 * @param command - executable and arguments to start.
 * @param timeoutMs - bound before the child is killed and reported as a timeout.
 * @returns the command outcome; never rejects for a child event.
 */
function probeCommand(spawnProbe: AndroidExecSpawn, command: ProbeCommand, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: AndroidExecChild | undefined
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    try {
      child = spawnProbe(command.file, [...command.args], { stdio: 'ignore' })
    } catch (error) {
      finish(failedOutcome(command, error))
      return
    }
    timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch (_childAlreadyExited) {
        // The bound owns the result; a child that exited first cannot be killed again.
      }
      finish({
        available: false,
        reason: 'PROBE_TIMEOUT',
        detail: `${describeCommand(command)} did not exit within ${String(timeoutMs)}ms`,
      })
    }, timeoutMs)
    child.once('error', (error) => { finish(failedOutcome(command, error)) })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish({ available: true })
        return
      }
      finish({
        available: false,
        reason: 'PROBE_FAILED',
        detail: `${describeCommand(command)} exited with ${code === null ? String(signal) : String(code)}`,
      })
    })
  })
}

/**
 * Classify one spawn error by errno.
 * @param command - command that failed.
 * @param error - synchronous throw or the child's `error` event value.
 * @returns a failed outcome naming the command and platform detail.
 */
function failedOutcome(command: ProbeCommand, error: unknown): ProbeFailure {
  const code = errnoCode(error)
  const reason: AndroidExecFailureReason = code === 'EACCES' || code === 'EPERM'
    ? 'PLATFORM_EXEC_BLOCKED'
    : code === 'ENOENT' ? 'INTERPRETER_MISSING' : 'PROBE_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return { available: false, reason, detail: `${describeCommand(command)}: ${message}` }
}

/**
 * Read a Node errno code without asserting the error's runtime class.
 * @param error - arbitrary thrown or emitted value.
 * @returns the string `code` value, when present.
 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Render one command for a diagnostic without shell quoting.
 * @param command - executable and arguments.
 * @returns JSON-quoted arguments joined by spaces.
 */
function describeCommand(command: ProbeCommand): string {
  return [command.file, ...command.args].map(part => JSON.stringify(part)).join(' ')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Boot-time Android exec probe result; absent outside an application boot. */
    androidExec?: AndroidExecProbeResult
  }
}
