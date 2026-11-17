---
kind: upgrade-guide
description: Web 登录密钥与 Cookie 改为进程级，dist 静态资源默认要求认证，pi-ai 拒绝公网明文 HTTP 端点。
---

# Web 鉴权与传输加固

[English](guide.md) | 中文

## 变更

Web 端不再持久化 Cookie 签名密钥。Token 在进程内存中保存随机密钥，签发有效期一天的 v3 Cookie，并让启动 token 有效十分钟、index 与 `/connect` 各兑换一次；重放、过期与重启都返回401。启动时删除 `client-connection/browser-session` 凭据记录并输出 warning。`POST /_dsh/auth/refresh` 可在首次登录后一天内续签浏览器 Cookie。

WebApp runtime 的 `printUrl` 改为 `auto`、`always`、`never`。`auto` 仅在未自动打开浏览器的交互式终端打印带 token 的 URL；其他调用把 URL 写入 `$DSH_HOME/run/web-<pid>.url`（目录0700、文件0600，退出时删除），stdout 只打印该路径。`always` 打印完整 URL 并警告它是凭据。

frontend dist 除 PWA manifest、图标与 favicon 外的所有文件都要求已认证 Peer，并新增浏览器加固响应头（nosniff、no-referrer、拒绝框架、COOP/CORP、permissions policy、TLS HSTS、Report-Only CSP）。pi-ai 对非 loopback 主机的明文 HTTP `baseURL` 直接拒绝，除非该路由设置 `allowInsecureHttp: true`；失败码为 `INSECURE_BASE_URL`。

## 迁移

1. 删除所有 `authentication-token` 配置中的 `cookieMaxAgeDays`。Token 不接受任何配置；十分钟启动 token 与一天 Cookie 有效期是固定安全约束。携带旧 Cookie 的页面会返回401。
2. 升级后重启一次 `dsh web`，然后在交互式终端打开打印的 URL，或读取 `$DSH_HOME/run/web-<pid>.url`。已打开过或超过十分钟的 URL 返回401；需要新 token 时重启服务器。
3. 原 `printUrl: true` 改为 `always`（仍需从 stdout 拿到 URL 的场景），`false` 改为 `never`。原先解析 `dsh web:` 行的脚本改为读取 stdout 打印的 run 文件路径。
4. 审查不带 Cookie 加载 dist 文件的自定义 shell、抓取器与启动器：静态资源现在返回401。仅安装资源保持匿名，加载页面时必须携带浏览器 Cookie。确认 index 带有新的安全响应头，反向代理不丢弃它们。
5. 逐个检查 pi-ai provider 的 `baseURL`。改为 HTTPS，或通过 SSH 隧道暴露 loopback URL（`ssh -N -L 8080:gateway:8000 user@host`，然后 `http://127.0.0.1:8080/v1`）。仅在可信私有网络设置 `allowInsecureHttp: true`。被拒绝的端点以 `INSECURE_BASE_URL` 失败，消息给出上述修法。
6. 确认：新登录能打开 GUI，刷新后保持登录，旧 Cookie 返回401，`/connect` 重放返回401，启动日志中没有任何 `token=` 行。
