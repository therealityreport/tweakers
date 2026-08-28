#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <CommonCrypto/CommonDigest.h>
#include <crt_externs.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

extern char **environ;

#ifndef TWEAKERS_MANAGER_CERTIFICATE_LEAF_SHA1
#error "TWEAKERS_MANAGER_CERTIFICATE_LEAF_SHA1 must be supplied by the policy-driven build"
#endif

namespace {

constexpr char kManagerId[] = "com.thomashulihan.tweakers";
constexpr char kLauncherName[] = "Tweakers Manager Launcher";
constexpr char kSealName[] = "target.seal";
constexpr char kManagerName[] = "manager.mjs";
constexpr char kLauncherIdentifier[] = "com.therealityreport.tweakers.manager-launcher";
constexpr char kCertificateLeafSha1[] = TWEAKERS_MANAGER_CERTIFICATE_LEAF_SHA1;
constexpr mode_t kManagedDirectoryMode = 0700;
constexpr mode_t kLauncherMode = 0500;
constexpr mode_t kReadOnlyFileMode = 0400;
constexpr size_t kMaximumSealBytes = 4096;
#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
constexpr size_t kMaximumPrepareInputBytes = 64 * 1024;
#endif

struct Seal {
  std::string generationId;
  std::string launcherSha256;
  std::string nodePath;
  std::string nodeSha256;
  std::string managerSha256;
};

enum class InvocationKind {
  kStatus,
#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
  kPrepare,
  kExecute,
  kCancel,
#endif
};

bool Fail(const std::string &message) {
  dprintf(STDERR_FILENO, "Tweakers Manager Launcher: %s\n", message.c_str());
  return false;
}

bool IsHexLower64(const std::string &value) {
  if (value.size() != 64) return false;
  for (const char c : value) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool IsCanonicalUuid(const char *value) {
  if (value == nullptr || std::strlen(value) != 36) return false;
  for (size_t index = 0; index < 36; ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
      continue;
    }
    const char c = value[index];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
bool IsStateToken(const char *value) {
  if (value == nullptr || std::strlen(value) != 7 + 64 || std::strncmp(value, "sha256:", 7) != 0) return false;
  return IsHexLower64(std::string(value + 7));
}

bool IsRfc3339(const char *value) {
  if (value == nullptr) return false;
  const std::string timestamp(value);
  // Match the protocol's narrow timestamp grammar here. JavaScript still
  // performs the final Date.parse validation after the signed launcher has
  // admitted only this fixed argv shape.
  if (timestamp.size() < 20 || timestamp[4] != '-' || timestamp[7] != '-' || timestamp[10] != 'T'
      || timestamp[13] != ':' || timestamp[16] != ':') return false;
  const auto digits = [&timestamp](size_t start, size_t count) {
    if (start + count > timestamp.size()) return false;
    for (size_t index = start; index < start + count; ++index) {
      if (timestamp[index] < '0' || timestamp[index] > '9') return false;
    }
    return true;
  };
  if (!digits(0, 4) || !digits(5, 2) || !digits(8, 2) || !digits(11, 2) || !digits(14, 2) || !digits(17, 2)) return false;
  size_t offset = 19;
  if (offset < timestamp.size() && timestamp[offset] == '.') {
    const size_t fractionalStart = ++offset;
    while (offset < timestamp.size() && timestamp[offset] >= '0' && timestamp[offset] <= '9') ++offset;
    if (offset == fractionalStart) return false;
  }
  if (offset == timestamp.size() - 1 && timestamp[offset] == 'Z') return true;
  if (offset + 6 != timestamp.size() || (timestamp[offset] != '+' && timestamp[offset] != '-')
      || timestamp[offset + 3] != ':' || !digits(offset + 1, 2) || !digits(offset + 4, 2)) return false;
  return true;
}

bool IsSupportedAction(const char *value) {
  if (value == nullptr) return false;
  static constexpr std::array<const char *, 10> actions = {
    "environment.cancel",
    "environment.recover",
    "desktop-update.resume",
    "desktop-update.cancel",
    "environment.switch",
    "desktop-update.start",
    "repair.run",
    "self-update.run",
    "refresh.full",
    "app.restart-runtime-proof",
  };
  for (const char *action : actions) {
    if (std::strcmp(value, action) == 0) return true;
  }
  return false;
}
#endif

std::string Dirname(const std::string &path) {
  const size_t slash = path.rfind('/');
  if (slash == std::string::npos) return {};
  return slash == 0 ? "/" : path.substr(0, slash);
}

std::string Basename(const std::string &path) {
  const size_t slash = path.rfind('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

bool CanonicalPath(const std::string &path, std::string *result) {
  if (path.empty() || path.front() != '/') return false;
  char resolved[PATH_MAX];
  if (realpath(path.c_str(), resolved) == nullptr) return false;
  *result = resolved;
  return true;
}

bool IsExpectedOwnedRegularFile(const std::string &path, uid_t owner, mode_t expectedMode, struct stat *result) {
  struct stat file {};
  if (lstat(path.c_str(), &file) != 0) return Fail("could not lstat " + path + ": " + std::strerror(errno));
  if (!S_ISREG(file.st_mode) || file.st_nlink != 1 || file.st_uid != owner || (file.st_mode & 07777) != expectedMode) {
    return Fail("unsafe managed file " + path);
  }
  std::string canonical;
  if (!CanonicalPath(path, &canonical) || canonical != path) return Fail("managed file is not canonical " + path);
  if (result != nullptr) *result = file;
  return true;
}

bool IsSafeNodeFile(const std::string &path, uid_t owner) {
  struct stat file {};
  if (lstat(path.c_str(), &file) != 0) return Fail("could not lstat node executable: " + std::string(std::strerror(errno)));
  if (!S_ISREG(file.st_mode) || file.st_nlink != 1 || (file.st_mode & (S_ISUID | S_ISGID)) != 0
      || (file.st_mode & (S_IWGRP | S_IWOTH)) != 0 || (file.st_uid != 0 && file.st_uid != owner)) {
    return Fail("unsafe node executable");
  }
  if ((file.st_mode & (S_IXUSR | S_IXGRP | S_IXOTH)) == 0) return Fail("node executable is not executable");
  std::string canonical;
  if (!CanonicalPath(path, &canonical) || canonical != path) return Fail("node executable is not canonical");
  return true;
}

bool IsExpectedManagedDirectory(const std::string &path, uid_t owner) {
  struct stat directory {};
  if (lstat(path.c_str(), &directory) != 0) return Fail("could not lstat " + path + ": " + std::strerror(errno));
  if (!S_ISDIR(directory.st_mode) || directory.st_uid != owner || (directory.st_mode & 07777) != kManagedDirectoryMode) {
    return Fail("unsafe managed directory " + path);
  }
  return true;
}

bool ValidateSafeAncestors(const std::string &path, uid_t owner) {
  if (path.empty() || path.front() != '/') return Fail("unsafe relative ancestor path");
  std::string current = "/";
  size_t offset = 1;
  while (offset <= path.size()) {
    const size_t slash = path.find('/', offset);
    const std::string component = path.substr(offset, slash == std::string::npos ? std::string::npos : slash - offset);
    if (!component.empty()) current = current == "/" ? "/" + component : current + "/" + component;
    struct stat item {};
    if (lstat(current.c_str(), &item) != 0) return Fail("could not lstat ancestor " + current + ": " + std::strerror(errno));
    if (!S_ISDIR(item.st_mode) || (item.st_mode & (S_IWGRP | S_IWOTH)) != 0 || (item.st_uid != 0 && item.st_uid != owner)) {
      return Fail("unsafe ancestor " + current);
    }
    if (slash == std::string::npos) break;
    offset = slash + 1;
  }
  return true;
}

bool ReadSmallFile(const std::string &path, std::string *contents) {
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return Fail("could not open " + path + ": " + std::strerror(errno));
  std::array<char, 1024> buffer {};
  contents->clear();
  while (true) {
    const ssize_t count = read(fd, buffer.data(), buffer.size());
    if (count < 0) {
      const int error = errno;
      close(fd);
      return Fail("could not read " + path + ": " + std::strerror(error));
    }
    if (count == 0) break;
    if (contents->size() + static_cast<size_t>(count) > kMaximumSealBytes) {
      close(fd);
      return Fail("target seal exceeds its fixed size limit");
    }
    contents->append(buffer.data(), static_cast<size_t>(count));
  }
  if (close(fd) != 0) return Fail("could not close " + path);
  return true;
}

bool Sha256File(const std::string &path, std::string *digest) {
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return Fail("could not open digest target " + path + ": " + std::strerror(errno));
  CC_SHA256_CTX context {};
  CC_SHA256_Init(&context);
  std::array<unsigned char, 16384> buffer {};
  while (true) {
    const ssize_t count = read(fd, buffer.data(), buffer.size());
    if (count < 0) {
      const int error = errno;
      close(fd);
      return Fail("could not read digest target " + path + ": " + std::strerror(error));
    }
    if (count == 0) break;
    CC_SHA256_Update(&context, buffer.data(), static_cast<CC_LONG>(count));
  }
  if (close(fd) != 0) return Fail("could not close digest target " + path);
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> bytes {};
  CC_SHA256_Final(bytes.data(), &context);
  static constexpr char hex[] = "0123456789abcdef";
  digest->assign(CC_SHA256_DIGEST_LENGTH * 2, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    (*digest)[index * 2] = hex[(bytes[index] >> 4) & 0x0f];
    (*digest)[index * 2 + 1] = hex[bytes[index] & 0x0f];
  }
  return true;
}

std::string Sha256Bytes(const std::string &contents) {
  CC_SHA256_CTX context {};
  CC_SHA256_Init(&context);
  CC_SHA256_Update(&context, contents.data(), static_cast<CC_LONG>(contents.size()));
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> bytes {};
  CC_SHA256_Final(bytes.data(), &context);
  static constexpr char hex[] = "0123456789abcdef";
  std::string digest(CC_SHA256_DIGEST_LENGTH * 2, '0');
  for (size_t index = 0; index < bytes.size(); ++index) {
    digest[index * 2] = hex[(bytes[index] >> 4) & 0x0f];
    digest[index * 2 + 1] = hex[bytes[index] & 0x0f];
  }
  return digest;
}

std::string GenerationIdPreimage(const Seal &seal) {
  return std::string("TWEAKERS_MANAGER_GENERATION_V1\n")
    + "manager-id=" + kManagerId + "\n"
    + "protocol-version=1\n"
    + "launcher-sha256=" + seal.launcherSha256 + "\n"
    + "node-path=" + seal.nodePath + "\n"
    + "node-sha256=" + seal.nodeSha256 + "\n"
    + "manager-sha256=" + seal.managerSha256 + "\n";
}

bool ParseSeal(const std::string &contents, Seal *seal) {
  if (contents.empty() || contents.back() != '\n') return Fail("target seal must end with one LF");
  std::vector<std::string> lines;
  size_t start = 0;
  while (start < contents.size()) {
    const size_t end = contents.find('\n', start);
    if (end == std::string::npos) return Fail("target seal is missing an LF");
    lines.push_back(contents.substr(start, end - start));
    start = end + 1;
  }
  if (lines.size() != 8 || lines[0] != "TWEAKERS_MANAGER_TARGET_SEAL_V1") return Fail("target seal has an invalid header or record count");
  const std::array<std::string, 7> keys = {
    "manager-id=", "protocol-version=", "generation-id=", "launcher-sha256=", "node-path=", "node-sha256=", "manager-sha256=",
  };
  std::array<std::string, 7> values {};
  for (size_t index = 0; index < keys.size(); ++index) {
    if (lines[index + 1].rfind(keys[index], 0) != 0) return Fail("target seal record order is invalid");
    values[index] = lines[index + 1].substr(keys[index].size());
    if (values[index].empty() || values[index].find_first_of("\r\n\0") != std::string::npos) return Fail("target seal record is empty or contains control data");
  }
  if (values[0] != kManagerId || values[1] != "1" || !IsHexLower64(values[2]) || !IsHexLower64(values[3]) || !IsHexLower64(values[5]) || !IsHexLower64(values[6])) {
    return Fail("target seal has an invalid fixed value");
  }
  if (values[4].front() != '/') return Fail("target seal node path is not absolute");
  *seal = {values[2], values[3], values[4], values[5], values[6]};
  return true;
}

bool SelfExecutablePath(std::string *path) {
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  if (size == 0 || size > PATH_MAX) return Fail("could not resolve the launcher path");
  std::vector<char> buffer(size + 1, '\0');
  if (_NSGetExecutablePath(buffer.data(), &size) != 0) return Fail("could not read the launcher path");
  std::string raw(buffer.data());
  if (!CanonicalPath(raw, path)) return Fail("could not canonicalize the launcher path");
  return true;
}

bool ValidateOwnCodeSignature(const std::string &path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(path.data()), path.size(), false);
  if (url == nullptr) return Fail("could not construct code-signing URL");
  SecStaticCodeRef code = nullptr;
  OSStatus result = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  CFRelease(url);
  if (result != errSecSuccess || code == nullptr) return Fail("could not inspect launcher code signature");
  const std::string text = std::string("identifier \"") + kLauncherIdentifier
    + "\" and certificate leaf = H\"" + kCertificateLeafSha1 + "\"";
  CFStringRef requirementText = CFStringCreateWithCString(kCFAllocatorDefault, text.c_str(), kCFStringEncodingUTF8);
  SecRequirementRef requirement = nullptr;
  result = requirementText == nullptr ? errSecParam : SecRequirementCreateWithString(requirementText, kSecCSDefaultFlags, &requirement);
  if (requirementText != nullptr) CFRelease(requirementText);
  if (result != errSecSuccess || requirement == nullptr) {
    CFRelease(code);
    return Fail("could not create launcher signing requirement");
  }
  result = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, requirement);
  CFRelease(requirement);
  CFRelease(code);
  if (result != errSecSuccess) return Fail("launcher code signature does not meet its designated requirement");
  return true;
}

bool ValidateInvocation(int argc, char *const argv[], InvocationKind *kind) {
  if (kind == nullptr) return Fail("could not classify manager invocation");
  if (argc == 5 && std::strcmp(argv[1], "status") == 0
      && std::strcmp(argv[2], "--request-id") == 0 && IsCanonicalUuid(argv[3])
      && std::strcmp(argv[4], "--json") == 0) {
    *kind = InvocationKind::kStatus;
    return true;
  }
#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
  if (argc == 13 && std::strcmp(argv[1], "prepare") == 0
      && std::strcmp(argv[2], "--request-id") == 0 && IsCanonicalUuid(argv[3])
      && std::strcmp(argv[4], "--operation-id") == 0 && IsCanonicalUuid(argv[5])
      && std::strcmp(argv[6], "--action") == 0 && IsSupportedAction(argv[7])
      && std::strcmp(argv[8], "--state-token") == 0 && IsStateToken(argv[9])
      && std::strcmp(argv[10], "--expires-at") == 0 && IsRfc3339(argv[11])
      && std::strcmp(argv[12], "--json") == 0) {
    *kind = InvocationKind::kPrepare;
    return true;
  }
  if (argc == 7 && (std::strcmp(argv[1], "execute") == 0 || std::strcmp(argv[1], "cancel") == 0)
      && std::strcmp(argv[2], "--request-id") == 0 && IsCanonicalUuid(argv[3])
      && std::strcmp(argv[4], "--operation-id") == 0 && IsCanonicalUuid(argv[5])
      && std::strcmp(argv[6], "--json") == 0) {
    *kind = std::strcmp(argv[1], "execute") == 0 ? InvocationKind::kExecute : InvocationKind::kCancel;
    return true;
  }
#endif
  return Fail("only the fixed v1 status manager argv shape is supported");
}

bool ValidatePrivilegeBoundary() {
  if (getuid() == 0 || geteuid() == 0 || getuid() != geteuid() || getgid() != getegid()) {
    return Fail("root, effective-ID mismatch, and set-ID launch are forbidden");
  }
  return true;
}

bool ValidateGeneration(const std::string &launcher, Seal *seal, std::string *managerPath, std::string *nodePath) {
  const uid_t owner = getuid();
  const std::string generation = Dirname(launcher);
  const std::string generations = Dirname(generation);
  const std::string managerRoot = Dirname(generations);
  const std::string managers = Dirname(managerRoot);
  const std::string userRoot = Dirname(managers);
  if (Basename(launcher) != kLauncherName || Basename(generations) != "generations" || Basename(managerRoot) != kManagerId || Basename(managers) != "managers" || userRoot.empty() || userRoot == "/") {
    return Fail("launcher is not in its fixed generation location");
  }
  if (!ValidateSafeAncestors(generation, owner)
      || !IsExpectedManagedDirectory(managers, owner)
      || !IsExpectedManagedDirectory(managerRoot, owner)
      || !IsExpectedManagedDirectory(generations, owner)
      || !IsExpectedManagedDirectory(generation, owner)
      || !IsExpectedOwnedRegularFile(launcher, owner, kLauncherMode, nullptr)) {
    return false;
  }
  const std::string sealPath = generation + "/" + kSealName;
  const std::string managerScript = generation + "/" + kManagerName;
  if (!IsExpectedOwnedRegularFile(sealPath, owner, kReadOnlyFileMode, nullptr)
      || !IsExpectedOwnedRegularFile(managerScript, owner, kReadOnlyFileMode, nullptr)) {
    return false;
  }
  std::string sealContents;
  if (!ReadSmallFile(sealPath, &sealContents) || !ParseSeal(sealContents, seal)) return false;
  if (Basename(generation) != seal->generationId) return Fail("target seal generation does not match its directory");
  std::string launcherDigest;
  std::string managerDigest;
  if (!Sha256File(launcher, &launcherDigest) || !Sha256File(managerScript, &managerDigest)) return false;
  if (launcherDigest != seal->launcherSha256 || managerDigest != seal->managerSha256) return Fail("target seal digest mismatch");
  if (Sha256Bytes(GenerationIdPreimage(*seal)) != seal->generationId || Basename(generation) != seal->generationId) {
    return Fail("target seal generation identity mismatch");
  }
  std::string canonicalNode;
  if (!CanonicalPath(seal->nodePath, &canonicalNode) || canonicalNode != seal->nodePath || !IsSafeNodeFile(canonicalNode, owner) || !ValidateSafeAncestors(Dirname(canonicalNode), owner)) {
    return false;
  }
  std::string nodeDigest;
  if (!Sha256File(canonicalNode, &nodeDigest) || nodeDigest != seal->nodeSha256) return Fail("node executable digest mismatch");
  *managerPath = managerScript;
  *nodePath = canonicalNode;
  return true;
}

#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
bool ReadPrepareInput(std::string *input) {
  if (input == nullptr) return Fail("could not retain prepare input");
  input->clear();
  std::array<char, 4096> buffer {};
  while (true) {
    const ssize_t count = read(STDIN_FILENO, buffer.data(), buffer.size());
    if (count < 0) {
      if (errno == EINTR) continue;
      return Fail("could not read bounded prepare input: " + std::string(std::strerror(errno)));
    }
    if (count == 0) return true;
    const size_t length = static_cast<size_t>(count);
    if (length > kMaximumPrepareInputBytes - input->size()) {
      return Fail("prepare input exceeds the fixed 64 KiB limit");
    }
    input->append(buffer.data(), length);
  }
}
#endif

bool WriteAll(int fd, const std::string &input) {
  size_t offset = 0;
  while (offset < input.size()) {
    const ssize_t written = write(fd, input.data() + offset, input.size() - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return Fail("could not pass bounded prepare input to sealed manager: " + std::string(std::strerror(errno)));
    }
    if (written == 0) return Fail("could not pass bounded prepare input to sealed manager");
    offset += static_cast<size_t>(written);
  }
  return true;
}

int WaitForManager(pid_t child) {
  int childStatus = 0;
  while (waitpid(child, &childStatus, 0) < 0) {
    if (errno == EINTR) continue;
    Fail("could not wait for sealed manager: " + std::string(std::strerror(errno)));
    return 70;
  }
  if (WIFEXITED(childStatus)) return WEXITSTATUS(childStatus);
  if (WIFSIGNALED(childStatus)) return 128 + WTERMSIG(childStatus);
  Fail("sealed manager exited without a status");
  return 70;
}

int SpawnManager(
  const std::string &nodePath,
  const std::string &managerPath,
  int argc,
  char *const argv[]
) {
  posix_spawnattr_t attributes {};
  int result = posix_spawnattr_init(&attributes);
  if (result != 0) {
    Fail("could not initialize spawn attributes");
    return 70;
  }
  const pid_t group = getpgrp();
  if (group <= 0 || posix_spawnattr_setpgroup(&attributes, group) != 0
      || posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP) != 0) {
    posix_spawnattr_destroy(&attributes);
    Fail("could not bind manager to the launcher's process group");
    return 70;
  }
  std::vector<char *> childArguments;
  childArguments.reserve(static_cast<size_t>(argc) + 2);
  childArguments.push_back(const_cast<char *>(nodePath.c_str()));
  childArguments.push_back(const_cast<char *>(managerPath.c_str()));
  for (int index = 1; index < argc; ++index) childArguments.push_back(argv[index]);
  childArguments.push_back(nullptr);
  char *childEnvironment[] = {nullptr};
#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
  const std::string *prepareInput = nullptr;
  posix_spawn_file_actions_t fileActions {};
  posix_spawn_file_actions_t *fileActionsPointer = nullptr;
  bool fileActionsInitialized = false;
  int inputPipe[2] = {-1, -1};
  if (prepareInput != nullptr) {
    if (pipe(inputPipe) != 0) {
      posix_spawnattr_destroy(&attributes);
      Fail("could not create bounded prepare input pipe: " + std::string(std::strerror(errno)));
      return 70;
    }
    if (fcntl(inputPipe[0], F_SETFD, FD_CLOEXEC) != 0 || fcntl(inputPipe[1], F_SETFD, FD_CLOEXEC) != 0) {
      const int error = errno;
      close(inputPipe[0]);
      close(inputPipe[1]);
      posix_spawnattr_destroy(&attributes);
      Fail("could not secure bounded prepare input pipe: " + std::string(std::strerror(error)));
      return 70;
    }
#ifdef F_SETNOSIGPIPE
    if (fcntl(inputPipe[1], F_SETNOSIGPIPE, 1) != 0) {
      const int error = errno;
      close(inputPipe[0]);
      close(inputPipe[1]);
      posix_spawnattr_destroy(&attributes);
      Fail("could not secure bounded prepare input pipe writer: " + std::string(std::strerror(error)));
      return 70;
    }
#endif
    result = posix_spawn_file_actions_init(&fileActions);
    if (result != 0) {
      close(inputPipe[0]);
      close(inputPipe[1]);
      posix_spawnattr_destroy(&attributes);
      Fail("could not initialize prepare input spawn actions: " + std::string(std::strerror(result)));
      return 70;
    }
    fileActionsInitialized = true;
    if (posix_spawn_file_actions_adddup2(&fileActions, inputPipe[0], STDIN_FILENO) != 0
        || (inputPipe[0] != STDIN_FILENO && posix_spawn_file_actions_addclose(&fileActions, inputPipe[0]) != 0)
        || posix_spawn_file_actions_addclose(&fileActions, inputPipe[1]) != 0) {
      posix_spawn_file_actions_destroy(&fileActions);
      close(inputPipe[0]);
      close(inputPipe[1]);
      posix_spawnattr_destroy(&attributes);
      Fail("could not bind bounded prepare input to sealed manager");
      return 70;
    }
    fileActionsPointer = &fileActions;
  }
#else
  posix_spawn_file_actions_t *fileActionsPointer = nullptr;
#endif
  pid_t child = 0;
  result = posix_spawn(&child, nodePath.c_str(), fileActionsPointer, &attributes, childArguments.data(), childEnvironment);
#if defined(TWEAKERS_MANAGER_EXPERIMENTAL_ACTIONS)
  if (fileActionsInitialized) posix_spawn_file_actions_destroy(&fileActions);
  posix_spawnattr_destroy(&attributes);
  if (inputPipe[0] >= 0) {
    close(inputPipe[0]);
    inputPipe[0] = -1;
  }
  if (result != 0) {
    if (inputPipe[1] >= 0) close(inputPipe[1]);
    Fail("could not start sealed manager: " + std::string(std::strerror(result)));
    return 70;
  }
  bool inputWritten = true;
  bool inputClosed = true;
  if (prepareInput != nullptr) {
    inputWritten = WriteAll(inputPipe[1], *prepareInput);
    if (close(inputPipe[1]) != 0) {
      inputClosed = false;
      Fail("could not close bounded prepare input pipe: " + std::string(std::strerror(errno)));
    }
  }
  const int childResult = WaitForManager(child);
  return inputWritten && inputClosed ? childResult : 70;
#else
  posix_spawnattr_destroy(&attributes);
  if (result != 0) {
    Fail("could not start sealed manager: " + std::string(std::strerror(result)));
    return 70;
  }
  return WaitForManager(child);
#endif
}

}  // namespace

int main(int argc, char *argv[]) {
  InvocationKind kind {};
  if (!ValidatePrivilegeBoundary() || !ValidateInvocation(argc, argv, &kind)) return 64;
  std::string launcher;
  if (!SelfExecutablePath(&launcher)) return 70;
  if (!ValidateOwnCodeSignature(launcher)) return 70;
  Seal seal;
  std::string managerPath;
  std::string nodePath;
  if (!ValidateGeneration(launcher, &seal, &managerPath, &nodePath)) return 70;
  return SpawnManager(nodePath, managerPath, argc, argv);
}
