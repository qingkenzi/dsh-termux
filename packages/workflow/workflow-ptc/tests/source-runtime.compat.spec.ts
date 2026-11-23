import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
/** The Node compatibility matrix runs this complete source-entry smoke. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SandboxUnavailableError, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import PtcWorkflowEngine from '../src/index.ts'
import { fakeParent, mountPtcRuntime } from './setup.ts'

/**
 * Probe the local sandbox independently, so that a host without an enforcing
 * backend skips the cases whose premise is confinement rather than reading the
 * PTC launch failure that follows from it.
 */
const sandboxUsable = await (async () => {
  const probe = new Context()
  try {
    await probe.plugin(Sandbox, {})
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    // A host whose chain (Linux: bwrap then Landlock) has no usable rung answers
    // this probe negatively — Android ships neither. Any other fault is a defect
    // in the probe host and stays loud.
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally { await probe.fiber.dispose() }
})()

async function setup(mode: SandboxMode, executionMode: 'per-call' | 'persistent-in-memory' = 'per-call') {
  const ctx = new Context()
  const files = await mountPtcRuntime(ctx, mode, executionMode)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('source runtime smoke must not start a child')),
  })
  await ctx.plugin(PtcWorkflowEngine, {})
  return { ctx, parent: await fakeParent(ctx), ...files }
}

// The premise is an enforcing confinement backend for the requested mode, and
// this host has none; the PTC sandbox runtime does not run on Android, so the
// case is skipped there rather than rewritten around the missing capability.
it.skipIf(!sandboxUsable)('runs the default workflow config through the source PTC runtime', async () => {
  const { ctx, parent } = await setup('read-only')
  const run = ctx.workflowEngine.start({
    script: 'return args.left * args.right',
    args: { left: 6, right: 7 },
    meta: { name: 'source-runtime-compat', description: 'source workflow and PTC entry' },
    parent,
  })
  try {
    const result = await run.result
    expect(result, result.error).toMatchObject({ value: 42, stopReason: 'completed', agentsStarted: 0 })
  } finally { await run.dispose() }
})

// Same premise: both parameters assert enforcement through a real backend.
it.skipIf(!sandboxUsable).each(['per-call', 'persistent-in-memory'] as const)('enforces workspace writes in %s workflows', async (executionMode) => {
  const mode = 'workspace-write'
  const { ctx, parent, root, cwd } = await setup(mode, executionMode)
  const outside = join(root, 'outside.txt')
  const inside = join(cwd, 'inside.txt')
  await writeFile(outside, 'unchanged')
  const run = ctx.workflowEngine.start({
    script: `const proc = globalThis.constructor.constructor('return process')()
const fs = proc.getBuiltinModule('node:fs')
try { fs.writeFileSync('inside.txt', 'inside') } catch {}
try { fs.writeFileSync(args.outside, 'changed') } catch {}
return 42`,
    args: { outside },
    meta: { name: 'source-confinement', description: 'direct Node file writes' },
    parent,
  })
  try {
    const result = await run.result
    expect(result.stopReason, result.error).toBe('completed')
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
    if (mode === 'workspace-write') expect(await readFile(inside, 'utf8')).toBe('inside')
    else await expect(readFile(inside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await run.dispose() }
})
