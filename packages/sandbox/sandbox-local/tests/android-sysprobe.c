/*
 * Test-only raw-syscall probe for android.e2e.ts. It compiles with the same
 * Termux `cc` that builds the supervisor and runs INSIDE a confined command, so
 * the assertions exercise kernel behavior rather than a shell diagnostic.
 *
 *   android-sysprobe io-uring
 *   android-sysprobe openat2-write <path>
 *   android-sysprobe dirfd-write <directory>
 *
 * Each mode exits 0 only when the supervisor produced the expected refusal
 * (EPERM for the escape surface, EACCES for a write outside the grants).
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_openat2
#define __NR_openat2 437
#endif

struct probe_open_how {
  uint64_t flags;
  uint64_t mode;
  uint64_t resolve;
};

static void report(const char *operation, long result) {
  fprintf(stderr, "%s: result=%ld errno=%d (%s)\n", operation, result, errno, strerror(errno));
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "io-uring") == 0) {
    char params[256];
    memset(params, 0, sizeof params);
    long result = syscall(__NR_io_uring_setup, 2, params);
    if (result < 0 && errno == EPERM) return 0;
    report("io_uring_setup", result);
    return 1;
  }
  if (argc == 3 && strcmp(argv[1], "openat2-write") == 0) {
    struct probe_open_how how = { .flags = O_WRONLY | O_CREAT, .mode = 0600, .resolve = 0 };
    long result = syscall(__NR_openat2, AT_FDCWD, argv[2], &how, sizeof how);
    if (result < 0 && errno == EACCES) return 0;
    report("openat2 write", result);
    return 1;
  }
  if (argc == 3 && strcmp(argv[1], "dirfd-write") == 0) {
    int directory = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0) {
      report("open directory", -1);
      return 1;
    }
    long result = syscall(__NR_openat, directory, "android-sysprobe-escape.txt", O_WRONLY | O_CREAT, 0600);
    if (result < 0 && errno == EACCES) return 0;
    report("openat through dirfd", result);
    return 1;
  }
  fprintf(stderr, "usage: android-sysprobe <io-uring|openat2-write <path>|dirfd-write <dir>>\n");
  return 125;
}
