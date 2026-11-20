---
description: "暂存文件的排他发布：先硬链接，再以排他复制并刷盘，全程保持“目标不存在才创建”的语义。"
kind: "package-reference"
---

# @deepseek-ai/dsh-util-exclusive-publish

[English](README.md) | 中文

## 概述

`publish-exclusive` 把暂存文件发布到一个必须尚不存在的名字下。它先尝试硬链接，再退化为 `copyFile(..., COPYFILE_EXCL)` 加文件刷盘。两条路径都把竞争失败报告为 `EEXIST`，因此并发创建者保留自己的文件，调用方可以把目标视为权威结果。父目录的 `fsync` 仍由调用方负责，因为本包只发布一个目录项，不刷目录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

发布一个内容已经落盘的暂存文件：

```ts
import { publishExclusive } from '@deepseek-ai/dsh-util-exclusive-publish'

declare const stagedPath: string
declare const finalPath: string

const method = await publishExclusive(stagedPath, finalPath)
// 'linked' and 'copied' keep stagedPath.
```

需要仅属主可读写的会话日志时传入 `mode`，复制路径会在刷盘前应用它：

```ts
await publishExclusive(stagedPath, finalPath, { mode: 0o600 })
```

`EEXIST` 表示另一个写入者已创建目标；本次调用不得删除或替换该文件。复制失败会把被拒绝的硬链接错误挂在 `cause` 上。

### 需要预案的失败

复制在字节尚未写完时就能被读取方看到，因此并发读取可能观察到不完整的副本。复制路径在复制、应用权限或刷盘失败时删除自己的部分结果，并在原始失败之后聚合清理失败。刷盘成功后的 close 失败会拒绝本次调用，但保留已持久化的目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `publishExclusive` 及其复制、权限与刷盘步骤 |

### 发布顺序

1. **硬链接**——`link(2)` 把暂存 inode 发布到第二个名字下。`EACCES`、`EPERM`、`ENOSYS`、`EOPNOTSUPP` 与 `ENOTSUP` 表示宿主拒绝硬链接；其余错误（包括 `EEXIST`）直接抛出。
2. **复制**——`copyFile(..., COPYFILE_EXCL)` 创建新 inode。传入 `mode` 时先应用权限，再以 `fsync` 打开（可写副本用 `r+`，只读副本用 `r`，POSIX 允许），确保发布的文件名不会早于未刷盘的字节。

### 两条路径为何共享同一契约

两条路径都以 `EEXIST` 失败而不是替换已有目标，成功时目标都指向完整字节。它们的差别只在于暂存名是否保留。[Session JSONL 后端](../../session/session-persistence-jsonl/README.zh.md)把复制权限固定为 `0o600`；[附件存储](../../attachment/attachment-local/README.zh.md)保留源权限；[fs-local](../../fs/fs-local/README.zh.md)把暂存文件放在目标旁边，使所有发布路径都留在同一文件系统。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

需要了解消费者或所属族时阅读以下页面。

- [Session JSONL 持久化](../../session/session-persistence-jsonl/README.zh.md)——以排他名字发布会话日志。
- [附件存储](../../attachment/attachment-local/README.zh.md)——发布内容寻址对象与别名。
- [本地文件系统提供方](../../fs/fs-local/README.zh.md)——发布带守卫的创建。
- [util 组地图](../README.zh.md)——本包所属的工具族。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **复制对读取方不是原子的**——另一个进程可能在字节与权限完成前观察到被复制的目标。
- **目录持久化留在调用方**——本包只刷复制的 inode，从不 fsync 目标的父目录。
- **硬链接拒绝取决于宿主的文件系统策略**——Android 应用数据在 SELinux 下返回 `EACCES`，因此那里每次发布都会走复制路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Android 应用数据对 `link(2)` 返回 `EACCES`，因此复制路径在 Termux 上是常规路径，而不是退化边界。需要零拷贝移动的调用方不应在此添加改名：发布语义是“目标不存在才创建”，改名会消耗暂存名。

</details>
