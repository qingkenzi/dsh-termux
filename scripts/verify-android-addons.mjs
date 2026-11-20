#!/usr/bin/env node
/**
 * Verify every Android-arm64 native addon and the bundled ripgrep.
 *
 * The checks load the same binaries the runtime loads: the require-builtin
 * addon, the flock addon acquired through a temporary file descriptor, sharp
 * (including its libvips versions), and the vendored ripgrep version. Every
 * `.node` file and the `rg` executable must also keep ELF `LOAD` segments
 * aligned for 16 KB-page Android devices.
 *
 * Source checkouts run this through `pnpm run verify:android`; other hosts exit
 * successfully without touching any file.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root, resolved from this script rather than the invoking directory. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Android 16 KB-page devices require every ELF LOAD segment to be aligned this much. */
const MIN_LOAD_ALIGN = 0x4000n

/** Portable binary inspection comes from binutils in Termux. */
const READELF_HINT = 'pkg install binutils'

/** Collected failure messages; the process exits nonzero when any remain. */
const failures = []
/** Absolute ELF paths discovered by the runtime checks. */
const elfPaths = new Set()

if (process.platform !== 'android') {
  console.log(`verify-android-addons: skipped (${process.platform}/${process.arch}); the checks target Android`)
  process.exit(0)
}

/**
 * Run one named check and record its result.
 * @param {string} label - user-facing check name.
 * @param {() => Promise<string> | string} action - check body returning evidence text.
 * @returns {Promise<void>}
 */
async function check(label, action) {
  try {
    const evidence = await action()
    console.log(`ok   ${label}${evidence ? `: ${evidence}` : ''}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${label}: ${message}`)
    console.error(`FAIL ${label}: ${message}`)
  }
}

/**
 * Resolve a dependency's package directory from the package that depends on it.
 * @param {NodeRequire} require - module resolver anchored at the dependent package.
 * @param {string} specifier - resolvable subpath of the dependency.
 * @param {string} name - dependency package name.
 * @returns {Promise<string>} the dependency's package directory.
 */
async function dependencyDirectory(require, specifier, name) {
  let directory = dirname(require.resolve(specifier))
  while (directory !== dirname(directory)) {
    try {
      const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (value.name === name) return directory
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  throw new Error(`cannot locate the ${name} package directory above ${directory}`)
}

/**
 * SHA-256 of a file, formatted for diagnostics.
 * @param {string} path - file to hash.
 * @returns {Promise<string>} lowercase hexadecimal digest.
 */
async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

await check('require-builtin addon loads and exports', () => {
  const require = createRequire(join(ROOT, 'apps', 'cli', 'package.json'))
  const addon = require('node-addon-require-builtin')
  for (const method of ['requireBuiltin', 'isAllowedInternalId', 'getBindingInfo']) {
    if (typeof addon[method] !== 'function') throw new Error(`node-addon-require-builtin exports no ${method}()`)
  }
  const binding = addon.getBindingInfo()
  if (typeof binding?.bindingPath !== 'string') throw new Error('getBindingInfo() returned no bindingPath')
  const loader = addon.requireBuiltin('internal/modules/cjs/loader')
  if (typeof loader?.Module !== 'function') throw new Error('requireBuiltin() did not return the CommonJS loader')
  elfPaths.add(binding.bindingPath)
  return binding.bindingPath
})

await check('flock addon tryLock', async () => {
  const require = createRequire(join(ROOT, 'packages', 'session', 'session-persistence-jsonl', 'package.json'))
  const entry = require.resolve('@deepseek-ai/node-addon-system/flock')
  const { tryLockExclusive } = await import(pathToFileURL(entry).href)
  if (typeof tryLockExclusive !== 'function') throw new Error('the flock entry exports no tryLockExclusive()')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-verify-flock-'))
  try {
    const file = join(directory, 'lock')
    const first = openSync(file, 'a+')
    try {
      await tryLockExclusive(first)
      const second = openSync(file, 'a+')
      try {
        let acquired = false
        try {
          await tryLockExclusive(second)
          acquired = true
        } catch (error) {
          if (error?.code !== 'EAGAIN') throw error
        }
        if (acquired) throw new Error('a second descriptor acquired the exclusive lock')
      } finally {
        closeSync(second)
      }
    } finally {
      closeSync(first)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const packageDirectory = await dependencyDirectory(require, '@deepseek-ai/node-addon-system/flock', '@deepseek-ai/node-addon-system')
  const entryAddon = join(packageDirectory, 'bin', 'bionic', 'system.node')
  await stat(entryAddon)
  elfPaths.add(entryAddon)
  const entryRequire = createRequire(join(packageDirectory, 'package.json'))
  let loaded = entryAddon
  try {
    const platformManifest = entryRequire.resolve('@deepseek-ai/node-addon-system-android-arm64/package.json')
    const platformAddon = join(dirname(platformManifest), 'bin', 'bionic', 'system.node')
    await stat(platformAddon)
    elfPaths.add(platformAddon)
    loaded = platformAddon
  } catch (error) {
    // The published platform package is optional in source-only builds.
    if (error?.code !== 'MODULE_NOT_FOUND') throw error
  }
  return `exclusive lock acquired; contention rejected with EAGAIN (${loaded})`
})

await check('sharp addon', async () => {
  const require = createRequire(join(ROOT, 'packages', 'attachment', 'attachment-local', 'package.json'))
  const sharp = require('sharp')
  if (typeof sharp.versions?.sharp !== 'string' || typeof sharp.versions?.vips !== 'string') {
    throw new Error('require("sharp").versions exposes no sharp and vips versions')
  }
  const packageDirectory = await dependencyDirectory(require, 'sharp', 'sharp')
  const releaseDirectory = join(packageDirectory, 'src', 'build', 'Release')
  const addons = (await readdir(releaseDirectory)).filter(name => name.endsWith('.node'))
  if (addons.length === 0) throw new Error(`no sharp addon under ${releaseDirectory}`)
  for (const name of addons) elfPaths.add(join(releaseDirectory, name))
  return `sharp ${sharp.versions.sharp}, vips ${sharp.versions.vips} (${addons.join(', ')})`
})

await check('bundled ripgrep', async () => {
  const vendor = join(ROOT, 'vendor', 'android-prebuilds')
  const manifest = JSON.parse(await readFile(join(vendor, 'rg.manifest.json'), 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error('rg.manifest.json records no version')
  const executable = join(vendor, 'rg')
  const info = await stat(executable)
  if (!info.isFile()) throw new Error(`${executable} is not a file`)
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  if (result.error !== undefined) throw new Error(`cannot run ${executable}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${executable} --version exited ${String(result.status)}: ${result.stderr.trim()}`)
  const firstLine = result.stdout.split('\n')[0]?.trim() ?? ''
  if (!firstLine.startsWith(`ripgrep ${manifest.version}`)) {
    throw new Error(`${executable} reports ${JSON.stringify(firstLine)}; manifest pins ripgrep ${manifest.version}`)
  }
  if (await sha256(executable) !== manifest.sha256) throw new Error(`${executable} does not match rg.manifest.json SHA-256`)
  elfPaths.add(executable)
  return firstLine
})

await check('ELF LOAD alignment for every Android binary', async () => {
  const readelf = spawnSync('readelf', ['--version'], { encoding: 'utf8' })
  if (readelf.error !== undefined) throw new Error(`readelf is unavailable (${READELF_HINT}): ${readelf.error.message}`)
  if (elfPaths.size === 0) throw new Error('no Android binaries were discovered by the runtime checks')
  const checked = []
  for (const path of [...elfPaths].sort()) {
    const result = spawnSync('readelf', ['-lW', path], { encoding: 'utf8' })
    if (result.error !== undefined) throw new Error(`cannot run readelf on ${path}: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`readelf failed on ${path}: ${result.stderr.trim()}`)
    const aligns = result.stdout.split('\n')
      .map(line => line.trim().split(/\s+/u))
      .filter(fields => fields[0] === 'LOAD')
      .map(fields => fields.at(-1))
    if (aligns.length === 0) throw new Error(`${path} has no ELF LOAD segments`)
    for (const align of aligns) {
      if (align === undefined || !/^0x[0-9a-f]+$/iu.test(align)) throw new Error(`${path} has an unparseable LOAD alignment ${String(align)}`)
      if (BigInt(align) < MIN_LOAD_ALIGN) throw new Error(`${path} LOAD alignment ${align} is below 0x4000`)
    }
    checked.push(path)
  }
  return `${checked.length} binaries with LOAD alignment >= 0x4000`
})

if (failures.length > 0) {
  console.error(`verify-android-addons: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('verify-android-addons: all Android checks passed')
