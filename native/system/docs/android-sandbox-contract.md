# CLI contract: android-sandbox-run

This file pins the Android supervisor's externally observable behavior — the cross-repo compatibility surface between the binary and every consumer. Consumers interact with it through `@deepseek-ai/node-addon-system/android-sandbox` (`androidSandboxRunnerPath`/`androidSandboxArgs`/`probeAndroidSandbox`); changing anything below requires a version bump for the whole package family and a note in the release notes.

## Invocation grammar

```text
android-sandbox-run --workspace <path> --tmp <path> --mode <read-only|workspace-write> -- <argv>...
android-sandbox-run --probe
```

- `--workspace <path>`: the canonical absolute root `workspace-write` may write under.
- `--tmp <path>`: the canonical absolute temp root `workspace-write` may write under.
- `--mode read-only`: grants no write root; `/dev/null` stays writable.
- `--mode workspace-write`: additionally grants the workspace and temp roots.
- `--`: mandatory separator; everything after it is the command argv, exec'd via `execvp` with the supervisor's environment unchanged.
- `--probe`: mutually exclusive with grants and a command.
- No other flags, no environment-variable inputs.

## Exit codes

- `125` (`ANDROID_SANDBOX_FAILURE_EXIT`): every supervisor-level failure — usage error, seccomp filter or listener setup failure, failed `exec`, notification loop failure. The wrapped command was NOT run.
- After a successful `exec`, every child status is passed through unchanged, including 125. Consumers therefore require both status 125 and an `android-sandbox-run: ` fatal line to attribute supervisor failure.
- `--probe`: `0` when the listener, the `Seccomp: 2` status, and one denied write are verified, `125` otherwise.

## Report lines

- Probe success prints exactly one stdout line: `android-sandbox: probe ok (seccomp user-notification listener active, Seccomp: 2)`. The entry package's `probeAndroidSandbox()` maps that line plus a zero exit to `partial`.
- Every fatal error prints one stderr line prefixed `android-sandbox-run: `.

## Confinement semantics

The command child sets `no_new_privs`, installs a seccomp filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER`, passes the listener descriptor to the unfiltered supervisor process over a Unix socket, and `exec`s the command. Every descendant inherits the filter; no descendant inherits the listener.

The supervisor resolves each notified path from the target process (`process_vm_readv`, falling back to `/proc/<pid>/mem`), using the notified task's cwd or descriptor for relative paths, rewrites `/proc/self`, `/proc/thread-self`, and `/dev/fd` magic links to the target pid, canonicalizes with `realpath()`, and allows the request only inside a granted root or at `/dev/null`. An unresolvable path is denied with `EACCES`.

Mediated syscalls: `openat` (write-intent flags only), `openat2` (all writes denied), `renameat`, `renameat2`, `unlinkat`, `mkdirat`, `symlinkat`, `linkat`, `truncate`, `ftruncate`, `fchmod`, `fchmodat`, `fchmodat2`, `utimensat`, and `chmod` where the architecture defines it.

Refused outright with `EPERM`: `io_uring_setup`, `open_by_handle_at`, `name_to_handle_at`, `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd`, `chroot`, `mount`, `umount2`, `pivot_root`, `unshare`, `setns`, `open_tree`, `move_mount`, `fsopen`, `fspick`, `fsmount`, `mount_setattr`, and `bpf`.

Partial boundary: reads are unconfined; `fchownat`, `setxattr`, `mknodat`, and other metadata writes are not filtered; writes through descriptors inherited from the caller are outside the policy; `openat2` writes are always denied; and an allowed path is re-resolved by the kernel after the supervisor's check, so a concurrent rename or symlink swap can redirect that write. Denials are unaffected.
