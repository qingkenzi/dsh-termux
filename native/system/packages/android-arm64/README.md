---
description: "Prebuilt Node-API flock addon for Android arm64 (bionic)."
kind: "package-library"
---
# @deepseek-ai/node-addon-system-android-arm64

English | [中文](README.zh.md)

This platform package supplies `bin/bionic/system.node`, a stable Node-API v8 addon used by `@deepseek-ai/node-addon-system/flock`. It contains no Landlock executable, JavaScript loader, or installation build script. The addon targets Android arm64 with bionic libc, and every `PT_LOAD` segment is aligned to at least 0x4000 so it loads on 16 KB page devices.

Platform prepack checks the payload's ELF format, AArch64 architecture, Node-API exports, and declared path with a pure Node reader; it never executes the addon. The Termux build compiles this payload from source, and the entry keeps `bin/bionic/system.node` as a source-compatible copy for `scripts/setup-android.sh`. See the workspace [support matrix](../../docs/support-matrix.md).
