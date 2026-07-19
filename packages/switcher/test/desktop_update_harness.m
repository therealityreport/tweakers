#define TWS_TESTING 1
#import "../src/tweakers_switcher.m"

#include <stdio.h>

static void TWSAssert(BOOL condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "desktop update regression failed: %s\n", message);
  abort();
}

int main(void) {
  @autoreleasepool {
    TWSAssert([TWSModeFromEvidence(@"patched", @"patched", NO)
                  isEqualToString:TWSModeTweakers],
              "matching patched integrity must report Tweakers");
    TWSAssert([TWSModeFromEvidence(@"stale-patched", @"new-official", YES)
                  isEqualToString:TWSModeChatgpt],
              "valid OpenAI signature must override stale Tweakers state");
    TWSAssert([TWSModeFromEvidence(@"stale-patched", @"unknown", NO)
                  isEqualToString:TWSModeUnknown],
              "unproven bundle evidence must not reuse stale persisted mode");

    NSDate *now = TWSParseISO8601Date(@"2026-07-17T17:00:00Z");
    TWSAssert(now != nil, "test clock must parse");

    NSDictionary *installed5440 = @{
      @"CFBundleShortVersionString": @"26.707.91948",
      @"CFBundleVersion": @"5440",
    };
    NSDictionary *fresh5488 = @{
      @"marketingVersion": @"26.715.21425",
      @"build": @"5488",
      @"checkedAt": @"2026-07-17T16:54:01.863Z",
    };
    TWSDesktopUpdateStatus *available =
        TWSDesktopUpdateStatusFromMetadata(fresh5488, installed5440, now);
    TWSAssert(available.kind == TWSDesktopUpdateAvailable,
              "fresh newer build must report update available");
    TWSAssert([TWSDesktopUpdateMenuTitle(available)
                  isEqualToString:@"ChatGPT update available · 26.715.21425 (5488)"],
              "available row must include the cached latest version");
    TWSAssert([available.detail containsString:@"Installed 26.707.91948 (5440)"],
              "available detail must identify the installed version");

    NSDictionary *installed5488 = @{
      @"CFBundleShortVersionString": @"26.715.21425",
      @"CFBundleVersion": @"5488",
    };
    TWSDesktopUpdateStatus *current =
        TWSDesktopUpdateStatusFromMetadata(fresh5488, installed5488, now);
    TWSAssert(current.kind == TWSDesktopUpdateCurrent,
              "equal build must report current");
    TWSAssert([TWSDesktopUpdateMenuTitle(current)
                  isEqualToString:@"ChatGPT update: Current · 26.715.21425 (5488)"],
              "current row must include the installed version");

    NSDictionary *installedNewer = @{
      @"CFBundleShortVersionString": @"26.716.10000",
      @"CFBundleVersion": @"6000",
    };
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(fresh5488, installedNewer, now).kind ==
                  TWSDesktopUpdateCurrent,
              "a newer installed build must never be called outdated");

    NSDictionary *marketingOnlyCurrent = @{
      @"CFBundleShortVersionString": @"26.707.91948",
    };
    NSDictionary *marketingOnlyLatest = @{
      @"marketingVersion": @"26.715.21425",
      @"checkedAt": @"2026-07-17T16:54:01Z",
    };
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(
                  marketingOnlyLatest, marketingOnlyCurrent, now).kind ==
                  TWSDesktopUpdateAvailable,
              "numeric marketing versions must be a safe build fallback");

    TWSAssert(TWSDesktopUpdateStatusFromMetadata(nil, installed5440, now).kind ==
                  TWSDesktopUpdateCheckNeeded,
              "missing cache must report check needed");
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(fresh5488, nil, now).kind ==
                  TWSDesktopUpdateCheckNeeded,
              "missing installed metadata must report check needed");

    NSDictionary *stale5488 = @{
      @"marketingVersion": @"26.715.21425",
      @"build": @"5488",
      @"checkedAt": @"2026-07-15T16:54:01Z",
    };
    TWSDesktopUpdateStatus *stale =
        TWSDesktopUpdateStatusFromMetadata(stale5488, installed5440, now);
    TWSAssert(stale.kind == TWSDesktopUpdateCheckNeeded,
              "stale cache must not report current or available");
    TWSAssert([TWSDesktopUpdateMenuTitle(stale)
                  isEqualToString:@"ChatGPT update: Check needed"],
              "stale cache must use truthful check-needed copy");

    NSDictionary *invalidTime = @{
      @"marketingVersion": @"26.715.21425",
      @"build": @"5488",
      @"checkedAt": @"not-a-date",
    };
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(invalidTime, installed5440, now).kind ==
                  TWSDesktopUpdateCheckNeeded,
              "invalid cache time must report check needed");

    NSDictionary *invalidVersion = @{
      @"marketingVersion": @"latest",
      @"build": @"unknown",
      @"checkedAt": @"2026-07-17T16:54:01Z",
    };
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(
                  invalidVersion, installed5440, now).kind ==
                  TWSDesktopUpdateCheckNeeded,
              "invalid cached versions must report check needed");

    NSDictionary *hugeInstalled = @{
      @"CFBundleVersion": @"999999999999999999999999999998",
    };
    NSDictionary *hugeLatest = @{
      @"build": @"999999999999999999999999999999",
      @"checkedAt": @"2026-07-17T16:54:01Z",
    };
    TWSAssert(TWSDesktopUpdateStatusFromMetadata(hugeLatest, hugeInstalled, now).kind ==
                  TWSDesktopUpdateAvailable,
              "large build comparison must not overflow");

    puts("Tweakers Switcher desktop update regression checks passed");
  }
  return 0;
}
