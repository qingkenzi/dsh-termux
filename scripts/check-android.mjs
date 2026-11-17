#!/usr/bin/env node
/**
 * Android/Termux acceptance checks for a built source checkout.
 *
 * The step list deliberately uses the same entry points a user runs: the
 * setup verifier, the native-addon verifier, the platform-package tests, and
 * the built CLI. Non-Android hosts skip the lane so the script is safe to run
 * from shared developer commands.
 */

import { spawnSync } from 'node:child_process'

if (process.platform !== 'android') {
  console.log(`check-android: skipped (${process.platform}/${process.arch}); this check targets Android`)
  process.exit(0)
}

/** One command with a human-readable label. */
const steps = [
  ['Android setup verification', 'sh', ['scripts/setup-android.sh', '--check']],
  ['Android native addons', 'node', ['scripts/verify-android-addons.mjs']],
  ['Android system package matrix', 'node', ['--test', 'native/system/test/package-matrix.test.js']],
  ['Bundled ripgrep', 'sh', ['scripts/setup-android-rg.sh', '--verify']],
  ['Built CLI version', 'node', ['apps/cli/lib/bin.js', '--version']],
  ['Built CLI web configuration', 'node', ['apps/cli/lib/bin.js', '--profile', 'web', '--dump-config']],
]

for (const [label, command, args] of steps) {
  console.log(`\ncheck-android: ${label}`)
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
  })
  if (result.error !== undefined) {
    console.error(`check-android: ${label} failed to start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`check-android: ${label} failed with exit ${String(result.status)}`)
    process.exit(result.status ?? 1)
  }
}

console.log('\ncheck-android: all Android checks passed')
