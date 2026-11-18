---
description: "Prebuilt Node-API flock addon and seccomp supervisor for Android arm64 (bionic)."
kind: "package-library"
---
# @deepseek-ai/node-addon-system-android-arm64

English | [中文](README.zh.md)

This platform package supplies `bin/bionic/system.node`, a stable Node-API v8 addon used by `@deepseek-ai/node-addon-system/flock`, and `bin/android-sandbox-run`, the seccomp user-notification supervisor used by `@deepseek-ai/node-addon-system/android-sandbox`. It contains no Landlock executable, JavaScript loader, or installation build script. Both payloads target Android arm64 with bionic libc, and every `PT_LOAD` segment is aligned to at least 0x4000 so they load on 16 KB page devices.

Platform prepack checks each payload's ELF format, AArch64 architecture, declared path, and executable permission with a pure Node reader; it never executes a payload. The supervisor is a partial boundary: it mediates the documented write syscalls, not every file effect, as the [Android supervisor contract](../../docs/android-sandbox-contract.md) records. The Termux build compiles both payloads from source, and the entry keeps `bin/bionic/system.node` as a source-compatible copy for `scripts/setup-android.sh`. See the workspace [support matrix](../../docs/support-matrix.md).
