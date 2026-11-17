---
kind: upgrade-guide
description: Web login secrets and Cookies are now process-scoped, every dist asset requires authentication, and pi-ai refuses public plain-HTTP endpoints.
---

# Web authentication and transport hardening

English | [中文](guide.zh.md)

## Change

The Web surface no longer persists its Cookie-signing secret. Token holds a random secret in process memory, mints a v3 Cookie that lasts one day, and accepts the launch token for ten minutes with one exchange for the index and one for `/connect`; replay, expiry, and a restart return 401. The `client-connection/browser-session` credential record is deleted at startup with a warning. `POST /_dsh/auth/refresh` renews a browser Cookie up to the day after its first login.

`printUrl` on the WebApp runtime is now `auto`, `always`, or `never`. `auto` prints the tokenized URL only on an interactive terminal that is not opening a browser; other invocations write `$DSH_HOME/run/web-<pid>.url` (directory 0700, file 0600, removed on exit) and print that path. `always` prints the URL with a credential warning.

The frontend dist now requires an authenticated Peer for every file except the PWA manifest, icons, and favicons, and adds browser-hardening headers (nosniff, no-referrer, frame denial, COOP/CORP, permissions policy, TLS HSTS, Report-Only CSP). pi-ai refuses a `baseURL` using plain HTTP to a non-loopback host unless the route sets `allowInsecureHttp: true`; the failure code is `INSECURE_BASE_URL`.

## Migration

1. Remove `cookieMaxAgeDays` from every `authentication-token` config. Token accepts no settings; the ten-minute launch-token lifetime and one-day Cookie lifetime are fixed. Opening a page with an old Cookie returns 401.
2. Restart `dsh web` once per upgrade, then open the URL printed on an interactive terminal or read `$DSH_HOME/run/web-<pid>.url`. A URL already opened, or one older than ten minutes, returns 401; restart the server for a new token.
3. Replace `printUrl: true` with `always` where captured stdout must still contain the URL, and `false` with `never`. Update scripts that scraped the `dsh web:` line to read the run file printed on stdout.
4. Audit custom shells, fetchers, and launchers that load dist files without a Cookie: static assets now return 401. Keep only the install assets anonymous, and send the browser Cookie for the shell. Confirm the served index carries the new security headers and that a reverse proxy preserves them.
5. For each pi-ai provider, check `baseURL`. Move it to HTTPS, or expose a loopback URL through an SSH tunnel (`ssh -N -L 8080:gateway:8000 user@host` then `http://127.0.0.1:8080/v1`). Set `allowInsecureHttp: true` only for a trusted private network. A rejected endpoint fails with `INSECURE_BASE_URL` and a message naming these remedies.
6. Confirm: a fresh login loads the GUI, a reload keeps it, an old Cookie returns 401, `/connect` replay returns 401, and no startup log line contains `token=`.
