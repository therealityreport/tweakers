#import <AppKit/AppKit.h>
#include <spawn.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <array>
#include <cctype>
#include <cerrno>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr char kElectronName[] = "Tweakers Electron";
constexpr char kConfigDirectory[] = "tweakers";
constexpr char kUserDataConfig[] = "variant-user-data-path";
constexpr char kCodexHomeConfig[] = "variant-codex-home-path";
constexpr char kAccountsBrokerConfig[] = "variant-accounts-broker-root";
constexpr size_t kMaximumConfigBytes = 4 * 1024;

bool Fail(const std::string &message) {
  dprintf(STDERR_FILENO, "Tweakers launcher: %s\n", message.c_str());
  return false;
}

std::string Dirname(const std::string &path) {
  const size_t slash = path.rfind('/');
  if (slash == std::string::npos) return {};
  return slash == 0 ? "/" : path.substr(0, slash);
}

std::string Basename(const std::string &path) {
  const size_t slash = path.rfind('/');
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

std::string Join(const std::string &left, const char *right) {
  return left + "/" + right;
}

bool CanonicalExistingPath(const std::string &path, std::string *result) {
  if (path.empty() || path.front() != '/') return false;
  std::array<char, PATH_MAX> resolved {};
  if (realpath(path.c_str(), resolved.data()) == nullptr) return false;
  *result = resolved.data();
  return true;
}

bool ReadOwnExecutablePath(std::string *path) {
  uint32_t bytes = 0;
  if (_NSGetExecutablePath(nullptr, &bytes) != -1 || bytes == 0) return Fail("could not resolve its executable directory");
  std::vector<char> buffer(static_cast<size_t>(bytes) + 1, '\0');
  if (_NSGetExecutablePath(buffer.data(), &bytes) != 0) return Fail("could not resolve its executable directory");
  if (!CanonicalExistingPath(buffer.data(), path)) return Fail("could not resolve its executable directory");
  return true;
}

bool IsSafeAppFile(
  const std::string &path,
  uid_t owner,
  bool executable,
  const char *label,
  struct stat *result = nullptr
) {
  struct stat entry {};
  if (lstat(path.c_str(), &entry) != 0) return Fail(std::string(label) + " is missing: " + std::strerror(errno));
  if (!S_ISREG(entry.st_mode) || entry.st_nlink != 1 || entry.st_uid != owner
      || (entry.st_mode & (S_IWGRP | S_IWOTH)) != 0
      || (executable && (entry.st_mode & (S_IXUSR | S_IXGRP | S_IXOTH)) == 0)) {
    return Fail(std::string(label) + " is missing or unsafe");
  }
  std::string canonical;
  if (!CanonicalExistingPath(path, &canonical) || canonical != path) {
    return Fail(std::string(label) + " is missing or unsafe");
  }
  if (result != nullptr) *result = entry;
  return true;
}

bool IsCanonicalAbsolutePath(const std::string &path) {
  if (path.size() < 2 || path.front() != '/') return false;
  size_t start = 1;
  while (start < path.size()) {
    const size_t slash = path.find('/', start);
    const size_t length = (slash == std::string::npos ? path.size() : slash) - start;
    if (length == 0 || (length == 1 && path[start] == '.')
        || (length == 2 && path[start] == '.' && path[start + 1] == '.')) {
      return false;
    }
    for (size_t index = start; index < start + length; ++index) {
      if (path[index] == '\0' || path[index] == '\n' || path[index] == '\r') return false;
    }
    if (slash == std::string::npos) return true;
    start = slash + 1;
  }
  return false;
}

bool ReadSignedPath(const std::string &path, uid_t launcherOwner, std::string *value) {
  if (!IsSafeAppFile(path, launcherOwner, false, "signed launch configuration")) return false;
  const int descriptor = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return Fail("could not open signed launch configuration: " + std::string(std::strerror(errno)));
  std::array<char, 1024> buffer {};
  std::string contents;
  while (true) {
    const ssize_t count = read(descriptor, buffer.data(), buffer.size());
    if (count < 0) {
      const int error = errno;
      close(descriptor);
      return Fail("could not read signed launch configuration: " + std::string(std::strerror(error)));
    }
    if (count == 0) break;
    if (contents.size() + static_cast<size_t>(count) > kMaximumConfigBytes) {
      close(descriptor);
      return Fail("signed launch configuration exceeds its fixed size limit");
    }
    contents.append(buffer.data(), static_cast<size_t>(count));
  }
  if (close(descriptor) != 0) return Fail("could not close signed launch configuration");
  if (contents.size() < 2 || contents.back() != '\n' || contents.find('\n') != contents.size() - 1
      || contents.find('\r') != std::string::npos || contents.find('\0') != std::string::npos) {
    return Fail("signed launch configuration must contain one canonical absolute path and one LF");
  }
  contents.pop_back();
  if (!IsCanonicalAbsolutePath(contents)) {
    return Fail("signed launch configuration is not a canonical absolute path");
  }
  *value = std::move(contents);
  return true;
}

bool IsSafePrivateDirectory(const std::string &path, uid_t owner, const char *label) {
  struct stat entry {};
  if (lstat(path.c_str(), &entry) != 0) return Fail(std::string(label) + " is missing or unsafe");
  if (!S_ISDIR(entry.st_mode) || entry.st_uid != owner || (entry.st_mode & 0077) != 0) {
    return Fail(std::string(label) + " is missing or unsafe");
  }
  std::string canonical;
  if (!CanonicalExistingPath(path, &canonical) || canonical != path) return Fail(std::string(label) + " is missing or unsafe");
  return true;
}

bool RemoveUntrustedUserDataSwitches(int argc, char *const argv[], std::vector<char *> *arguments) {
  arguments->clear();
  for (int index = 1; index < argc; ++index) {
    const char *argument = argv[index];
    if (argument == nullptr) return Fail("received an invalid launch argument");
    if (std::strcmp(argument, "--user-data-dir") == 0) {
      if (++index >= argc) return Fail("received an unterminated --user-data-dir argument");
      continue;
    }
    static constexpr char kUserDataPrefix[] = "--user-data-dir=";
    if (std::strncmp(argument, kUserDataPrefix, sizeof(kUserDataPrefix) - 1) == 0) continue;
    arguments->push_back(argv[index]);
  }
  return true;
}

bool IsSafeUserName(const std::string &value) {
  if (value.empty() || value.size() > 255) return false;
  for (const unsigned char character : value) {
    if (!std::isalnum(character) && character != '_' && character != '-' && character != '.') return false;
  }
  return true;
}

bool IsSafeEnvironmentValue(const std::string &value) {
  if (value.empty()) return false;
  for (const unsigned char character : value) {
    if (character == '\0' || character == '\n' || character == '\r') return false;
  }
  return true;
}

bool ReadTrustedUserEnvironment(
  std::string *home,
  std::string *user,
  std::string *shell,
  std::string *temporaryDirectory
) {
  const struct passwd *record = getpwuid(getuid());
  if (record == nullptr || record->pw_dir == nullptr || record->pw_name == nullptr || record->pw_shell == nullptr) {
    return Fail("could not resolve the current macOS user");
  }
  std::string canonicalHome;
  if (!CanonicalExistingPath(record->pw_dir, &canonicalHome)) {
    return Fail("could not resolve the current macOS home directory");
  }
  const std::string accountName(record->pw_name);
  const std::string loginShell(record->pw_shell);
  if (!IsSafeUserName(accountName) || loginShell.empty() || loginShell.front() != '/'
      || !IsSafeEnvironmentValue(loginShell) || access(loginShell.c_str(), X_OK) != 0) {
    return Fail("the current macOS user record is unsafe");
  }

  const size_t temporaryBytes = confstr(_CS_DARWIN_USER_TEMP_DIR, nullptr, 0);
  if (temporaryBytes < 2 || temporaryBytes > PATH_MAX) {
    return Fail("could not resolve the current macOS temporary directory");
  }
  std::vector<char> temporaryBuffer(temporaryBytes, '\0');
  if (confstr(_CS_DARWIN_USER_TEMP_DIR, temporaryBuffer.data(), temporaryBuffer.size()) == 0) {
    return Fail("could not resolve the current macOS temporary directory");
  }
  std::string canonicalTemporaryDirectory;
  if (!CanonicalExistingPath(temporaryBuffer.data(), &canonicalTemporaryDirectory)) {
    return Fail("could not resolve the current macOS temporary directory");
  }

  *home = std::move(canonicalHome);
  *user = accountName;
  *shell = loginShell;
  *temporaryDirectory = std::move(canonicalTemporaryDirectory);
  return true;
}

void AddEnvironment(
  std::vector<std::string> *storage,
  const char *name,
  const std::string &value
) {
  storage->push_back(std::string(name) + "=" + value);
}

bool BuildExactLaunchEnvironment(
  const std::string &userData,
  const std::string &codexHome,
  const std::string &accountsBrokerRoot,
  std::vector<std::string> *storage,
  std::vector<char *> *environment
) {
  std::string home;
  std::string user;
  std::string shell;
  std::string temporaryDirectory;
  if (!ReadTrustedUserEnvironment(&home, &user, &shell, &temporaryDirectory)) return false;
  const std::array<const std::string *, 7> values = {{
    &home,
    &user,
    &shell,
    &temporaryDirectory,
    &userData,
    &codexHome,
    &accountsBrokerRoot,
  }};
  for (const std::string *value : values) {
    if (!IsSafeEnvironmentValue(*value)) return Fail("could not bind isolated launch environment");
  }

  storage->clear();
  storage->reserve(15);
  AddEnvironment(storage, "HOME", home);
  AddEnvironment(storage, "USER", user);
  AddEnvironment(storage, "LOGNAME", user);
  AddEnvironment(storage, "SHELL", shell);
  AddEnvironment(storage, "TMPDIR", temporaryDirectory);
  AddEnvironment(storage, "PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
  AddEnvironment(storage, "LANG", "en_US.UTF-8");
  AddEnvironment(storage, "MallocNanoZone", "0");
  AddEnvironment(storage, "CODEX_ELECTRON_USER_DATA_PATH", userData);
  AddEnvironment(storage, "CODEX_HOME", codexHome);
  AddEnvironment(storage, "CODEX_SQLITE_HOME", codexHome);
  AddEnvironment(storage, "TWEAKERS_ACCOUNTS_BROKER_ROOT", accountsBrokerRoot);
  AddEnvironment(storage, "TWEAKER_ACCOUNTS_BROKER_ROOT", accountsBrokerRoot);
  AddEnvironment(storage, "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1");
  AddEnvironment(storage, "TWEAKERS_DERIVED_VARIANT", "1");

  environment->clear();
  environment->reserve(storage->size() + 1);
  for (std::string &entry : *storage) environment->push_back(entry.data());
  environment->push_back(nullptr);
  return true;
}

// The manager authenticates this wrapper's exact pre-Electron ancestry. No
// caller-selected command or environment crosses this fixed launch boundary.
bool PreparePortableDesktop() {
  std::string home, user, shell, temporaryDirectory;
  if (!ReadTrustedUserEnvironment(&home, &user, &shell, &temporaryDirectory)) return false;
  const std::string continuity = home + "/Library/Application Support/Tweakers Desktop Continuity";
  struct stat continuityStat {};
  if (lstat(continuity.c_str(), &continuityStat) != 0 && errno == ENOENT) return true;
  if (!IsSafePrivateDirectory(continuity, getuid(), "desktop continuity root")) return false;
  const std::string descriptor = home + "/Library/Application Support/Menu Bar/manager-descriptors/com.thomashulihan.tweakers.json";
  struct stat descriptorStat {};
  if (!IsSafeAppFile(descriptor, getuid(), false, "manager descriptor", &descriptorStat)
      || descriptorStat.st_size <= 0 || descriptorStat.st_size > 16384 || (descriptorStat.st_mode & 0077) != 0) return false;
  const int fd = open(descriptor.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return Fail("could not read manager descriptor");
  std::vector<char> bytes(static_cast<size_t>(descriptorStat.st_size));
  const ssize_t count = read(fd, bytes.data(), bytes.size());
  close(fd);
  if (count != descriptorStat.st_size) return Fail("manager descriptor changed while reading");
  NSData *data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![value isKindOfClass:[NSDictionary class]] || ![value[@"executable"] isKindOfClass:[NSString class]]) return Fail("invalid manager descriptor");
  const std::string manager([value[@"executable"] UTF8String]);
  const std::string prefix = home + "/Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/generations/";
  const std::string suffix = "/Tweakers Manager Launcher";
  if (manager.rfind(prefix, 0) != 0 || manager.size() != prefix.size() + 64 + suffix.size()
      || manager.substr(manager.size() - suffix.size()) != suffix) return Fail("manager path is outside its fixed generation");
  const std::string generation = manager.substr(prefix.size(), 64);
  if (generation.find_first_not_of("0123456789abcdef") != std::string::npos
      || !IsSafeAppFile(manager, getuid(), true, "manager launcher")) return false;
  std::array<char *, 3> arguments = {{const_cast<char *>(manager.c_str()), const_cast<char *>("portable-desktop-prelaunch-v1"), nullptr}};
  std::array<char *, 1> environment = {{nullptr}};
  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions) != 0) return Fail("could not prepare desktop handoff");
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
  pid_t child = 0;
  const int spawned = posix_spawn(&child, manager.c_str(), &actions, nullptr, arguments.data(), environment.data());
  posix_spawn_file_actions_destroy(&actions);
  if (spawned != 0) return Fail("could not start desktop handoff manager");
  int status = 0; pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 75) {
    @autoreleasepool {
      [NSApplication sharedApplication];
      [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
      NSAlert *alert = [[NSAlert alloc] init];
      alert.messageText = @"Review conflicting desktop settings";
      alert.informativeText = @"Some portable settings changed in both desktops. Both versions are preserved. Open Tweakers to review which settings to keep; synchronization will retry at the next idle handoff.";
      [alert addButtonWithTitle:@"Open Tweakers to Review"];
      [alert addButtonWithTitle:@"Cancel"];
      [NSApp activateIgnoringOtherApps:YES];
      return [alert runModal] == NSAlertFirstButtonReturn;
    }
  }
  if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return Fail("desktop settings handoff needs attention; use the managed launch command for details");
  return true;
}

}  // namespace

int main(int argc, char *argv[]) {
  std::string launcher;
  if (!ReadOwnExecutablePath(&launcher)) return 1;
  const std::string macosDirectory = Dirname(launcher);
  const std::string contentsDirectory = Dirname(macosDirectory);
  const std::string appRoot = Dirname(contentsDirectory);
  if (Basename(macosDirectory) != "MacOS" || Basename(contentsDirectory) != "Contents"
      || appRoot.size() <= 4 || appRoot.substr(appRoot.size() - 4) != ".app") {
    Fail("must run from a canonical Tweakers app bundle");
    return 1;
  }

  struct stat launcherStat {};
  if (!IsSafeAppFile(launcher, getuid(), true, "Tweakers App Launcher", &launcherStat)) return 1;
  const std::string electron = Join(macosDirectory, kElectronName);
  if (!IsSafeAppFile(electron, launcherStat.st_uid, true, "original Electron executable")) return 1;

  const std::string resources = Join(contentsDirectory, "Resources");
  const std::string configuration = Join(resources, kConfigDirectory);
  std::string userData;
  std::string codexHome;
  std::string accountsBrokerRoot;
  if (!ReadSignedPath(Join(configuration, kUserDataConfig), launcherStat.st_uid, &userData)
      || !ReadSignedPath(Join(configuration, kCodexHomeConfig), launcherStat.st_uid, &codexHome)
      || !ReadSignedPath(Join(configuration, kAccountsBrokerConfig), launcherStat.st_uid, &accountsBrokerRoot)) {
    return 1;
  }
  if (!IsSafePrivateDirectory(userData, getuid(), "isolated user-data path")
      || !IsSafePrivateDirectory(codexHome, getuid(), "isolated Codex home")) {
    return 1;
  }
  // The Accounts broker can be absent during first launch or recovery. Its
  // signed, canonical path still binds this client to one global owner; the
  // runtime will enter its fail-closed unavailable state if no broker appears.

  std::vector<char *> forwarded;
  if (!RemoveUntrustedUserDataSwitches(argc, argv, &forwarded)) return 1;
  std::vector<std::string> environmentStorage;
  std::vector<char *> environment;
  if (!BuildExactLaunchEnvironment(
    userData,
    codexHome,
    accountsBrokerRoot,
    &environmentStorage,
    &environment
  )) return 1;

  if (!PreparePortableDesktop()) return 1;

  std::string forcedUserDataArgument = "--user-data-dir=" + userData;
  std::vector<char *> launchArguments;
  launchArguments.reserve(forwarded.size() + 3);
  launchArguments.push_back(const_cast<char *>(electron.c_str()));
  // Electron's singleton must see this signed path before any forwarded
  // argument. Every incoming spelling of --user-data-dir was removed above.
  launchArguments.push_back(const_cast<char *>(forcedUserDataArgument.c_str()));
  launchArguments.insert(launchArguments.end(), forwarded.begin(), forwarded.end());
  launchArguments.push_back(nullptr);
  // Do not pass the manager, terminal, or development session's environment
  // into the desktop client.  Only the fixed user basics and signed Tweakers
  // isolation bindings above cross this native process boundary.
  execve(electron.c_str(), launchArguments.data(), environment.data());
  Fail("could not start Electron: " + std::string(std::strerror(errno)));
  return 1;
}
