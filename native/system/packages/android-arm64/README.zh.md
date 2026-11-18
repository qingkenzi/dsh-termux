---
description: "为 Android arm64（bionic）提供预编译 Node-API flock addon 与 seccomp supervisor。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system-android-arm64

[English](README.md) | 中文

此平台包提供 `bin/bionic/system.node` 与 `bin/android-sandbox-run`：前者是供 `@deepseek-ai/node-addon-system/flock` 使用的稳定 Node-API v8 addon，后者是供 `@deepseek-ai/node-addon-system/android-sandbox` 使用的 seccomp 用户通知 supervisor。它不包含 Landlock 可执行文件、JavaScript 加载器或安装构建脚本。两个产物都面向使用 bionic libc 的 Android arm64，且每个 `PT_LOAD` 段至少按 0x4000 对齐，因此可在 16 KB 内存页设备上加载。

平台 prepack 用纯 Node 读取器检查每个产物的 ELF 格式、AArch64 架构、声明路径和可执行权限，不会执行任何产物。该 supervisor 是部分边界：它只管辖文档列出的写类系统调用，而不是每个文件操作；详见 [Android supervisor 约定](../../docs/android-sandbox-contract.md)。Termux 构建会从源码编译两个产物；入口包保留 `bin/bionic/system.node` 作为源码兼容副本，供 `scripts/setup-android.sh` 恢复。参见工作区的[支持矩阵](../../docs/support-matrix.md)。
