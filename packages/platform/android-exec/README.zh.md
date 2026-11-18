---
description: "启动时的 Android W^X/exec 探测：确认 node 与 Termux shell 能启动子进程，把缓存结果发布到应用上下文，并将被阻止的平台归类为 PLATFORM_EXEC_BLOCKED。"
kind: "package-library"
---

# @deepseek-ai/dsh-android-exec

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-android-exec` 在启动时一次性证明 DSH 能在 Android 上启动子进程。DSH 以 Termux 应用 uid 运行，Android 的 W^X 策略只允许 targetSdk 为 28 或更低的应用执行 app data 中的二进制。本包启动 `node -e 0` 与 `$PREFIX/bin/sh -c true`，缓存分类后的结果，并在 profile 条目挂载前把它发布为 `ctx.androidExec`。应用启动与本地子进程提供方消费该结果；非 Android 宿主不启动任何进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

`packages/boot/app-boot` 在 `boot()` 期间安装探测，`packages/subprocess/subprocess-local` 在 spawn 前读取已发布的结果。只有在测试探测，或为另一个宿主提供方添加同样的能力检查时，才直接使用本包。不要在每次工具调用时探测：一次启动拥有一个 `AndroidExecProbe` 缓存。

### 入口

```ts
import { AndroidExecProbe, installAndroidExec, probeAndroidExec } from '@deepseek-ai/dsh-android-exec'

const result = await probeAndroidExec()                  // one-shot, non-Android is a no-op
const cached = new AndroidExecProbe()                    // owner-scoped cache
await cached.probe()                                     // later calls return the same result
await installAndroidExec(ctx, 'dsh')                     // publish ctx.androidExec and warn once
```

`probeAndroidExec({ platform, execPath, shellPath, spawn, timeoutMs })` 在同一个时限内以忽略 stdio 的方式启动两条命令。`available: false` 会带上 `reason` 与命令级 `detail`；reason 取值为 `PLATFORM_EXEC_BLOCKED`、`INTERPRETER_MISSING`、`PROBE_TIMEOUT` 或 `PROBE_FAILED`。`installAndroidExec` 发布 `ctx.androidExec`；被阻止的结果会记录一条结构化启动告警，文案指出 Termux 的 `targetSdk ≥ 29` 限制与 app lib 目录的规避方式。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`probeAndroidExec` 解析 `$PREFIX/bin/sh`（否则 `/system/bin/sh`）并并发运行两条命令。每个子进程都有较短的默认时限；超时后用 `SIGKILL` 终止。errno 分类直接读取子进程的 `error.code`，不假设 `Error` 子类：`EACCES`/`EPERM` 映射为 `PLATFORM_EXEC_BLOCKED`，`ENOENT` 映射为 `INTERPRETER_MISSING`，非零退出或畸形结果映射为 `PROBE_FAILED`。`AndroidExecProbe` 同时记忆进行中的 promise 与已结算的值，因此并发调用方共享同一次探测。两条命令都失败时，按上述顺序选择最严重的 reason。

`androidSpawnFailure` 与 `androidExecBlockedMessage` 是共享的报告辅助函数。本地子进程提供方在启动后到达的 spawn 错误上使用它们，包括同步抛出的 `node-pty` 分配错误，使消费方不必在 Android 上分类原始 `EACCES`。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [app-boot](../../boot/app-boot/README.zh.md) — 在 Loader 挂载条目之前安装探测。
- [subprocess-local](../../subprocess/subprocess-local/README.zh.md) — 以 `PLATFORM_EXEC_BLOCKED` 终止 exec 能力。
- [Android/Termux 指南](../../../docs/user/guide/android-termux.zh.md) — 本探测保护的部署环境。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **探测证明的是当前挂载与 targetSdk，而不是未来升级**——Termux 在 DSH 运行期间提高 `targetSdk` 无法被观察，直到下次启动；spawn 的兜底分类能识别之后的 `EACCES`，但无法恢复能力。
- **被阻止的结果会同时禁用所有本地 exec 工具**——bash、持久终端、LSP 服务器与普通子进程调用共享同一个提供方；本包刻意让 Web UI、模型请求与文件工具继续可用，而不是向模型隐藏这些工具。
- **时限是固定的安全边界**——`DEFAULT_ANDROID_EXEC_TIMEOUT_MS` 覆盖健康的 Termux 启动；设备较慢的调用方传入 `timeoutMs`，而不是修改包默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
