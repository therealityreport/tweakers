// Tweakers menu-bar mode switcher.
//
// A tiny NSStatusItem app that shows which mode /Applications/ChatGPT.app is
// in ("chatgpt" = pristine official payload, "tweakers" = patched payload) and
// offers the switch to the other one. In ChatGPT mode the app is pristine (no
// injected UI), so this menu bar item is the only in-GUI way back to Tweakers
// mode — it must stay dumb and reliable:
//
//   - It only READS installer state (state.json) — it never touches bundles.
//   - Mode changes use `tweakers mode <target> --yes`; development reloads use
//     the registered checkout's `tweakers refresh-local --source development`.
//     Both are spawned fully detached (new session, no wait) so they survive
//     the app quitting during promotion.
//   - The CLI invocation comes from a sidecar config the installer writes at
//     `tweakers mode setup` time (switcher.json in the Tweakers user root) —
//     nothing machine-specific is baked into this binary.
//
// Lifecycle: launched by the com.therealityreport.tweakers.switcher
// LaunchAgent with KeepAlive={SuccessfulExit:false}, so launchd restarts it
// after a crash but a clean "Quit Switcher" (exit 0) stays quit.
//
// AppKit + Foundation only; targets macOS 13+.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>

static NSString *const TWSModeChatgpt = @"chatgpt";
static NSString *const TWSModeTweakers = @"tweakers";
static NSString *const TWSModeUnknown = @"unknown";

/// Refresh cadence while the menu is closed; the menu itself refreshes on open.
static const uint64_t TWSRefreshIntervalSeconds = 5;

#pragma mark - Installer state access

/// Resolves the Tweakers user root exactly like the installer's paths.ts:
/// TWEAKERS_HOME -> CODEX_PLUSPLUS_HOME -> ~/Library/Application Support with
/// the legacy codex-plusplus directory staying authoritative while it exists.
static NSString *TWSUserRoot(void) {
  NSDictionary<NSString *, NSString *> *env = NSProcessInfo.processInfo.environment;
  if (env[@"TWEAKERS_HOME"].length > 0) return env[@"TWEAKERS_HOME"];
  if (env[@"CODEX_PLUSPLUS_HOME"].length > 0) return env[@"CODEX_PLUSPLUS_HOME"];
  NSString *appSupport =
      [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"];
  NSString *legacy = [appSupport stringByAppendingPathComponent:@"codex-plusplus"];
  if ([NSFileManager.defaultManager fileExistsAtPath:legacy]) return legacy;
  return [appSupport stringByAppendingPathComponent:@"Tweakers"];
}

static NSDictionary *TWSReadJSONDictionary(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

/// Current mode from the installer's state.json. Anything other than an
/// explicit "chatgpt"/"tweakers" string reports as "unknown" — this app never
/// guesses about bundle contents.
static NSString *TWSCurrentMode(void) {
  NSDictionary *state =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"state.json"]);
  id mode = state[@"mode"];
  if ([mode isKindOfClass:[NSString class]] &&
      ([mode isEqualToString:TWSModeChatgpt] || [mode isEqualToString:TWSModeTweakers])) {
    return mode;
  }
  return TWSModeUnknown;
}

static NSString *TWSAppRoot(void) {
  NSDictionary *state =
      TWSReadJSONDictionary([TWSUserRoot() stringByAppendingPathComponent:@"state.json"]);
  id appRoot = state[@"appRoot"];
  return [appRoot isKindOfClass:[NSString class]] && [appRoot length] > 0
      ? appRoot
      : @"/Applications/ChatGPT.app";
}

/// CLI invocation (argv prefix) from the sidecar the installer writes at setup
/// time. Returns nil when missing/malformed so the UI can point at
/// `tweakers mode setup` instead of spawning garbage.
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
  id section = config[@"codexPlusPlus"];
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
      reload.toolTip = @"Run tweakers dev-sync to register and build a development checkout first.";
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
  _statusItem.button.toolTip =
      [NSString stringWithFormat:@"Tweakers — current mode: %@", _mode];
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
                           repair:@"Run “tweakers dev-sync” in Terminal to register and build the checkout."];
    return;
  }
  NSArray<NSString *> *argv =
      [cli arrayByAddingObjectsFromArray:@[
        @"refresh-local", @"--source", @"development", @"--app", TWSAppRoot()
      ]];
  if (!TWSSpawnDetached(argv)) {
    [self showSpawnErrorWithTitle:@"Could not start the Tweakers reload"
                           reason:@"The development CLI could not be started."
                           repair:@"Run “tweakers dev-sync” in Terminal to repair the development checkout."];
  }
}

- (void)switchMode:(NSMenuItem *)sender {
  NSString *target = sender.representedObject;
  if (![target isKindOfClass:[NSString class]]) return;
  [self activateForModal];

  BOOL toTweakers = [target isEqualToString:TWSModeTweakers];
  NSAlert *confirm = [[NSAlert alloc] init];
  confirm.messageText =
      toTweakers ? @"Switch to Tweakers mode?" : @"Switch to ChatGPT mode?";
  confirm.informativeText = [NSString stringWithFormat:
      @"ChatGPT will quit and restart as the %@.\n"
      @"Some macOS permissions may need re-granting after the switch.",
      toTweakers ? @"patched Tweakers app" : @"official ChatGPT app"];
  [confirm addButtonWithTitle:@"Switch"];
  [confirm addButtonWithTitle:@"Cancel"];
  if ([confirm runModal] != NSAlertFirstButtonReturn) return;

  NSArray<NSString *> *cli = TWSCliInvocation();
  if (cli == nil) {
    [self showSpawnErrorWithTitle:@"Could not start the mode switch"
                           reason:@"The switcher configuration is missing or unreadable."
                           repair:@"Run “tweakers mode setup” in Terminal to repair the switcher."];
    return;
  }
  NSArray<NSString *> *argv =
      [cli arrayByAddingObjectsFromArray:@[ @"mode", target, @"--yes" ]];
  if (!TWSSpawnDetached(argv)) {
    [self showSpawnErrorWithTitle:@"Could not start the mode switch"
                           reason:@"The Tweakers CLI could not be started."
                           repair:@"Run “tweakers mode setup” in Terminal to repair the switcher."];
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
