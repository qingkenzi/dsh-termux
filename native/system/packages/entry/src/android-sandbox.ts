/**
 * The JavaScript API over the prebuilt `android-sandbox-run` seccomp
 * supervisor: resolve the binary for this host, build its grant argv, and run
 * its functional probe.
 *
 * This module owns the supervisor's CLI contract so consumers never spell its
 * flags themselves. Policy stays with the consumer: this package does not know
 * what a "sandbox mode" is, only which mode and roots one confined run grants.
 *
 * Deliberately no environment-variable overrides: which binary confines a
 * process must never be decidable by the ambient environment. Test injection is
 * by function parameter.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The supervisor binary's file name inside each platform package's `bin/`. */
export const ANDROID_SANDBOX_BIN = 'android-sandbox-run'

/**
 * The exit code for every supervisor-level failure (usage error, seccomp
 * setup, failed exec). After a successful `exec` the wrapped command may also
 * return 125, so consumers require a matching `android-sandbox-run: ` fatal
 * line to attribute supervisor failure. Part of the CLI contract.
 */
export const ANDROID_SANDBOX_FAILURE_EXIT = 125

/**
 * The probe's verdict on this host: `partial` when the kernel delivers a
 * user-notification listener and reports `Seccomp: 2`, `unusable` otherwise.
 * The supervisor is never a full boundary — it mediates the documented write
 * syscalls, not every file effect — so a passing probe reports `partial`.
 */
export type AndroidSandboxEnforcement = 'partial' | 'unusable'

/** File-effect grants for one confined run. */
export interface AndroidSandboxGrants {
  /** `read-only` grants no write root beyond the required `/dev/null` sink. */
  readonly mode: 'read-only' | 'workspace-write'
  /** Canonical absolute root `workspace-write` may write under. */
  readonly workspaceRoot: string
  /** Canonical absolute temp root `workspace-write` may write under. */
  readonly tempRoot: string
}

/**
 * Path of the supervisor binary for this host, resolved from the per-platform
 * npm package `@deepseek-ai/node-addon-system-<platform>-<arch>`. The fallback
 * points inside this package's own `node_modules` and never exists; existence
 * is deliberately not checked here because {@link probeAndroidSandbox} is the
 * single availability signal.
 * @param resolvePackageJson - test hook over `require.resolve` (the default
 *   covers real installs); receives the platform package's `package.json`
 *   specifier and returns its absolute path, throwing when unresolvable.
 * @returns the absolute supervisor path to probe and exec.
 */
export function androidSandboxRunnerPath(
  resolvePackageJson: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string {
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`
  try {
    return join(dirname(resolvePackageJson(`${platformPackage}/package.json`)), 'bin', ANDROID_SANDBOX_BIN)
  } catch {
    // Unresolvable platform package: fall back to the path pnpm's layout WOULD
    // use — absolute and inside this package's boundary, never cwd-relative.
    return fileURLToPath(new URL(`../node_modules/${platformPackage}/bin/${ANDROID_SANDBOX_BIN}`, import.meta.url))
  }
}

/**
 * The supervisor arguments for one set of grants — everything before the `--`
 * argv separator. A caller spawns `[runnerPath(), ...grantArgs, '--', ...argv]`.
 * @param grants - the mode and the canonical roots it may write under.
 * @returns the `--workspace`, `--tmp`, and `--mode` argument list.
 */
export function androidSandboxArgs(grants: AndroidSandboxGrants): string[] {
  return ['--workspace', grants.workspaceRoot, '--tmp', grants.tempRoot, '--mode', grants.mode]
}

/**
 * Functional probe: `android-sandbox-run --probe` forks a filtered child,
 * requires the kernel to deliver a user-notification listener, reads
 * `Seccomp: 2` from the child, and verifies that a write outside the granted
 * set is actually denied. A missing binary, an unenforcing kernel, or a broken
 * supervisor probes `unusable`. Synchronous by design: consumers run it once
 * and cache the verdict.
 * @param runner - the supervisor path to probe; defaults to
 *   {@link androidSandboxRunnerPath}'s resolution for this host.
 * @param options - `timeoutMs` bounds the probe child (default 2000).
 * @returns `partial` for a verified supervisor, otherwise `unusable`.
 */
export function probeAndroidSandbox(
  runner: string = androidSandboxRunnerPath(),
  options: { timeoutMs?: number } = {},
): AndroidSandboxEnforcement {
  if (!existsSync(runner)) return 'unusable'
  const result = spawnSync(runner, ['--probe'], {
    timeout: options.timeoutMs ?? 2000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return 'unusable'
  return /Seccomp: 2/.test(result.stdout) ? 'partial' : 'unusable'
}
