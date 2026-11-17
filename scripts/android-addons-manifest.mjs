#!/usr/bin/env node
/**
 * Regenerate `vendor/android-prebuilds/addons.manifest.json` from the committed
 * Android binaries. The manifest pins each file's size and SHA-256 so
 * `setup-android.sh`, `stage-android-addons.ts`, and the package postinstall
 * verify the same bytes. Rewriting is deterministic: file order is fixed and
 * the output has no timestamp.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this script rather than the invoking directory. */
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Files committed under `vendor/android-prebuilds` and covered by the manifest. */
export const ANDROID_ADDON_FILES = Object.freeze(['require_builtin.node', 'system.node', 'rg'])

/** Manifest name inside the vendor directory; the package staging copy reuses it. */
export const ANDROID_ADDONS_MANIFEST = 'addons.manifest.json'

/**
 * Compute the manifest for a vendor directory.
 * @param {string} [vendorDirectory] - directory holding the prebuilt binaries.
 * @returns {Promise<{schemaVersion: number, target: string, algorithm: string, files: Record<string, {size: number, sha256: string}>}>} the deterministic manifest value.
 */
export async function computeAndroidAddonsManifest(vendorDirectory = join(REPOSITORY_ROOT, 'vendor', 'android-prebuilds')) {
  const files = {}
  for (const name of ANDROID_ADDON_FILES) {
    const path = join(vendorDirectory, name)
    const content = await readFile(path)
    files[name] = {
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  }
  return {
    schemaVersion: 1,
    target: 'aarch64-linux-android',
    algorithm: 'sha256',
    files,
  }
}

/**
 * Write the manifest for a vendor directory.
 * @param {string} [vendorDirectory] - directory holding the prebuilt binaries.
 * @returns {Promise<string>} the manifest path that was written.
 */
export async function writeAndroidAddonsManifest(vendorDirectory = join(REPOSITORY_ROOT, 'vendor', 'android-prebuilds')) {
  const manifestPath = join(vendorDirectory, ANDROID_ADDONS_MANIFEST)
  const manifest = await computeAndroidAddonsManifest(vendorDirectory)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

if (import.meta.main) {
  const vendorDirectory = process.argv[2]
    ?? (process.env.DSH_ANDROID_PREBUILDS_DIR ?? join(REPOSITORY_ROOT, 'vendor', 'android-prebuilds'))
  // A missing binary or an unreadable directory fails the command; the previous manifest stays untouched.
  const manifestPath = await writeAndroidAddonsManifest(vendorDirectory)
  console.log(`wrote ${manifestPath}`)
}
