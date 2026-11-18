/**
 * Host availability reports: the same chain verdict `confine()` fails closed
 * on, published before any command runs so deployments can choose a default
 * mode and the GUI can show what this host actually enforces.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'

const WW: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }

/** Mount the provider, then install the test hooks the availability walk reads. */
async function setup(config: Config = {}, internals: LocalSandboxProvider['internals'] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = internals
  return { ctx, sandbox }
}

describe('LocalSandboxProvider.availability()', () => {
  it('reports bwrap with full enforcement when its functional probe passes', async () => {
    const { sandbox } = await setup({}, { platform: 'linux', probeBwrap: () => true, probeLandlock: () => 'full' })
    expect(sandbox.availability()).toMatchObject({
      available: true,
      backend: 'bwrap',
      enforcement: 'full',
      remediation: 'No action needed.',
    })
    expect(sandbox.availability().reason).toContain('bubblewrap')
  })

  it('reports the Landlock fallback and its per-ABI partial enforcement', async () => {
    const { sandbox } = await setup({}, {
      platform: 'linux',
      probeBwrap: () => false,
      probeLandlock: () => 'partial',
      landlockLauncher: '/fake/landlock-run',
    })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: true, backend: 'landlock', enforcement: 'partial' })
    expect(availability.reason).toContain('not enforced')
    expect(availability.remediation).toContain('partial')
  })

  it('reports every failed rung with the platform chain and the install remediation', async () => {
    const { sandbox } = await setup({}, {
      platform: 'linux',
      probeBwrap: () => false,
      probeLandlock: () => 'unusable',
      landlockLauncher: '/fake/landlock-run',
    })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: false, backend: 'none', enforcement: 'none' })
    expect(availability.reason).toContain('bwrap, then landlock')
    expect(availability.remediation).toContain('bubblewrap')
  })

  it('selects the sole Seatbelt candidate without probing and reports full enforcement', async () => {
    const { sandbox } = await setup({}, { platform: 'darwin', seatbeltExec: '/fake/sandbox-exec' })
    expect(sandbox.availability()).toMatchObject({ available: true, backend: 'seatbelt', enforcement: 'full' })
  })

  it('reports the Windows ACL runner as available with partial enforcement', async () => {
    const { sandbox } = await setup({}, {
      platform: 'win32',
      windowsAclRunnerArgs: ['fake-runner'],
      windowsAclRunnerEntry: '/fake/runner.js',
    })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: true, backend: 'windows-acl', enforcement: 'partial' })
    expect(availability.reason).toContain('not enforced')
  })

  it('reports the probed Android seccomp supervisor as available with partial enforcement', async () => {
    const probeAndroidSandbox = vi.fn(() => 'partial' as const)
    const { sandbox } = await setup({}, { platform: 'android', probeAndroidSandbox })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: true, backend: 'android-sandbox', enforcement: 'partial' })
    expect(availability.reason).toContain('seccomp user-notification supervisor')
    expect(availability.reason).toContain('not enforced')
    expect(availability.remediation).toContain('partial')
    expect(availability.remediation).toContain('bubblewrap or Landlock')
    expect(probeAndroidSandbox).toHaveBeenCalledTimes(1)
  })

  it('reports Android unavailable when the supervisor probe fails, and confine() stays fail-closed', async () => {
    const probeAndroidSandbox = vi.fn(() => 'unusable' as const)
    const { sandbox } = await setup({}, { platform: 'android', probeAndroidSandbox })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: false, backend: 'none', enforcement: 'none' })
    expect(availability.reason).toContain('android-sandbox candidate failed the functional probe')
    expect(availability.remediation).toContain('seccomp user notification')
    expect(availability.remediation).toContain('danger-full-access')
    await expect(sandbox.confine(['true'], WW)).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(sandbox.confine(['true'], WW)).rejects.toMatchObject({ code: SANDBOX_UNAVAILABLE })
    expect(probeAndroidSandbox).toHaveBeenCalledTimes(1)
  })

  it('reads the resolved supervisor path as unusable when the injected binary is absent', async () => {
    // The default probe checks existence before spawning; an injected absent
    // path pins that arm on every host.
    const { sandbox } = await setup({}, {
      platform: 'android',
      androidSandboxRunner: '/nonexistent/android-sandbox-run',
    })
    expect(sandbox.availability()).toMatchObject({ available: false, enforcement: 'none' })
  })

  it('reports a platform with an injected empty chain as having none', async () => {
    const { sandbox } = await setup({}, { platform: 'android', chain: [], probeAndroidSandbox: () => 'partial' })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: false, enforcement: 'none' })
    expect(availability.reason).toContain('this platform has no runner chain')
    expect(availability.remediation).toContain('danger-full-access')
    expect(availability.remediation).toContain('Landlock')
  })

  it('reports an operator-supplied runner command as full enforcement', async () => {
    const { sandbox } = await setup({
      runnerCommand: ['fake-runner'],
      runnerFailureSignatures: ['fake-runner: '],
    })
    expect(sandbox.availability()).toMatchObject({
      available: true, backend: 'runner-command', enforcement: 'full',
    })
  })

  it('reports a throwing probe as unavailable instead of propagating it', async () => {
    const { sandbox } = await setup({}, {
      platform: 'linux',
      probeBwrap: () => { throw new Error('probe exploded') },
    })
    const availability = sandbox.availability()
    expect(availability).toMatchObject({ available: false, enforcement: 'none' })
    expect(availability.reason).toContain('probe exploded')
  })

  it('resolves the chain once and reuses the verdict for the same provider', async () => {
    let probes = 0
    const { sandbox } = await setup({}, {
      platform: 'linux',
      probeBwrap: () => { ++probes; return true },
      probeLandlock: () => 'full',
    })
    expect(sandbox.availability().backend).toBe('bwrap')
    expect(sandbox.availability().backend).toBe('bwrap')
    await sandbox.confine(['true'], WW)
    expect(probes).toBe(1)
  })
})
