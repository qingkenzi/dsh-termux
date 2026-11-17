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

当 stdout 不是终端时，登录 URL 会以 0600 权限写入 `$DSH_HOME/run/web-<pid>.url`，而不是打印出来。打开一次该 URL；服务器随后设置浏览器 cookie。cookie 最长有效一天，且每次服务器重启都会撤销，因此重启后需从 run 文件重新打开 URL。服务器退出时会删除该文件。

## 权限模式

Android 没有可用的 bionic 文件沙箱后端：bubblewrap 与 Landlock 不可用，user namespace 被禁用。因此默认部署使用 `danger-full-access` 并输出警告。需要其他模式时显式设置 `DSH_PERMISSION_MODE`：

```sh
DSH_PERMISSION_MODE=danger-full-access pnpm dsh web --no-open
```

在安装沙箱 provider 之前，`read-only` 与 `workspace-write` 会以 `SANDBOX_UNAVAILABLE` fail-closed。不要在未理解该边界的情况下运行不可信提示或工具。

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

`.github/workflows/android.yml` 通过 SSH/rsync 连接真实设备的 self-hosted runner 运行 Termux lane：安装依赖、执行 `setup:android`、构建产物、运行 `check:android`，并回放可移植的 snapshot。需要内核沙箱或 CUA 的场景在 `snapshot.yml` 中声明 `requires`/`skip.android`，这些路径仍以 Linux/macOS lane 为准。Hosted Linux CI 不能替代该 lane：它无法提供 `process.platform=android`、bionic N-API 或 Android 应用数据文件系统。
## 排障

- `ERR_FLOCK_ADDON_MISSING` 或 `ANDROID_ADDONS_MISSING`：运行 `pnpm run setup:android`。
- `No usable native binding found for node-addon-require-builtin-android-arm64`：在启用 lifecycle scripts 的情况下运行 `pnpm install`，再运行 `pnpm run setup:android`。
- sharp 加载失败：运行 `pnpm run setup:android`；缺失 libvips 时会重建，重装后会从缓存恢复。
- `SEARCH_RG_UNAVAILABLE`：运行 `sh scripts/setup-android.sh`，或安装 Termux 的 `ripgrep` 包。
- `SANDBOX_UNAVAILABLE`：改用 `DSH_PERMISSION_MODE=danger-full-access` 或安装沙箱 provider；不要期待 Android 内核自带沙箱。

## 升级

拉取源码后重新执行 `pnpm install`、`pnpm run setup:android` 与 `pnpm run build`。升级后旧浏览器 cookie 失效，需要重新打开登录 URL。请保留 `~/.dsh` 备份；源码构建不会上传它。
