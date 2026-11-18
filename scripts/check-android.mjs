#!/usr/bin/env node
/**
 * Android/Termux acceptance checks for a built source checkout.
 *
 * The step list deliberately uses the same entry points a user runs: the
 * setup verifier, the native-addon verifier, the platform-package tests, and
 * the built CLI. A non-Android host fails instead of reporting success, so a
 * green `check:android` always means the lane ran on a device; set
 * DSH_ANDROID_CHECK_ALLOW_SKIP=1 to opt out explicitly.
 */

import { spawnSync } from 'node:child_process'

const ALLOW_SKIP_ENV = 'DSH_ANDROID_CHECK_ALLOW_SKIP'

if (process.platform !== 'android') {
  if (process.env[ALLOW_SKIP_ENV] !== '1') {
    console.error(
      `check-android: this check targets Android; ${process.platform}/${process.arch} cannot run it. `
      + `Set ${ALLOW_SKIP_ENV}=1 to skip explicitly.`,
    )
    process.exit(1)
  }
  console.log(`check-android: skipped (${process.platform}/${process.arch}); ${ALLOW_SKIP_ENV}=1`)
  process.exit(0)
}

const MINUTE_MS = 60_000

/**
 * One command with its display label, hard timeout, and optional failure hint.
 * `quiet` hides the step banner for commands that are expected to be silent.
 */
const steps = [
  {
    label: 'Android setup verification',
    command: 'sh',
    args: ['scripts/setup-android.sh', '--check'],
    timeoutMs: 10 * MINUTE_MS,
    hint: 'run "pnpm run setup:android" to restore the Android native addons, then rerun this check',
  },
  {
    label: 'Android native addons',
    command: 'node',
    args: ['scripts/verify-android-addons.mjs'],
    timeoutMs: 2 * MINUTE_MS,
  },
  {
    label: 'Android system package matrix',
    command: 'node',
    args: ['--test', 'native/system/test/package-matrix.test.js'],
    timeoutMs: 5 * MINUTE_MS,
  },
  {
    label: 'Android seccomp supervisor',
    command: 'native/system/packages/android-arm64/bin/android-sandbox-run',
    args: ['--probe'],
    timeoutMs: 2 * MINUTE_MS,
    hint: 'run "pnpm run build:native-system" to build the seccomp supervisor, then rerun this check',
  },
  {
    label: 'Bundled ripgrep',
    command: 'sh',
    args: ['scripts/setup-android-rg.sh', '--verify'],
    timeoutMs: 2 * MINUTE_MS,
    hint: 'run "pnpm run setup:android" to restore the bundled ripgrep binary',
  },
  {
    label: 'Built CLI version',
    command: 'node',
    args: ['apps/cli/lib/bin.js', '--version'],
    timeoutMs: 2 * MINUTE_MS,
    hint: 'run "pnpm run build:artifacts" to produce apps/cli/lib/bin.js',
  },
  {
    label: 'Built CLI web configuration',
    command: 'node',
    args: ['apps/cli/lib/bin.js', '--profile', 'web', '--dump-config'],
    timeoutMs: 2 * MINUTE_MS,
    quiet: true,
    hint: 'run "pnpm run build:artifacts" to produce apps/cli/lib/bin.js',
  },
]

/** Report a failed step, its hint, and exit non-zero. */
function fail(label, message, hint) {
  console.error(`check-android: ${label} ${message}`)
  if (hint !== undefined) console.error(`check-android: ${hint}`)
  process.exit(1)
}

for (const step of steps) {
  if (step.quiet !== true) console.log(`\ncheck-android: ${step.label}`)
  const timeoutSeconds = String(step.timeoutMs / 1000)
  const result = spawnSync(step.command, step.args, {
    // Successful setup/verification steps keep their evidence in the CI log.
    stdio: step.quiet === true ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    env: process.env,
    timeout: step.timeoutMs,
  })
  if (result.error !== undefined) {
    const message = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutSeconds}s`
      : `failed to start: ${result.error.message}`
    fail(step.label, message, step.hint)
  }
  if (result.signal !== null) fail(step.label, `was terminated by ${result.signal}`, step.hint)
  if (result.status !== 0) {
    fail(step.label, `failed with exit ${String(result.status)}`, step.hint)
  }
}

console.log('\ncheck-android: all Android checks passed')
