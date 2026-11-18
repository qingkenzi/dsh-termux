---
description: "Boot-time Android W^X/exec probe: proves node and the Termux shell can start children, publishes the cached result to the application context, and classifies a blocked platform as PLATFORM_EXEC_BLOCKED."
kind: "package-library"
---

# @deepseek-ai/dsh-android-exec

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-android-exec` proves once at boot that DSH can start child processes on Android. DSH runs under the Termux app uid, where Android's W^X policy allows executing binaries from app data only while the app targets API 28 or lower. The package starts `node -e 0` and `$PREFIX/bin/sh -c true`, caches the classified result, and publishes it as `ctx.androidExec` before profile entries mount. App boot and the local subprocess provider consume it; on non-Android hosts the probe starts no process.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

`packages/boot/app-boot` installs the probe during `boot()`, and `packages/subprocess/subprocess-local` reads the published result before it spawns. Use the package directly only to test the probe or to add the same capability check to another host provider. Do not probe per tool call: one boot owns one `AndroidExecProbe` cache.

### Entry point

```ts
import { AndroidExecProbe, installAndroidExec, probeAndroidExec } from '@deepseek-ai/dsh-android-exec'

const result = await probeAndroidExec()                  // one-shot, non-Android is a no-op
const cached = new AndroidExecProbe()                    // owner-scoped cache
await cached.probe()                                     // later calls return the same result
await installAndroidExec(ctx, 'dsh')                     // publish ctx.androidExec and warn once
```

`probeAndroidExec({ platform, execPath, shellPath, spawn, timeoutMs })` starts both commands with ignored stdio under one bound. `available: false` carries a `reason` and a command-level `detail`; the reasons are `PLATFORM_EXEC_BLOCKED`, `INTERPRETER_MISSING`, `PROBE_TIMEOUT`, and `PROBE_FAILED`. `installAndroidExec` publishes `ctx.androidExec`, and an unavailable result logs one structured startup warning; a blocked one names the Termux `targetSdk ≥ 29` restriction and the app-lib workaround.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`probeAndroidExec` resolves `$PREFIX/bin/sh` (else `/system/bin/sh`) and runs both commands concurrently. Each child has a short default bound; a timeout kills it with `SIGKILL`. Errno classification reads the child's `error.code` without assuming an `Error` subclass: `EACCES`/`EPERM` map to `PLATFORM_EXEC_BLOCKED`, `ENOENT` to `INTERPRETER_MISSING`, and a nonzero or malformed result to `PROBE_FAILED`. `AndroidExecProbe` memoizes both the in-flight promise and the settled value, so racing callers share one probe. When both commands fail, the most consequential reason wins in the order listed above.

`androidSpawnFailure` and `androidExecBlockedMessage` are the shared reporting helpers. The local subprocess provider uses them when a spawn error arrives after boot, including a synchronous `node-pty` allocation error, so consumers never have to classify a raw `EACCES` on Android.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [app-boot](../../boot/app-boot/README.md) — installs the probe before the Loader mounts entries.
- [subprocess-local](../../subprocess/subprocess-local/README.md) — terminates exec capability with `PLATFORM_EXEC_BLOCKED`.
- [Android/Termux guide](../../../docs/user/guide/android-termux.md) — the deployment this probe protects.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The probe proves the current mount and targetSdk, not a future upgrade** — a Termux update that raises `targetSdk` while DSH keeps running cannot be observed until the next boot; the fallback spawn classification catches a later `EACCES` but cannot restore capability.
- **A blocked result disables every local exec tool together** — bash, persistent terminals, LSP servers, and ordinary subprocess calls share one provider; the package deliberately keeps the Web UI, model requests, and file tools running instead of hiding those tools from the model.
- **The timeout is a fixed safety bound** — `DEFAULT_ANDROID_EXEC_TIMEOUT_MS` covers a healthy Termux startup; a caller with a slower device passes `timeoutMs` rather than changing the package default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
