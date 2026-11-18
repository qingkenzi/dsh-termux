# Run DSH on Android with Termux

English | [中文](android-termux.zh.md)

DSH has no Android APK. This page describes the source-build path in [Termux](https://termux.dev/) on aarch64 Android. The port keeps the same `@deepseek-ai/dsh` package and adds Android-arm64 native binaries and setup scripts to the checkout.

## Prerequisites

Install Termux and these packages:

```sh
pkg install nodejs-lts python clang make cmake git binutils
pip install meson ninja
```

Node must be 24.9 or newer. The native setup also expects `pkg-config` and the Termux development packages listed by `scripts/setup-android-sharp.sh`.

## Install from source

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run setup:android
pnpm run build
pnpm run verify:android
```

`pnpm install` restores the pinned `require_builtin.node` into its dependency slot. `pnpm run setup:android` then restores the bionic flock addon, verifies the bundled ripgrep binary, and builds libvips plus the sharp addon. The command is idempotent; run it again after any `pnpm install --force` or lockfile change. Use `sh scripts/setup-android.sh --sharp=skip --check` when only the CLI is needed.

## Start the Web UI

```sh
pnpm dsh web --no-open
```

When stdout is not a terminal, the login URL is written to `$DSH_HOME/run/web-<pid>.url` with mode 0600 instead of being printed. Opening the URL signs a browser cookie; the cookie lasts 30 days by default and survives a restart, so the browser stays signed in. The file itself is removed when the server exits, and the new instance publishes its own.

## Permission mode

Android has no usable bionic file-sandbox backend: bubblewrap and Landlock are unavailable, and user namespaces are disabled. The default deployment therefore uses `danger-full-access` and logs a warning. Set `DSH_PERMISSION_MODE` explicitly when you need another mode:

```sh
DSH_PERMISSION_MODE=danger-full-access pnpm dsh web --no-open
```

`read-only` and `workspace-write` fail closed with `SANDBOX_UNAVAILABLE` until a sandbox provider is installed. Do not run untrusted prompts or tools without understanding this boundary.

## Exec capability (W^X)

Android permits executing binaries from an app's data directory only while the app targets API 28 or lower. Termux currently reports `targetSdk 28`, so `node`, `bash`, `ssh`, and the bundled `ripgrep` start normally. A future Termux build with `targetSdk ≥ 29` would block every one of those child processes while the CLI, Web UI, model requests, and file tools keep working.

DSH probes this once during startup with `node -e 0` and `$PREFIX/bin/sh -c true`. If the probe is blocked, startup logs one warning naming the `targetSdk` rule and the workaround, and each exec-based call fails with `PLATFORM_EXEC_BLOCKED` instead of a random `EACCES`. Keep Termux on a `targetSdk 28` build, or move the node and shell interpreters into the app's native library (lib) directory, which Android still permits executing, and point DSH at them there.

## What works

| Capability | Android/Termux |
| --- | --- |
| CLI, Web UI, Sessions, attachments | Yes |
| Model requests and tool calls | Yes |
| bash and persistent terminals | Yes |
| `grep` and `glob` | Yes, through the bundled ripgrep binary |
| SSH execution | Yes, when a local `ssh` client and remote host are available |
| File-manager reveal and Open folder | Yes, through `termux-open`/`xdg-open` |
| CUA, Playwright automation | No |
| Kernel file sandbox | No |
| `pnpm run lint`, `pnpm run duplication`, coverage gate | Linux CI; Android native bindings are unavailable |

## Provider transport

Use an HTTPS provider endpoint, or reach a private HTTP endpoint through an SSH tunnel and point `baseURL` at the loopback end. Plain HTTP to a non-loopback host is refused with `INSECURE_BASE_URL`. If the endpoint cannot offer TLS, set `allowInsecureHttp: true` on that provider only after accepting that API keys, prompts, and tool output cross the network in clear text.

## Verification and CI

`.github/workflows/android.yml` runs the Termux lane on a self-hosted runner that reaches a real device over SSH/rsync. It installs dependencies, runs `setup:android`, builds artifacts, runs `check:android`, and replays the portable snapshots. Scenarios that need a kernel sandbox or CUA declare `requires`/`skip.android` in `snapshot.yml`; their Linux/macOS lanes remain the authority for those paths. Hosted Linux CI does not substitute for this lane: it cannot provide `process.platform=android`, bionic N-API, or the Android app-data filesystem. Register a runner labelled `self-hosted`, `linux`, and `android-device`; set the repository secret `DSH_ANDROID_DEVICE` to the SSH destination of a Termux device (and optionally `DSH_ANDROID_ROOT` to its checkout root). The lane stays queued until that runner exists.

## Troubleshooting

- `ERR_FLOCK_ADDON_MISSING` or `ANDROID_ADDONS_MISSING`: run `pnpm run setup:android`.
- `No usable native binding found for node-addon-require-builtin-android-arm64`: run `pnpm install` with lifecycle scripts enabled, then `pnpm run setup:android`.
- sharp load failure: run `pnpm run setup:android`; it rebuilds libvips when absent and restores the cached addon after a reinstall.
- `SEARCH_RG_UNAVAILABLE`: run `sh scripts/setup-android.sh` or install the Termux `ripgrep` package.
- `PLATFORM_EXEC_BLOCKED`: startup proved Android cannot execute binaries from app data. Keep Termux at `targetSdk 28`, or place the node and shell interpreters in the app lib directory and restart DSH; exec-based tools stay unavailable until then.
- `SANDBOX_UNAVAILABLE`: switch to `DSH_PERMISSION_MODE=danger-full-access` or install a sandbox provider; do not expect Android's kernel sandbox to exist.

## Upgrading

Pull the source, run `pnpm install`, `pnpm run setup:android`, and `pnpm run build` again. Old browser cookies are invalid after the upgrade, so reopen the login URL. Keep `~/.dsh` backed up; the source build does not upload it.
