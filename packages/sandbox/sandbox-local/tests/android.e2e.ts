/**
 * Android/Termux end-to-end proof of the seccomp supervisor through
 * `LocalSandboxProvider.confine()`: the real runner is loaded and probed, a
 * workspace marker lands and is read back by the host, a `$HOME/.dsh` write is
 * denied with EACCES and leaves no file, and raw escape attempts (io_uring,
 * openat2 write, a directory descriptor outside the grants) are refused.
 * Runs only on Android; other hosts skip it. Requires the native payload
 * (`pnpm run build:native-system`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { androidSandboxRunnerPath } from '@deepseek-ai/node-addon-system/android-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const onAndroid = process.platform === 'android'
const runner = onAndroid ? androidSandboxRunnerPath() : ''
const temporary = onAndroid ? mkdtempSync(join(tmpdir(), 'dsh-android-e2e-')) : ''
const sysprobe = onAndroid ? join(temporary, 'android-sysprobe') : ''

let ctx: Context | undefined

beforeAll(() => {
  if (!onAndroid) return
  const source = fileURLToPath(new URL('./android-sysprobe.c', import.meta.url))
  const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', sysprobe, source], {
    encoding: 'utf8',
  })
  if (compiled.status !== 0) throw new Error(`failed to compile ${source}: ${compiled.stderr}`)
})

afterAll(() => {
  if (onAndroid) rmSync(temporary, { recursive: true, force: true })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function provider(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  return ctx.sandbox as LocalSandboxProvider
}

function workspace(): string {
  return mkdtempSync(join(temporary, 'ws-'))
}

/** Confine one argv under `policy` and run it for real, rooted at the workspace. */
async function runConfined(sandbox: LocalSandboxProvider, argv: string[], policy: SandboxPolicy) {
  const confined = await sandbox.confine(argv, policy)
  return spawnSync(confined.argv[0] as string, confined.argv.slice(1), {
    cwd: policy.workspaceRoot,
    timeout: 30_000,
    encoding: 'utf8',
  })
}

describe.skipIf(!onAndroid)('sandbox-local: real Android seccomp confinement', () => {
  it('built and loads the supervisor, and its probe verifies the listener', () => {
    expect(existsSync(runner), `missing ${runner}; run pnpm run build:native-system`).toBe(true)
    const probe = spawnSync(runner, ['--probe'], { timeout: 10_000, encoding: 'utf8' })
    expect(probe.status, probe.stderr).toBe(0)
    expect(probe.stdout).toContain('Seccomp: 2')
  })

  it('reports the probed backend with partial enforcement and the EACCES denial dialect', async () => {
    const sandbox = await provider()
    expect(sandbox.availability()).toMatchObject({
      available: true,
      backend: 'android-sandbox',
      enforcement: 'partial',
    })
    const directory = workspace()
    const confined = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: directory })
    expect(confined.enforcement).toBe('partial')
    expect(confined.denialSignatures).toEqual(['permission denied'])
    expect(confined.runnerFailureRules).toEqual([
      { allowedExitCodes: [125], fatalSignatures: ['android-sandbox-run: '] },
    ])
  })

  it('lands a workspace marker (read back by the host) and denies $HOME/.dsh with no file', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const marker = join(directory, 'marker.txt')
    const denied = join(process.env.HOME ?? tmpdir(), '.dsh', `dsh-android-e2e-denied-${process.pid}.txt`)
    const result = await runConfined(
      sandbox,
      ['bash', '-c', `printf workspace-marker > ${marker}; printf outside-marker > ${denied}`],
      { mode: 'workspace-write', workspaceRoot: directory },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('permission denied')
    // Marker double verification: the host reads the exact bytes the confined
    // command wrote, and the denied marker never reached the filesystem.
    expect(readFileSync(marker, 'utf8')).toBe('workspace-marker')
    expect(existsSync(denied)).toBe(false)
  })

  it('keeps an explicit read-only mode denying a workspace marker', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const marker = join(directory, 'read-only.txt')
    const result = await runConfined(sandbox, ['bash', '-c', `printf no > ${marker}`], {
      mode: 'read-only',
      workspaceRoot: directory,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('permission denied')
    expect(existsSync(marker)).toBe(false)
  })

  it('allows a relative-path workspace write resolved through the confined cwd', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const result = await runConfined(sandbox, ['bash', '-c', 'printf relative > relative.txt'], {
      mode: 'workspace-write',
      workspaceRoot: directory,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(directory, 'relative.txt'), 'utf8')).toBe('relative')
  })

  it('keeps /dev/null writable and reads unconfined', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const result = await runConfined(sandbox, ['bash', '-c', 'cat /system/etc/hosts > /dev/null && echo reads-ok'], {
      mode: 'read-only',
      workspaceRoot: directory,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('reads-ok\n')
  })

  it.each(['workspace-write', 'read-only'] as const)('refuses io_uring_setup under %s', async (mode) => {
    const sandbox = await provider()
    const directory = workspace()
    const result = await runConfined(sandbox, [sysprobe, 'io-uring'], { mode, workspaceRoot: directory })
    expect(result.status, result.stderr).toBe(0)
  })

  it('denies openat2 write while openat2 reads still succeed', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const target = join(directory, 'openat2.txt')
    const write = await runConfined(sandbox, [sysprobe, 'openat2-write', target], {
      mode: 'workspace-write',
      workspaceRoot: directory,
    })
    expect(write.status, write.stderr).toBe(0)
    expect(existsSync(target)).toBe(false)
    const read = await runConfined(sandbox, ['bash', '-c', 'cat /system/etc/hosts > /dev/null && echo read-ok'], {
      mode: 'workspace-write',
      workspaceRoot: directory,
    })
    expect(read.status, read.stderr).toBe(0)
  })

  it('denies a write through a directory descriptor opened outside the grants', async () => {
    const sandbox = await provider()
    const directory = workspace()
    const result = await runConfined(sandbox, [sysprobe, 'dirfd-write', process.env.HOME ?? tmpdir()], {
      mode: 'workspace-write',
      workspaceRoot: directory,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(process.env.HOME ?? tmpdir(), 'android-sysprobe-escape.txt'))).toBe(false)
  })
})
