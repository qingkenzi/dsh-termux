/**
 * Contract tests for `expected/host-requirements.yml`: the declaration that lets
 * the expected-output tier skip a capability-dependent file explicitly instead
 * of failing on a host that cannot reproduce its committed output.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  androidSandboxAvailable,
  expectedHostUnavailable,
  expectedSkipReason,
  parseExpectedHostManifest,
  readExpectedHostManifest,
  type ExpectedHostRequirement,
} from './expected-platform.ts'

const root = fileURLToPath(new URL('.', import.meta.url))

/** Wrap entry YAML under the manifest version header. */
function manifest(scenarios: string): string {
  return `version: 1\nscenarios:\n${scenarios}`
}

const sandboxEntry = `  - file: profiles/headless/tests/example.expected.e2e.ts
    requires: [sandbox]
    reason: Android exposes no file-sandbox backend for the recorded permission events.
`

describe('parseExpectedHostManifest', () => {
  it('accepts a capability with its reviewed platform reason', () => {
    expect(parseExpectedHostManifest(manifest(sandboxEntry))).toEqual({
      version: 1,
      scenarios: [{
        file: 'profiles/headless/tests/example.expected.e2e.ts',
        requires: ['sandbox'],
        reason: 'Android exposes no file-sandbox backend for the recorded permission events.',
      }],
    })
  })

  it('rejects unknown fields instead of ignoring a misspelled declaration', () => {
    expect(() => parseExpectedHostManifest(`${manifest(sandboxEntry)}extra: true\n`)).toThrow('unknown field(s): extra')
    expect(() => parseExpectedHostManifest(manifest(`  - file: a.expected.e2e.ts
    requires: [sandbox]
    detail: because
`))).toThrow('unknown field(s): detail')
  })

  it('rejects an unsupported version and an empty scenario list', () => {
    expect(() => parseExpectedHostManifest('version: 2\nscenarios:\n' + sandboxEntry)).toThrow('version must be 1')
    expect(() => parseExpectedHostManifest('version: 1\nscenarios: []\n')).toThrow('non-empty array')
  })

  it('rejects a repeated driver, an unknown capability, and an empty reason', () => {
    expect(() => parseExpectedHostManifest(manifest(sandboxEntry + sandboxEntry))).toThrow('repeats')
    expect(() => parseExpectedHostManifest(manifest(`  - file: a.expected.e2e.ts
    requires: [network]
`))).toThrow('may only name sandbox or cua')
    expect(() => parseExpectedHostManifest(manifest(`  - file: a.expected.e2e.ts
    skip:
      android: ' '
`))).toThrow('non-empty reason')
  })

  it('requires a capability reason to name the capability it replaces', () => {
    expect(() => parseExpectedHostManifest(manifest(`  - file: a.expected.e2e.ts
    requires: [sandbox]
    reason: Unavailable on this host.
`))).toThrow('must name the unavailable capability sandbox')
    expect(() => parseExpectedHostManifest(manifest(`  - file: a.expected.e2e.ts
    reason: sandbox is missing
`))).toThrow('reason requires a capability list')
  })

  it('rejects a driver path outside the expected-output tree', () => {
    expect(() => parseExpectedHostManifest(manifest(`  - file: ../escape.expected.e2e.ts
    requires: [sandbox]
`))).toThrow('relative POSIX path')
    expect(() => parseExpectedHostManifest(manifest(`  - file: profiles/headless/tests/not-a-driver.ts
    requires: [sandbox]
`))).toThrow('must end with .expected.e2e.ts')
  })
})

describe('expectedSkipReason', () => {
  const requirement: ExpectedHostRequirement = {
    file: 'profiles/headless/tests/example.expected.e2e.ts',
    requires: ['sandbox'],
    reason: 'Android exposes no file-sandbox backend.',
  }

  const noSandbox = { sandbox: 'no working file-sandbox backend' }

  it('uses the reviewed reason on a host that lacks the declared capability', () => {
    expect(expectedSkipReason(requirement, 'android', noSandbox)).toBe('Android exposes no file-sandbox backend.')
    expect(expectedSkipReason(requirement, 'android', {})).toBeUndefined()
  })

  it('leaves a capable host running', () => {
    expect(expectedSkipReason(requirement, 'linux', {})).toBeUndefined()
    expect(expectedSkipReason(requirement, 'darwin', {})).toBeUndefined()
  })

  it('generates a reason that names the missing capability when no platform note exists', () => {
    const bare: ExpectedHostRequirement = { file: requirement.file, requires: ['sandbox'] }
    expect(expectedSkipReason(bare, 'android', noSandbox)).toContain('sandbox (no working file-sandbox backend)')
    expect(expectedSkipReason(bare, 'linux', {})).toBeUndefined()
  })

  it('honours an explicit platform skip without a capability requirement', () => {
    expect(expectedSkipReason({ file: requirement.file, skip: { win32: 'POSIX process semantics only.' } }, 'win32'))
      .toBe('POSIX process semantics only.')
  })
})

describe('host capability probe', () => {
  it('reports the Android sandbox verdict from the shipped supervisor', () => {
    const unavailable = expectedHostUnavailable('android')
    expect(unavailable.cua).toContain('no computer-use helper')
    if (androidSandboxAvailable()) expect(unavailable).not.toHaveProperty('sandbox')
    else expect(unavailable.sandbox).toContain('no working file-sandbox backend')
    expect(expectedHostUnavailable('linux')).toEqual({})
  })
})

describe('committed host-requirements.yml', () => {
  const committed = readExpectedHostManifest()

  it('declares at least one capability-dependent driver', () => {
    expect(committed.scenarios.length).toBeGreaterThan(0)
  })

  it('wires every declared driver to the shared resolver', () => {
    for (const requirement of committed.scenarios) {
      const driver = join(root, ...requirement.file.split('/'))
      expect(readFileSync(driver, 'utf8')).toContain('expectedScenario(import.meta.url)')
    }
  })
})
