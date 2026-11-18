---
description: "platform 包组：应用启动与执行提供方必须共同遵守的宿主平台能力事实，不属于任何单一能力家族。"
kind: "package-group"
---

# platform/ — 宿主平台能力事实

[English](README.md) | 中文

## 概述

`platform/` 组负责多个能力家族必须一致应用的宿主平台事实。这里的包只探测或推导一项平台约束；应用启动、子进程提供方以及未来的执行提供方消费同一份事实，而不是各自解释原始平台错误。本组不持有产品服务，也不拥有工具；失败与降级策略仍由消费方负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`android-exec`](android-exec/README.zh.md) | 启动时探测一次 Android W^X/exec 能力，并发布类型化结果与 `PLATFORM_EXEC_BLOCKED` 分类 |

<a id="related-documentation"></a>
## 相关文档

- [包地图](../README.zh.md) — `platform/` 在所有包组中的位置。
- [boot/](../boot/README.zh.md) — 在 profile 条目挂载前安装 Android 探测。
- [subprocess/](../subprocess/README.zh.md) — 其本地提供方在平台被阻止时终止 exec 工具的能力家族。
- [Android/Termux 指南](../../docs/user/guide/android-termux.zh.md) — 这些事实描述的部署环境。

<a id="dev-note"></a>
## 开发备注

无。
