import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installAndroidAddons } from '../scripts/install-android-addons.mjs'

const roots: string[] = []

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-install-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Fixture {
  readonly packageRoot: string
  readonly sourceDirectory: string
  readonly target: string
  readonly payload: Buffer
}

/**
 * Build a package fixture with a fake installed require-builtin dependency and
 * one staged prebuilt, so the script never touches the workspace node_modules.
 */
async function fixture(options: { readonly manifestSha?: string; readonly payload?: Buffer } = {}): Promise<Fixture> {
  const root = await temporary()
  const packageRoot = join(root, 'package')
  const dependency = join(packageRoot, 'node_modules', 'node-addon-require-builtin')
  const payload = options.payload ?? Buffer.from('android arm64 require-builtin bytes')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  await mkdir(join(dependency, 'build', 'napi', 'napi-v9-android-arm64'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'dsh-fixture' })}\n`)
  await writeFile(join(dependency, 'package.json'), `${JSON.stringify({
    name: 'node-addon-require-builtin',
    version: '0.1.9',
    exports: { './package.json': './package.json' },
  })}\n`)
  const sourceDirectory = join(packageRoot, 'vendor', 'android-prebuilds')
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, 'require_builtin.node'), payload)
  await writeFile(join(sourceDirectory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    target: 'aarch64-linux-android',
    algorithm: 'sha256',
    files: { 'require_builtin.node': { size: payload.byteLength, sha256: options.manifestSha ?? sha256 } },
  })}\n`)
  return {
    packageRoot,
    sourceDirectory,
    target: join(dependency, 'build', 'napi', 'napi-v9-android-arm64', 'require_builtin.node'),
    payload,
  }
}

describe('Android postinstall restore', () => {
  it('installs the pinned addon atomically and is idempotent', async () => {
    const { packageRoot, target, payload } = await fixture()

    await expect(installAndroidAddons({ platform: 'android', packageRoot })).resolves.toEqual({ status: 'installed' })
    expect(await readFile(target)).toEqual(payload)
    expect((await stat(target)).mode & 0o111).not.toBe(0)
    expect(await readdir(join(target, '..'))).toEqual(['require_builtin.node'])

    await expect(installAndroidAddons({ platform: 'android', packageRoot })).resolves.toEqual({ status: 'current' })
    expect(await readFile(target)).toEqual(payload)
  })

  it('falls back to a source checkout vendor directory', async () => {
    const root = await temporary()
    const packageRoot = join(root, 'apps', 'cli')
    const dependency = join(packageRoot, 'node_modules', 'node-addon-require-builtin')
    const payload = Buffer.from('source checkout addon')
    const sourceDirectory = join(root, 'vendor', 'android-prebuilds')
    await mkdir(join(dependency, 'build', 'napi', 'napi-v9-android-arm64'), { recursive: true })
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{}\n')
    await writeFile(join(dependency, 'package.json'), `${JSON.stringify({
      name: 'node-addon-require-builtin',
      exports: { './package.json': './package.json' },
    })}\n`)
    await writeFile(join(sourceDirectory, 'require_builtin.node'), payload)
    await writeFile(join(sourceDirectory, 'addons.manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      target: 'aarch64-linux-android',
      algorithm: 'sha256',
      files: {
        'require_builtin.node': {
          size: payload.byteLength,
          sha256: createHash('sha256').update(payload).digest('hex'),
        },
      },
    })}\n`)

    await expect(installAndroidAddons({ platform: 'android', packageRoot })).resolves.toEqual({ status: 'installed' })
    expect(await readFile(join(dependency, 'build', 'napi', 'napi-v9-android-arm64', 'require_builtin.node'))).toEqual(payload)
  })

  it('does nothing outside Android', async () => {
    const { packageRoot, target } = await fixture()
    await expect(installAndroidAddons({ platform: 'linux', packageRoot })).resolves.toEqual({ status: 'not-android' })
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a payload that does not match the manifest', async () => {
    const { packageRoot, target } = await fixture({ manifestSha: '0'.repeat(64) })
    await expect(installAndroidAddons({ platform: 'android', packageRoot }))
      .rejects.toThrow(/pinned SHA-256/u)
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
