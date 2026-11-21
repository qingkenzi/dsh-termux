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
git clone https://github.com/qingkenzi/dsh-termux.git
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

The server prints `dsh web: http://...` on stdout; open that URL once in a browser. The browser cookie keeps the configured lifetime (30 days by default), so a server restart does not require opening the URL again. `--no-open` suppresses the automatic browser launch only.

## Deployment scripts

The fork also ships the device launcher and watchdog in `deploy/termux/`: `dsh` resolves the checkout beside it, `keep-alive.sh` restarts the server and republishes the login URL, and `dsh-menu.sh` adds an interactive menu. Copy them into `~/dsh` and start the watchdog with `tmux new-session -d -s dsh -n watchdog '~/dsh/keep-alive.sh'`; `deploy/termux/README.md` lists the files, environment variables, and the one-shot rc.3-to-rc.5 migration scripts.

## Permission mode

Android carries no supported sandbox backend: bubblewrap, Landlock, and Seatbelt do not exist there. The shipped Android default is therefore `danger-full-access`, which means file-modifying tools run unconfined; the permission picker shows that preset when the Web UI opens.

Selecting a confined preset on a host without a working backend fails closed with `SANDBOX_UNAVAILABLE`. Install a sandbox provider before relying on `read-only` or `workspace-write`, and do not run untrusted prompts or tools on a deployment that cannot confine.

## What works

| Capability | Android/Termux |
| --- | --- |
| CLI, Web UI, Sessions, attachments | Yes |
| Model requests and tool calls | Yes |
| bash and persistent terminals | Yes |
| `grep` and `glob` | Yes, through the bundled ripgrep binary |
| SSH execution | Yes, when a local `ssh` client and remote host are available |
| File-manager reveal and Open folder | Yes, through `xdg-open`/`termux-open` |
| CUA, Playwright automation | No |
| File sandbox | No: the Android default is `danger-full-access` |
| SQLite Session persistence (`session-persistence-sqlite`) | No: its routing marker publishes with `link(2)`, which Android app data refuses; the shipped profiles use JSONL |
| `pnpm run lint`, `pnpm run duplication`, coverage gate | Linux CI; Android native bindings are unavailable |

## Verification and CI

`.github/workflows/android.yml` runs the Termux lane on a self-hosted runner that reaches a real device over SSH/rsync. It installs dependencies, runs `setup:android`, builds artifacts, runs `check:android`, and replays the portable snapshots.

Hosted Linux CI does not substitute for this lane: it cannot provide `process.platform=android`, bionic N-API, or the Android app-data filesystem. Register a runner labelled `self-hosted`, `linux`, and `android-device`; set the repository secret `DSH_ANDROID_DEVICE` to the SSH destination of a Termux device (and optionally `DSH_ANDROID_ROOT` to its checkout root). The lane stays queued until that runner exists.

## Troubleshooting

- `ERR_FLOCK_ADDON_MISSING` or `ANDROID_ADDONS_MISSING`: run `pnpm run setup:android`.
- `No usable native binding found for node-addon-require-builtin-android-arm64`: run `pnpm install` with lifecycle scripts enabled, then `pnpm run setup:android`.
- sharp load failure: run `pnpm run setup:android`; it rebuilds libvips when absent and restores the cached addon after a reinstall.
- `grep` or `glob` cannot start ripgrep: run `pnpm run setup:android` to restore the bundled binary, or install the Termux `ripgrep` package.
- `SANDBOX_UNAVAILABLE`: switch the permission preset to `danger-full-access`, or install a sandbox provider; the Android kernel has no backend the Harness supports here.

## Upgrading

Pull the source, run `pnpm install`, `pnpm run setup:android`, and `pnpm run build` again. The browser session survives the upgrade because the signing secret is durable; keep `~/.dsh` backed up, since the source build does not upload it.
