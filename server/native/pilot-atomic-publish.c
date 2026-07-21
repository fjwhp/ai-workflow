#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#define FLOWGATE_CONFLICT 10
#define FLOWGATE_UNAVAILABLE 11
#define FLOWGATE_FAILED 12
#define FLOWGATE_USAGE 64

static int publish_no_replace(int parent_fd, const char *source, const char *target) {
#if defined(__APPLE__)
  return renameatx_np(parent_fd, source, parent_fd, target, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, parent_fd, source, parent_fd, target, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  return -1;
#endif
}

static int safe_name(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0
    && strchr(name, '/') == NULL;
}

static int parse_identity(const char *value, uint64_t *result) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return -1;
  *result = (uint64_t)parsed;
  return 0;
}

int main(int argc, char **argv) {
  uint64_t expected_parent_dev, expected_parent_ino, expected_source_dev, expected_source_ino;
  if (argc != 8 || argv[1][0] == '\0' || !safe_name(argv[4]) || !safe_name(argv[7])
      || strcmp(argv[4], argv[7]) == 0
      || parse_identity(argv[2], &expected_parent_dev) != 0
      || parse_identity(argv[3], &expected_parent_ino) != 0
      || parse_identity(argv[5], &expected_source_dev) != 0
      || parse_identity(argv[6], &expected_source_ino) != 0) return FLOWGATE_USAGE;
  int parent_fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) return FLOWGATE_UNAVAILABLE;
  struct stat parent_stat;
  struct stat source_stat;
  if (fstat(parent_fd, &parent_stat) != 0 || !S_ISDIR(parent_stat.st_mode)
      || parent_stat.st_uid != getuid() || (parent_stat.st_mode & 0022) != 0
      || (uint64_t)parent_stat.st_dev != expected_parent_dev
      || (uint64_t)parent_stat.st_ino != expected_parent_ino) {
    close(parent_fd);
    return FLOWGATE_UNAVAILABLE;
  }
  if (fstatat(parent_fd, argv[4], &source_stat, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISDIR(source_stat.st_mode) || source_stat.st_uid != getuid()
      || (source_stat.st_mode & 0777) != 0700
      || (uint64_t)source_stat.st_dev != expected_source_dev
      || (uint64_t)source_stat.st_ino != expected_source_ino) {
    close(parent_fd);
    return FLOWGATE_FAILED;
  }
  if (publish_no_replace(parent_fd, argv[4], argv[7]) == 0) {
    close(parent_fd);
    return 0;
  }
  int saved_errno = errno;
  close(parent_fd);
  errno = saved_errno;
  if (errno == EEXIST || errno == ENOTEMPTY) return FLOWGATE_CONFLICT;
  if (errno == ENOSYS || errno == ENOTSUP || errno == EINVAL) return FLOWGATE_UNAVAILABLE;
  return FLOWGATE_FAILED;
}
