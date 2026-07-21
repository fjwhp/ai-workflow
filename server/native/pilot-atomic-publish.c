#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

#define FLOWGATE_CONFLICT 10
#define FLOWGATE_UNAVAILABLE 11
#define FLOWGATE_FAILED 12
#define FLOWGATE_USAGE 64

static int publish_no_replace(const char *source, const char *target) {
#if defined(__APPLE__)
  return renamex_np(source, target, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  return -1;
#endif
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] == '\0' || argv[2][0] == '\0') return FLOWGATE_USAGE;
  if (publish_no_replace(argv[1], argv[2]) == 0) return 0;
  if (errno == EEXIST || errno == ENOTEMPTY) return FLOWGATE_CONFLICT;
  if (errno == ENOSYS || errno == ENOTSUP || errno == EINVAL) return FLOWGATE_UNAVAILABLE;
  return FLOWGATE_FAILED;
}
