/**
 * The probe's classification, one-shot cache, startup installation, and the
 * real-device pass that a targetSdk 28 Termux app must retain.
 */

import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  ANDROID_EXEC_FAILURE_REASONS,
  AndroidExecProbe,
  DEFAULT_ANDROID_EXEC_TIMEOUT_MS,
  PLATFORM_EXEC_BLOCKED,
  PlatformExecBlockedError,
  androidExecDiagnostic,
  androidExecGuidance,
  androidSpawnFailure,
  installAndroidExec,
  probeAndroidExec,
  type AndroidExecChild,
  type AndroidExecProbeResult,
  type AndroidExecSpawn,
} from '../src/index.ts'

/** A child whose terminal events the test emits. */
class FakeChild extends EventEmitter implements AndroidExecChild {
  kill = vi.fn((_signal?: NodeJS.Signals) => true)
}

/** Recorded spawn call and the child it returned. */
interface RecordedSpawn {
  readonly calls: { command: string; args: readonly string[] }[]
  readonly children: FakeChild[]
  readonly spawn: AndroidExecSpawn
}

/**
 * Build an injected spawner that records calls and returns controllable children.
 * @param react - optional callback run for each child to emit its terminal event.
 * @returns the recorder and the spawn function.
 */
function recordingSpawn(react?: (child: FakeChild, index: number) => void): RecordedSpawn {
  const calls: RecordedSpawn['calls'] = []
  const children: FakeChild[] = []
  return {
    calls,
    children,
    spawn: (command, args) => {
      const child = new FakeChild()
      calls.push({ command, args })
      children.push(child)
      const index = children.length - 1
      // Listeners attach after the launcher returns; emit on the next microtask.
      if (react !== undefined) queueMicrotask(() => { react(child, index) })
      return child
    },
  }
}

/** @returns an errno-shaped error for a probe child event. */
function errnoError(code: string, message = `${code}: simulated probe failure`): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** @returns the failed probe result for assertions. */
function failure(reason: AndroidExecProbeResult['reason'], detail = 'probe detail'): AndroidExecProbeResult {
  return { available: false, reason, detail }
}

describe('probeAndroidExec', () => {
  it('is a no-op off Android without starting a process', async () => {
    const spawn = vi.fn<AndroidExecSpawn>()
    await expect(probeAndroidExec({ platform: 'linux', spawn })).resolves.toEqual({
      available: true, reason: undefined, detail: undefined,
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts the runtime and the configured shell on Android', async () => {
    const recorded = recordingSpawn(child => { child.emit('exit', 0, null) })
    const result = await probeAndroidExec({
      platform: 'android',
      execPath: '/data/data/com.termux/files/usr/bin/node',
      env: { PREFIX: '/data/data/com.termux/files/usr' },
      spawn: recorded.spawn,
    })
    expect(result).toEqual({ available: true, reason: undefined, detail: undefined })
    expect(recorded.calls).toEqual([
      { command: '/data/data/com.termux/files/usr/bin/node', args: ['-e', '0'] },
      { command: '/data/data/com.termux/files/usr/bin/sh', args: ['-c', 'true'] },
    ])
  })

  it('probes both the runtime and the shell', async () => {
    const recorded = recordingSpawn()
    const result = probeAndroidExec({
      platform: 'android', execPath: '/node', shellPath: '/shell', spawn: recorded.spawn,
    })
    await Promise.resolve()
    expect(recorded.calls).toHaveLength(2)
    for (const child of recorded.children) child.emit('exit', 0, null)
    await expect(result).resolves.toMatchObject({ available: true })
  })

  it.each(['EACCES', 'EPERM'])('reports %s as PLATFORM_EXEC_BLOCKED', async (code) => {
    const recorded = recordingSpawn((child, index) => {
      if (index === 0) child.emit('error', errnoError(code))
      else child.emit('exit', 0, null)
    })
    const result = await probeAndroidExec({
      platform: 'android', execPath: '/runtime/node', shellPath: '/shell', spawn: recorded.spawn,
    })
    expect(result).toMatchObject({ available: false, reason: 'PLATFORM_EXEC_BLOCKED' })
    expect(result.detail).toContain(code)
    expect(result.detail).toContain('/runtime/node')
  })

  it('reports ENOENT as a missing interpreter', async () => {
    const recorded = recordingSpawn((child, index) => {
      if (index === 0) child.emit('error', errnoError('ENOENT'))
      else child.emit('exit', 0, null)
    })
    const result = await probeAndroidExec({
      platform: 'android', execPath: '/runtime/node', shellPath: '/shell', spawn: recorded.spawn,
    })
    expect(result).toMatchObject({ available: false, reason: 'INTERPRETER_MISSING' })
    expect(result.detail).toContain('/runtime/node')
  })

  it('reports a synchronous throw as a classified failure', async () => {
    const result = await probeAndroidExec({
      platform: 'android', execPath: '/runtime/node', shellPath: '/shell',
      spawn: () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) },
    })
    expect(result).toMatchObject({ available: false, reason: 'PLATFORM_EXEC_BLOCKED' })
  })

  it('reports a nonzero exit as a diagnostic failure', async () => {
    const recorded = recordingSpawn((child, index) => {
      child.emit('exit', index === 0 ? 1 : 0, null)
    })
    const result = await probeAndroidExec({
      platform: 'android', execPath: '/runtime/node', shellPath: '/shell', spawn: recorded.spawn,
    })
    expect(result).toMatchObject({ available: false, reason: 'PROBE_FAILED' })
    expect(result.detail).toContain('exited with 1')
  })

  it('kills a hung probe and reports the timeout', async () => {
    const recorded = recordingSpawn()
    const result = await probeAndroidExec({
      platform: 'android', execPath: '/runtime/node', shellPath: '/shell', spawn: recorded.spawn, timeoutMs: 5,
    })
    expect(result).toMatchObject({ available: false, reason: 'PROBE_TIMEOUT' })
    expect(result.detail).toContain('within 5ms')
    for (const child of recorded.children) expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects an invalid bound before starting a process', async () => {
    const spawn = vi.fn<AndroidExecSpawn>()
    await expect(probeAndroidExec({ platform: 'android', spawn, timeoutMs: 0 }))
      .rejects.toThrow('timeoutMs must be a positive finite number')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lists every failure reason in precedence order', () => {
    expect(ANDROID_EXEC_FAILURE_REASONS).toEqual([
      'PLATFORM_EXEC_BLOCKED', 'INTERPRETER_MISSING', 'PROBE_TIMEOUT', 'PROBE_FAILED',
    ])
    expect(DEFAULT_ANDROID_EXEC_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it.skipIf(process.platform !== 'android')('passes on this Termux device with the real interpreters', async () => {
    const result = await probeAndroidExec({ timeoutMs: 10_000 })
    expect(result).toEqual({ available: true, reason: undefined, detail: undefined })
  })
})

describe('AndroidExecProbe', () => {
  it('probes once even when callers race the first call', async () => {
    const recorded = recordingSpawn(child => { queueMicrotask(() => { child.emit('exit', 0, null) }) })
    const probe = new AndroidExecProbe({ platform: 'android', execPath: '/node', shellPath: '/shell', spawn: recorded.spawn })
    expect(probe.settled).toBeUndefined()
    const [first, second] = await Promise.all([probe.probe(), probe.probe()])
    expect(first).toEqual({ available: true, reason: undefined, detail: undefined })
    expect(second).toBe(first)
    expect(recorded.calls).toHaveLength(2)
    expect(probe.settled).toBe(first)
    await expect(probe.probe()).resolves.toBe(first)
    expect(recorded.calls).toHaveLength(2)
  })
})

describe('installAndroidExec', () => {
  it('publishes the result and logs one structured warning when execution is blocked', async () => {
    const ctx = new Context()
    const messages: unknown[][] = []
    ctx.logger.exporter({ levels: { default: 2 }, export: ({ args }) => { messages.push(args) } })
    const probe = { probe: vi.fn(async () => failure('PLATFORM_EXEC_BLOCKED')) }
    try {
      const result = await installAndroidExec(ctx, 'dsh', { probe })
      expect(result).toEqual(failure('PLATFORM_EXEC_BLOCKED'))
      expect(ctx.get('androidExec')).toEqual(result)
      expect(probe.probe).toHaveBeenCalledTimes(1)
      expect(messages).toHaveLength(1)
      expect(messages[0]?.[0]).toContain('targetSdk ≥ 29')
      expect(messages[0]?.[0]).toContain('app lib directory')
      expect(messages[0]?.[0]).toContain(PLATFORM_EXEC_BLOCKED)
      expect(messages[0]?.[1]).toMatchObject({ available: false, reason: 'PLATFORM_EXEC_BLOCKED' })
      await installAndroidExec(ctx, 'dsh', { probe })
      expect(probe.probe).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('publishes an available result without a warning', async () => {
    const ctx = new Context()
    const warnings: unknown[][] = []
    ctx.logger.exporter({ levels: { default: 2 }, export: ({ args }) => { warnings.push(args) } })
    try {
      await expect(installAndroidExec(ctx, 'dsh', {
        probe: { probe: async () => ({ available: true, reason: undefined, detail: undefined }) },
      })).resolves.toMatchObject({ available: true })
      expect(ctx.get('androidExec')).toMatchObject({ available: true })
      expect(warnings).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('Android exec failure reporting', () => {
  it('builds an actionable warning naming the targetSdk rule and app-lib remedy', () => {
    const warning = androidExecDiagnostic('dsh', failure('PLATFORM_EXEC_BLOCKED', 'EACCES'))
    expect(warning).toContain('PLATFORM_EXEC_BLOCKED')
    expect(warning).toContain('targetSdk ≥ 29')
    expect(warning).toContain('app lib directory')
    expect(warning).toContain('Web UI')
    expect(androidExecDiagnostic('dsh', { available: true, reason: undefined, detail: undefined })).toBe('')
    expect(androidExecGuidance()).toContain('targetSdk ≥ 29')
  })

  it('maps EACCES/EPERM to PlatformExecBlockedError and leaves other failures unchanged', () => {
    const blocked = androidSpawnFailure(errnoError('EACCES'), '/shell')
    expect(blocked).toBeInstanceOf(PlatformExecBlockedError)
    expect(blocked).toMatchObject({ code: PLATFORM_EXEC_BLOCKED })
    expect((blocked as Error).message).toContain('cannot start "/shell"')
    expect((blocked as Error).message).toContain(androidExecGuidance())
    expect((blocked as Error).message).toContain('app lib directory')
    const missing = errnoError('ENOENT')
    expect(androidSpawnFailure(missing, '/shell')).toBe(missing)
    expect(androidSpawnFailure('not an error', '/shell')).toBe('not an error')
  })
})
