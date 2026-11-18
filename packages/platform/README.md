---
description: "The platform package group: host-platform capability facts that application boot and execution providers must agree on, outside any single capability family."
kind: "package-group"
---

# platform/ — host-platform capability facts

English | [中文](README.zh.md)

## Summary

The `platform/` group owns facts about the host platform that several capability families must apply consistently. A package here probes or derives one platform constraint; application boot, subprocess providers, and future execution providers consume the same fact instead of each interpreting a raw platform error. The group holds no product service and owns no tool; consumers keep their own failure and degradation policy.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`android-exec`](android-exec/README.md) | Probes Android W^X/exec capability once at boot and publishes the typed result and `PLATFORM_EXEC_BLOCKED` classification |

<a id="related-documentation"></a>
## Related documentation

- [Packages map](../README.md) — where `platform/` sits among all package groups.
- [boot/](../boot/README.md) — installs the Android probe before profile entries mount.
- [subprocess/](../subprocess/README.md) — the capability family whose local provider terminates exec tools on a blocked platform.
- [Android/Termux guide](../../docs/user/guide/android-termux.md) — the deployment these facts describe.

<a id="dev-note"></a>
## Dev Note

None.
