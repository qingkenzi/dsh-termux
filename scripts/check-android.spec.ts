import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const scriptUrl = new URL('./check-android.mjs', import.meta.url).href

/**
 * Run the Android check on a simulated non-Android host. `process.platform`
 * is configurable, so the child can exercise the guard on any real platform.
 */
function runOnLinux(env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  const source = `Object.defineProperty(process, 'platform', { value: 'linux' }); await import(${JSON.stringify(scriptUrl)})`
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', env })
}

const baseEnv: NodeJS.ProcessEnv = { ...process.env }
delete baseEnv.DSH_ANDROID_CHECK_ALLOW_SKIP

describe('check-android platform guard', () => {
  it('fails on a non-Android host instead of silently passing', () => {
    const result = runOnLinux(baseEnv)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('this check targets Android')
    expect(result.stderr).toContain('DSH_ANDROID_CHECK_ALLOW_SKIP=1')
  })

  it('skips with exit 0 only for an explicit DSH_ANDROID_CHECK_ALLOW_SKIP=1', () => {
    const result = runOnLinux({ ...baseEnv, DSH_ANDROID_CHECK_ALLOW_SKIP: '1' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('check-android: skipped (linux/')
    expect(result.stderr).toBe('')
  })
})
