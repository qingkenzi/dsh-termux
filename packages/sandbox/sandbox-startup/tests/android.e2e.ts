/**
 * Android/Termux end-to-end check of the shipped startup decision: the real
 * local provider reports no backend, the base deployment's `ask` policy keeps
 * the confined mode instead of switching to full access, and a confined
 * command still fails closed with the actionable SandboxUnavailableError. Runs
 * only on an Android host; other hosts skip it.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxStartupService from '../src/index.ts'

const onAndroid = process.platform === 'android'

describe.skipIf(!onAndroid)('Android host without a sandbox backend', () => {
  /** Compose the real local provider under the base deployment's startup policy. */
  async function compose(onUnavailable: 'ask' | 'danger-full-access' | 'fail') {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSandboxProvider)
    await ctx.plugin(SandboxStartupService, { onUnavailable })
    return ctx
  }

  it('reports no backend through the seam availability report', async () => {
    const ctx = await compose('ask')
    expect(ctx.sandbox.availability()).toMatchObject({ available: false, backend: 'none', enforcement: 'none' })
    expect(ctx.sandbox.availability().reason).toContain('Android exposes no runner chain')
  })

  it('starts confined and fails a confined command closed', async () => {
    const ctx = await compose('ask')
    expect(ctx.sandboxStartup.mode).toBe('workspace-write')
    expect(ctx.sandboxStartup.awaitingChoice).toBe(true)
    expect(ctx.sandboxStartup.approvalPolicy).toBe('ask')
    const workspace = process.cwd()
    await expect(ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: workspace }))
      .rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  it('honors an explicit deployment acceptance of unconfined file effects', async () => {
    const ctx = await compose('danger-full-access')
    expect(ctx.sandboxStartup.mode).toBe('danger-full-access')
    expect(ctx.sandboxStartup.awaitingChoice).toBe(false)
    expect(ctx.sandboxStartup.approvalPolicy).toBe('never')
  })
})
