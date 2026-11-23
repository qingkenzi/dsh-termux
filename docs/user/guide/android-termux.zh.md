# 在 Android/Termux 上运行 DSH

[English](android-termux.md) | 中文

DSH 没有 Android APK。本页说明在 aarch64 Android 的 [Termux](https://termux.dev/) 中从源码构建的路径。该移植保留同一个 `@deepseek-ai/dsh` 包，只在检出中增加 Android-arm64 原生二进制与安装脚本。

## 前置条件

安装 Termux 与以下软件包：

```sh
pkg install nodejs-lts python clang make cmake git binutils
pip install meson ninja
```

Node 必须为 24.22.3 或更高的 24.x 版本，或 26.13.1 或更高版本，即 `package.json` 中 `engines.node` 的范围。原生安装还需要 `pkg-config` 以及 `scripts/setup-android-sharp.sh` 列出的 Termux 开发包。

## 从源码安装

```sh
git clone https://github.com/qingkenzi/dsh-termux.git deepseek-harness
cd deepseek-harness
pnpm install
pnpm run setup:android
pnpm run build
pnpm run verify:android
```

`pnpm install` 无法提供这些 Android 原生件，因为它们的 npm 平台包没有 bionic 构建。`pnpm run setup:android` 随后把固定版本的 `require_builtin.node` 装回依赖槽位，恢复 bionic flock addon，校验内置的 ripgrep 二进制，并构建 libvips 与 sharp addon。该命令幂等；任何 `pnpm install --force` 或锁文件变化后都应重新运行。只需 CLI 时可用 `sh scripts/setup-android.sh --sharp=skip --check`。

## 启动 Web UI

```sh
pnpm dsh web --no-open
```

服务器会在 stdout 打印 `dsh web: http://...`；在浏览器中打开该 URL 一次即可。浏览器 cookie 会保持配置的有效期（默认 30 天），因此重启服务器后无需再次打开该 URL。`--no-open` 只抑制自动启动浏览器。

## 部署脚本

该移植还在 `deploy/termux/` 提供设备端部署脚本：`dsh` 解析自身旁边的检出，`keep-alive.sh` 负责重启服务器并重新发布登录地址，`dsh-menu.sh` 提供交互菜单，`cutover.sh` 与 `rollback.sh` 在准备好的检出之间切换生效路径。把它们复制到 `~/dsh`，用 `tmux new-session -d -s dsh -n watchdog '~/dsh/keep-alive.sh'` 启动看门狗；文件清单、环境变量与切换/回滚流程见 `deploy/termux/README.md`。

## 权限模式

Android 不提供任何受支持的沙箱后端：bubblewrap、Landlock 与 Seatbelt 在那里都不存在。因此随包发布的 Android 默认值是 `danger-full-access`，即修改文件的工具在无约束下运行；Web UI 打开时，权限选择器会显示该预设。

在没有可用后端的主机上选择受限预设会以 `SANDBOX_UNAVAILABLE` fail-closed。在依赖 `read-only` 或 `workspace-write` 之前请安装沙箱提供方；不要在无法实施限制的部署上运行不可信的提示词或工具。

## 可用能力

| 能力 | Android/Termux |
| --- | --- |
| CLI、Web UI、会话、附件 | 可用 |
| 模型请求与工具调用 | 可用 |
| bash 与持久终端 | 可用 |
| `grep` 与 `glob` | 可用，通过内置的 ripgrep 二进制 |
| SSH 执行 | 本机有 `ssh` 客户端且可连接远端主机时可用 |
| 文件管理器 reveal 与 Open folder | 可用，经 Termux 的 `xdg-open` |
| CUA、Playwright 自动化 | 不可用 |
| 文件沙箱 | 不可用：Android 默认值为 `danger-full-access` |
| SQLite 会话持久化（`session-persistence-sqlite`） | 可用：文件系统拒绝 `link(2)` 时，其路由标记改为独占拷贝发布 |
| `pnpm run lint`、`pnpm run duplication`、覆盖率门禁 | 由 Linux CI 负责；Android 原生 binding 不可用 |

## 验证与 CI

`.github/workflows/android.yml` 在通过 SSH/rsync 连接真实设备的 self-hosted runner 上运行 Termux lane：安装依赖、运行 `setup:android`、构建产物、运行 `check:android`，并回放可移植的快照。

Hosted Linux CI 不能替代该 lane：它无法提供 `process.platform=android`、bionic N-API 或 Android 应用数据文件系统。注册带有 `self-hosted`、`linux`、`android-device` 标签的 runner，并把仓库 secret `DSH_ANDROID_DEVICE` 设为 Termux 设备的 SSH 目标（可选 `DSH_ANDROID_ROOT` 指定检出根目录）。runner 不存在时该 lane 会持续排队。

## 排障

- `ERR_FLOCK_ADDON_MISSING`，或 `pnpm run verify:android` 报出 addon 检查失败：运行 `pnpm run setup:android`。
- `No usable native binding found for node-addon-require-builtin-android-arm64`：先运行 `pnpm install`，再运行 `pnpm run setup:android`。
- sharp 加载失败：运行 `pnpm run setup:android`；缺失 libvips 时会重建，重装后会从缓存恢复。
- `grep` 或 `glob` 无法启动 ripgrep：运行 `pnpm run setup:android` 恢复内置二进制，或安装 Termux 的 `ripgrep` 包。
- `SANDBOX_UNAVAILABLE`：把权限预设切换为 `danger-full-access`，或安装沙箱提供方；此处 Android 内核没有 Harness 支持的后端。

## 升级

拉取源码后重新执行 `pnpm install`、`pnpm run setup:android` 与 `pnpm run build`。由于签名密钥是持久的，浏览器会话在升级后仍然有效；请保留 `~/.dsh` 备份，源码构建不会上传它。设备部署用 `deploy/termux/cutover.sh` 切换，它先跑预检，失败时自动回滚，`deploy/termux/rollback.sh` 则撤销上一次切换；两者见 [deploy/termux/README.zh.md](../../../deploy/termux/README.zh.md)。
