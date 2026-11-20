---
description: "Exclusive file publication for a staged file: a hard link, then a flushed exclusive copy that preserves create-if-absent semantics."
kind: "package-reference"
---

# @deepseek-ai/dsh-util-exclusive-publish

English | [中文](README.zh.md)

## Summary

`publish-exclusive` publishes a staged file under a name that must not already exist. It tries a hard link, then `copyFile(..., COPYFILE_EXCL)` followed by a file flush. Every path reports a lost race as `EEXIST`, so a concurrent creator keeps its file and the caller can treat the target as authoritative. The caller still owns the parent directory's `fsync`, because this package publishes one entry and does not fsync directories.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Publish a staged file that is already durable:

```ts
import { publishExclusive } from '@deepseek-ai/dsh-util-exclusive-publish'

declare const stagedPath: string
declare const finalPath: string

const method = await publishExclusive(stagedPath, finalPath)
// 'linked' and 'copied' keep stagedPath.
```

A caller that needs an owner-only session log passes `mode`; the copy path applies it before flushing:

```ts
import { publishExclusive } from '@deepseek-ai/dsh-util-exclusive-publish'

declare const stagedPath: string
declare const finalPath: string

await publishExclusive(stagedPath, finalPath, { mode: 0o600 })
```

`EEXIST` means another writer created the target; this call must not remove or replace that file. A copy failure carries the refused hard-link error as its `cause`.

### Failures to plan for

A copy is visible to readers while its bytes are still being written, so a reader that races publication can observe a partial copy. The copy path removes its own partial result when copying, mode application, or flushing fails, and it aggregates a cleanup failure after the original failure. A close failure that follows a successful flush rejects the call but keeps the durable target.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `publishExclusive` and its copy, mode, and flush steps |

### Publication order

1. **Link** — `link(2)` publishes the staged inode under a second name. `EACCES`, `EPERM`, `ENOSYS`, `EOPNOTSUPP`, and `ENOTSUP` mean the host refuses hard links; every other error, including `EEXIST`, propagates.
2. **Copy** — `copyFile(..., COPYFILE_EXCL)` creates a new inode. The copy receives `mode` when given, then is opened for `fsync` (`r+`, or `r` for a read-only copy, which POSIX permits) so a published name never outlives unflushed bytes.

### Why both paths share one contract

Both fail with `EEXIST` instead of replacing an existing target, and both leave the target naming complete bytes when they succeed. They differ only in whether the staged name survives. The [Session JSONL backend](../../session/session-persistence-jsonl/README.md) fixes the copy mode to `0o600`; [attachment storage](../../attachment/attachment-local/README.md) keeps the source mode; [fs-local](../../fs/fs-local/README.md) keeps its staged file beside the target so every path stays on one filesystem.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers or the family this primitive belongs to.

- [Session JSONL persistence](../../session/session-persistence-jsonl/README.md) — publishes session logs under exclusive names.
- [Attachment storage](../../attachment/attachment-local/README.md) — publishes content-addressed objects and aliases.
- [Local filesystem provider](../../fs/fs-local/README.md) — publishes guarded creates.
- [util group map](../README.md) — the utility family this package belongs to.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Copy publication is not atomic for readers** — another process can observe a copied target before its bytes and mode are complete.
- **Directory durability stays with the caller** — this package flushes a copied inode but never fsyncs the target's parent directory.
- **Hard-link denial follows the host's filesystem policy** — Android app data under SELinux answers `EACCES`, so every publication there takes the copy path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Android app data refuses `link(2)` with `EACCES`, so the copy path is the normal path on Termux rather than a degraded edge case. A caller that needs a zero-copy move should not add one here: publication semantics are create-if-absent, and a rename would consume the staged name.

</details>
