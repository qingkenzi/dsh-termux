/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; the Android package carries the bionic flock addon and the
 * android-sandbox-run seccomp supervisor; flock uses stable Node-API with
 * separate Linux libc builds. Node headers come from the Node installation
 * running this script.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { 'host-addon-only': { type: 'boolean' } }, allowPositionals: false })
const hostAddonOnly = values['host-addon-only'] === true
const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  'android-sandbox': 'packages/entry/src/android-sandbox.c',
  flock: 'packages/entry/src/flock.c',
}

interface Binary {
  tool: string
  kind: string
  path: string
  napi?: number
  libc?: string
}

/** ELF `PT_LOAD` program-header type. */
const ELF_PT_LOAD = 1
/** Android 16 KB page devices require each loadable segment aligned to at least 0x4000. */
const ANDROID_LOAD_ALIGN = 0x4000

/**
 * Read the `p_align` of every ELF64 `PT_LOAD` program header.
 * @param file - Little-endian ELF64 binary to inspect.
 * @returns One alignment value per loadable segment.
 */
function loadSegmentAlignments(file: string): number[] {
  const data = readFileSync(file)
  if (data.length < 64 || data.readUInt32LE(0) !== 0x464c457f || data[4] !== 2 || data[5] !== 1) {
    throw new Error(`build: ${file} is not a little-endian ELF64 binary`)
  }
  const programHeaders = Number(data.readBigUInt64LE(32))
  const entrySize = data.readUInt16LE(54)
  const entryCount = data.readUInt16LE(56)
  if (entrySize < 56 || programHeaders === 0 || programHeaders + entryCount * entrySize > data.length) {
    throw new Error(`build: ${file} has truncated ELF program headers`)
  }
  const alignments: number[] = []
  for (let index = 0; index < entryCount; index++) {
    const offset = programHeaders + index * entrySize
    if (data.readUInt32LE(offset) === ELF_PT_LOAD) alignments.push(Number(data.readBigUInt64LE(offset + 48)))
  }
  return alignments
}

/**
 * Reject a compiled Android addon that cannot load on a 16 KB page device.
 * @param file - Compiled addon to inspect.
 */
function verifyAndroidLoadAlignment(file: string): void {
  const alignments = loadSegmentAlignments(file)
  if (alignments.length === 0) throw new Error(`build: ${file} has no PT_LOAD program headers`)
  const smallest = Math.min(...alignments)
  if (smallest < ANDROID_LOAD_ALIGN) {
    throw new Error(`build: ${file} has a PT_LOAD segment aligned to 0x${smallest.toString(16)}; `
      + `Android 16 KB page devices require 0x${ANDROID_LOAD_ALIGN.toString(16)} or greater`)
  }
}

/**
 * Compile the Android payloads into the platform package: the bionic flock
 * addon (also copied to the entry package for source-only checkouts and
 * `scripts/setup-android.sh`) and the android-sandbox-run seccomp supervisor.
 *
 * Termux reports `android` on bionic libc, so the addon has no glibc/musl
 * variant and lives at a fixed `bionic/` path. The supervisor is a dynamically
 * linked PIE executable, which is what Android loads; both artifacts pin the
 * linker page size and are verified for 16 KB page devices. Node-API is
 * ABI-stable, so the addon source and flags match the Linux build. Android has
 * no other native target, so `--host-addon-only` and a full build produce the
 * same payloads.
 * @param headers - Node-API header directory from the running Node installation.
 */
function buildAndroidBinaries(headers: string): void {
  const spec = JSON.parse(readFileSync(join(root, 'packages/android-arm64/prebuilds.json'), 'utf8')) as {
    binaries: Binary[]
  }
  const addon = spec.binaries.find((candidate) => (
    candidate.kind === 'node-api' && candidate.tool === 'flock' && candidate.napi === 8
  ))
  if (addon === undefined) {
    throw new Error('build: packages/android-arm64/prebuilds.json declares no Node-API v8 flock addon')
  }
  const addonSource = sources[addon.tool]
  if (addonSource === undefined) throw new Error(`build: unknown tool ${addon.tool}`)
  if (!existsSync(join(headers, 'node_api.h'))) {
    throw new Error(`build: Node-API headers missing at ${headers}; install the Node development headers for this Termux nodejs package`)
  }
  const addonOutput = join(root, 'packages/android-arm64', addon.path)
  const entryCopy = join(root, 'packages/entry/bin/bionic/system.node')
  mkdirSync(join(root, '.release'), { recursive: true })
  const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
  try {
    const pending = join(temporary, 'system.node')
    const result = spawnSync('cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden',
      '-DNAPI_VERSION=8', '-I', headers, '-shared', '-Wl,-z,max-page-size=16384', '-o', pending,
      join(root, addonSource),
    ], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('build: cc failed for the Android flock addon')
    verifyAndroidLoadAlignment(pending)
    mkdirSync(dirname(addonOutput), { recursive: true })
    mkdirSync(dirname(entryCopy), { recursive: true })
    copyFileSync(pending, addonOutput)
    copyFileSync(pending, entryCopy)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  // A binary that cannot register here would only fail the first session write.
  createRequire(import.meta.url)(addonOutput)
  console.log(`build: verified 16 KB page alignment and built packages/android-arm64/${addon.path}`)
  console.log('build: built entry/bin/bionic/system.node as the source-compatible copy')

  const runner = spec.binaries.find((candidate) => (
    candidate.kind === 'bionic-executable' && candidate.tool === 'android-sandbox'
  ))
  if (runner === undefined) {
    throw new Error('build: packages/android-arm64/prebuilds.json declares no bionic android-sandbox executable')
  }
  const runnerSource = sources[runner.tool]
  if (runnerSource === undefined) throw new Error(`build: unknown tool ${runner.tool}`)
  const runnerOutput = join(root, 'packages/android-arm64', runner.path)
  mkdirSync(join(root, '.release'), { recursive: true })
  const runnerTemporary = mkdtempSync(join(root, '.release', 'native-build-'))
  try {
    const pending = join(runnerTemporary, 'android-sandbox-run')
    const result = spawnSync('cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
      '-Wl,-z,max-page-size=16384', '-o', pending, join(root, runnerSource),
    ], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('build: cc failed for the Android seccomp supervisor')
    verifyAndroidLoadAlignment(pending)
    mkdirSync(dirname(runnerOutput), { recursive: true })
    renameSync(pending, runnerOutput)
  } finally {
    rmSync(runnerTemporary, { recursive: true, force: true })
  }
  console.log(`build: verified 16 KB page alignment and built packages/android-arm64/${runner.path}`)
}

if (process.platform === 'android') {
  const headers = resolve(dirname(process.execPath), '../include/node')
  buildAndroidBinaries(headers)
  process.exit(0)
}

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  if (hostAddonOnly) process.exit(0)
  throw new Error('build: system binaries are built on Linux or macOS; no native target for this host')
}
const host = `${process.platform}-${process.arch}`
const libc = process.platform === 'linux'
  ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
  : undefined
const headers = resolve(dirname(process.execPath), '../include/node')
let built = 0

for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name)
  const metadata = join(dir, 'prebuilds.json')
  if (!existsSync(metadata)) continue
  const spec = JSON.parse(readFileSync(metadata, 'utf8')) as { platform: string; binaries: Binary[] }
  if (spec.platform !== host) continue

  for (const binary of spec.binaries) {
    if (hostAddonOnly && (binary.kind !== 'node-api' || (binary.libc !== undefined && binary.libc !== libc))) continue
    const source = sources[binary.tool]
    if (source === undefined) throw new Error(`build: unknown tool ${binary.tool}`)
    const output = join(dir, binary.path)
    mkdirSync(dirname(output), { recursive: true })
    let compiler: string
    let flags: string[]

    if (binary.kind === 'static-musl' && process.platform === 'linux' && binary.tool === 'landlock-run') {
      compiler = 'musl-gcc'
      flags = ['-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-static', '-s']
    } else if (binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8) {
      if (!existsSync(join(headers, 'node_api.h'))) {
        throw new Error(`build: Node-API headers missing at ${headers}; use a Node installation with development headers`)
      }
      compiler = process.platform === 'linux' && binary.libc === 'musl' ? 'musl-gcc' : 'cc'
      flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', headers]
      if (process.platform === 'darwin') {
        if (binary.libc !== undefined) throw new Error('build: macOS flock does not select a Linux libc')
        flags.push('-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0')
      } else {
        if (binary.libc !== 'glibc' && binary.libc !== 'musl') {
          throw new Error('build: Linux flock must select glibc or musl')
        }
        flags.push('-shared')
      }
    } else {
      throw new Error(`build: unsupported ${binary.tool}/${binary.kind} target on ${host}`)
    }

    mkdirSync(join(root, '.release'), { recursive: true })
    const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
    try {
      const pending = join(temporary, basename(output))
      const result = spawnSync(compiler, [...flags, '-o', pending, join(root, source)], { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`build: ${compiler} failed for ${binary.path}`)
      // Readers never see a truncated addon when source checks build concurrently.
      renameSync(pending, output)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    console.log(`build: built ${basename(dir)}/${binary.path}`)
    built++
  }
}
if (built === 0) throw new Error(`build: no declared binaries for ${host}`)
