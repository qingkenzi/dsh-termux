---
description: "Prebuilt system primitives for Linux confinement and POSIX Session write locks."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

## Summary

Use the Linux `landlock-run` executable or the Android `android-sandbox-run` seccomp supervisor to confine subprocesses, or the `./flock` entry to acquire a POSIX write lock. Platform packages contain the precompiled binaries; consumer installation never builds native code. Landlock policy and Session lifecycle remain with callers.

## Table of Contents

- [Use](#use)
- [Support](#support)
- [Development](#development)

## Use

`@deepseek-ai/node-addon-system/landlock-run` exports `launcherPath`, `probe`, and `grantArgs` for Landlock. Its executable name, flags, and failure semantics are defined by the [CLI contract](docs/cli-contract.md).

`@deepseek-ai/node-addon-system/android-sandbox` exports `androidSandboxRunnerPath`, `androidSandboxArgs`, and `probeAndroidSandbox` for the Android seccomp supervisor. Its flags, exit codes, and report line are defined by the [Android supervisor contract](docs/android-sandbox-contract.md). The supervisor is a partial boundary: it mediates the documented write syscalls, not every file effect.

The [flock behavior contract](docs/flock-contract.md) maps descriptor, process, and advisory-lock semantics to independent native tests.

`@deepseek-ai/node-addon-system/flock` exports `tryLockExclusive(fd): Promise<void>`. Keep the descriptor open until completion. Acquisition uses nonblocking exclusive flock; contention rejects with `EAGAIN` or `EWOULDBLOCK`, and closing the final descriptor for the open file description releases the lock. See the [entry README](packages/entry/README.md).

Importing either entry does not load an addon. A missing Landlock executable probes unusable; a missing flock binding rejects acquisition. Neither path compiles or silently grants unsupported behavior.

## Support

Linux x64/arm64 packages contain the static Landlock executable and separate glibc/musl `system.node` files. macOS x64/arm64 packages contain `system.node` only. The Android arm64 package contains the bionic `system.node` and the `android-sandbox-run` supervisor; it has no Landlock executable, declares no libc variant, and aligns every `PT_LOAD` segment for 16 KB page devices. Landlock additionally needs an enforcing Linux kernel; Windows uses the Harness's existing locking implementation. The [support matrix](docs/support-matrix.md) names builders and verification owners.

## Development

From this directory, `pnpm build:ts` builds the entry, `pnpm build:native` builds the host's declared native payload, and `pnpm build:test-oracle` builds an independent flock syscall fixture. Then `pnpm test` exercises entry, lock, packaging, and available kernel behavior. Linux requires musl-gcc for a complete build; macOS uses cc. The root `pnpm run build:native-system` builds only the current host addon for source tests. On Android, both build commands compile the bionic flock addon into `packages/android-arm64/bin/bionic/system.node`, keep `packages/entry/bin/bionic/system.node` as a source-compatible copy, and build the seccomp supervisor at `packages/android-arm64/bin/android-sandbox-run`; the build fails when a `PT_LOAD` segment is aligned below 0x4000.

The [architecture](docs/architecture.md), [packaging](docs/packaging.md), and [release procedure](docs/release.md) own implementation and publication details.

### Dev Note

None.
