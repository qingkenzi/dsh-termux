---
description: "Exclusive file publication for a staged file: hard link, then renameat2(RENAME_NOREPLACE), then a flushed exclusive copy that preserves create-if-absent semantics."
kind: "package-reference"
---

# @deepseek-ai/dsh-util-exclusive-publish

English | [中文](README.zh.md)

## Summary

`publish-exclusive` publishes a staged file under a name that must not already exist. It tries a hard link, then `renameat2(RENAME_NOREPLACE)` for hosts that refuse hard links but allow a zero-copy rename, then `copyFile(..., COPYFILE_EXCL)` followed by a file flush. Every path reports a lost race as `EEXIST`, so a concurrent creator keeps its file and the caller can treat the target as authoritative. The caller still owns the parent directory's `fsync`, because this package publishes one entry and does not fsync directories.

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
// 'linked' and 'copied' keep stagedPath; 'renamed' consumes it.
```

A caller that needs an owner-only session log passes `mode`; a caller that must keep the staged name as another live name passes `rename: null`, which skips the zero-copy rename and never moves it:

```ts
await publishExclusive(stagedPath, finalPath, { mode: 0o600 })
await publishExclusive(existingObjectPath, aliasPath, { rename: null })
```

`EEXIST` means another writer created the target; this call must not remove or replace that file. `EXDEV` and `ENOENT` from the rename propagate because a copy cannot repair them; the caller named a target the rename cannot reach. A copy failure carries the refused hard-link error as its `cause`.

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
| [`src/renameat2.ts`](src/renameat2.ts) | koffi-backed `renameat2(RENAME_NOREPLACE)` declaration and errno mapping |

### Publication order

1. **Link** — `link(2)` publishes the staged inode under a second name. `EACCES`, `EPERM`, `ENOSYS`, `EOPNOTSUPP`, and `ENOTSUP` mean the host refuses hard links; every other error, including `EEXIST`, propagates.
2. **Rename** — `renameat2(RENAME_NOREPLACE)` moves the staged name without copying bytes. It is declared through koffi from libc's `renameat2` symbol, or from the raw `syscall` symbol with number 276 on arm64 or 316 on x86_64. `ENOSYS`, `EINVAL`, and `EOPNOTSUPP` fall through to the copy; every other error, including `EXDEV`, `ENOENT`, and `EEXIST`, propagates. A host without koffi, without either symbol, or without a syscall number behaves as `ENOSYS`.
3. **Copy** — `copyFile(..., COPYFILE_EXCL)` creates a new inode. The copy receives `mode` when given, then is opened for `fsync` (`r+`, or `r` for a read-only copy, which POSIX permits) so a published name never outlives unflushed bytes.

### Why the three paths share one contract

All three fail with `EEXIST` instead of replacing an existing target, and all three leave the target naming complete bytes when they succeed. They differ only in what happens to the staged name and in whether readers can observe an intermediate state. The [Session JSONL backend](../../session/session-persistence-jsonl/README.md) fixes the copy mode to `0o600`; [attachment storage](../../attachment/attachment-local/README.md) keeps the source mode and disables the rename when aliasing an object that must keep its canonical name; [fs-local](../../fs/fs-local/README.md) keeps its staged file beside the target so every path stays on one filesystem.

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
- **The rename consumes the staged name** — a caller that needs the staged name to remain must pass `rename: null` and accept link or copy.
- **Directory durability stays with the caller** — this package flushes a copied inode but never fsyncs the target's parent directory.
- **`renameat2` is Linux-only** — macOS and Windows hosts without usable hard links publish by copy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The raw syscall fallback covers Linux architectures whose libc omits the `renameat2` symbol. Add a number to `RENAMEAT2_SYSCALL` only with evidence from that architecture's syscall table; an unlisted architecture reports the capability as unavailable and copies instead.

</details>
