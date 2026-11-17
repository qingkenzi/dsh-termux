/** Types for the plain-ESM Android postinstall restore script. */

/** Options accepted by {@link installAndroidAddons}. */
export interface InstallAndroidAddonsOptions {
  /** Platform override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** CLI package root; defaults to the directory above this script. */
  packageRoot?: string
  /** Explicit prebuilt directory; defaults to the staged copy, then the source-checkout vendor tree. */
  sourceDirectory?: string
}

/** The action the restore performed. */
export interface AndroidAddonInstallResult {
  status: 'not-android' | 'current' | 'installed'
}

/**
 * Copy the pinned Android require-builtin addon into the installed dependency.
 * @param options - platform, package root, and optional prebuilt directory.
 * @returns the action taken.
 */
export function installAndroidAddons(options?: InstallAndroidAddonsOptions): Promise<AndroidAddonInstallResult>
