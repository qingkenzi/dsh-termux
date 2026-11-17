/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; flock uses stable Node-API with separate Linux libc builds.
 * Node headers come from the Node installation running this script.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { 'host-addon-only': { type: 'boolean' } }, allowPositionals: false })
const hostAddonOnly = values['host-addon-only'] === true
const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  flock: 'packages/entry/src/flock.c',
}

interface Binary {
  tool: string
  kind: string
  path: string
  napi?: number
  libc?: string
}

/**
 * Compile the Android flock addon into the entry package.
 *
 * Termux reports `android` on bionic libc, and no platform package carries a
 * binary for it, so the addon lives beside the entry that loads it. Node-API is
 * ABI-stable, so the same source and flags as the Linux build apply.
 * @param headers - Node-API header directory from the running Node installation.
 */
function buildAndroidFlock(headers: string): void {
  const output = join(root, 'packages/entry/bin/bionic/system.node')
  if (!existsSync(join(headers, 'node_api.h'))) {
    throw new Error(`build: Node-API headers missing at ${headers}; install the Node development headers for this Termux nodejs package`)
  }
  mkdirSync(join(root, '.release'), { recursive: true })
  const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
  try {
    const pending = join(temporary, 'system.node')
    const result = spawnSync('cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden',
      '-DNAPI_VERSION=8', '-I', headers, '-shared', '-o', pending,
      join(root, 'packages/entry/src/flock.c'),
    ], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('build: cc failed for the Android flock addon')
    mkdirSync(dirname(output), { recursive: true })
    renameSync(pending, output)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  // A binary that cannot register here would only fail the first session write.
  createRequire(import.meta.url)(output)
  console.log('build: built entry/bin/bionic/system.node')
}

if (process.platform === 'android') {
  const headers = resolve(dirname(process.execPath), '../include/node')
  buildAndroidFlock(headers)
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
