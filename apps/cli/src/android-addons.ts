/**
 * Android native prerequisites the CLI launcher prepares before profile boot.
 *
 * `util-ripgrep` caches its first resolution for the process lifetime, so the
 * launcher must publish the packaged ripgrep path before any profile module
 * imports it. The same bootstrap checks the require-builtin addon that the
 * package postinstall restores; `pnpm install --ignore-scripts` skips that
 * lifecycle script, so a missing addon is reported with a restore command
 * instead of surfacing only as a loader failure.
 * @module @deepseek-ai/dsh/android-addons
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** CLI package root, resolved from the module location in both source and built layouts. */
const CLI_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Installed addon locations the native loader probes for Android arm64. */
const REQUIRE_BUILTIN_PARTS = ['build', 'napi', 'napi-v9-android-arm64', 'require_builtin.node']

/** Dependencies the launcher can supply to keep preparation testable. */
export interface PrepareAndroidAddonsOptions {
  /** Platform override for tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** CLI package root holding `vendor/android-prebuilds`; defaults to this package. */
  readonly packageRoot?: string
  /** Environment to update; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Diagnostic sink; defaults to stderr. */
  readonly warn?: (message: string) => void
}

/** Outcome of Android preparation. */
export interface PreparedAndroidAddons {
  /** Bundled ripgrep published through `DSH_RG_PATH`, when one was found. */
  readonly rgPath?: string
  /** Actionable problems; empty on non-Android hosts and healthy installations. */
  readonly problems: readonly string[]
}

/**
 * Publish the bundled Android ripgrep and check the require-builtin addon.
 *
 * On non-Android hosts this function reads no files, loads no native code, and
 * changes no environment value. An explicit `DSH_RG_PATH` is never overwritten.
 * @param options - platform, package root, environment, and diagnostic sink overrides.
 * @returns the ripgrep path that was published and any actionable problems.
 */
export function prepareAndroidAddons(options: PrepareAndroidAddonsOptions = {}): PreparedAndroidAddons {
  const platform = options.platform ?? process.platform
  if (platform !== 'android') return { problems: [] }
  const packageRoot = options.packageRoot ?? CLI_PACKAGE_ROOT
  const env = options.env ?? process.env
  const problems: string[] = []

  const rgPath = bundledRipgrep(packageRoot)
  if (rgPath !== undefined && env.DSH_RG_PATH === undefined) env.DSH_RG_PATH = rgPath

  const addonProblem = requireBuiltinProblem(packageRoot)
  if (addonProblem !== undefined) {
    problems.push(addonProblem)
    const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
    warn(addonProblem)
  }

  return { ...(rgPath === undefined ? {} : { rgPath }), problems }
}

/**
 * Find the Android ripgrep shipped by the package or beside a source checkout.
 * @param packageRoot - CLI package root.
 * @returns the executable path when present.
 */
function bundledRipgrep(packageRoot: string): string | undefined {
  for (const candidate of [
    join(packageRoot, 'vendor', 'android-prebuilds', 'rg'),
    join(packageRoot, '..', '..', 'vendor', 'android-prebuilds', 'rg'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Check the install location the resolver later loads and describe a missing addon.
 * @param packageRoot - CLI package root.
 * @returns an actionable multi-line diagnostic, or undefined when the addon exists.
 */
function requireBuiltinProblem(packageRoot: string): string | undefined {
  try {
    const require = createRequire(join(packageRoot, 'package.json'))
    const installed = dirname(require.resolve('node-addon-require-builtin/package.json'))
    const addon = join(installed, ...REQUIRE_BUILTIN_PARTS)
    if (existsSync(addon)) return undefined
    return missingAddonReport(addon, packageRoot)
  } catch (error) {
    return `dsh: Android require-builtin addon cannot be resolved from ${packageRoot}: ${error instanceof Error ? error.message : String(error)}\n`
      + restoreInstructions(packageRoot)
  }
}

/**
 * Render the missing-addon diagnostic for an installed dependency that lacks its Android binary.
 * @param addon - expected addon path.
 * @param packageRoot - CLI package root used to choose the source-checkout instruction.
 * @returns a multi-line diagnostic.
 */
function missingAddonReport(addon: string, packageRoot: string): string {
  return `dsh: Android require-builtin addon is missing at ${addon}.\n`
    + restoreInstructions(packageRoot)
}

/**
 * Explain how to restore the addon for this installation shape.
 * @param packageRoot - CLI package root.
 * @returns a multi-line restore instruction.
 */
function restoreInstructions(packageRoot: string): string {
  const sourceCheckout = existsSync(join(packageRoot, '..', '..', 'scripts', 'setup-android.sh'))
  return 'dsh: The package postinstall restores it; `pnpm install --ignore-scripts` skips lifecycle scripts.\n'
    + (sourceCheckout
      ? 'dsh: Run `sh scripts/setup-android.sh` from the repository root to restore it.\n'
      : 'dsh: Run `npm rebuild @deepseek-ai/dsh` without `--ignore-scripts` to restore it.\n')
}
