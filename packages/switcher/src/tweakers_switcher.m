// Tweakers menu-bar mode switcher.
//
// A tiny NSStatusItem app that shows which mode /Applications/ChatGPT.app is
// in ("chatgpt" = pristine official payload, "tweakers" = patched payload) and
// offers the switch to the other one. In ChatGPT mode the app is pristine (no
// injected UI), so this menu bar item is the only in-GUI way back to Tweakers
// mode — it must stay dumb and reliable:
//
//   - It only READS installer state, cached appcast metadata, and signed live
//     bundle evidence — it never touches bundles or performs network requests.
//   - Mode changes use `tweaker mode <target>`; that CLI prepares the complete
//     environment first, then owns the one confirmation and verified restart.
//     Development reloads use
//     the registered checkout's `tweaker refresh-local --source development`.
//     Both are spawned fully detached (new session, no wait) so they survive
//     the app quitting during promotion.
//   - The CLI invocation comes from a sidecar config the installer writes at
//     `tweaker mode setup` time (switcher.json in the Tweakers user root) —
//     nothing machine-specific is baked into this binary.
//
// Lifecycle: launched by the com.therealityreport.tweakers.switcher
// LaunchAgent with KeepAlive={SuccessfulExit:false}, so launchd restarts it
// after a crash but a clean "Quit Switcher" (exit 0) stays quit.
//
// AppKit + Foundation only; targets macOS 13+.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>

static NSString *const TWSModeChatgpt = @"chatgpt";
static NSString *const TWSModeTweakers = @"tweakers";
static NSString *const TWSModeUnknown = @"unknown";
static NSString *const TWSOpenAITeamIdentifier = @"2DC432GLL2";

/// Refresh cadence while the menu is closed; the menu itself refreshes on open.
static const uint64_t TWSRefreshIntervalSeconds = 5;
/// Cached update metadata older than this is not authoritative enough to call
/// the installed desktop current.
static const NSTimeInterval TWSAppcastFreshnessSeconds = 24 * 60 * 60;
static const NSTimeInterval TWSAppcastFutureToleranceSeconds = 5 * 60;

#pragma mark - Installer state access

/// Resolves the Tweakers user root exactly like the installer's paths.ts:
/// TWEAKERS_HOME -> TWEAKER_HOME -> ~/Library/Application Support with
/// the legacy tweaker directory staying authoritative while it exists.
static NSString *TWSUserRoot(void) {
  NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
  if (env[@"TWEAKERS_HOME"].length > 0) return env[@"TWEAKERS_HOME"];
  if (env[@"TWEAKER_HOME"].length > 0) return env[@"TWEAKER_HOME"];
  NSString *appSupport =
      [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"];
  NSString *legacy = [appSupport stringByAppendingPathComponent:@"tweaker"];
  if ([NSFileManager.defaultManager fileExistsAtPath:legacy]) return legacy;
  return [appSupport stringByAppendingPathComponent:@"Tweakers"];
}

static NSDictionary *TWSReadJSONDictionary(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

static NSString *TWSAppRoot(void);

static NSString *TWSLiveAsarIntegrityHash(NSString *appRoot) {
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:
      [appRoot stringByAppendingPathComponent:@"Contents/Info.plist"]];
  NSDictionary *integrity = [info[@"ElectronAsarIntegrity"] isKindOfClass:[NSDictionary class]]
      ? info[@"ElectronAsarIntegrity"]
      : nil;
  NSDictionary *asar = [integrity[@"Resources/app.asar"] isKindOfClass:[NSDictionary class]]
      ? integrity[@"Resources/app.asar"]
      : nil;
  id hash = asar[@"hash"];
  return [hash isKindOfClass:[NSString class]] && [hash length] > 0 ? hash : nil;
}

static BOOL TWSHasValidOpenAISignature(NSString *appRoot) {
  SecStaticCodeRef code = NULL;
  NSURL *url = [NSURL fileURLWithPath:appRoot];
  if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess) {
    return NO;
  }
  BOOL valid = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL) == errSecSuccess;
  CFDictionaryRef rawInfo = NULL;
  if (valid && SecCodeCopySigningInformation(code, kSecCSSigningInformation, &rawInfo) == errSecSuccess) {
    NSDictionary *signing = CFBridgingRelease(rawInfo);
    id team = signing[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    valid = [team isKindOfClass:[NSString class]] && [team isEqualToString:TWSOpenAITeamIdentifier];
  } else {
    valid = NO;
  }
  CFRelease(code);
  return valid;
}

static NSString *TWSModeFromEvidence(
    NSString *patchedHash,
    NSString *liveHash,
    BOOL validOpenAISignature) {
  if (patchedHash.length > 0 && liveHash.length > 0 && [patchedHash isEqualToString:liveHash]) {
    return TWSModeTweakers;
  }
  if (validOpenAISignature) return TWSModeChatgpt;
  return TWSModeUnknown;
}

/// Report observed bundle reality, never stale persisted intent. state.json's
/// patched hash proves Tweakers; a strict OpenAI Team signature proves ChatGPT.
static NSString *TWSCurrentMode(void) {
  NSDictionary *state =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"state.json"]);
  NSString *appRoot = TWSAppRoot();
  id patchedHash = state[@"patchedAsarHash"];
  return TWSModeFromEvidence(
      [patchedHash isKindOfClass:[NSString class]] ? patchedHash : nil,
      TWSLiveAsarIntegrityHash(appRoot),
      TWSHasValidOpenAISignature(appRoot));
}

static NSString *TWSAppRoot(void) {
  NSDictionary *state =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"state.json"]);
  id appRoot = state[@"appRoot"];
  return [appRoot isKindOfClass:[NSString class]] && [appRoot length] > 0
      ? appRoot
      : @"/Applications/ChatGPT.app";
}

#pragma mark - Read-only desktop update status

typedef NS_ENUM(NSInteger, TWSDesktopUpdateKind) {
  TWSDesktopUpdateCheckNeeded = 0,
  TWSDesktopUpdateCurrent = 1,
  TWSDesktopUpdateAvailable = 2,
};

@interface TWSDesktopUpdateStatus : NSObject
@property(nonatomic) TWSDesktopUpdateKind kind;
@property(nonatomic, copy) NSString *currentVersion;
@property(nonatomic, copy) NSString *latestVersion;
@property(nonatomic, copy) NSString *detail;
@end

@implementation TWSDesktopUpdateStatus
@end

static NSString *TWSNonEmptyString(id value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *trimmed = [(NSString *)value
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return trimmed.length > 0 ? trimmed : nil;
}

static BOOL TWSIsDecimalString(NSString *value) {
  if (value.length == 0) return NO;
  return [value rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet]
             .location == NSNotFound;
}

static BOOL TWSIsDottedNumericVersion(NSString *value) {
  if (value.length == 0) return NO;
  NSArray<NSString *> *parts = [value componentsSeparatedByString:@"."];
  if (parts.count == 0) return NO;
  for (NSString *part in parts) {
    if (!TWSIsDecimalString(part)) return NO;
  }
  return YES;
}

/// Compares arbitrarily long unsigned decimal strings without integer
/// overflow. Callers validate the strings first.
static NSComparisonResult TWSCompareDecimalStrings(NSString *left, NSString *right) {
  NSUInteger leftIndex = 0;
  while (leftIndex + 1 < left.length && [left characterAtIndex:leftIndex] == '0') leftIndex += 1;
  NSUInteger rightIndex = 0;
  while (rightIndex + 1 < right.length && [right characterAtIndex:rightIndex] == '0') rightIndex += 1;
  NSString *normalizedLeft = [left substringFromIndex:leftIndex];
  NSString *normalizedRight = [right substringFromIndex:rightIndex];
  if (normalizedLeft.length < normalizedRight.length) return NSOrderedAscending;
  if (normalizedLeft.length > normalizedRight.length) return NSOrderedDescending;
  return [normalizedLeft compare:normalizedRight];
}

static NSComparisonResult TWSCompareDottedNumericVersions(
    NSString *left,
    NSString *right,
    BOOL *valid) {
  if (!TWSIsDottedNumericVersion(left) || !TWSIsDottedNumericVersion(right)) {
    if (valid != NULL) *valid = NO;
    return NSOrderedSame;
  }
  if (valid != NULL) *valid = YES;
  NSArray<NSString *> *leftParts = [left componentsSeparatedByString:@"."];
  NSArray<NSString *> *rightParts = [right componentsSeparatedByString:@"."];
  NSUInteger count = MAX(leftParts.count, rightParts.count);
  for (NSUInteger index = 0; index < count; index += 1) {
    NSString *leftPart = index < leftParts.count ? leftParts[index] : @"0";
    NSString *rightPart = index < rightParts.count ? rightParts[index] : @"0";
    NSComparisonResult comparison = TWSCompareDecimalStrings(leftPart, rightPart);
    if (comparison != NSOrderedSame) return comparison;
  }
  return NSOrderedSame;
}

static NSDate *TWSParseISO8601Date(NSString *raw) {
  if (raw.length == 0) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
      NSISO8601DateFormatWithFractionalSeconds;
  NSDate *date = [formatter dateFromString:raw];
  if (date != nil) return date;
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
  return [formatter dateFromString:raw];
}

static NSString *TWSDesktopVersionDisplay(NSString *marketing, NSString *build) {
  BOOL marketingValid = TWSIsDottedNumericVersion(marketing);
  BOOL buildValid = TWSIsDecimalString(build);
  if (marketingValid && buildValid) {
    return [NSString stringWithFormat:@"%@ (%@)", marketing, build];
  }
  if (marketingValid) return marketing;
  if (buildValid) return [NSString stringWithFormat:@"build %@", build];
  return nil;
}

static TWSDesktopUpdateStatus *TWSDesktopUpdateCheckNeededStatus(NSString *detail) {
  TWSDesktopUpdateStatus *status = [[TWSDesktopUpdateStatus alloc] init];
  status.kind = TWSDesktopUpdateCheckNeeded;
  status.detail = detail;
  return status;
}

/// Pure comparison seam used by the focused native regression harness.
static TWSDesktopUpdateStatus *TWSDesktopUpdateStatusFromMetadata(
    NSDictionary *appcast,
    NSDictionary *appInfo,
    NSDate *now) {
  if (![appcast isKindOfClass:[NSDictionary class]]) {
    return TWSDesktopUpdateCheckNeededStatus(@"Cached OpenAI appcast information is missing.");
  }
  NSString *checkedAtRaw = TWSNonEmptyString(appcast[@"checkedAt"]);
  NSDate *checkedAt = TWSParseISO8601Date(checkedAtRaw);
  if (checkedAt == nil) {
    return TWSDesktopUpdateCheckNeededStatus(@"Cached OpenAI appcast check time is missing or invalid.");
  }
  NSDate *effectiveNow = now ?: [NSDate date];
  NSTimeInterval age = [effectiveNow timeIntervalSinceDate:checkedAt];
  if (age > TWSAppcastFreshnessSeconds || age < -TWSAppcastFutureToleranceSeconds) {
    return TWSDesktopUpdateCheckNeededStatus(@"Cached OpenAI appcast information is stale.");
  }
  if (![appInfo isKindOfClass:[NSDictionary class]]) {
    return TWSDesktopUpdateCheckNeededStatus(@"Installed ChatGPT metadata is unavailable.");
  }

  NSString *currentMarketing = TWSNonEmptyString(appInfo[@"CFBundleShortVersionString"]);
  NSString *currentBuild = TWSNonEmptyString(appInfo[@"CFBundleVersion"]);
  NSString *latestMarketing = TWSNonEmptyString(appcast[@"marketingVersion"]);
  NSString *latestBuild = TWSNonEmptyString(appcast[@"build"]);

  NSComparisonResult comparison = NSOrderedSame;
  BOOL comparisonValid = NO;
  if (TWSIsDecimalString(currentBuild) && TWSIsDecimalString(latestBuild)) {
    comparison = TWSCompareDecimalStrings(currentBuild, latestBuild);
    comparisonValid = YES;
  } else {
    comparison = TWSCompareDottedNumericVersions(
        currentMarketing, latestMarketing, &comparisonValid);
  }
  if (!comparisonValid) {
    return TWSDesktopUpdateCheckNeededStatus(
        @"Installed or cached ChatGPT version metadata is incomplete or invalid.");
  }

  TWSDesktopUpdateStatus *status = [[TWSDesktopUpdateStatus alloc] init];
  status.kind = comparison == NSOrderedAscending
      ? TWSDesktopUpdateAvailable
      : TWSDesktopUpdateCurrent;
  status.currentVersion = TWSDesktopVersionDisplay(currentMarketing, currentBuild);
  status.latestVersion = TWSDesktopVersionDisplay(latestMarketing, latestBuild);
  status.detail = [NSString stringWithFormat:@"Installed %@ · Cached latest %@ · Checked %@",
      status.currentVersion ?: @"unknown",
      status.latestVersion ?: @"unknown",
      checkedAtRaw];
  return status;
}

static NSDictionary *TWSCachedAppcastMetadata(void) {
  NSDictionary *config =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"config.json"]);
  id section = config[@"tweaker"];
  if (![section isKindOfClass:[NSDictionary class]]) section = config[@"codexPlusPlus"];
  id appcast = [section isKindOfClass:[NSDictionary class]]
      ? ((NSDictionary *)section)[@"codexAppcastCache"]
      : nil;
  return [appcast isKindOfClass:[NSDictionary class]] ? appcast : nil;
}

static NSDictionary *TWSInstalledAppMetadata(NSString *appRoot) {
  NSString *path = [appRoot stringByAppendingPathComponent:@"Contents/Info.plist"];
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:path];
  return [info isKindOfClass:[NSDictionary class]] ? info : nil;
}

static TWSDesktopUpdateStatus *TWSCurrentDesktopUpdateStatus(void) {
  NSString *appRoot = TWSAppRoot();
  return TWSDesktopUpdateStatusFromMetadata(
      TWSCachedAppcastMetadata(),
      TWSInstalledAppMetadata(appRoot),
      [NSDate date]);
}

static NSString *TWSDesktopUpdateMenuTitle(TWSDesktopUpdateStatus *status) {
  switch (status.kind) {
    case TWSDesktopUpdateAvailable:
      return status.latestVersion.length > 0
          ? [NSString stringWithFormat:@"ChatGPT update available · %@", status.latestVersion]
          : @"ChatGPT update available";
    case TWSDesktopUpdateCurrent:
      return status.currentVersion.length > 0
          ? [NSString stringWithFormat:@"ChatGPT update: Current · %@", status.currentVersion]
          : @"ChatGPT update: Current";
    case TWSDesktopUpdateCheckNeeded:
    default:
      return @"ChatGPT update: Check needed";
  }
}

/// CLI invocation (argv prefix) from the sidecar the installer writes at setup
/// time. Returns nil when missing/malformed so the UI can point at
/// `tweaker mode setup` instead of spawning garbage.
static NSArray<NSString *> *TWSCliInvocation(void) {
  NSDictionary *config =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"switcher.json"]);
  id cli = config[@"cli"];
  if (![cli isKindOfClass:[NSArray class]] || [cli count] == 0) return nil;
  for (id entry in cli) {
    if (![entry isKindOfClass:[NSString class]] || [entry length] == 0) return nil;
  }
  return cli;
}

/// Refreshes must enter through the registered development checkout's CLI
/// when it exists. The installer binds runtime asset paths relative to the CLI
/// tree, so using the managed CLI could build the checkout and then promote
/// the older managed assets. This mirrors runtime/main.ts localRefreshCli().
static NSArray<NSString *> *TWSRefreshCliInvocation(void) {
  NSArray<NSString *> *cli = TWSCliInvocation();
  if (cli.count < 2 ||
      ![NSFileManager.defaultManager isExecutableFileAtPath:cli[0]]) return nil;

  NSDictionary *config =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"config.json"]);
  id section = config[@"tweaker"];
  id sourceRoot = [section isKindOfClass:[NSDictionary class]]
      ? ((NSDictionary *)section)[@"developmentSourceRoot"]
      : nil;
  if (![sourceRoot isKindOfClass:[NSString class]] || [sourceRoot length] == 0) return nil;

  NSString *developmentCli =
      [sourceRoot stringByAppendingPathComponent:@"packages/installer/dist/cli.js"];
  if (![NSFileManager.defaultManager fileExistsAtPath:developmentCli]) return nil;

  NSMutableArray<NSString *> *refreshCli = [cli mutableCopy];
  refreshCli[refreshCli.count - 1] = developmentCli;
  return [refreshCli copy];
}

#pragma mark - Detached spawn

/// Spawns argv fully detached: its own session (POSIX_SPAWN_SETSID), stdio on
/// /dev/null, never waited on. The Node executable's directory is prepended to
/// PATH so a development refresh can find its sibling npm even though the
/// LaunchAgent starts with macOS's minimal PATH.
static BOOL TWSSpawnDetached(NSArray<NSString *> *argv) {
  if (argv.count == 0) return NO;

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSID);

  char **cargv = calloc(argv.count + 1, sizeof(char *));
  for (NSUInteger i = 0; i < argv.count; i += 1) {
    cargv[i] = strdup(argv[i].fileSystemRepresentation);
  }

  NSMutableDictionary<NSString *, NSString *> *childEnv =
      [NSProcessInfo.processInfo.environment mutableCopy];
  NSString *runtimeBin = [argv[0] stringByDeletingLastPathComponent];
  NSString *existingPath = childEnv[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
  childEnv[@"PATH"] = [NSString stringWithFormat:@"%@:%@", runtimeBin, existingPath];
  NSArray<NSString *> *envKeys = [[childEnv allKeys] sortedArrayUsingSelector:@selector(compare:)];
  char **cenv = calloc(envKeys.count + 1, sizeof(char *));
  for (NSUInteger i = 0; i < envKeys.count; i += 1) {
    NSString *key = envKeys[i];
    NSString *entry = [NSString stringWithFormat:@"%@=%@", key, childEnv[key]];
    cenv[i] = strdup(entry.UTF8String);
  }

  pid_t pid = 0;
  int rc = posix_spawn(&pid, cargv[0], &actions, &attr, cargv, cenv);

  for (NSUInteger i = 0; i < argv.count; i += 1) free(cargv[i]);
  free(cargv);
  for (NSUInteger i = 0; i < envKeys.count; i += 1) free(cenv[i]);
  free(cenv);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  return rc == 0;
}

#pragma mark - App delegate

@interface TWSAppDelegate : NSObject <NSApplicationDelegate, NSMenuDelegate>
@end

@implementation TWSAppDelegate {
  NSStatusItem *_statusItem;
  NSMenu *_menu;
  dispatch_source_t _timer;
  NSString *_mode;
  BOOL _menuOpen;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  _mode = TWSCurrentMode();

  _statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
  NSImage *icon = [NSImage imageWithSystemSymbolName:@"arrow.triangle.2.circlepath.circle"
                            accessibilityDescription:@"Tweakers mode switcher"];
  if (icon != nil) {
    icon.template = YES; // adapts to light/dark menu bars
    _statusItem.button.image = icon;
  } else {
    _statusItem.button.title = @"T";
  }

  _menu = [[NSMenu alloc] init];
  _menu.delegate = self;
  _statusItem.menu = _menu;
  [self rebuildMenu];

  // Coarse poll so the indicator tracks switches made from Terminal or the
  // in-app toggle; menuNeedsUpdate: covers the menu-open path precisely.
  _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(_timer,
                            dispatch_time(DISPATCH_TIME_NOW, TWSRefreshIntervalSeconds * NSEC_PER_SEC),
                            TWSRefreshIntervalSeconds * NSEC_PER_SEC,
                            NSEC_PER_SEC);
  __weak typeof(self) weakSelf = self;
  dispatch_source_set_event_handler(_timer, ^{ [weakSelf refreshMode]; });
  dispatch_resume(_timer);
}

- (void)refreshMode {
  NSString *mode = TWSCurrentMode();
  if ([mode isEqualToString:_mode]) return;
  _mode = mode;
  // Never mutate the menu while it is tracking; it refreshes itself on open.
  if (!_menuOpen) [self rebuildMenu];
}

#pragma mark NSMenuDelegate

- (void)menuNeedsUpdate:(NSMenu *)menu {
  _mode = TWSCurrentMode();
  [self rebuildMenu];
}

- (void)menuWillOpen:(NSMenu *)menu {
  _menuOpen = YES;
}

- (void)menuDidClose:(NSMenu *)menu {
  _menuOpen = NO;
}

#pragma mark Menu construction

- (void)rebuildMenu {
  [_menu removeAllItems];

  NSString *indicator;
  if ([_mode isEqualToString:TWSModeChatgpt]) {
    indicator = @"Mode: ChatGPT ✓";
  } else if ([_mode isEqualToString:TWSModeTweakers]) {
    indicator = @"Mode: Tweakers ✓";
  } else {
    indicator = @"Mode: unknown";
  }
  // No action => stays disabled under automatic menu-item validation.
  [_menu addItemWithTitle:indicator action:nil keyEquivalent:@""];

  // Update availability is independent of the selected app experience. Keep
  // this row read-only: the official app or the durable installer transaction
  // owns update actions, while the switcher only reports fresh cached truth.
  TWSDesktopUpdateStatus *desktopUpdate = TWSCurrentDesktopUpdateStatus();
  NSMenuItem *desktopUpdateItem =
      [_menu addItemWithTitle:TWSDesktopUpdateMenuTitle(desktopUpdate)
                       action:nil
                keyEquivalent:@""];
  desktopUpdateItem.enabled = NO;
  desktopUpdateItem.toolTip = desktopUpdate.detail;

  // A coordinated local refresh is only valid while the patched payload owns
  // the live app. refresh-local itself re-checks the mode before any mutation.
  if ([_mode isEqualToString:TWSModeTweakers]) {
    BOOL refreshAvailable = TWSRefreshCliInvocation() != nil;
    NSMenuItem *reload =
        [_menu addItemWithTitle:@"Reload Tweakers with Latest Changes…"
                         action:refreshAvailable ? @selector(reloadTweakers:) : NULL
                  keyEquivalent:@""];
    reload.target = refreshAvailable ? self : nil;
    reload.enabled = refreshAvailable;
    if (!reload.enabled) {
      reload.toolTip = @"Run tweaker dev-sync to register and build a development checkout first.";
    }
  }

  // Offer whichever mode is not active; an unknown mode offers both.
  if (![_mode isEqualToString:TWSModeTweakers]) {
    [self addSwitchItemWithTitle:@"Switch to Tweakers…" target:TWSModeTweakers];
  }
  if (![_mode isEqualToString:TWSModeChatgpt]) {
    [self addSwitchItemWithTitle:@"Switch to ChatGPT…" target:TWSModeChatgpt];
  }

  [_menu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *quit = [_menu addItemWithTitle:@"Quit Switcher"
                                      action:@selector(terminate:)
                               keyEquivalent:@""];
  quit.target = NSApp; // clean exit(0): KeepAlive={SuccessfulExit:false} stays quit
  NSString *updateSuffix = desktopUpdate.kind == TWSDesktopUpdateAvailable
      ? @" · ChatGPT update available"
      : @"";
  _statusItem.button.toolTip = [NSString stringWithFormat:
      @"Tweakers — current mode: %@%@", _mode, updateSuffix];
}

- (void)addSwitchItemWithTitle:(NSString *)title target:(NSString *)targetMode {
  NSMenuItem *item = [_menu addItemWithTitle:title action:@selector(switchMode:) keyEquivalent:@""];
  item.target = self;
  item.representedObject = targetMode;
}

#pragma mark Switching

- (void)reloadTweakers:(NSMenuItem *)sender {
  [self activateForModal];

  NSAlert *confirm = [[NSAlert alloc] init];
  confirm.messageText = @"Reload Tweakers with latest changes?";
  confirm.informativeText =
      @"Tweakers will build the registered development checkout and validate a disposable candidate while ChatGPT remains open.\n\n"
      @"After validation succeeds, ChatGPT will quit, promote the refreshed Tweakers app, "
      @"and reopen. If validation or promotion fails, the current app is kept or restored.";
  [confirm addButtonWithTitle:@"Reload Tweakers"];
  [confirm addButtonWithTitle:@"Cancel"];
  if ([confirm runModal] != NSAlertFirstButtonReturn) return;

  NSArray<NSString *> *cli = TWSRefreshCliInvocation();
  if (cli == nil) {
    [self showSpawnErrorWithTitle:@"Could not start the Tweakers reload"
                           reason:@"The registered development checkout or its CLI runtime is missing."
                           repair:@"Run “tweaker dev-sync” in Terminal to register and build the checkout."];
    return;
  }
  NSArray<NSString *> *argv =
      [cli arrayByAddingObjectsFromArray:@[
        @"refresh-local", @"--source", @"development", @"--app", TWSAppRoot()
      ]];
  if (!TWSSpawnDetached(argv)) {
    [self showSpawnErrorWithTitle:@"Could not start the Tweakers reload"
                           reason:@"The development CLI could not be started."
                           repair:@"Run “tweaker dev-sync” in Terminal to repair the development checkout."];
  }
}

- (void)switchMode:(NSMenuItem *)sender {
  NSString *target = sender.representedObject;
  if (![target isKindOfClass:[NSString class]]) return;

  NSArray<NSString *> *cli = TWSCliInvocation();
  if (cli == nil) {
    [self showSpawnErrorWithTitle:@"Could not start the mode switch"
                           reason:@"The switcher configuration is missing or unreadable."
                           repair:@"Run “tweaker mode setup” in Terminal to repair the switcher."];
    return;
  }
  NSArray<NSString *> *argv =
      [cli arrayByAddingObjectsFromArray:@[ @"mode", target ]];
  if (!TWSSpawnDetached(argv)) {
    [self showSpawnErrorWithTitle:@"Could not start the mode switch"
                           reason:@"The Tweakers CLI could not be started."
                           repair:@"Run “tweaker mode setup” in Terminal to repair the switcher."];
  }
}

- (void)showSpawnErrorWithTitle:(NSString *)title
                         reason:(NSString *)reason
                         repair:(NSString *)repair {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleWarning;
  alert.messageText = title;
  alert.informativeText = [NSString stringWithFormat:@"%@\n%@", reason, repair];
  [alert addButtonWithTitle:@"OK"];
  [alert runModal];
}

/// LSUIElement apps are never frontmost by default; without activation the
/// confirmation alert can appear behind other windows.
- (void)activateForModal {
  if (@available(macOS 14.0, *)) {
    [NSApp activate];
  } else {
    [NSApp activateIgnoringOtherApps:YES];
  }
}

@end

/// NSApplication.delegate is weak, so the delegate needs a strong owner that
/// outlives main()'s locals: under ARC an optimized build (-O2) may release a
/// local right after its last use, deallocating the delegate before
/// applicationDidFinishLaunching ever fires — a permanently headless switcher
/// that launchd still reports as healthy. A static keeps the lifetime
/// independent of optimizer behavior.
static TWSAppDelegate *sDelegate;

#if !defined(TWS_TESTING)
int main(void) {
  @autoreleasepool {
    // Detached children (the mode CLI) are never waited on; auto-reap them.
    signal(SIGCHLD, SIG_IGN);
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    sDelegate = [[TWSAppDelegate alloc] init];
    app.delegate = sDelegate;
    [app run];
  }
  return 0;
}
#endif
