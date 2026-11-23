import { join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { dependency, existsSync } = vi.hoisted(() => ({
  dependency: { rgPath: '/node_modules/@vscode/ripgrep/bin/rg' },
  existsSync: vi.fn(),
}))
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalRgPathOverride = process.env.DSH_RG_PATH

/**
 * The Android prebuild `resolveRgPath` looks for beside this package in a source
 * checkout. It is committed for every platform, but only consulted when
 * `process.platform` is `android`.
 */
const androidPrebuild = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../vendor/android-prebuilds/rg')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync }
})

vi.mock('@vscode/ripgrep', () => ({ get rgPath() { return dependency.rgPath } }))

beforeEach(() => {
  vi.resetModules()
  existsSync.mockReset()
  dependency.rgPath = '/node_modules/@vscode/ripgrep/bin/rg'
  Reflect.deleteProperty(process, 'pkg')
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
  // The CLI bootstrap exports this on Android; clear it so the platform cases
  // below observe only the rule they set up.
  Reflect.deleteProperty(process.env, 'DSH_RG_PATH')
})

afterEach(() => {
  Reflect.deleteProperty(process, 'pkg')
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
  process.execPath = originalExecPath
  if (originalRgPathOverride === undefined) Reflect.deleteProperty(process.env, 'DSH_RG_PATH')
  else process.env.DSH_RG_PATH = originalRgPathOverride
})

describe('ripgrep resolution', () => {
  it('uses the native sidecar beside the current executable', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'linux' })
    process.execPath = '/runtime/dsh'
    existsSync.mockReturnValue(true)
    const sidecar = '/runtime/dsh-rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses a conventional executable name for the Windows ripgrep sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'win32' })
    process.execPath = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64.exe'
    existsSync.mockReturnValue(true)
    const sidecar = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64-rg.exe'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the dependency binary in an ordinary Node process', async () => {
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'linux' })
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    expect(existsSync).not.toHaveBeenCalled()
  })

  it('uses the bundled Android prebuild on an Android source checkout', async () => {
    // The `@vscode/ripgrep` platform packages ship no Android binary, so the
    // port resolves the prebuild committed beside the package before it consults
    // the dependency.
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'android' })
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(androidPrebuild)
    expect(existsSync).toHaveBeenCalledWith(androidPrebuild)
  })

  it('prefers an explicit DSH_RG_PATH over the bundled Android prebuild', async () => {
    // The CLI bootstrap exports this path because it is the only party that
    // knows where an installed prebuild lives outside a source checkout.
    const configured = '/data/data/com.termux/files/usr/lib/dsh/rg'
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'android' })
    process.env.DSH_RG_PATH = configured
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(configured)
    expect(existsSync).toHaveBeenCalledWith(configured)
  })

  it('falls back to the dependency binary when Android ships no prebuild', async () => {
    Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: 'android' })
    existsSync.mockReturnValue(false)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    expect(existsSync).toHaveBeenCalledWith(androidPrebuild)
  })

  it('uses the dependency binary when a packaged runtime has no sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(false)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(dependency.rgPath)
    const executable = parse(process.execPath)
    const sidecar = process.platform === 'win32'
      ? join(executable.dir, `${executable.name}-rg.exe`)
      : `${process.execPath}-rg`
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the unpacked executable path for an Electron ASAR dependency', async () => {
    Reflect.defineProperty(process.versions, 'electron', { configurable: true, value: '44.0.0' })
    dependency.rgPath = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@vscode/ripgrep/bin/rg'
    const { resolveRgPath } = await import('@deepseek-ai/dsh-util-ripgrep')

    await expect(resolveRgPath()).resolves.toBe(
      '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep/bin/rg',
    )
  })
})
