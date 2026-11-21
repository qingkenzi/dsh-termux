# Termux 部署脚本

[English](README.md) | 中文

这些脚本是源码检出外层的 Termux 部署层。它们不属于 `@deepseek-ai/dsh` 包，也不是运行 CLI 的必需项；它们提供启动器、自动重启的看门狗，以及设备上使用的一次性检出迁移脚本。

## 文件

| 文件 | 用途 |
| --- | --- |
| `dsh` | 解析自身旁边的检出并执行源码 CLI；固定版本的 require-builtin 二进制缺失时恢复 Android addon。 |
| `keep-alive.sh` | 运行 `dsh web`，崩溃后重启，把登录地址发布为 Termux 通知，并在 `~/.dsh/run/watchdog.lock` 持有单实例锁。 |
| `url.sh` | 打印看门狗发布的登录地址，优先读取 `latest.url`，回退到 `web-<pid>.url`。 |
| `relogin.sh` | 重启一次服务器并打印新的登录地址。 |
| `dsh-menu.sh` | 交互式启动、停止、状态与地址菜单；同时带有本机的 pi-web 与 SillyTavern 快捷项。 |
| `cutover-rc5.sh` | rc.3 到 rc.5 的一次性检出交换，含预检、重启后冒烟与失败自动回滚。 |
| `rollback-rc3.sh` | 撤销 `cutover-rc5.sh` 执行的交换。 |

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

`DSH_TERMUX_BASE` 默认为 `$HOME/dsh`，用于定位启动器、检出与 `.logs` 目录。`DSH_HOME` 默认为 `$HOME/.dsh`，用于定位运行目录、会话与设置。看门狗、菜单与 `url.sh` 假定 Web 端口为 `3080`；端口本身由组合后的 profile 决定。

## 迁移脚本

`cutover-rc5.sh` 与 `rollback-rc3.sh` 固定对应 rc.3 与 rc.5 的包版本。切换会校验两个构建、停止看门狗与服务器、交换两个检出、重写 git 工作树链接，并在报告成功前验证重启后的服务器。复用到其他版本前请修改版本常量与检出名，先运行 `cutover-rc5.sh --check`，并保留 rc.3 检出，因为仓库的 git 目录在它里面。

## 注意

登录地址携带 bearer token；看门狗以 `600` 权限写入 `latest.url`。请把它当作凭据，不要提交。看门狗锁记录持有者的 pid，只有持有者退出时才会删除该锁。
