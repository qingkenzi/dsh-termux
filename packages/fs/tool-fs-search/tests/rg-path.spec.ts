/**
 * Resolution-failure tests for the lazy packaged-ripgrep lookup. The real
 * `@vscode/ripgrep` dependency is exercised by tools.spec.ts where a platform
 * package exists; here it is mocked to throw at evaluation, proving a missing or
 * corrupt platform package (`--omit=optional`, partial install) surfaces as a
 * per-call `SEARCH_FAILED` — not a composition-load failure. An Android source
 * checkout resolves the prebuild committed in `vendor/android-prebuilds` before
 * it consults that package, so the failure cases deny the prebuild to keep their
 * premise real on every platform.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { resolveRgPath, runRipgrep } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

const { denyAndroidPrebuild } = vi.hoisted(() => ({ denyAndroidPrebuild: { current: false } }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // `resolveRgPath` probes the Android prebuild with `existsSync`. Denying
    // that one path while the flag is set reproduces an Android checkout
    // without it; every other probe reaches the real filesystem.
    existsSync: (...args: Parameters<typeof actual.existsSync>): boolean => {
      const [path] = args
      return denyAndroidPrebuild.current && typeof path === 'string'
        && path.replaceAll('\\', '/').endsWith('/vendor/android-prebuilds/rg')
        ? false
        : actual.existsSync(...args)
    },
  }
})

// The CLI bootstrap exports a ripgrep path on Android; clear it so each case
// below observes only the resolution rule it sets up.
const originalRgPathOverride = process.env.DSH_RG_PATH

beforeEach(() => { Reflect.deleteProperty(process.env, 'DSH_RG_PATH') })
afterEach(() => {
  if (originalRgPathOverride === undefined) Reflect.deleteProperty(process.env, 'DSH_RG_PATH')
  else process.env.DSH_RG_PATH = originalRgPathOverride
})

describe('lazy packaged-ripgrep resolution', () => {
  it('fails the first search call with SEARCH_FAILED instead of failing module load', async () => {
    // A failed resolution rejects before any spawn, so no subprocess service is
    // needed; on Android the resolved prebuild reaches the absent service and
    // fails the same way.
    const controller = new AbortController()
    const callId = brandString<ToolCallId>('missing-platform-package')
    const exec: ToolExecution = {
      signal: controller.signal,
      name: 'glob',
      arguments: {},
      callId,
      rootCallId: callId,
      token: Symbol('missing-platform-package') as ToolExecutionToken,
    }

    await expect(runRipgrep(new Context(), exec, 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })

  it('memoizes the outcome of the first resolution for every later call', async () => {
    const settled = await resolveRgPath().then(
      (path: string) => ({ path }),
      (error: Error) => ({ error }),
    )

    if ('path' in settled) {
      // The port ships `vendor/android-prebuilds/rg` because no
      // `@vscode/ripgrep` platform package carries an Android binary, so
      // resolution succeeds on Android instead of reaching the throwing module.
      expect(settled.path.replaceAll('\\', '/')).toMatch(/\/vendor\/android-prebuilds\/rg$/u)
      await expect(resolveRgPath()).resolves.toBe(settled.path)
    } else {
      expect(settled.error.message).toMatch(/platform package/u)
      await expect(resolveRgPath()).rejects.toThrow(/platform package/u)
    }
  })

  it('keeps failing every later call when the resolution itself failed', async () => {
    // A fresh module instance owns a fresh memoized promise, so the denial below
    // decides this resolution rather than the one the tests above already ran.
    denyAndroidPrebuild.current = true
    vi.resetModules()
    try {
      const { resolveRgPath: resolveWithoutPrebuild } = await import('@deepseek-ai/dsh-tool-fs-search')
      const first = resolveWithoutPrebuild()
      // The same promise, not a retried resolution.
      expect(resolveWithoutPrebuild()).toBe(first)
      await expect(first).rejects.toThrow(/platform package/u)
      await expect(resolveWithoutPrebuild()).rejects.toThrow(/platform package/u)
    } finally {
      denyAndroidPrebuild.current = false
    }
  })
})
