#import <Foundation/Foundation.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string>

struct BoundDirectory {
  int parent = -1;
  std::string parentPath;
  std::string name;
  uint64_t device = 0;
  uint64_t inode = 0;
};

static bool ParseIdentity(const char *value, uint64_t *output) {
  if (value == nullptr || value[0] == '\0' || value[0] == '-') return false;
  errno = 0;
  char *end = nullptr;
  const unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return false;
  *output = static_cast<uint64_t>(parsed);
  return true;
}

static bool ExactPhysicalPath(const char *path) {
  if (path == nullptr || path[0] != '/') return false;
  char resolved[PATH_MAX];
  return realpath(path, resolved) != nullptr && strcmp(path, resolved) == 0;
}

static bool SplitPath(const char *path, std::string *parent, std::string *name) {
  if (path == nullptr) return false;
  const std::string value(path);
  const size_t separator = value.rfind('/');
  if (separator == std::string::npos || separator + 1 >= value.size()) return false;
  *parent = separator == 0 ? "/" : value.substr(0, separator);
  *name = value.substr(separator + 1);
  return *name != "." && *name != ".." && name->find('/') == std::string::npos;
}

static bool SameIdentity(const struct stat &value, uint64_t device, uint64_t inode) {
  return static_cast<uint64_t>(value.st_dev) == device
      && static_cast<uint64_t>(value.st_ino) == inode;
}

static bool VisibleParentMatches(const BoundDirectory &bound) {
  struct stat held;
  struct stat visible;
  return fstat(bound.parent, &held) == 0
      && lstat(bound.parentPath.c_str(), &visible) == 0
      && S_ISDIR(visible.st_mode)
      && !S_ISLNK(visible.st_mode)
      && held.st_dev == visible.st_dev
      && held.st_ino == visible.st_ino
      && ExactPhysicalPath(bound.parentPath.c_str());
}

static bool BindDirectory(
    const char *path,
    uint64_t expectedDevice,
    uint64_t expectedInode,
    BoundDirectory *output) {
  if (!ExactPhysicalPath(path)
      || !SplitPath(path, &output->parentPath, &output->name)) return false;
  output->parent = open(output->parentPath.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (output->parent < 0) return false;
  output->device = expectedDevice;
  output->inode = expectedInode;
  struct stat entry;
  if (fstatat(output->parent, output->name.c_str(), &entry, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISDIR(entry.st_mode)
      || !SameIdentity(entry, expectedDevice, expectedInode)
      || !VisibleParentMatches(*output)) {
    close(output->parent);
    output->parent = -1;
    return false;
  }
  return true;
}

static bool Revalidate(const BoundDirectory &bound) {
  struct stat entry;
  return VisibleParentMatches(bound)
      && fstatat(bound.parent, bound.name.c_str(), &entry, AT_SYMLINK_NOFOLLOW) == 0
      && S_ISDIR(entry.st_mode)
      && SameIdentity(entry, bound.device, bound.inode);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 8 || strcmp(argv[1], "--swap-directories") != 0) {
      fprintf(stderr, "usage: Tweakers Swap Helper --swap-directories <absolute-dir> <absolute-dir> <first-dev> <first-ino> <second-dev> <second-ino>\n");
      return 64;
    }
    uint64_t firstDevice = 0;
    uint64_t firstInode = 0;
    uint64_t secondDevice = 0;
    uint64_t secondInode = 0;
    if (!ParseIdentity(argv[4], &firstDevice)
        || !ParseIdentity(argv[5], &firstInode)
        || !ParseIdentity(argv[6], &secondDevice)
        || !ParseIdentity(argv[7], &secondInode)) {
      fprintf(stderr, "swap identities must be unsigned decimal device/inode values\n");
      return 64;
    }
    BoundDirectory first;
    BoundDirectory second;
    if (!BindDirectory(argv[2], firstDevice, firstInode, &first)
        || !BindDirectory(argv[3], secondDevice, secondInode, &second)) {
      if (first.parent >= 0) close(first.parent);
      if (second.parent >= 0) close(second.parent);
      fprintf(stderr, "swap inputs do not match their exact physical directory identities\n");
      return 65;
    }
    if (!Revalidate(first) || !Revalidate(second)) {
      close(first.parent);
      close(second.parent);
      fprintf(stderr, "swap inputs changed after identity binding\n");
      return 65;
    }
    if (renameatx_np(first.parent, first.name.c_str(), second.parent, second.name.c_str(), RENAME_SWAP) != 0) {
      const int failure = errno;
      close(first.parent);
      close(second.parent);
      fprintf(stderr, "atomic directory swap failed: %s (errno=%d)\n", strerror(failure), failure);
      return failure == EPERM || failure == EACCES ? 77 : 1;
    }
    close(first.parent);
    close(second.parent);
  }
  return 0;
}
