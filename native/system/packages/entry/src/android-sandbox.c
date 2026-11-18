/*
 * android-sandbox-run: seccomp user-notification supervisor for Android.
 *
 * The Android rung of the consuming sandbox seam. Android kernels enforce
 * seccomp filters but expose neither usable mount namespaces nor a Landlock
 * LSM on Termux, so this runner filters the file-write syscall family and
 * brokers each request from an unfiltered supervisor process.
 *
 * CLI contract:
 *
 *   android-sandbox-run --workspace <path> --tmp <path> --mode <mode> -- <argv>...
 *   android-sandbox-run --probe
 *
 * `--mode` is `read-only` or `workspace-write`; read-only grants no write root
 * and keeps only /dev/null writable. workspace-write additionally grants the
 * canonical `--workspace` and `--tmp` trees. `--probe` verifies that this
 * kernel delivers a user-notification listener and reports `Seccomp: 2`.
 *
 * Mechanism: the child installs a filter with SECCOMP_FILTER_FLAG_NEW_LISTENER,
 * passes the listener descriptor to the parent, and execs the command. Every
 * descendant inherits the filter; no descendant inherits the listener. The
 * parent reads each target path with process_vm_readv (falling back to
 * /proc/<pid>/mem), resolves it in the target's cwd/dirfd context, canonicalizes
 * it with realpath, and answers ALLOW (SECCOMP_USER_NOTIF_FLAG_CONTINUE) or
 * EACCES. An unresolvable path is denied.
 *
 * Partial enforcement (reported by the provider as `partial`):
 * - Only the listed write syscalls are mediated; other file-metadata effects
 *   (fchownat, setxattr, mknodat, fallocate on a writable descriptor) and
 *   writes through descriptors inherited from the caller are not governed.
 * - openat2 with write flags is always denied because the open_how structure
 *   cannot be checked against the kernel's later path resolution safely.
 * - Symlinks are resolved with realpath at check time, after which the kernel
 *   resolves the path again; a concurrent rename or symlink change can redirect
 *   an ALLOW decision (TOCTOU). Denials are unaffected.
 * - `/proc` and `/dev/fd` magic links are rewritten to the target pid and then
 *   canonicalized; a link whose target is not a regular path (a pipe or socket)
 *   is denied for write.
 * - io_uring, handle-based open, ptrace, cross-process memory access, mount and
 *   namespace syscalls return EPERM from the filter directly.
 * - Reads are not confined by the file-effect policy.
 *
 * Fail-closed: every runner-level failure prints one `android-sandbox-run: `
 * stderr line and exits 125 without running the command. A command that exits
 * 125 itself is distinguishable only by that fatal prefix, exactly like
 * landlock-run.
 *
 * Plain C11 over libc and the kernel UAPI. Built for Android arm64 by
 * `scripts/build.ts` into packages/android-arm64/bin/android-sandbox-run with
 * 16 KB page alignment; this source stays in the entry package for audit.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define RUNNER_NAME "android-sandbox-run"
#define EXIT_RUNNER_FAILURE 125
#define PATH_BUFFER PATH_MAX

/* Every runner-level diagnostic starts with this prefix; part of the CLI contract. */
#define PREFIX RUNNER_NAME ": "

/*
 * Kernel UAPI pieces newer toolchains may not carry. The seccomp filter and
 * notification layouts are stable kernel ABI; defining the missing names here
 * keeps the build independent of header vintage, as main.c does for Landlock.
 */
#ifndef SECCOMP_USER_NOTIF_FLAG_CONTINUE
#define SECCOMP_USER_NOTIF_FLAG_CONTINUE (1UL << 0)
#endif
#ifndef SECCOMP_GET_NOTIF_SIZES
#define SECCOMP_GET_NOTIF_SIZES 3
#endif
#ifndef SECCOMP_IOCTL_NOTIF_ID_VALID
#define SECCOMP_IOCTL_NOTIF_ID_VALID _IOW('!', 2, __u64)
#endif
#ifndef __NR_openat2
#define __NR_openat2 437
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef __NR_open_tree
#define __NR_open_tree 428
#endif
#ifndef __NR_move_mount
#define __NR_move_mount 429
#endif
#ifndef __NR_fsopen
#define __NR_fsopen 430
#endif
#ifndef __NR_fspick
#define __NR_fspick 433
#endif
#ifndef __NR_fsmount
#define __NR_fsmount 432
#endif
#ifndef __NR_mount_setattr
#define __NR_mount_setattr 442
#endif
#ifndef __NR_open_by_handle_at
#define __NR_open_by_handle_at 265
#endif
#ifndef __NR_name_to_handle_at
#define __NR_name_to_handle_at 264
#endif
#ifndef __NR_ptrace
#define __NR_ptrace 117
#endif
#ifndef __NR_process_vm_readv
#define __NR_process_vm_readv 270
#endif
#ifndef __NR_process_vm_writev
#define __NR_process_vm_writev 271
#endif
#ifndef __NR_chroot
#define __NR_chroot 51
#endif
#ifndef __NR_mount
#define __NR_mount 40
#endif
#ifndef __NR_umount2
#define __NR_umount2 39
#endif
#ifndef __NR_pivot_root
#define __NR_pivot_root 41
#endif
#ifndef __NR_unshare
#define __NR_unshare 97
#endif
#ifndef __NR_setns
#define __NR_setns 268
#endif
#ifndef __NR_bpf
#define __NR_bpf 280
#endif
#ifndef __NR_renameat
#define __NR_renameat 38
#endif
#ifndef __NR_renameat2
#define __NR_renameat2 276
#endif
#ifndef __NR_unlinkat
#define __NR_unlinkat 35
#endif
#ifndef __NR_mkdirat
#define __NR_mkdirat 34
#endif
#ifndef __NR_symlinkat
#define __NR_symlinkat 36
#endif
#ifndef __NR_linkat
#define __NR_linkat 37
#endif
#ifndef __NR_truncate
#define __NR_truncate 45
#endif
#ifndef __NR_ftruncate
#define __NR_ftruncate 46
#endif
#ifndef __NR_fchmod
#define __NR_fchmod 52
#endif
#ifndef __NR_fchmodat
#define __NR_fchmodat 53
#endif
#ifndef __NR_utimensat
#define __NR_utimensat 88
#endif
#ifndef __NR_openat
#define __NR_openat 56
#endif
#ifndef __NR_seccomp
#define __NR_seccomp 277
#endif

/* `struct open_how` layout from the openat2 UAPI (openat2(2)). */
struct sandbox_open_how {
  uint64_t flags;
  uint64_t mode;
  uint64_t resolve;
};

/* Flag bits that make an open a write effect. Checked in the filter for openat
 * and again by the supervisor before it decides. */
#define WRITE_FLAGS_MASK ((uint32_t)(O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND | __O_TMPFILE))

enum sandbox_mode {
  MODE_READ_ONLY = 0,
  MODE_WORKSPACE_WRITE = 1,
};

/* Resolved roots, set before the fork and inherited by the supervisor. */
static enum sandbox_mode mode = MODE_READ_ONLY;
static char workspace_root[PATH_BUFFER];
static char tmp_root[PATH_BUFFER];

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

/* Print one fatal runner diagnostic; returns the runner failure exit code. */
static int fail(const char *detail) {
  fprintf(stderr, PREFIX "%s\n", detail);
  return EXIT_RUNNER_FAILURE;
}

static int fail_errno(const char *step) {
  fprintf(stderr, PREFIX "%s: %s\n", step, strerror(errno));
  return EXIT_RUNNER_FAILURE;
}

static int fail_usage(const char *message, const char *detail) {
  fprintf(stderr, PREFIX "usage error: %s%s\n", message, detail == NULL ? "" : detail);
  return EXIT_RUNNER_FAILURE;
}

/* True when `path` equals `root` or lies beneath it on a component boundary. */
static int under_root(const char *path, const char *root) {
  size_t length = strlen(root);
  if (length == 0) return 0;
  if (strncmp(path, root, length) != 0) return 0;
  if (path[length] == '\0') return 1;
  return root[length - 1] == '/' || path[length] == '/';
}

/* True when a write to this canonical path is inside the mode's granted set. */
static int path_allowed(const char *path) {
  if (strcmp(path, "/dev/null") == 0) return 1;
  if (mode == MODE_READ_ONLY) return 0;
  return under_root(path, workspace_root) || under_root(path, tmp_root);
}

/* Read at most `length` bytes from another process, falling back to
 * /proc/<pid>/mem when process_vm_readv is unavailable or refused. A short read
 * is returned as-is: a string ending at a page boundary is still usable. */
static ssize_t read_remote_partial(pid_t pid, uint64_t address, void *buffer, size_t length) {
  struct iovec local = { .iov_base = buffer, .iov_len = length };
  struct iovec remote = { .iov_base = (void *)(uintptr_t)address, .iov_len = length };
  ssize_t got = process_vm_readv(pid, &local, 1, &remote, 1, 0);
  if (got >= 0) return got;
  char mem_path[64];
  int written = snprintf(mem_path, sizeof mem_path, "/proc/%d/mem", (int)pid);
  if (written <= 0 || (size_t)written >= sizeof mem_path) return -1;
  int fd = open(mem_path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  got = pread(fd, buffer, length, (off_t)address);
  close(fd);
  return got;
}

/* Read exactly `length` bytes; a short read fails. */
static int read_remote(pid_t pid, uint64_t address, void *buffer, size_t length) {
  return read_remote_partial(pid, address, buffer, length) == (ssize_t)length ? 0 : -1;
}

/*
 * Copy a NUL-terminated remote string into `out`. Reads in small chunks so a
 * string that ends near an unreadable page boundary still resolves; an
 * unterminated or unreadable string fails (the caller denies).
 */
static int read_remote_string(pid_t pid, uint64_t address, char *out, size_t capacity) {
  size_t total = 0;
  if (capacity == 0) return -1;
  while (total + 1 < capacity) {
    size_t chunk = capacity - 1 - total;
    if (chunk > 64) chunk = 64;
    char buffer[64];
    ssize_t got = read_remote_partial(pid, address + total, buffer, chunk);
    if (got <= 0) return -1;
    memcpy(out + total, buffer, (size_t)got);
    total += (size_t)got;
    if (memchr(buffer, '\0', (size_t)got) != NULL) return 0;
    if ((size_t)got < chunk) return -1;
  }
  return -1;
}

/* Read a symlink's target (the target process's cwd or an open descriptor). */
static int read_link_target(const char *path, char *out, size_t capacity) {
  ssize_t length = readlink(path, out, capacity - 1);
  if (length <= 0 || (size_t)length >= capacity - 1) return -1;
  out[length] = '\0';
  if (out[0] != '/') return -1; /* pipes, sockets, anon inodes: not a path */
  if (length >= 10 && strcmp(out + length - 10, " (deleted)") == 0) return -1;
  return 0;
}

/*
 * Rewrite procfs magic links relative to `pid`. realpath() in the supervisor
 * would otherwise resolve `/proc/self` and `/dev/fd` against the SUPERVISOR's
 * descriptors, which is a different process's state.
 */
static int rewrite_magic_links(pid_t pid, const char *input, char *out, size_t capacity) {
  const char *prefixes[] = { "/proc/self/", "/proc/thread-self/", "/dev/fd/" };
  char pid_link[64];
  int written = snprintf(pid_link, sizeof pid_link, "/proc/%d/", (int)pid);
  if (written <= 0 || (size_t)written >= sizeof pid_link) return -1;
  for (size_t index = 0; index < sizeof prefixes / sizeof prefixes[0]; index++) {
    size_t length = strlen(prefixes[index]);
    if (strncmp(input, prefixes[index], length) != 0) continue;
    if (strlen(pid_link) + strlen(input + length) + 1 > capacity) return -1;
    strcpy(out, pid_link);
    if (prefixes[index][1] == 'd') strcat(out, "fd/");
    strcat(out, input + length);
    return 0;
  }
  const struct { const char *name; const char *fd; } standard[] = {
    { "/dev/stdin", "0" }, { "/dev/stdout", "1" }, { "/dev/stderr", "2" },
  };
  for (size_t index = 0; index < sizeof standard / sizeof standard[0]; index++) {
    size_t length = strlen(standard[index].name);
    if (strncmp(input, standard[index].name, length) != 0) continue;
    if (input[length] != '\0' && input[length] != '/') continue;
    if (snprintf(out, capacity, "/proc/%d/fd/%s%s", (int)pid, standard[index].fd, input + length)
        >= (int)capacity) return -1;
    return 0;
  }
  if (strlen(input) + 1 > capacity) return -1;
  strcpy(out, input);
  return 0;
}

/*
 * Canonicalize `input`: realpath() when the whole path exists, otherwise
 * realpath(parent) + basename so creating a new entry inside an existing
 * directory keeps a resolved parent. Any other failure is unresolvable.
 */
static int canonicalize(const char *input, char *out, size_t capacity) {
  char resolved[PATH_BUFFER];
  if (realpath(input, resolved) != NULL) {
    if (strlen(resolved) + 1 > capacity) return -1;
    strcpy(out, resolved);
    return 0;
  }
  if (errno != ENOENT && errno != ENOTDIR) return -1;
  char parent[PATH_BUFFER];
  if (strlen(input) + 1 > sizeof parent) return -1;
  strcpy(parent, input);
  char *slash = strrchr(parent, '/');
  if (slash == NULL) return -1;
  char base[PATH_BUFFER];
  if (strlen(slash + 1) + 1 > sizeof base) return -1;
  strcpy(base, slash + 1);
  if (base[0] == '\0') return -1;
  if (slash == parent) {
    slash[1] = '\0';
  } else {
    *slash = '\0';
  }
  char resolved_parent[PATH_BUFFER];
  if (realpath(parent, resolved_parent) == NULL) return -1;
  if (strlen(resolved_parent) + strlen(base) + 2 > capacity) return -1;
  if (strcmp(resolved_parent, "/") == 0) {
    snprintf(out, capacity, "/%s", base);
  } else {
    snprintf(out, capacity, "%s/%s", resolved_parent, base);
  }
  return 0;
}

/* Read a write target path from the notified process and decide. */
static int path_request(pid_t pid, int dirfd, uint64_t remote_path) {
  char raw[PATH_BUFFER];
  if (read_remote_string(pid, remote_path, raw, sizeof raw) != 0) return 0;
  if (raw[0] == '\0') return 0;
  char composed[PATH_BUFFER];
  if (raw[0] == '/') {
    if (strlen(raw) + 1 > sizeof composed) return 0;
    strcpy(composed, raw);
  } else {
    char base[PATH_BUFFER];
    char link[64];
    int written;
    if (dirfd == AT_FDCWD) {
      written = snprintf(link, sizeof link, "/proc/%d/cwd", (int)pid);
    } else {
      written = snprintf(link, sizeof link, "/proc/%d/fd/%d", (int)pid, dirfd);
    }
    if (written <= 0 || (size_t)written >= sizeof link) return 0;
    if (read_link_target(link, base, sizeof base) != 0) return 0;
    if (strlen(base) + strlen(raw) + 2 > sizeof composed) return 0;
    snprintf(composed, sizeof composed, "%s/%s", base, raw);
  }
  char rewritten[PATH_BUFFER];
  if (rewrite_magic_links(pid, composed, rewritten, sizeof rewritten) != 0) return 0;
  char resolved[PATH_BUFFER];
  if (canonicalize(rewritten, resolved, sizeof resolved) != 0) return 0;
  return path_allowed(resolved);
}

/* Resolve an already-open descriptor to its path and decide. */
static int fd_request(pid_t pid, int fd) {
  char link[64];
  int written = snprintf(link, sizeof link, "/proc/%d/fd/%d", (int)pid, fd);
  if (written <= 0 || (size_t)written >= sizeof link) return 0;
  char target[PATH_BUFFER];
  if (read_link_target(link, target, sizeof target) != 0) return 0;
  char resolved[PATH_BUFFER];
  if (canonicalize(target, resolved, sizeof resolved) != 0) return 0;
  return path_allowed(resolved);
}

/* openat2 carries its flags in a user pointer; read them before deciding. */
static int openat2_request(pid_t pid, const struct seccomp_data *data) {
  uint64_t size = data->args[3];
  if (size < sizeof(struct sandbox_open_how)) return 0;
  struct sandbox_open_how how;
  memset(&how, 0, sizeof how);
  if (read_remote(pid, data->args[2], &how, sizeof how) != 0) return 0;
  if ((how.flags & WRITE_FLAGS_MASK) != 0) return 0;
  /* A read-only openat2 is a read effect, outside this backend's promise. */
  return 1;
}

/* Decide one notification: 1 allow/continue, 0 deny with EACCES. */
static int request_allowed(pid_t pid, const struct seccomp_data *data) {
  switch (data->nr) {
    case __NR_openat: {
      int flags = (int)data->args[2];
      if ((flags & WRITE_FLAGS_MASK) == 0) return 1;
      return path_request(pid, (int)data->args[0], data->args[1]);
    }
    case __NR_openat2:
      return openat2_request(pid, data);
    case __NR_renameat:
      return path_request(pid, (int)data->args[0], data->args[1])
          && path_request(pid, (int)data->args[2], data->args[3]);
    case __NR_renameat2:
      return path_request(pid, (int)data->args[0], data->args[1])
          && path_request(pid, (int)data->args[2], data->args[3]);
    case __NR_unlinkat:
      return path_request(pid, (int)data->args[0], data->args[1]);
    case __NR_mkdirat:
      return path_request(pid, (int)data->args[0], data->args[1]);
    case __NR_symlinkat:
      /* symlinkat(target, newdirfd, linkpath): only the link path is written. */
      return path_request(pid, (int)data->args[1], data->args[2]);
    case __NR_linkat:
      return path_request(pid, (int)data->args[0], data->args[1])
          && path_request(pid, (int)data->args[2], data->args[3]);
    case __NR_truncate:
      return path_request(pid, AT_FDCWD, data->args[0]);
    case __NR_ftruncate:
      return fd_request(pid, (int)data->args[0]);
    case __NR_fchmod:
      return fd_request(pid, (int)data->args[0]);
    case __NR_fchmodat:
      return path_request(pid, (int)data->args[0], data->args[1]);
    case __NR_fchmodat2:
      return path_request(pid, (int)data->args[0], data->args[1]);
    case __NR_utimensat:
      /* utimensat(dirfd, NULL, times, flags) updates the descriptor itself. */
      if (data->args[1] == 0) return fd_request(pid, (int)data->args[0]);
      return path_request(pid, (int)data->args[0], data->args[1]);
#ifdef __NR_chmod
    case __NR_chmod:
      return path_request(pid, AT_FDCWD, data->args[0]);
#endif
    default:
      /* The filter only notifies known syscalls; deny an unknown one closed. */
      return 0;
  }
}

/* ------------------------------------------------------------------------- */
/* Filter and listener plumbing                                               */
/* ------------------------------------------------------------------------- */

#if defined(__aarch64__)
#define EXPECTED_AUDIT_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define EXPECTED_AUDIT_ARCH AUDIT_ARCH_X86_64
#else
#error "android-sandbox-run supports aarch64 and x86_64 only"
#endif

/*
 * BPF program. Denied escape surfaces return EPERM without a supervisor round
 * trip; write syscalls return USER_NOTIF. openat is notified only when its
 * flags carry write intent, which also keeps every read-only open off the
 * supervisor path.
 */
#define DENY_SYSCALL(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))
#define NOTIFY_SYSCALL(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF)

static struct sock_filter filter_program[] = {
  /* Reject a foreign ABI outright instead of interpreting its syscall numbers. */
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_AUDIT_ARCH, 1, 0),
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

  /* Escape surfaces that bypass path mediation or the seam's assumptions. */
  DENY_SYSCALL(__NR_io_uring_setup),
  DENY_SYSCALL(__NR_open_by_handle_at),
  DENY_SYSCALL(__NR_name_to_handle_at),
  DENY_SYSCALL(__NR_ptrace),
  DENY_SYSCALL(__NR_process_vm_readv),
  DENY_SYSCALL(__NR_process_vm_writev),
  DENY_SYSCALL(__NR_pidfd_getfd),
  DENY_SYSCALL(__NR_chroot),
  DENY_SYSCALL(__NR_mount),
  DENY_SYSCALL(__NR_umount2),
  DENY_SYSCALL(__NR_pivot_root),
  DENY_SYSCALL(__NR_unshare),
  DENY_SYSCALL(__NR_setns),
  DENY_SYSCALL(__NR_open_tree),
  DENY_SYSCALL(__NR_move_mount),
  DENY_SYSCALL(__NR_fsopen),
  DENY_SYSCALL(__NR_fspick),
  DENY_SYSCALL(__NR_fsmount),
  DENY_SYSCALL(__NR_mount_setattr),
  DENY_SYSCALL(__NR_bpf),

  /* openat: USER_NOTIF only when flags carry write intent. The flags load
   * clobbers the accumulator, so the syscall number is reloaded for the
   * following comparisons. */
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 4),
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args) + sizeof(uint64_t) * 2),
  BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, WRITE_FLAGS_MASK, 0, 1),
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

  /* Every other mediated write syscall has no flag argument worth filtering on. */
  NOTIFY_SYSCALL(__NR_openat2),
  NOTIFY_SYSCALL(__NR_renameat),
  NOTIFY_SYSCALL(__NR_renameat2),
  NOTIFY_SYSCALL(__NR_unlinkat),
  NOTIFY_SYSCALL(__NR_mkdirat),
  NOTIFY_SYSCALL(__NR_symlinkat),
  NOTIFY_SYSCALL(__NR_linkat),
  NOTIFY_SYSCALL(__NR_truncate),
  NOTIFY_SYSCALL(__NR_ftruncate),
  NOTIFY_SYSCALL(__NR_fchmod),
  NOTIFY_SYSCALL(__NR_fchmodat),
  NOTIFY_SYSCALL(__NR_fchmodat2),
  NOTIFY_SYSCALL(__NR_utimensat),
#ifdef __NR_chmod
  NOTIFY_SYSCALL(__NR_chmod),
#endif

  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
};

static struct sock_fprog filter = {
  .len = (unsigned short)(sizeof filter_program / sizeof filter_program[0]),
  .filter = filter_program,
};

/*
 * Install the filter on this process and return its notification listener.
 * Returns 0 on success, else -1 with errno set. Refuses a kernel whose
 * notification structure is larger than this build understands.
 */
static int install_listener(int *listener) {
  struct seccomp_notif_sizes sizes;
  memset(&sizes, 0, sizeof sizes);
  if (syscall(__NR_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) != 0) return -1;
  if (sizes.seccomp_notif > sizeof(struct seccomp_notif)
      || sizes.seccomp_notif_resp > sizeof(struct seccomp_notif_resp)) {
    errno = ENOTSUP;
    return -1;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  long fd = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &filter);
  if (fd < 0) return -1;
  *listener = (int)fd;
  return 0;
}

/* Send one descriptor over a connected Unix socket. */
static int send_fd(int socket_fd, int descriptor) {
  char marker = 'L';
  struct iovec iov = { .iov_base = &marker, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof control);
  struct msghdr message;
  memset(&message, 0, sizeof message);
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof control;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header == NULL) return -1;
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &descriptor, sizeof descriptor);
  ssize_t sent;
  do {
    sent = sendmsg(socket_fd, &message, 0);
  } while (sent < 0 && errno == EINTR);
  return sent == 1 ? 0 : -1;
}

/* Receive one descriptor; returns -1 when the peer sent none. */
static int receive_fd(int socket_fd) {
  char marker;
  struct iovec iov = { .iov_base = &marker, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof control);
  struct msghdr message;
  memset(&message, 0, sizeof message);
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof control;
  ssize_t received;
  do {
    received = recvmsg(socket_fd, &message, 0);
  } while (received < 0 && errno == EINTR);
  if (received <= 0) return -1;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header == NULL || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) return -1;
  int descriptor = -1;
  memcpy(&descriptor, CMSG_DATA(header), sizeof descriptor);
  return descriptor;
}

/* Answer one notification. */
static void respond(int listener, const struct seccomp_notif *request, int allow) {
  struct seccomp_notif_resp response;
  memset(&response, 0, sizeof response);
  response.id = request->id;
  if (allow) {
    response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
  } else {
    response.error = -EACCES;
  }
  /* The target may have died between receive and send; that is not an error. */
  (void)ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response);
}

/*
 * Wait for the next notification. POLLHUP means no filtered task is left (the
 * kernel reports it once the last task drops the filter); waiting on the ioctl
 * alone would block forever after the command exits.
 * Returns 1 when a notification is ready, 0 when every filtered task is gone,
 * -1 on a poll failure.
 */
static int await_notification(int listener) {
  for (;;) {
    struct pollfd descriptor = { .fd = listener, .events = POLLIN };
    int ready = poll(&descriptor, 1, -1);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (descriptor.revents & POLLIN) return 1;
    if (descriptor.revents & (POLLHUP | POLLNVAL)) return 0;
    if (descriptor.revents & POLLERR) return -1;
  }
}

/* Drain notifications until every filtered task is gone. Returns 0 normally. */
static int supervise(int listener) {
  for (;;) {
    int ready = await_notification(listener);
    if (ready < 0) return fail_errno("notification poll failed");
    if (ready == 0) return 0;
    struct seccomp_notif request;
    memset(&request, 0, sizeof request);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) != 0) {
      if (errno == EINTR || errno == ENOENT) {
        if (errno == ENOENT) return 0;
        continue;
      }
      return fail_errno("notification receive failed");
    }
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) != 0) continue;
    respond(listener, &request, request_allowed((pid_t)request.pid, &request.data));
  }
}

/* Translate a wait status into the runner's exit code. */
static int exit_code(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return EXIT_RUNNER_FAILURE;
}

/* ------------------------------------------------------------------------- */
/* Probe                                                                      */
/* ------------------------------------------------------------------------- */

/* Read /proc/<pid>/status and verify the kernel reports Seccomp: 2 (filter). */
static int seccomp_mode_is_filter(pid_t pid) {
  char path[64];
  if (snprintf(path, sizeof path, "/proc/%d/status", (int)pid) >= (int)sizeof path) return 0;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  char buffer[4096];
  ssize_t length = read(fd, buffer, sizeof buffer - 1);
  close(fd);
  if (length <= 0) return 0;
  buffer[length] = '\0';
  const char *line = strstr(buffer, "\nSeccomp:");
  if (line == NULL) return 0;
  line += 9;
  while (*line == ' ' || *line == '\t') line++;
  return *line == '2';
}

/* Probe child: install the filter, then try a write the supervisor must deny. */
static void probe_child(const char *target, int socket_fd) {
  int listener = -1;
  if (install_listener(&listener) != 0) {
    fprintf(stderr, PREFIX "probe failed: seccomp filter setup: %s\n", strerror(errno));
    _exit(EXIT_RUNNER_FAILURE);
  }
  if (send_fd(socket_fd, listener) != 0) {
    fprintf(stderr, PREFIX "probe failed: listener transfer: %s\n", strerror(errno));
    _exit(EXIT_RUNNER_FAILURE);
  }
  close(listener);
  close(socket_fd);
  int fd = openat(AT_FDCWD, target, O_WRONLY | O_TRUNC | O_CLOEXEC);
  if (fd >= 0) {
    close(fd);
    _exit(1); /* the write was allowed: enforcement is not active */
  }
  _exit(errno == EACCES ? 0 : 1);
}

/* Parent side of --probe: verify listener, Seccomp: 2, and one denied write. */
static int run_probe(void) {
  char directory[PATH_BUFFER];
  const char *configured = getenv("TMPDIR");
  if (configured != NULL && configured[0] == '/') {
    if (strlen(configured) + 1 > sizeof directory) return fail("probe failed: TMPDIR is too long");
    strcpy(directory, configured);
  } else if (getcwd(directory, sizeof directory) == NULL) {
    return fail_errno("probe failed: cannot determine a temp directory");
  }
  char template_path[PATH_BUFFER];
  if (snprintf(template_path, sizeof template_path, "%s/%s-probe-XXXXXX", directory, RUNNER_NAME)
      >= (int)sizeof template_path) {
    return fail("probe failed: temp path is too long");
  }
  int probe_fd = mkstemp(template_path);
  if (probe_fd < 0) return fail_errno("probe failed: cannot create a temp file");
  close(probe_fd);

  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) != 0) {
    unlink(template_path);
    return fail_errno("probe failed: socketpair");
  }
  pid_t child = fork();
  if (child < 0) {
    close(sockets[0]);
    close(sockets[1]);
    unlink(template_path);
    return fail_errno("probe failed: fork");
  }
  if (child == 0) {
    close(sockets[0]);
    probe_child(template_path, sockets[1]);
  }
  close(sockets[1]);
  int listener = receive_fd(sockets[0]);
  close(sockets[0]);
  if (listener < 0) {
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    unlink(template_path);
    return fail("probe failed: the seccomp listener was not received");
  }
  int filtered = seccomp_mode_is_filter(child);
  int notifications = 0;
  for (;;) {
    int ready = await_notification(listener);
    if (ready < 0) {
      close(listener);
      kill(child, SIGKILL);
      waitpid(child, NULL, 0);
      unlink(template_path);
      return fail_errno("probe failed: notification poll");
    }
    if (ready == 0) break;
    struct seccomp_notif request;
    memset(&request, 0, sizeof request);
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) != 0) {
      if (errno == EINTR) continue;
      if (errno == ENOENT) break;
      break;
    }
    notifications++;
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request.id) != 0) continue;
    respond(listener, &request, request_allowed((pid_t)request.pid, &request.data));
  }
  close(listener);
  int status = 0;
  waitpid(child, &status, 0);
  unlink(template_path);
  if (!filtered) return fail("probe failed: the kernel does not report Seccomp: 2 for the filtered child");
  if (notifications == 0) return fail("probe failed: no seccomp user notification was delivered");
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    return fail("probe failed: a write outside the granted set was not denied with EACCES");
  }
  printf(RUNNER_NAME ": probe ok (seccomp user-notification listener active, Seccomp: 2)\n");
  return 0;
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

struct cli {
  int probe;
  int have_workspace;
  int have_tmp;
  int have_mode;
  const char *workspace;
  const char *tmp;
  const char *mode;
  char **command;
};

static int parse(int argc, char **argv, struct cli *parsed) {
  memset(parsed, 0, sizeof *parsed);
  int index = 1;
  while (index < argc) {
    const char *argument = argv[index];
    if (strcmp(argument, "--probe") == 0) {
      if (argc != 2) return fail_usage("--probe takes no other arguments", NULL);
      parsed->probe = 1;
      index += 1;
    } else if (strcmp(argument, "--workspace") == 0 || strcmp(argument, "--tmp") == 0
               || strcmp(argument, "--mode") == 0) {
      if (index + 1 >= argc) return fail_usage(argument, " requires a value");
      if (strcmp(argument, "--workspace") == 0) {
        parsed->workspace = argv[index + 1];
        parsed->have_workspace = 1;
      } else if (strcmp(argument, "--tmp") == 0) {
        parsed->tmp = argv[index + 1];
        parsed->have_tmp = 1;
      } else {
        parsed->mode = argv[index + 1];
        parsed->have_mode = 1;
      }
      index += 2;
    } else if (strcmp(argument, "--") == 0) {
      parsed->command = &argv[index + 1];
      break;
    } else {
      return fail_usage("unknown argument: ", argument);
    }
  }
  if (parsed->probe) return 0;
  if (!parsed->have_mode) return fail_usage("missing --mode <read-only|workspace-write>", NULL);
  if (!parsed->have_workspace) return fail_usage("missing --workspace <path>", NULL);
  if (!parsed->have_tmp) return fail_usage("missing --tmp <path>", NULL);
  if (strcmp(parsed->mode, "read-only") == 0) {
    mode = MODE_READ_ONLY;
  } else if (strcmp(parsed->mode, "workspace-write") == 0) {
    mode = MODE_WORKSPACE_WRITE;
  } else {
    return fail_usage("unknown --mode: ", parsed->mode);
  }
  if (parsed->command == NULL || parsed->command[0] == NULL) {
    return fail_usage("missing `-- <argv>...` command", NULL);
  }
  if (realpath(parsed->workspace, workspace_root) == NULL) return fail_errno("cannot resolve --workspace");
  if (realpath(parsed->tmp, tmp_root) == NULL) return fail_errno("cannot resolve --tmp");
  if (workspace_root[0] != '/' || tmp_root[0] != '/') return fail("--workspace and --tmp must be absolute");
  return 0;
}

int main(int argc, char **argv) {
  struct cli command_line;
  int code = parse(argc, argv, &command_line);
  if (code != 0) return code;
  if (command_line.probe) return run_probe();

  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) != 0) return fail_errno("socketpair failed");
  pid_t child = fork();
  if (child < 0) return fail_errno("fork failed");
  if (child == 0) {
    close(sockets[0]);
    int listener = -1;
    if (install_listener(&listener) != 0) {
      fprintf(stderr, PREFIX "seccomp filter setup failed: %s\n", strerror(errno));
      _exit(EXIT_RUNNER_FAILURE);
    }
    if (send_fd(sockets[1], listener) != 0) {
      fprintf(stderr, PREFIX "listener transfer failed: %s\n", strerror(errno));
      _exit(EXIT_RUNNER_FAILURE);
    }
    close(listener);
    close(sockets[1]);
    execvp(command_line.command[0], command_line.command);
    fprintf(stderr, PREFIX "exec failed: %s\n", strerror(errno));
    _exit(EXIT_RUNNER_FAILURE);
  }

  close(sockets[1]);
  int listener = receive_fd(sockets[0]);
  close(sockets[0]);
  if (listener < 0) {
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    return fail("sandbox setup failed before the command started");
  }
  code = supervise(listener);
  close(listener);
  if (code != 0) {
    kill(child, SIGKILL);
    waitpid(child, NULL, 0);
    return code;
  }
  int status = 0;
  if (waitpid(child, &status, 0) < 0 && errno != ECHILD) return fail_errno("waitpid failed");
  return exit_code(status);
}
