---
description: "部署沙箱模式的启动权威：把显式配置、宿主后端可用性与声明的无后端策略解析为唯一模式、其配套审批策略，以及进程级可用性报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-startup

[English](README.md) | 中文

## 摘要

`dsh-sandbox-startup` 决定部署从哪个文件作用域模式启动，并发布为 `ctx.sandboxStartup`。它向已挂载的沙箱提供者询问本机究竟能强制什么，优先采用显式配置的模式；否则在有后端的宿主上选择 `workspace-write`，无后端时按部署声明的策略处理。所有随发行版提供的 bundle 都读取解析出的模式，而不是各自重复一段平台表达式，因此没有后端的宿主不会悄悄滑入无约束执行：显式要求的受限模式会 fail-closed，GUI 策略则保持受限模式并报告用户尚未做出选择。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在同时挂载 `@deepseek-ai/dsh-sandbox` 与 `@deepseek-ai/dsh-sandbox-policy` 的组合中挂载它，并让 `sandbox-policy.mode` 指向 `ctx.sandboxStartup.mode`。

### 何时选择它

凡默认沙箱模式需要跟随宿主能力、而不是写死平台表的部署都应选择它。仅当组合直接声明模式时才可跳过——那时该行就是权威，也不存在可用性报告。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-sandbox-startup'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE
    onUnavailable: ask
```

`mode` 是部署的显式模式（随发行版 bundle 中取自 `DSH_PERMISSION_MODE`；headless 的 `--permission-mode` 是按会话选择权限预设，优先级更高）。留空即把选择交给宿主能力。

### 决策

`resolveDefaultMode()` 是显式模式、宿主可用性判定与 `onUnavailable` 的纯函数，按以下顺序解析：

1. 显式 `danger-full-access`——视为部署自身的声明并接受。
2. 显式受限模式，且宿主有后端。
3. 显式受限模式，但宿主无后端——抛出 `SandboxStartupUnavailableError`（`SANDBOX_STARTUP_UNAVAILABLE`），指出宿主原因、补救方式与确切的覆盖写法。
4. 无显式模式，且宿主有后端——`workspace-write`。
5. 无显式模式，且宿主无后端——`onUnavailable: 'danger-full-access'` 接受无约束效果，`'ask'` 保持受限模式并报告 `awaitingChoice`，`'fail'` 抛错。

`ask` 是 GUI 默认，`fail` 是 headless 默认。两者都不会自行走到 `danger-full-access`：受限操作会经提供者的 `SANDBOX_UNAVAILABLE` 拒绝而 fail-closed，只有用户显式确认风险的预设切换才会运行无约束工作。

## 理解实现

服务在构造时解析一次——提供者为同一进程生命周期缓存后端链判定——并在初始化期间发出 `sandbox/availability-changed`，让进程级消费者先订阅再读取。配套的 `approvalPolicy` 仅在接受了无约束模式时为 `never`；因此 `ask` 与 `fail` 部署保留受限部署会用的审批提示。`awaitingChoice` 标记 GUI 状态：横幅与 chip 说明本机没有后端，更宽的模式仍由用户决定。

可用性本身是提供者的报告：`available`、`backend`、`enforcement`（`full`、`partial` 或 `none`）、面向用户的 `reason`，以及可执行的 `remediation`。提供者的 `availability()` 从不抛错；无法解析的判定会变成 `available: false` 并附上原因，使部署能够解释并选择，而不是崩溃。这条规则在此尤为重要：本服务在构造函数中调用提供者，若探针失败以抛错报告，就会拖垮整个组合而不是报告宿主。

## 延伸阅读

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐次调用策略、提供者链与 fail-closed 错误。
- [`dsh-sandbox`](../sandbox/README.zh.md)——约束 seam 与可用性报告契约。
- [`dsh-sandbox-policy`](../sandbox-policy/README.zh.md)——本服务供给的逐次调用策略归属地。
- [`dsh-permission-presets`](../../interaction/permission-presets/README.zh.md)——其表行即启动服务解析出的模式/审批配对。

## 模型体验

间接，经由 [`dsh-sandbox-policy`](../sandbox-policy/README.zh.md) 的运行时上下文快照承载本服务解析出的模式。

#### KV 缓存影响

无直接失效；只有当部署模式的改变本身会改变策略文本时，解析出的模式才会影响它。

## 已知限制与后续工作

- 判定每个进程只解析一次；运行期间新装的后端在重启前不会生效。
- 现有 bundle 都没有把待定选择做成阻塞式首次运行模态框：GUI 在权限 chip 上显示强制程度后缀，并在其选择器中显示原因与补救方式，而受限操作在用户切换预设前保持 fail-closed。
- `onUnavailable: 'ask'` 没有确认通道，因此接受无约束工作的用户通过既有的完全权限风险确认完成，而不是启动对话框。
