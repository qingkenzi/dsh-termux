/**
 * Host-capability declarations for the owner-local expected-output tier.
 *
 * `pnpm run test:expected` runs assembled CLI expectations on every host, but a
 * committed output may record facts only a host with a working file-sandbox
 * backend can produce. `expected/host-requirements.yml` declares those files,
 * the capabilities they need, and the reviewed per-platform reason. This module
 * resolves that declaration into an explicit, printed skip instead of a silent
 * failure or an inferred timeout.
 * @module expected-platform
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { it } from 'vitest'

/** Host capability an expected-output file may require. */
export type ExpectedCapability = 'sandbox' | 'cua'

/** Platform key an expected-output file may name in an explicit skip. */
export type ExpectedSkipPlatform = 'android' | 'win32' | 'darwin' | 'linux'

/** One expected-output file's host requirement. */
export interface ExpectedHostRequirement {
  /** Path from `apps/cli/tests/` to the owning `*.expected.e2e.ts` file, with `/` separators. */
  readonly file: string
  /** Capabilities the committed output records; a host without one cannot run the file. */
  readonly requires?: readonly ExpectedCapability[]
  /** Reviewed reason printed when a declared capability is unavailable; names each capability. */
  readonly reason?: string
  /** Explicit per-platform skip reasons for output that cannot apply there at all. */
  readonly skip?: Partial<Record<ExpectedSkipPlatform, string>>
}

/** Parsed `expected/host-requirements.yml`. */
export interface ExpectedHostManifest {
  /** Manifest format version. */
  readonly version: 1
  /** One entry per file whose committed output depends on a host capability or platform. */
  readonly scenarios: readonly ExpectedHostRequirement[]
}

/** One file's resolved host decision plus its test registrar. */
export interface ExpectedScenario {
  /** Why this file's scenarios do not run on this host, or undefined when they do. */
  readonly skipReason: string | undefined
  /**
   * Register one expected-output test. On a host that lacks a declared
   * capability the test is recorded as skipped with the printed reason instead
   * of running a comparison its host cannot reproduce.
   * @param title - the test title reported by the runner.
   * @param body - the assertions to run when the host satisfies the declaration.
   * @param timeout - optional per-test timeout in milliseconds.
   * @returns Nothing.
   */
  it(title: string, body: () => void | Promise<void>, timeout?: number): void
}

const CAPABILITIES: readonly ExpectedCapability[] = ['sandbox', 'cua']
const SKIP_PLATFORMS: readonly ExpectedSkipPlatform[] = ['android', 'win32', 'darwin', 'linux']
const ROOT_KEYS = ['version', 'scenarios']
const ENTRY_KEYS = ['file', 'requires', 'reason', 'skip']

/** The directory holding every expected-output driver. */
const TESTS_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Capabilities each known host cannot exercise for a reason other than the
 * sandbox backend, with the reason the runner prints. The Android sandbox
 * entry is resolved separately because the shipped Android supervisor can
 * provide one.
 */
const HOST_UNAVAILABLE: Partial<Record<NodeJS.Platform, Readonly<Partial<Record<ExpectedCapability, string>>>>> = {
  android: {
    cua: 'Android exposes no computer-use helper',
  },
}

/**
 * Ask the committed Android supervisor whether this device actually has a
 * file-effect backend. A deployment without one cannot reproduce the recorded
 * sandbox events, so the expected tier must skip rather than fail its compare.
 * @returns true when the seccomp listener and its probe both work.
 */
export function androidSandboxAvailable(): boolean {
  const runner = join(TESTS_ROOT, '../../../native/system/packages/android-arm64/bin/android-sandbox-run')
  if (!existsSync(runner)) return false
  const probe = spawnSync(runner, ['--probe'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  // A probe that never settled is not evidence of a missing backend: run the
  // scenario so its own assertion fails loudly instead of a silent skip.
  if (probe.status === null) return true
  return probe.status === 0 && /Seccomp: 2/u.test(probe.stdout)
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`)
}

function singleLine(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty reason`)
  }
  if (/[\r\n]/u.test(value)) throw new Error(`${label} must be a single line`)
  return value.trim()
}

/** Parse one comma-separated capability list as YAML yields it (array form). */
function capabilities(value: unknown, label: string): ExpectedCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const seen = new Set<string>()
  return value.map((item) => {
    if (typeof item !== 'string' || !CAPABILITIES.includes(item as ExpectedCapability)) {
      throw new Error(`${label} may only name ${CAPABILITIES.join(' or ')}, got ${JSON.stringify(item)}`)
    }
    if (seen.has(item)) throw new Error(`${label} repeats ${item}`)
    seen.add(item)
    return item as ExpectedCapability
  })
}

/**
 * Parse and structurally validate one host-requirements manifest without
 * reading the files it names.
 * @param source - complete manifest text.
 * @param path - diagnostic path for errors.
 * @returns the validated declaration.
 */
export function parseExpectedHostManifest(source: string, path = 'host-requirements.yml'): ExpectedHostManifest {
  let parsed: unknown
  try {
    parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA })
  } catch (error) {
    throw new Error(`${path}: invalid YAML: ${String(error)}`)
  }
  const root = mapping(parsed, path)
  exactKeys(root, ROOT_KEYS, path)
  if (root.version !== 1) throw new Error(`${path}.version must be 1`)
  if (!Array.isArray(root.scenarios) || root.scenarios.length === 0) {
    throw new Error(`${path}.scenarios must be a non-empty array`)
  }
  const files = new Set<string>()
  const scenarios = root.scenarios.map((raw, index): ExpectedHostRequirement => {
    const label = `${path}.scenarios[${index}]`
    const entry = mapping(raw, label)
    exactKeys(entry, ENTRY_KEYS, label)
    if (typeof entry.file !== 'string' || entry.file.trim().length === 0) {
      throw new Error(`${label}.file must name an expected-output driver`)
    }
    const file = entry.file
    if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      throw new Error(`${label}.file must be a relative POSIX path inside apps/cli/tests`)
    }
    if (!file.endsWith('.expected.e2e.ts')) {
      throw new Error(`${label}.file must end with .expected.e2e.ts`)
    }
    if (files.has(file)) throw new Error(`${label}.file repeats ${file}`)
    files.add(file)
    const requires = entry.requires === undefined ? undefined : capabilities(entry.requires, `${label}.requires`)
    let reason: string | undefined
    if (entry.reason !== undefined) {
      const value = singleLine(entry.reason, `${label}.reason`)
      if (requires === undefined) throw new Error(`${label}.reason requires a capability list`)
      const unnamed = requires.filter(capability => !value.toLowerCase().includes(capability))
      if (unnamed.length > 0) {
        throw new Error(`${label}.reason must name the unavailable capability ${unnamed.join(', ')}`)
      }
      reason = value
    }
    let skip: Partial<Record<ExpectedSkipPlatform, string>> | undefined
    if (entry.skip !== undefined) {
      const rawSkip = mapping(entry.skip, `${label}.skip`)
      exactKeys(rawSkip, SKIP_PLATFORMS, `${label}.skip`)
      const reasons = Object.entries(rawSkip).map(([platform, value]) => [
        platform as ExpectedSkipPlatform,
        singleLine(value, `${label}.skip.${platform}`),
      ] as const)
      if (reasons.length === 0) throw new Error(`${label}.skip must name at least one platform`)
      skip = Object.fromEntries(reasons) as Partial<Record<ExpectedSkipPlatform, string>>
    }
    if (requires === undefined && skip === undefined) {
      throw new Error(`${label} must declare requires or skip`)
    }
    return {
      file,
      ...(requires === undefined ? {} : { requires }),
      ...(reason === undefined ? {} : { reason }),
      ...(skip === undefined ? {} : { skip }),
    }
  })
  return { version: 1, scenarios }
}

/**
 * Read and validate the committed manifest, confirming every declared driver
 * exists and still owns committed expected output.
 * @param root - directory holding the expected-output drivers; defaults to `apps/cli/tests`.
 * @returns the validated declaration.
 * @throws when a declared driver or its `expected/` tree is missing, so a
 *   capability declaration cannot hide a deleted fixture.
 */
export function readExpectedHostManifest(root = TESTS_ROOT): ExpectedHostManifest {
  const path = join(root, 'expected', 'host-requirements.yml')
  const manifest = parseExpectedHostManifest(readFileSync(path, 'utf8'), relative(process.cwd(), path) || path)
  for (const requirement of manifest.scenarios) {
    const driver = join(root, ...requirement.file.split('/'))
    if (!existsSync(driver) || !statSync(driver).isFile()) {
      throw new Error(`host-requirements.yml names ${requirement.file}, which is not a file`)
    }
    const expectedRoot = join(dirname(driver), 'expected')
    if (!existsSync(expectedRoot) || !statSync(expectedRoot).isDirectory()) {
      throw new Error(`host-requirements.yml names ${requirement.file}, which owns no expected/ output tree`)
    }
    const owned = readdirSync(expectedRoot, { recursive: true }).filter(entry => {
      const path = join(expectedRoot, entry.toString())
      return existsSync(path) && statSync(path).isFile()
    })
    if (owned.length === 0) {
      throw new Error(`host-requirements.yml names ${requirement.file}, whose expected/ output tree is empty`)
    }
  }
  return manifest
}

/**
 * The capabilities one host cannot exercise, with the reason printed for each.
 * A host absent from the table is assumed to provide every declared capability;
 * the Linux/macOS CI lanes remain the authority for those paths.
 * @param platform - host `process.platform` value.
 * @returns the reason per unavailable capability.
 */
export function expectedHostUnavailable(
  platform: NodeJS.Platform = process.platform,
): Readonly<Partial<Record<ExpectedCapability, string>>> {
  if (platform === 'android') {
    return {
      ...HOST_UNAVAILABLE.android,
      ...(androidSandboxAvailable()
        ? {}
        : { sandbox: 'Android exposes no working file-sandbox backend (the seccomp supervisor probe failed), so confined operations fail closed' }),
    }
  }
  return HOST_UNAVAILABLE[platform] ?? {}
}

/**
 * Resolve whether one declared requirement runs on this host.
 * @param requirement - one validated manifest entry.
 * @param platform - host `process.platform` value.
 * @param unavailable - this host's capability verdict; defaults to {@link expectedHostUnavailable}.
 * @returns the declared reason, a generated reason naming the missing
 *   capability, or undefined when the host satisfies the declaration.
 */
export function expectedSkipReason(
  requirement: ExpectedHostRequirement,
  platform: NodeJS.Platform = process.platform,
  unavailable: Readonly<Partial<Record<ExpectedCapability, string>>> = expectedHostUnavailable(platform),
): string | undefined {
  const missing = (requirement.requires ?? []).filter(capability => unavailable[capability] !== undefined)
  if (missing.length > 0) {
    if (requirement.reason !== undefined) return requirement.reason
    const detail = missing.map(capability => `${capability} (${unavailable[capability] ?? ''})`).join('; ')
    return `requires ${detail}`
  }
  return requirement.skip?.[platform as ExpectedSkipPlatform]
}

/** The committed manifest, read once per worker process. */
let committed: ExpectedHostManifest | undefined

/**
 * Resolve one expected-output driver's host decision.
 * @param testFileUrl - the driver's `import.meta.url`.
 * @returns its declared skip reason (when this host cannot run it) and the
 *   registrar that prints that reason while recording the skip.
 * @throws when the committed manifest is invalid or names a missing fixture.
 */
export function expectedScenario(testFileUrl: string): ExpectedScenario {
  committed ??= readExpectedHostManifest()
  const file = relative(TESTS_ROOT, fileURLToPath(testFileUrl)).split(sep).join('/')
  const requirement = committed.scenarios.find(entry => entry.file === file)
  const skipReason = requirement === undefined ? undefined : expectedSkipReason(requirement)
  return {
    skipReason,
    it(title, body, timeout) {
      if (skipReason === undefined) {
        it(title, body, timeout)
        return
      }
      console.warn(`test:expected: skipping "${title}" on ${process.platform}: ${skipReason}`)
      it(title, context => { context.skip(skipReason) }, timeout)
    },
  }
}
