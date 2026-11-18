/**
 * The startup decision matrix and the service that publishes it. Every input
 * is explicit, so the matrix runs without process environment or a real host
 * backend, and the service composes over a fake provider.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxAvailability } from '@deepseek-ai/dsh-sandbox'
import SandboxStartupService, {
  SANDBOX_STARTUP_UNAVAILABLE, SandboxStartupUnavailableError, resolveDefaultMode,
} from '../src/index.ts'
import type { SandboxUnavailablePolicy } from '../src/index.ts'

const AVAILABLE: SandboxAvailability = {
  available: true,
  backend: 'bwrap',
  enforcement: 'full',
  reason: 'Confined processes run under bubblewrap mount namespaces; every promised file effect is enforced.',
  remediation: 'No action needed.',
}

const PARTIAL: SandboxAvailability = {
  available: true,
  backend: 'windows-acl',
  enforcement: 'partial',
  reason: 'Confined processes run under the Windows restricted-token ACL runner; part of the promised file-effect surface is not enforced.',
  remediation: 'Treat this boundary as partial.',
}

const UNAVAILABLE: SandboxAvailability = {
  available: false,
  backend: 'none',
  enforcement: 'none',
  reason: 'No file-sandbox backend is usable on android: Android exposes no runner chain, and bubblewrap and Landlock are unavailable on Termux.',
  remediation: 'Run with danger-full-access only when unconfined file effects are acceptable on this host, or move the workspace to a Linux host.',
}

describe('resolveDefaultMode', () => {
  it('starts confined with workspace-write when a backend exists', () => {
    expect(resolveDefaultMode({ availability: AVAILABLE, onUnavailable: 'fail' })).toEqual({
      mode: 'workspace-write', explicit: false, awaitingChoice: false, approvalPolicy: 'ask',
    })
  })

  it('accepts a partial backend as available', () => {
    expect(resolveDefaultMode({ availability: PARTIAL, onUnavailable: 'fail' }).mode).toBe('workspace-write')
  })

  it.each(['read-only', 'workspace-write'] as const)(
    'honors an explicit %s mode when a backend exists',
    (mode) => {
      expect(resolveDefaultMode({ mode, availability: AVAILABLE, onUnavailable: 'fail' })).toEqual({
        mode, explicit: true, awaitingChoice: false, approvalPolicy: 'ask',
      })
    },
  )

  it('accepts an explicitly requested danger-full-access mode without a backend', () => {
    expect(resolveDefaultMode({ mode: 'danger-full-access', availability: UNAVAILABLE, onUnavailable: 'fail' })).toEqual({
      mode: 'danger-full-access', explicit: true, awaitingChoice: false, approvalPolicy: 'never',
    })
  })

  it.each(['read-only', 'workspace-write'] as const)(
    'fails closed for an explicit %s mode without a backend and names the override',
    (mode) => {
      expect(() => resolveDefaultMode({ mode, availability: UNAVAILABLE, onUnavailable: 'ask' }))
        .toThrow(SandboxStartupUnavailableError)
      try {
        resolveDefaultMode({ mode, availability: UNAVAILABLE, onUnavailable: 'ask' })
      } catch (error) {
        expect((error as SandboxStartupUnavailableError).code).toBe(SANDBOX_STARTUP_UNAVAILABLE)
        expect((error as Error).message).toContain(`"${mode}"`)
        expect((error as Error).message).toContain('DSH_PERMISSION_MODE=danger-full-access')
        expect((error as Error).message).toContain('danger-full-access')
        expect((error as Error).message).toContain('Android exposes no runner chain')
        expect((error as Error).message).toContain(UNAVAILABLE.remediation)
      }
    },
  )

  it('keeps the confined mode under the ask policy instead of switching to full access', () => {
    expect(resolveDefaultMode({ availability: UNAVAILABLE, onUnavailable: 'ask' })).toEqual({
      mode: 'workspace-write', explicit: false, awaitingChoice: true, approvalPolicy: 'ask',
    })
  })

  it('accepts a declared danger-full-access policy without a backend', () => {
    expect(resolveDefaultMode({ availability: UNAVAILABLE, onUnavailable: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access', explicit: false, awaitingChoice: false, approvalPolicy: 'never',
    })
  })

  it('refuses to start under the fail policy without a backend', () => {
    expect(() => resolveDefaultMode({ availability: UNAVAILABLE, onUnavailable: 'fail' }))
      .toThrow(SandboxStartupUnavailableError)
    expect(() => resolveDefaultMode({ availability: UNAVAILABLE, onUnavailable: 'fail' }))
      .toThrow(/onUnavailable|DSH_PERMISSION_MODE=danger-full-access/u)
  })

  it.each<SandboxUnavailablePolicy>(['ask', 'danger-full-access', 'fail'])(
    'never reaches danger-full-access silently under %s',
    (onUnavailable) => {
      let decision
      try {
        decision = resolveDefaultMode({ availability: UNAVAILABLE, onUnavailable })
      } catch (error) {
        expect(error).toBeInstanceOf(SandboxStartupUnavailableError)
        return
      }
      if (decision.mode === 'danger-full-access') {
        expect(decision.awaitingChoice).toBe(false)
        expect(decision.approvalPolicy).toBe('never')
        expect(onUnavailable).toBe('danger-full-access')
      }
    },
  )
})

/** Mount the service over a fake provider reporting `availability`. */
async function mounted(options: {
  availability: SandboxAvailability
  config?: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access', onUnavailable?: SandboxUnavailablePolicy }
}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('sandbox', { availability: () => options.availability })
  const events: SandboxAvailability[] = []
  ctx.on('sandbox/availability-changed', availability => { events.push(availability) })
  const fiber = ctx.plugin(SandboxStartupService, options.config ?? {})
  return { ctx, events, fiber }
}

describe('SandboxStartupService', () => {
  it('publishes the resolved mode, its paired approval policy, and the availability event', async () => {
    const { ctx, events } = await mounted({ availability: AVAILABLE })
    expect(ctx.sandboxStartup.mode).toBe('workspace-write')
    expect(ctx.sandboxStartup.approvalPolicy).toBe('ask')
    expect(ctx.sandboxStartup.awaitingChoice).toBe(false)
    expect(ctx.sandboxStartup.explicit).toBe(false)
    expect(events).toEqual([AVAILABLE])
  })

  it('uses an explicit configured mode over host capability', async () => {
    const { ctx, events } = await mounted({ availability: AVAILABLE, config: { mode: 'read-only' } })
    expect(ctx.sandboxStartup.mode).toBe('read-only')
    expect(ctx.sandboxStartup.explicit).toBe(true)
    expect(events).toEqual([AVAILABLE])
  })

  it('fails activation when the decision must fail closed', async () => {
    const { fiber } = await mounted({ availability: UNAVAILABLE })
    await expect(fiber).rejects.toBeInstanceOf(SandboxStartupUnavailableError)
  })

  it('fails activation for an explicit confined mode without a backend', async () => {
    const { fiber } = await mounted({ availability: UNAVAILABLE, config: { mode: 'workspace-write', onUnavailable: 'ask' } })
    await expect(fiber).rejects.toThrow(/"workspace-write"/u)
  })

  it('reports the pending choice and warns instead of failing under the ask policy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, events } = await mounted({ availability: UNAVAILABLE, config: { onUnavailable: 'ask' } })
      expect(ctx.sandboxStartup.mode).toBe('workspace-write')
      expect(ctx.sandboxStartup.awaitingChoice).toBe(true)
      expect(events).toEqual([UNAVAILABLE])
    } finally {
      warn.mockRestore()
    }
  })

  it('defaults the unavailable policy to fail', async () => {
    const { fiber } = await mounted({ availability: UNAVAILABLE, config: {} })
    await expect(fiber).rejects.toThrow(/DSH_PERMISSION_MODE=danger-full-access|onUnavailable/u)
  })
})
