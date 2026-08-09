#import <Foundation/Foundation.h>

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

static bool RequireDirectory(const char *path) {
  struct stat value;
  return path != nullptr && path[0] == '/' && lstat(path, &value) == 0
      && S_ISDIR(value.st_mode) && !S_ISLNK(value.st_mode);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 4 || strcmp(argv[1], "--swap-directories") != 0) {
      fprintf(stderr, "usage: Tweakers Swap Helper --swap-directories <absolute-dir> <absolute-dir>\n");
      return 64;
    }
    if (!RequireDirectory(argv[2]) || !RequireDirectory(argv[3])) {
      fprintf(stderr, "swap inputs must be existing absolute real directories\n");
      return 65;
    }
    if (renameatx_np(AT_FDCWD, argv[2], AT_FDCWD, argv[3], RENAME_SWAP) != 0) {
      const int failure = errno;
      fprintf(stderr, "atomic directory swap failed: %s (errno=%d)\n", strerror(failure), failure);
      return failure == EPERM || failure == EACCES ? 77 : 1;
    }
  }
  return 0;
}
