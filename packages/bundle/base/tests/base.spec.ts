/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = parseEntryYaml(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'",
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-deepseek-api')).toEqual({ id: 'web-deepseek-api', name: '@deepseek-ai/dsh-web-deepseek-api' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'web-search-deepseek')).toMatchObject({
      name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    })
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-fetch-http')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-deepseek-api')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-search-deepseek')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
  it('resolves the deployment mode and approval policy from the startup authority', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    const rowOf = (id: string): Record<string, unknown> => {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      return row
    }
    const jsExpr = (id: string, field: string): string => {
      const value = (rowOf(id).config as Record<string, unknown>)[field] as { __jsExpr?: string } | undefined
      if (value?.__jsExpr === undefined) throw new Error(`${id}.${field} must be a !!js expression`)
      return value.__jsExpr
    }

    // The startup row is the authority: the environment states an explicit mode
    // only, and this deployment accepts the no-backend fallback explicitly.
    expect(rowOf('sandbox-startup')).toMatchObject({
      name: '@deepseek-ai/dsh-sandbox-startup',
      config: { onUnavailable: 'danger-full-access' },
    })
    expect(jsExpr('sandbox-startup', 'mode')).toBe('process.env.DSH_PERMISSION_MODE')
    expect(rowOf('sandbox-policy')).toMatchObject({ inject: ['sandboxStartup'] })
    expect(jsExpr('sandbox-policy', 'mode')).toBe('ctx.sandboxStartup.mode')
    expect(rowOf('approval')).toMatchObject({ inject: ['sandboxStartup'] })
    expect(jsExpr('approval', 'policy')).toBe('ctx.sandboxStartup.approvalPolicy')
    // No row keeps a duplicated platform expression beside the authority.
    const serialized = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(serialized).not.toContain("process.platform === 'android'")
  })

  it('carries a permission preset for every startup decision', async () => {
    const { resolveDefaultMode } = await import('@deepseek-ai/dsh-sandbox-startup')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    const permission = rows.find(candidate => candidate.id === 'permission')
    const presets = (permission?.config as { presets?: Record<string, { sandbox: string, approval: string }> } | undefined)?.presets
    if (presets === undefined) throw new Error('the base patch must configure the permission preset table')
    const availability = (available: boolean) => ({
      available,
      backend: available ? 'bwrap' : 'none',
      enforcement: available ? 'full' as const : 'none' as const,
      reason: 'reason',
      remediation: 'remediation',
    })
    // Every decision the startup authority can publish must land on a selectable
    // preset; a default mode outside the table cannot be pinned into a session.
    for (const explicit of [undefined, 'read-only', 'workspace-write', 'danger-full-access'] as const) {
      for (const onUnavailable of ['ask', 'danger-full-access'] as const) {
        for (const available of [true, false]) {
          let decision
          try {
            decision = resolveDefaultMode({
              ...explicit === undefined ? {} : { mode: explicit },
              availability: availability(available),
              onUnavailable,
            })
          } catch {
            continue
          }
          expect(
            Object.values(presets).some(spec => spec.sandbox === decision.mode && spec.approval === decision.approvalPolicy),
            `${decision.mode} + ${decision.approvalPolicy}`,
          ).toBe(true)
        }
      }
    }
    expect(Object.keys(presets)).toContain('workspace-write')
  })
})
