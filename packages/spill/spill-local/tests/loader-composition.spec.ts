/**
 * Real-composition proof: a cordis.yml loaded by the vendored Loader applies
 * spill-local configuration and completes its fiber-owned startup cleanup.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSpillStore, { sessionDir } from '@deepseek-ai/dsh-spill-local'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether OS temp roots satisfy the cleanup sweep's POSIX ancestor policy.
 * `resolveRoot` refuses a root below a group-writable, non-sticky ancestor
 * owned by another local user: on Android the system-owned `/data` chain fails
 * that check, so the real Loader's startup sweep is correctly rejected before
 * it touches a fixture seeded from `tmpdir()`. CI hosts with the usual sticky
 * `/tmp` keep full coverage.
 */
const tempRootIsTrustworthy = (() => {
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  const uid = process.geteuid()
  try {
    let child = tmpdir()
    let childStats = statSync(child)
    for (;;) {
      const parent = dirname(child)
      if (parent === child) return true
      const stats = statSync(parent)
      const writableByOthers = (stats.mode & 0o022) !== 0
      const sticky = (stats.mode & 0o1000) !== 0
      if (writableByOthers && (!sticky || childStats.uid !== uid)) return false
      child = parent
      childStats = stats
    }
  } catch {
    return false
  }
})()

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('spill-local real Loader composition through cordis.yml', () => {
  it.skipIf(!tempRootIsTrustworthy)('loads cleanupPeriodDays and prunes only expired session contents', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-spill-loader-'))
    const oldDir = sessionDir(root, 'old-session')
    const freshDir = sessionDir(root, 'fresh-session')
    await mkdir(oldDir, { recursive: true })
    await mkdir(freshDir, { recursive: true })
    const old = join(oldDir, 'old.txt')
    const fresh = join(freshDir, 'fresh.txt')
    await writeFile(old, 'old')
    await writeFile(fresh, 'fresh')
    const now = Date.now()
    await utimes(old, (now - 40 * DAY_MS) / 1000, (now - 40 * DAY_MS) / 1000)
    await utimes(fresh, (now - DAY_MS) / 1000, (now - DAY_MS) / 1000)

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-spill-local'",
      '  config:',
      `    root: ${JSON.stringify(root)}`,
      '    cleanupPeriodDays: 30',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-spill-local') throw new Error(`unexpected Loader import: ${specifier}`)
        return LocalSpillStore
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    await context.fiber.dispose()
    context = undefined

    expect(existsSync(old)).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(freshDir)).toBe(true)
    expect(existsSync(root)).toBe(true)
  }, 30_000)
})
