#!/usr/bin/env node
/**
 * Restore the Android require-builtin addon after an npm or pnpm install.
 *
 * `node-addon-require-builtin` has no Android platform package, so the CLI
 * package carries the bionic arm64 addon in `vendor/android-prebuilds`. This
 * lifecycle script copies the pinned bytes into the installed dependency's
 * `build/napi/napi-v9-android-arm64` directory. It is idempotent and a no-op
 * outside Android.
 *
 * The script is intentionally best-effort: a failed restore prints actionable
 * instructions and lets the install finish. `scripts/setup-android.sh
 * --check` and the CLI startup diagnostic fail loudly when the addon is still
 * missing, which covers `pnpm install --ignore-scripts`.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root of `@deepseek-ai/dsh`, derived from this script's location. */
const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** File names the installed addon loader resolves. */
const REQUIRED_FILE = 'require_builtin.node'
const TARGET_PARTS = ['build', 'napi', 'napi-v9-android-arm64', REQUIRED_FILE]

/** Package directories this script may find the staged payload in. */
const MANIFESTS = ['manifest.json', 'addons.manifest.json']

/**
 * Copy the pinned Android require-builtin addon into the installed dependency.
 * @param {{platform?: NodeJS.Platform, packageRoot?: string, sourceDirectory?: string}} [options]
 *   platform override for tests, CLI package root, and an explicit prebuilt directory.
 * @returns {Promise<{status: 'not-android' | 'current' | 'installed'}>} the action taken.
 * @throws When the payload, its manifest, or the dependency target cannot be resolved.
 */
export async function installAndroidAddons(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'android') return { status: 'not-android' }

  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT
  const source = await findSourceDirectory(packageRoot, options.sourceDirectory)
  if (source === undefined) {
    throw new Error(
      'the Android prebuilt payload is missing; restore it from the package tarball '
      + `(expected ${join(packageRoot, 'vendor', 'android-prebuilds', REQUIRED_FILE)})`,
    )
  }
  const manifestPath = MANIFESTS.map(name => join(source, name)).find(path => existsSync(path))
  if (manifestPath === undefined) {
    throw new Error(`the Android prebuilt manifest is missing in ${source}`)
  }
  const manifest = await readManifest(manifestPath, REQUIRED_FILE)
  const sourceFile = join(source, REQUIRED_FILE)
  const content = await readFile(sourceFile)
  if (content.byteLength !== manifest.size) {
    throw new Error(
      `${sourceFile} is ${content.byteLength} bytes but the manifest records ${manifest.size}; `
      + restoreHint(packageRoot),
    )
  }
  if (sha256(content) !== manifest.sha256) {
    throw new Error(`${sourceFile} does not match its pinned SHA-256; ${restoreHint(packageRoot)}`)
  }

  const packageDirectory = await resolveRequireBuiltinDirectory(packageRoot)
  const target = join(packageDirectory, ...TARGET_PARTS)
  if (await sameContent(target, manifest.sha256)) return { status: 'current' }

  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${createHash('sha256').update(content).digest('hex').slice(0, 8)}.tmp`
  try {
    await copyFile(sourceFile, temporary)
    await chmod(temporary, 0o755)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { status: 'installed' }
}

/**
 * Locate the prebuilt directory: the package's staged copy first, then a source checkout's vendor tree.
 * @param {string} packageRoot - CLI package root.
 * @param {string | undefined} explicit - caller-supplied directory.
 * @returns {Promise<string | undefined>} the directory containing the addon and a manifest.
 */
async function findSourceDirectory(packageRoot, explicit) {
  const candidates = explicit === undefined
    ? [join(packageRoot, 'vendor', 'android-prebuilds'), resolve(packageRoot, '..', '..', 'vendor', 'android-prebuilds')]
    : [explicit]
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, REQUIRED_FILE))) continue
    if (MANIFESTS.some(name => existsSync(join(candidate, name)))) return candidate
  }
  return undefined
}

/**
 * Read the size and hash pinned for one file.
 * @param {string} path - manifest file.
 * @param {string} name - expected file name.
 * @returns {Promise<{size: number, sha256: string}>} the validated entry.
 */
async function readManifest(path, name) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  const entry = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value.files?.[name]
    : undefined
  if (entry === undefined || typeof entry.size !== 'number' || typeof entry.sha256 !== 'string') {
    throw new Error(`${path} has no valid ${name} size and SHA-256 entry`)
  }
  return { size: entry.size, sha256: entry.sha256 }
}

/**
 * Resolve the installed `node-addon-require-builtin` package directory.
 * @param {string} packageRoot - CLI package root.
 * @returns {Promise<string>} the dependency's package directory.
 * @throws When Node cannot resolve the dependency package.
 */
async function resolveRequireBuiltinDirectory(packageRoot) {
  const require = createRequire(join(packageRoot, 'package.json'))
  let directory
  try {
    directory = dirname(require.resolve('node-addon-require-builtin/package.json'))
  } catch (packageJsonError) {
    // The package's exports may hide package.json; walk up from its entry point instead.
    let entry
    try {
      entry = require.resolve('node-addon-require-builtin')
    } catch (entryError) {
      throw new Error(
        `node-addon-require-builtin is not installed for ${packageRoot}; run an install with lifecycle scripts enabled`,
        { cause: entryError },
      )
    }
    directory = await packageDirectoryOf(entry, packageJsonError)
  }
  return directory
}

/**
 * Walk up from a resolved entry until a manifest names `node-addon-require-builtin`.
 * @param {string} entry - resolved module file.
 * @param {unknown} cause - the package.json resolution failure to retain on failure.
 * @returns {Promise<string>} the package directory.
 */
async function packageDirectoryOf(entry, cause) {
  let directory = dirname(entry)
  while (directory !== dirname(directory)) {
    try {
      const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (value.name === 'node-addon-require-builtin') return directory
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  throw new Error(`could not locate the node-addon-require-builtin package above ${entry}`, { cause })
}

/**
 * Whether a target already holds the pinned bytes.
 * @param {string} path - target addon path.
 * @param {string} expected - expected SHA-256.
 * @returns {Promise<boolean>} whether the file exists with that hash.
 */
async function sameContent(path, expected) {
  try {
    if (!(await stat(path)).isFile()) return false
    return sha256(await readFile(path)) === expected
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Hash bytes with SHA-256.
 * @param {Buffer} content - file content.
 * @returns {string} lowercase hexadecimal digest.
 */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Actionable restore instruction for the current installation shape.
 * @param {string} packageRoot - CLI package root.
 * @returns {string} a command the user can run.
 */
function restoreHint(packageRoot) {
  return existsSync(join(packageRoot, '..', '..', 'scripts', 'setup-android.sh'))
    ? 'run `sh scripts/setup-android.sh` from the repository root'
    : 'run `npm rebuild @deepseek-ai/dsh` without `--ignore-scripts`'
}

if (import.meta.main) {
  try {
    const result = await installAndroidAddons()
    if (result.status === 'installed') console.log('dsh: restored the Android require-builtin addon')
  } catch (error) {
    console.warn(`dsh: warning: could not restore the Android require-builtin addon: ${error instanceof Error ? error.message : String(error)}`)
    console.warn('dsh: warning: DSH cannot start on Android until it is restored; rerun the command above.')
  }
}
