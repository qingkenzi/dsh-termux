import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareAndroidAddons } from '../src/android-addons.ts'

const roots: string[] = []

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-android-addons-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Package fixture with a resolvable dependency and an optional installed addon. */
async function fixture(options: { readonly addon?: boolean } = {}): Promise<{ packageRoot: string; rg: string }> {
  const root = await temporary()
  const packageRoot = join(root, 'apps', 'cli')
  const dependency = join(packageRoot, 'node_modules', 'node-addon-require-builtin')
  const rg = join(packageRoot, 'vendor', 'android-prebuilds', 'rg')
  await mkdir(join(packageRoot, 'vendor', 'android-prebuilds'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), '{}\n')
  await writeFile(rg, 'rg\n')
  await mkdir(join(dependency, 'build', 'napi', 'napi-v9-android-arm64'), { recursive: true })
  await writeFile(join(dependency, 'package.json'), `${JSON.stringify({
    name: 'node-addon-require-builtin',
    exports: { './package.json': './package.json' },
  })}\n`)
  if (options.addon !== false) {
    await writeFile(join(dependency, 'build', 'napi', 'napi-v9-android-arm64', 'require_builtin.node'), 'addon\n')
  }
  return { packageRoot, rg }
}

describe('prepareAndroidAddons', () => {
  it('does nothing outside Android', async () => {
    const { packageRoot, rg } = await fixture()
    const env: NodeJS.ProcessEnv = {}
    const warnings: string[] = []
    expect(prepareAndroidAddons({ platform: 'linux', packageRoot, env, warn: message => warnings.push(message) }))
      .toEqual({ problems: [] })
    expect(env).toEqual({})
    expect(rg).not.toBe(env.DSH_RG_PATH)
    expect(warnings).toEqual([])
  })

  it('publishes the bundled ripgrep and accepts a healthy addon install', async () => {
    const { packageRoot, rg } = await fixture()
    const env: NodeJS.ProcessEnv = {}
    const warnings: string[] = []
    const prepared = prepareAndroidAddons({ platform: 'android', packageRoot, env, warn: message => warnings.push(message) })
    expect(prepared).toEqual({ rgPath: rg, problems: [] })
    expect(env.DSH_RG_PATH).toBe(rg)
    expect(warnings).toEqual([])
  })

  it('never overwrites an explicit DSH_RG_PATH', async () => {
    const { packageRoot } = await fixture()
    const env: NodeJS.ProcessEnv = { DSH_RG_PATH: '/custom/rg' }
    prepareAndroidAddons({ platform: 'android', packageRoot, env, warn: () => {} })
    expect(env.DSH_RG_PATH).toBe('/custom/rg')
  })

  it('reports a missing addon with a restore command', async () => {
    const { packageRoot } = await fixture({ addon: false })
    const warnings: string[] = []
    const prepared = prepareAndroidAddons({
      platform: 'android',
      packageRoot,
      env: {},
      warn: message => warnings.push(message),
    })
    expect(prepared.problems).toHaveLength(1)
    expect(prepared.problems[0]).toContain('require_builtin.node')
    expect(prepared.problems[0]).toContain('pnpm install --ignore-scripts')
    expect(prepared.problems[0]).toContain('npm rebuild @deepseek-ai/dsh')
    expect(warnings).toEqual(prepared.problems)
  })
})
