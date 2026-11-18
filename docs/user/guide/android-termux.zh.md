# 在 Android/Termux 上运行 DSH

[English](android-termux.md) | 中文

DSH 没有 Android APK。本页说明在 aarch64 Android 的 [Termux](https://termux.dev/) 中从源码构建的路径。该移植仍使用同一个 `@deepseek-ai/dsh` 包，只在检出中增加 Android-arm64 原生二进制与安装脚本。

## 前置条件

安装 Termux 与以下软件包：

```sh
pkg install nodejs-lts python clang make cmake git binutils
pip install meson ninja
```

Node 必须为 24.9 或更高版本。原生安装还需要 `pkg-config` 以及 `scripts/setup-android-sharp.sh` 列出的 Termux 开发包。

## 从源码安装

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run setup:android
pnpm run build
pnpm run verify:android
```

`pnpm install` 会把固定版本的 `require_builtin.node` 恢复到依赖槽位。`pnpm run setup:android` 随后恢复 bionic flock addon、校验内置 ripgrep，并构建 libvips 与 sharp addon。该命令幂等；任何 `pnpm install --force` 或锁文件变化后都应重新运行。只需要 CLI 时可用 `sh scripts/setup-android.sh --sharp=skip --check`。

## 启动 Web UI

```sh
pnpm dsh web --no-open
```

当 stdout 不是终端时，登录 URL 会以 0600 权限写入 `$DSH_HOME/run/web-<pid>.url`，而不是打印出来。打开该 URL 即签发浏览器 cookie；cookie 默认有效 30 天且跨重启保留，浏览器无需重新登录。该文件在服务器退出时删除，新实例会发布自己的文件。

## 权限模式

Android 没有可用的 bionic 文件沙箱后端：bubblewrap 与 Landlock 不可用，user namespace 被禁用。因此默认部署使用 `danger-full-access` 并输出警告。需要其他模式时显式设置 `DSH_PERMISSION_MODE`：

```sh
DSH_PERMISSION_MODE=danger-full-access pnpm dsh web --no-open
```

在安装沙箱 provider 之前，`read-only` 与 `workspace-write` 会以 `SANDBOX_UNAVAILABLE` fail-closed。不要在未理解该边界的情况下运行不可信提示或工具。

## Exec 能力（W^X）

只有当应用 targetSdk 为 28 或更低时，Android 才允许执行应用 data 目录中的二进制。Termux 当前报告 `targetSdk 28`，因此 `node`、`bash`、`ssh` 和内置 `ripgrep` 都能正常启动子进程。未来若 Termux 使用 `targetSdk ≥ 29`，这些子进程会全部被阻止，而 CLI、Web UI、模型请求与文件工具仍可工作。

DSH 在启动时用 `node -e 0` 与 `$PREFIX/bin/sh -c true` 探测一次。若探测被阻止，启动会记录一条告警，说明 `targetSdk` 规则与规避方式；每次依赖 exec 的调用都会以 `PLATFORM_EXEC_BLOCKED` 失败，而不是随机的 `EACCES`。请让 Termux 继续使用 `targetSdk 28` 构建，或把 node 与 shell 解释器放进应用的 native library（lib）目录——Android 仍允许执行该目录——并让 DSH 指向那里的解释器。

## 可用能力

| 能力 | Android/Termux |
| --- | --- |
| CLI、Web UI、会话、附件 | 可用 |
| 模型请求与工具调用 | 可用 |
| bash 与持久终端 | 可用 |
| `grep` 与 `glob` | 可用，使用内置 ripgrep |
| SSH 执行 | 本机有 `ssh` 客户端且可连接远端时可用 |
| 文件管理器 reveal 与 Open folder | 可用，经 `termux-open`/`xdg-open` |
| CUA、Playwright 自动化 | 不可用 |
| 内核文件沙箱 | 不可用 |
| `pnpm run lint`、`pnpm run duplication`、覆盖率门禁 | 由 Linux CI 负责；Android 原生 binding 不可用 |

## Provider 传输

使用 HTTPS provider 端点；私有 HTTP 端点可通过 SSH 隧道并把 `baseURL` 指向本地回环地址。非 loopback 的明文 HTTP 会以 `INSECURE_BASE_URL` 被拒绝。若端点无法提供 TLS，只有在该 provider 上明确接受“API key、提示与工具输出明文过网”的风险后，才设置 `allowInsecureHttp: true`。

## 验证与 CI

`.github/workflows/android.yml` 通过 SSH/rsync 连接真实设备的 self-hosted runner 运行 Termux lane：安装依赖、执行 `setup:android`、构建产物、运行 `check:android`，并回放可移植的 snapshot。需要内核沙箱或 CUA 的场景在 `snapshot.yml` 中声明 `requires`/`skip.android`，这些路径仍以 Linux/macOS lane 为准。Hosted Linux CI 不能替代该 lane：它无法提供 `process.platform=android`、bionic N-API 或 Android 应用数据文件系统。 注册带有 `self-hosted`、`linux`、`android-device` 标签的 runner，并把仓库 secret `DSH_ANDROID_DEVICE` 设为 Termux 设备的 SSH 目标（可选 `DSH_ANDROID_ROOT` 指定检出根目录）。runner 不存在时该 lane 会持续排队。

## 排障

- `ERR_FLOCK_ADDON_MISSING` 或 `ANDROID_ADDONS_MISSING`：运行 `pnpm run setup:android`。
- `No usable native binding found for node-addon-require-builtin-android-arm64`：在启用 lifecycle scripts 的情况下运行 `pnpm install`，再运行 `pnpm run setup:android`。
- sharp 加载失败：运行 `pnpm run setup:android`；缺失 libvips 时会重建，重装后会从缓存恢复。
- `SEARCH_RG_UNAVAILABLE`：运行 `sh scripts/setup-android.sh`，或安装 Termux 的 `ripgrep` 包。
- `PLATFORM_EXEC_BLOCKED`：启动探测证明 Android 无法执行 app data 中的二进制。请让 Termux 继续使用 `targetSdk 28`，或把 node 与 shell 解释器放进应用 lib 目录后重启 DSH；在此之前依赖 exec 的工具不可用。
- `SANDBOX_UNAVAILABLE`：改用 `DSH_PERMISSION_MODE=danger-full-access` 或安装沙箱 provider；不要期待 Android 内核自带沙箱。

## 升级

拉取源码后重新执行 `pnpm install`、`pnpm run setup:android` 与 `pnpm run build`。升级后旧浏览器 cookie 失效，需要重新打开登录 URL。请保留 `~/.dsh` 备份；源码构建不会上传它。
