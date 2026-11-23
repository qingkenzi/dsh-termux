# Termux 部署脚本

[English](README.md) | 中文

这些脚本是源码检出外层的 Termux 部署层。它们不属于 `@deepseek-ai/dsh` 包，也不是运行 CLI 的必需项；它们提供启动器、自动重启的看门狗，以及设备上使用的检出切换与回滚脚本。

## 文件

| 文件 | 用途 |
| --- | --- |
| `dsh` | 解析自身旁边的检出或自身所在的检出目录并执行源码 CLI；固定版本的 require-builtin 二进制缺失时恢复 Android addon。 |
| `keep-alive.sh` | 运行 `dsh web`，崩溃后重启，把登录地址发布为 Termux 通知，并在 `~/.dsh/run/watchdog.lock` 持有单实例锁。 |
| `url.sh` | 打印看门狗发布的登录地址，优先读取 `latest.url`，回退到 `web-<pid>.url`。 |
| `relogin.sh` | 重启一次服务器并打印新的登录地址。 |
| `dsh-menu.sh` | 交互式启动、停止、状态与地址菜单；同时带有本机的 pi-web 与 SillyTavern 快捷项。 |
| `cutover.sh` | 把准备好的检出换到线上位置：预检、停止看门狗与服务器、交换目录并修复 git 工作树链接、重启后冒烟，失败时自动回滚。 |
| `rollback.sh` | 反向执行上一次 `cutover.sh` 的交换，重启先前的检出，并把被替换的检出留作排查。 |

## 安装

把脚本复制到存放检出的目录，并赋予可执行权限：

```sh
mkdir -p ~/dsh
cp deploy/termux/dsh deploy/termux/*.sh ~/dsh/
chmod +x ~/dsh/dsh ~/dsh/*.sh
```

在该目录启动看门狗，并打开它推送到 Termux 通知栏的地址：

```sh
tmux new-session -d -s dsh -n watchdog '~/dsh/keep-alive.sh'
```

## 环境变量

`DSH_TERMUX_BASE` 默认为 `$HOME/dsh`，用于定位启动器、检出与 `.logs` 目录。`DSH_HOME` 默认为 `$HOME/.dsh`，用于定位运行目录、会话与设置。看门狗、菜单与 `url.sh` 假定 Web 端口为 `3080`；端口本身由组合后的 profile 决定。看门狗按 `DSH_WATCHDOG_URL_WAIT_SECONDS`（默认 180 秒）等待首个登录地址，因为源码冷启动要在绑定端口前先编译整个应用。

`dsh` 按顺序在两个位置解析检出：先找 `$DSH_TERMUX_BASE/deepseek-harness`，再找脚本自身所在的目录。因此脚本既可以放在 `deepseek-harness` 检出旁边，也可以直接放进检出根目录。

## 迁移脚本

`cutover.sh` 与 `rollback.sh` 不再写死版本：路径、期望版本与期望分支都来自环境变量，默认值即上面的目录布局。切换会校验两个检出、停止看门狗与服务器、交换 `CUTOVER_FROM` 与 `CUTOVER_TO`（先前的检出去到 `CUTOVER_ASIDE`）、重写 git 工作树链接、重启看门狗，并验证重启后的服务器：登录地址可访问、服务进程运行于线上路径、版本与分支符合期望。停服后的任何失败都会撤销交换并重启先前的检出。`rollback.sh` 执行反向交换，把被替换的检出留在 `CUTOVER_FAILED`。两者都支持 `--check`，只做预检，请先运行它。在新构建验证通过前请保留 aside 检出，因为在当前布局里它持有线上工作树的 `.git` 文件所指向的 git 目录。涉及的变量为 `DSH_TERMUX_BASE`、`CUTOVER_FROM`、`CUTOVER_TO`、`CUTOVER_ASIDE`、`CUTOVER_FAILED`、`CUTOVER_EXPECT_FROM`、`CUTOVER_EXPECT_TO`、`CUTOVER_BRANCH`、`CUTOVER_URL_WAIT_SECONDS`、`ROLLBACK_EXPECT`、`ROLLBACK_BRANCH` 与 `DSH_HOME`。

## 注意

登录地址携带 bearer token；看门狗以 `600` 权限写入 `latest.url`。请把它当作凭据，不要提交。看门狗锁记录持有者的 pid，只有持有者退出时才会删除该锁。
