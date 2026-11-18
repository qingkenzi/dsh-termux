/**
 * The headless overlay's sandbox rows: a one-shot run has no user to ask, so
 * the deployment states its no-backend fallback explicitly and reads the
 * starting mode from the same startup authority the base bundle mounts.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'

/** Every patch row in the headless overlay, in file order. */
function rows(): Record<string, unknown>[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = parseEntryYaml(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'))
  if (!Array.isArray(parsed)) throw new TypeError('headless patch must parse to a patch list')
  return parsed.flatMap((patch): Record<string, unknown>[] =>
    typeof patch === 'object' && patch !== null ? [patch as Record<string, unknown>] : [],
  )
}

/** The single row with this id. */
function row(id: string): Record<string, unknown> {
  const found = rows().find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`headless patch must address ${id}`)
  return found
}

/** The `!!js` expression carried by one config field. */
function jsExpr(id: string, field: string): string {
  const value = (row(id).config as Record<string, unknown>)[field] as { __jsExpr?: string } | undefined
  if (value?.__jsExpr === undefined) throw new Error(`${id}.${field} must be a !!js expression`)
  return value.__jsExpr
}

describe('dsh-headless sandbox rows', () => {
  it('states the deployment fallback when this host has no backend', () => {
    expect(row('sandbox-startup')).toMatchObject({
      config: { onUnavailable: 'danger-full-access' },
    })
    expect(jsExpr('sandbox-startup', 'mode')).toBe('process.env.DSH_PERMISSION_MODE')
  })

  it('keeps the deployment mode and the CLI grants on the same policy row', () => {
    expect(row('sandbox-policy')).toMatchObject({ inject: ['headlessStartup', 'sandboxStartup'] })
    expect(jsExpr('sandbox-policy', 'mode')).toBe('ctx.sandboxStartup.mode')
    expect(jsExpr('sandbox-policy', 'additionalWritableRoots')).toBe('ctx.headlessStartup.additionalWritableRoots')
  })
})
