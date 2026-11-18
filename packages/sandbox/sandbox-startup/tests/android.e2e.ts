/**
 * Android/Termux end-to-end check of the shipped startup decision against the
 * real seccomp supervisor: the local provider probes the built
 * `android-sandbox-run`, reports a partial backend, and the default
 * deployment starts in `workspace-write` instead of awaiting a user choice.
 * Runs only on an Android host with the native payload built
 * (`pnpm run build:native-system`); other hosts skip it.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { androidSandboxRunnerPath } from '@deepseek-ai/node-addon-system/android-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxStartupService from '../src/index.ts'

const onAndroid = process.platform === 'android'
const runner = onAndroid ? androidSandboxRunnerPath() : ''

describe.skipIf(!onAndroid)('Android seccomp sandbox backend', () => {
  /** Compose the real local provider under the base deployment's startup policy. */
  async function compose(onUnavailable: 'ask' | 'danger-full-access' | 'fail') {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSandboxProvider)
    await ctx.plugin(SandboxStartupService, { onUnavailable })
    return ctx
  }

  it('built the supervisor (pnpm run build:native-system)', () => {
    expect(existsSync(runner), `missing ${runner}; run pnpm run build:native-system`).toBe(true)
  })

  it('reports the probed supervisor through the seam availability report', async () => {
    const ctx = await compose('ask')
    expect(ctx.sandbox.availability()).toMatchObject({
      available: true,
      backend: 'android-sandbox',
      enforcement: 'partial',
    })
  })

  it('starts in workspace-write instead of awaiting a choice', async () => {
    const ctx = await compose('ask')
    expect(ctx.sandboxStartup.mode).toBe('workspace-write')
    expect(ctx.sandboxStartup.awaitingChoice).toBe(false)
    expect(ctx.sandboxStartup.approvalPolicy).toBe('ask')
  })

  it('runs a confined command whose workspace write lands and whose outside write is denied', async () => {
    const ctx = await compose('ask')
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-android-startup-'))
    onTestFinished(() => rmSync(workspace, { recursive: true, force: true }))
    const allowed = join(workspace, 'allowed.txt')
    const denied = join(process.env.HOME ?? tmpdir(), `.dsh-android-startup-denied-${process.pid}`)
    const confined = await ctx.sandbox.confine(
      ['bash', '-c', `printf ok > ${allowed}; printf no > ${denied}`],
      { mode: 'workspace-write', workspaceRoot: workspace },
    )
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('permission denied')
    expect(readFileSync(allowed, 'utf8')).toBe('ok')
    expect(existsSync(denied)).toBe(false)
  })

  it('keeps an explicit read-only mode denying workspace writes', async () => {
    const ctx = await compose('ask')
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-android-startup-ro-'))
    onTestFinished(() => rmSync(workspace, { recursive: true, force: true }))
    const denied = join(workspace, 'denied.txt')
    const confined = await ctx.sandbox.confine(
      ['bash', '-c', `printf no > ${denied}`],
      { mode: 'read-only', workspaceRoot: workspace },
    )
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('permission denied')
    expect(existsSync(denied)).toBe(false)
  })
})
