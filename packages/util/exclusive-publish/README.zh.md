---
description: "暂存文件的排他发布：先硬链接，再 renameat2(RENAME_NOREPLACE)，最后以排他复制并刷盘，全程保持“目标不存在才创建”的语义。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-exclusive-publish

[English](README.md) | 中文

## 概述

`publish-exclusive` 把暂存文件发布到一个必须尚不存在的名字下。它先尝试硬链接；对于拒绝硬链接但允许零拷贝改名的宿主，再尝试 `renameat2(RENAME_NOREPLACE)`；最后退化为 `copyFile(..., COPYFILE_EXCL)` 加文件刷盘。三条路径都把竞争失败报告为 `EEXIST`，因此并发创建者保留自己的文件，调用方可以把目标视为权威结果。父目录的 `fsync` 仍由调用方负责，因为本包只发布一个目录项，不刷目录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

发布一个已经持久化的暂存文件：

```ts
import { publishExclusive } from '@deepseek-ai/dsh-util-exclusive-publish'

declare const stagedPath: string
declare const finalPath: string

const method = await publishExclusive(stagedPath, finalPath)
// 'linked' and 'copied' keep stagedPath; 'renamed' consumes it.
```

需要仅属主可读写的会话日志时传入 `mode`；必须让暂存名继续作为另一个有效名字存在时传入 `rename: null`，它会跳过零拷贝改名，绝不移动暂存文件：

```ts
await publishExclusive(stagedPath, finalPath, { mode: 0o600 })
await publishExclusive(existingObjectPath, aliasPath, { rename: null })
```

`EEXIST` 表示另一个写入方创建了目标；本次调用不得删除或替换该文件。改名返回的 `EXDEV` 与 `ENOENT` 会向上抛出，因为复制无法修复它们：调用方给出的目标路径无法通过改名到达。复制失败会把被拒绝的硬链接错误放进 `cause`。

### 需要预案的失败

复制过程中，读取方可能看到尚未写完的字节，因此与发布竞争的读取方可能观察到不完整的副本。复制、应用权限或刷盘失败时，复制路径会删除自己的不完整结果；清理失败会聚合在原错误之后。刷盘已经成功、随后关闭描述符失败时，调用会被拒绝，但已持久的副本保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源文件映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `publishExclusive` 及其复制、权限与刷盘步骤 |
| [`src/renameat2.ts`](src/renameat2.ts) | 基于 koffi 的 `renameat2(RENAME_NOREPLACE)` 声明与 errno 映射 |

### 发布顺序

1. **硬链接**——`link(2)` 把暂存 inode 以第二个名字发布。`EACCES`、`EPERM`、`ENOSYS`、`EOPNOTSUPP` 与 `ENOTSUP` 表示宿主拒绝硬链接；其余错误（包括 `EEXIST`）直接抛出。
2. **改名**——`renameat2(RENAME_NOREPLACE)` 移动暂存名，不复制字节。它通过 koffi 从 libc 的 `renameat2` 符号声明，或从原始 `syscall` 符号声明，arm64 使用编号 276，x86_64 使用 316。`ENOSYS`、`EINVAL` 与 `EOPNOTSUPP` 会继续尝试复制；其余错误（包括 `EXDEV`、`ENOENT` 与 `EEXIST`）直接抛出。没有 koffi、两个符号都不存在或没有对应系统调用编号的宿主按 `ENOSYS` 处理。
3. **复制**——`copyFile(..., COPYFILE_EXCL)` 创建新 inode。给出 `mode` 时先应用权限，再打开副本执行 `fsync`（`r+`；只读副本用 `r`，POSIX 允许），因此已发布的名字不会留下未刷盘的内容。

### 三条路径为何共享同一契约

三条路径都以 `EEXIST` 失败而不是替换已有目标，成功时目标都指向完整字节。它们的差别只在于暂存名的去向，以及读取方能否观察到中间状态。[Session JSONL 后端](../../session/session-persistence-jsonl/README.zh.md)把复制权限固定为 `0o600`；[附件存储](../../attachment/attachment-local/README.zh.md)保留源权限，并在为必须保留规范名的对象建立别名时禁用改名；[fs-local](../../fs/fs-local/README.zh.md)把暂存文件放在目标旁边，使所有发布路径都留在同一文件系统。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

需要了解消费方或本原语所属的包族时，阅读以下页面。

- [Session JSONL 持久化](../../session/session-persistence-jsonl/README.zh.md)——以排他名字发布会话日志。
- [附件存储](../../attachment/attachment-local/README.zh.md)——发布内容寻址对象与别名。
- [本地文件系统提供方](../../fs/fs-local/README.zh.md)——发布带防护的创建。
- [util 包族地图](../README.zh.md)——本包所属的工具族。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **复制发布对读取方不是原子的**——另一个进程可能在副本的字节与权限完成之前看到目标。
- **改名会消耗暂存名**——需要暂存名继续存在时，调用方必须传入 `rename: null`，并接受硬链接或复制路径。
- **目录持久性仍由调用方负责**——本包刷新复制的 inode，但从不 fsync 目标的父目录。
- **`renameat2` 仅限 Linux**——没有可用硬链接的 macOS 与 Windows 宿主通过复制发布。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

原始系统调用兜底覆盖 libc 省略 `renameat2` 符号的 Linux 架构。只有拿到该架构系统调用表的证据后，才向 `RENAMEAT2_SYSCALL` 添加编号；未列出的架构报告能力不可用并改为复制。

</details>
