/** Stage the Android prebuilt binaries inside the published `dsh` package. */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this script rather than the invoking directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Committed prebuilts and their manifest. */
const VENDOR_DIRECTORY = join(REPOSITORY_ROOT, 'vendor', 'android-prebuilds')

/** Package-local copy that `apps/cli/package.json` publishes, and the manifest name it shares with the vendor directory. */
const STAGED_DIRECTORY = join(REPOSITORY_ROOT, 'apps', 'cli', 'vendor', 'android-prebuilds')
const MANIFEST_NAME = 'addons.manifest.json'

/** Files the CLI package needs at runtime; the flock addon stays a source-checkout concern. */
const STAGED_FILES = ['require_builtin.node', 'rg'] as const

/** One pinned binary. */
interface AndroidAddonEntry {
  readonly size: number
  readonly sha256: string
}

/** The vendor manifest's validated subset used here. */
interface AndroidAddonsManifest {
  readonly schemaVersion: number
  readonly target: string
  readonly algorithm: string
  readonly files: Readonly<Record<string, AndroidAddonEntry>>
}

/** Staged file content captured before the destination is replaced. */
interface StagedFile {
  readonly name: (typeof STAGED_FILES)[number]
  readonly content: Buffer
  readonly mode: number
  readonly entry: AndroidAddonEntry
}

/**
 * Replace the package's staged Android addons with a verified copy of the vendor files.
 *
 * All sources are verified before the destination is touched, so a corrupt
 * prebuild cannot leave a partially staged package. Runs from the `prepack`
 * lifecycle of `@deepseek-ai/dsh`; `postpack` calls {@link cleanStagedAndroidAddons}.
 * @param source - Vendor directory holding the binaries and manifest; defaults to `vendor/android-prebuilds`.
 * @param destination - Package directory receiving the copy; defaults to `apps/cli/vendor/android-prebuilds`.
 * @returns Resolves after the destination holds the verified binaries and their manifest subset.
 * @throws When the manifest is invalid, a file is missing, or size and SHA-256 disagree with it.
 */
export async function stageAndroidAddons(
  source: string = VENDOR_DIRECTORY,
  destination: string = STAGED_DIRECTORY,
): Promise<void> {
  const manifest = await readManifest(join(source, MANIFEST_NAME))
  const staged: StagedFile[] = []
  for (const name of STAGED_FILES) {
    const entry = manifest.files[name]
    if (entry === undefined) throw new Error(`stage-android-addons: ${MANIFEST_NAME} has no entry for ${name}`)
    const path = join(source, name)
    const content = await readFile(path)
    if (content.byteLength !== entry.size) {
      throw new Error(`stage-android-addons: ${path} is ${content.byteLength} bytes; ${MANIFEST_NAME} records ${entry.size}`)
    }
    if (sha256(content) !== entry.sha256) {
      throw new Error(`stage-android-addons: ${path} does not match its ${MANIFEST_NAME} SHA-256`)
    }
    staged.push({ name, content, mode: name === 'rg' ? 0o755 : 0o644, entry })
  }

  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const file of staged) {
    const target = join(destination, file.name)
    await writeFile(target, file.content)
    await chmod(target, file.mode)
  }
  const stagedManifest: AndroidAddonsManifest = {
    schemaVersion: manifest.schemaVersion,
    target: manifest.target,
    algorithm: manifest.algorithm,
    files: Object.fromEntries(staged.map(file => [file.name, file.entry])),
  }
  await writeFile(join(destination, MANIFEST_NAME), `${JSON.stringify(stagedManifest, null, 2)}\n`)
}

/**
 * Remove the staged copy, so no pack leaves a stale tree for the next one.
 * @param destination - Package directory to remove; defaults to `apps/cli/vendor/android-prebuilds`.
 * @returns Resolves after the directory is absent.
 */
export async function cleanStagedAndroidAddons(destination: string = STAGED_DIRECTORY): Promise<void> {
  await rm(destination, { recursive: true, force: true })
}

/**
 * Read and validate the vendor manifest.
 * @param path - Manifest file path.
 * @returns the validated manifest.
 * @throws When the file is not a JSON object with the expected fields.
 */
async function readManifest(path: string): Promise<AndroidAddonsManifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.target !== 'string'
    || value.algorithm !== 'sha256' || !isRecord(value.files)) {
    throw new Error(`stage-android-addons: ${path} is not a supported Android addons manifest`)
  }
  const files: Record<string, AndroidAddonEntry> = {}
  for (const [name, entry] of Object.entries(value.files)) {
    if (!isRecord(entry) || typeof entry.size !== 'number' || typeof entry.sha256 !== 'string') {
      throw new Error(`stage-android-addons: ${path} has an invalid entry for ${name}`)
    }
    files[name] = { size: entry.size, sha256: entry.sha256 }
  }
  return { schemaVersion: 1, target: value.target, algorithm: 'sha256', files }
}

/**
 * Whether a JSON value is a non-array object.
 * @param value - Parsed JSON value.
 * @returns whether the value is a record.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Hash file content with the algorithm the manifest records.
 * @param content - Complete file content.
 * @returns lowercase hexadecimal SHA-256.
 */
function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

if (import.meta.main) {
  if (process.argv.includes('--clean')) await cleanStagedAndroidAddons()
  else await stageAndroidAddons()
}
