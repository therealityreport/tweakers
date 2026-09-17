#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *const kDoctorKind = @"tweakers-independent-doctor";
static NSString *const kDoctorBundleIdentifier = @"com.therealityreport.tweakers.doctor";
static NSString *const kDoctorActivateNotification = @"com.therealityreport.tweakers.doctor.activate";
static NSString *const kManagerSectionDefaultsKey = @"TweakersManagerSelectedSection";
static NSString *const kManagerSidebarCollapsedDefaultsKey = @"TweakersManagerSidebarCollapsed";
static NSArray<NSString *> *ManagerSections(void) { return @[@"overview", @"updates", @"doctor"]; }
static BOOL IsManagerSection(id value) { return [value isKindOfClass:[NSString class]] && [ManagerSections() containsObject:value]; }
static int gDoctorInstanceLock = -1;
static NSArray<NSString *> *DoctorActionIds(void) {
  return @[@"reconnect", @"scan", @"repair", @"retry", @"update", @"decide", @"observe", @"preview_before", @"preview_after"];
}
static NSArray<NSString *> *PrimaryDoctorActionIds(void) {
  return @[@"reconnect", @"scan", @"repair", @"retry", @"update", @"preview_before", @"preview_after"];
}

static BOOL IsStringArray(id value) {
  if (![value isKindOfClass:[NSArray class]]) return NO;
  for (id item in value) if (![item isKindOfClass:[NSString class]]) return NO;
  return YES;
}

static BOOL IsFingerprint(id value) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  static NSRegularExpression *pattern;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    pattern = [NSRegularExpression regularExpressionWithPattern:@"^sha256:[a-f0-9]{64}$" options:0 error:nil];
  });
  NSString *fingerprint = value;
  return [pattern firstMatchInString:fingerprint options:0 range:NSMakeRange(0, fingerprint.length)] != nil;
}

static BOOL IsNullableString(id value) {
  return value == nil || value == NSNull.null || [value isKindOfClass:[NSString class]];
}
static BOOL IsNullOrString(id value) {
  return value == NSNull.null || [value isKindOfClass:[NSString class]];
}

static BOOL IsNonnegativeInteger(id value) {
  return [value isKindOfClass:[NSNumber class]] && [value longLongValue] >= 0;
}

static BOOL IsDoctorReviewProgress(id value) {
  if (value == nil || value == NSNull.null) return YES;
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *review = value;
  NSDictionary *files = review[@"files"], *questions = review[@"questions"];
  id pause = review[@"pause"];
  if (![review[@"version"] isEqual:@1] || ![review[@"policy"] isEqual:@"finish_automatically"]
      || ![@[@"preparing", @"explaining", @"ready", @"action_required", @"deferred", @"superseded"] containsObject:review[@"stage"]]
      || ![files isKindOfClass:[NSDictionary class]] || ![questions isKindOfClass:[NSDictionary class]]
      || !IsNonnegativeInteger(files[@"total"]) || !IsNonnegativeInteger(files[@"accounted"])
      || !IsNonnegativeInteger(questions[@"total"]) || !IsNonnegativeInteger(questions[@"completed"]) || !IsNonnegativeInteger(questions[@"reused"])
      || !IsNonnegativeInteger(review[@"entries"]) || !IsNonnegativeInteger(review[@"limitations"])) return NO;
  return pause == nil || pause == NSNull.null || ([pause isKindOfClass:[NSDictionary class]]
    && [@[@"source_unavailable", @"provider_unavailable", @"usage_unavailable", @"no_progress", @"compatibility_required"] containsObject:pause[@"code"]]
    && [pause[@"message"] isKindOfClass:[NSString class]]
    && [@[@"retry", @"sign_in", @"inspect_evidence", @"repair"] containsObject:pause[@"action"]]);
}

static BOOL IsDoctorCompatibility(id value) {
  if (value == nil || value == NSNull.null) return YES;
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *compatibility = value;
  NSDictionary *binding = compatibility[@"binding"];
  if (![compatibility[@"version"] isEqual:@1] || ![compatibility[@"policyVersion"] isEqual:@1]
      || ![@[@"passed", @"conflict", @"verification_unavailable"] containsObject:compatibility[@"status"]]
      || !IsFingerprint(compatibility[@"fingerprint"]) || ![binding isKindOfClass:[NSDictionary class]]
      || !IsFingerprint(binding[@"beforeFingerprint"]) || !IsFingerprint(binding[@"afterFingerprint"])
      || !IsFingerprint(binding[@"comparisonFingerprint"]) || !IsFingerprint(binding[@"tweakersFingerprint"])
      || !IsFingerprint(binding[@"configurationFingerprint"]) || !IsNullOrString(binding[@"candidateFingerprint"])
      || !IsFingerprint(binding[@"validationFingerprint"]) || ![compatibility[@"checks"] isKindOfClass:[NSArray class]]
      || ![compatibility[@"repairs"] isKindOfClass:[NSArray class]] || !IsStringArray(compatibility[@"postInstallChecks"])) return NO;
  for (id value in compatibility[@"checks"]) {
    if (![value isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *check = value;
    if (![check[@"id"] isKindOfClass:[NSString class]] || ![check[@"owner"] isKindOfClass:[NSString class]]
        || ![@[@"passed", @"conflict", @"verification_unavailable"] containsObject:check[@"outcome"]]
        || ![check[@"expected"] isKindOfClass:[NSString class]] || ![check[@"observed"] isKindOfClass:[NSString class]]
        || !IsStringArray(check[@"evidence"]) || ![check[@"nextAction"] isKindOfClass:[NSString class]]) return NO;
  }
  for (id value in compatibility[@"repairs"]) {
    if (![value isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *repair = value;
    if (![repair[@"conflictId"] isKindOfClass:[NSString class]] || !IsNonnegativeInteger(repair[@"attempt"]) || [repair[@"attempt"] integerValue] < 1
        || ![@[@"reserved", @"completed", @"rejected", @"interrupted"] containsObject:repair[@"status"]]
        || ![repair[@"evidence"] isKindOfClass:[NSString class]] || ![repair[@"summary"] isKindOfClass:[NSString class]]) return NO;
  }
  return YES;
}

static BOOL IsDoctorAdoptionReview(id value) {
  if (value == nil || value == NSNull.null) return YES;
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *adoption = value;
  NSDictionary *changeReport = adoption[@"report"];
  NSArray *changes = changeReport[@"changes"];
  NSDictionary *coverage = changeReport[@"coverage"];
  if (![adoption[@"schemaVersion"] isEqual:@1]
      || ![@[@"review_required", @"ready", @"deferred", @"preservation_required", @"superseded"] containsObject:adoption[@"state"]]
      || ![changeReport isKindOfClass:[NSDictionary class]]
      || ![changeReport[@"schemaVersion"] isEqual:@1]
      || ![changeReport[@"jobId"] isKindOfClass:[NSString class]]
      || ![changeReport[@"beforeFingerprint"] isKindOfClass:[NSString class]]
      || ![changeReport[@"afterFingerprint"] isKindOfClass:[NSString class]]
      || ![changeReport[@"comparisonFingerprint"] isKindOfClass:[NSString class]]
      || ![changeReport[@"implementationFingerprint"] isKindOfClass:[NSString class]]
      || !IsNullOrString(changeReport[@"candidateFingerprint"])
      || ![changes isKindOfClass:[NSArray class]]
      || ![coverage isKindOfClass:[NSDictionary class]]
      || ![coverage[@"total"] isKindOfClass:[NSNumber class]]
      || ![coverage[@"classified"] isKindOfClass:[NSNumber class]]
      || ![coverage[@"unresolved"] isKindOfClass:[NSNumber class]]
      || !IsStringArray(changeReport[@"limitations"])
      || ![changeReport[@"fingerprint"] isKindOfClass:[NSString class]]
      || ![adoption[@"decisions"] isKindOfClass:[NSArray class]]
      || ![adoption[@"observations"] isKindOfClass:[NSArray class]]
      || !IsStringArray(adoption[@"blockers"])
      || ![adoption[@"fingerprint"] isKindOfClass:[NSString class]]) return NO;
  for (id item in changes) {
    if (![item isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *change = item;
    id reviewWork = change[@"reviewWork"];
    if (![change[@"id"] isKindOfClass:[NSString class]]
        || ![change[@"area"] isKindOfClass:[NSString class]]
        || ![change[@"title"] isKindOfClass:[NSString class]]
        || ![change[@"before"] isKindOfClass:[NSString class]]
        || ![change[@"after"] isKindOfClass:[NSString class]]
        || ![@[@"observed", @"inferred_from_code", @"documented_upstream", @"unknown"] containsObject:change[@"status"]]
        || !IsNullableString(change[@"unknownPolicy"])
        || (change[@"unknownPolicy"] != nil && change[@"unknownPolicy"] != NSNull.null
            && ![@[@"acknowledgment", @"blocking"] containsObject:change[@"unknownPolicy"]])
        || ![change[@"technicalOnly"] isKindOfClass:[NSNumber class]]
        || ![change[@"evidence"] isKindOfClass:[NSArray class]]
        || !IsStringArray(change[@"dependencies"])
        || !IsStringArray(change[@"compatibility"])
        || ![change[@"overrides"] isKindOfClass:[NSArray class]]
        || (reviewWork != nil && reviewWork != NSNull.null
            && (![reviewWork isKindOfClass:[NSDictionary class]] || ![reviewWork[@"version"] isEqual:@1]
                || ![@[@"behavior", @"internal", @"evidence_needed", @"observation_limit"] containsObject:reviewWork[@"kind"]]
                || ![@[@"changed_behavior", @"packaging", @"identical_content", @"opaque_binary", @"source_unavailable", @"unsupported_syntax", @"unclassified_change"] containsObject:reviewWork[@"reasonCode"]]
                || ![reviewWork[@"question"] isKindOfClass:[NSString class]]))) return NO;
    NSDictionary *explanation = change[@"explanation"];
    if (explanation != nil && explanation != NSNull.null) {
      if (![explanation isKindOfClass:[NSDictionary class]]
          || ![explanation[@"summary"] isKindOfClass:[NSString class]]
          || ![explanation[@"evidenceReferences"] isKindOfClass:[NSArray class]]
          || ![explanation[@"sourceReferences"] isKindOfClass:[NSArray class]]) return NO;
      for (id reference in explanation[@"evidenceReferences"]) {
        if (![reference isKindOfClass:[NSDictionary class]]
            || ![reference[@"id"] isKindOfClass:[NSString class]] || !IsFingerprint(reference[@"sha256"])) return NO;
      }
      for (id reference in explanation[@"sourceReferences"]) {
        if (![reference isKindOfClass:[NSDictionary class]]
            || ![reference[@"path"] isKindOfClass:[NSString class]] || !IsFingerprint(reference[@"sha256"])) return NO;
      }
    }
    for (id evidenceItem in change[@"evidence"]) {
      if (![evidenceItem isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *evidence = evidenceItem;
      if (![evidence[@"artifact"] isKindOfClass:[NSString class]]
          || ![evidence[@"path"] isKindOfClass:[NSString class]]
          || !IsNullableString(evidence[@"kind"])
          || (evidence[@"kind"] != nil && evidence[@"kind"] != NSNull.null
              && ![@[@"static", @"native_interaction", @"upstream_documentation"] containsObject:evidence[@"kind"]])
          || !IsNullOrString(evidence[@"beforeSha256"])
          || !IsNullOrString(evidence[@"afterSha256"])
          || ![evidence[@"detail"] isKindOfClass:[NSString class]]) return NO;
    }
    for (id overrideItem in change[@"overrides"]) {
      if (![overrideItem isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *override = overrideItem;
      if (![override[@"id"] isKindOfClass:[NSString class]]
          || ![override[@"label"] isKindOfClass:[NSString class]]
          || ![override[@"verificationFingerprint"] isKindOfClass:[NSString class]]) return NO;
    }
  }
  NSDictionary *changelog = changeReport[@"changelog"];
  if (changelog != nil && changelog != NSNull.null) {
    if (![changelog isKindOfClass:[NSDictionary class]] || ![changelog[@"schemaVersion"] isEqual:@1]
        || ![changelog[@"entries"] isKindOfClass:[NSArray class]] || ![changelog[@"unresolved"] isKindOfClass:[NSArray class]]) return NO;
    for (id item in changelog[@"entries"]) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *entry = item;
      if (![entry[@"id"] isKindOfClass:[NSString class]] || ![@[@"Added", @"Changed", @"Fixed", @"Removed", @"Deprecated", @"Security"] containsObject:entry[@"category"]]
          || ![entry[@"title"] isKindOfClass:[NSString class]] || ![entry[@"workflow"] isKindOfClass:[NSString class]]
          || ![entry[@"before"] isKindOfClass:[NSString class]] || ![entry[@"after"] isKindOfClass:[NSString class]]
          || ![@[@"inferred_from_code", @"observed", @"documented_upstream"] containsObject:entry[@"status"]]
          || ![@[@"upstream", @"tweakers"] containsObject:entry[@"origin"]]
          || !IsStringArray(entry[@"analysisGroupIds"]) || !IsStringArray(entry[@"dependencies"])
          || (entry[@"decisionDependencies"] && !IsStringArray(entry[@"decisionDependencies"]))
          || !IsStringArray(entry[@"limitations"]) || ![entry[@"evidenceReferences"] isKindOfClass:[NSArray class]]) return NO;
      for (id reference in entry[@"evidenceReferences"]) if (![reference isKindOfClass:[NSDictionary class]]
          || ![reference[@"id"] isKindOfClass:[NSString class]] || !IsFingerprint(reference[@"sha256"])) return NO;
    }
    for (id item in changelog[@"unresolved"]) if (![item isKindOfClass:[NSDictionary class]]
        || ![item[@"groupId"] isKindOfClass:[NSString class]] || ![item[@"reason"] isKindOfClass:[NSString class]]) return NO;
  }
  for (id item in adoption[@"decisions"]) {
    if (![item isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *decision = item;
    if (![decision[@"changeId"] isKindOfClass:[NSString class]]
        || ![@[@"accept", @"acknowledge_unknown", @"preserve", @"override"] containsObject:decision[@"choice"]]
        || !IsNullableString(decision[@"overrideId"])) return NO;
  }
  for (id item in adoption[@"observations"]) {
    if (![item isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *observation = item;
    if (![observation[@"changeId"] isKindOfClass:[NSString class]]
        || ![observation[@"before"] isKindOfClass:[NSString class]]
        || ![observation[@"after"] isKindOfClass:[NSString class]]
        || ![observation[@"conditions"] isKindOfClass:[NSString class]]
        || ![@[@"matches", @"differs", @"unavailable"] containsObject:observation[@"outcome"]]
        || ![observation[@"recordedAt"] isKindOfClass:[NSString class]]
        || ![observation[@"source"] isEqual:@"user_manual"]) return NO;
  }
  return YES;
}

static BOOL IsDoctorReport(NSDictionary *report) {
  if (![report isKindOfClass:[NSDictionary class]]
      || ![report[@"schemaVersion"] isEqual:@1]
      || ![report[@"kind"] isEqual:kDoctorKind]
      || ![report[@"target"] isKindOfClass:[NSDictionary class]]
      || ![report[@"health"] isKindOfClass:[NSDictionary class]]
      || ![report[@"update"] isKindOfClass:[NSDictionary class]]
      || ![report[@"findings"] isKindOfClass:[NSArray class]]
      || ![report[@"actions"] isKindOfClass:[NSArray class]]
      || !IsFingerprint(report[@"fingerprint"])
      || !IsDoctorAdoptionReview(report[@"adoption"])) return NO;
  if (report[@"workflowVersion"] != nil && report[@"workflowVersion"] != NSNull.null && ![report[@"workflowVersion"] isEqual:@2]) return NO;
  NSDictionary *execution = report[@"update"][@"execution"];
  if (execution != nil && execution != NSNull.null
      && (![execution isKindOfClass:[NSDictionary class]]
          || ![execution[@"version"] isEqual:@2]
          || ![@[@"manual", @"available_update"] containsObject:execution[@"trigger"]]
          || ![@[@"running", @"ready", @"action_required", @"failed", @"superseded"] containsObject:execution[@"status"]]
          || ![execution[@"recoverable"] isKindOfClass:[NSNumber class]])) return NO;
  if (!IsDoctorReviewProgress(report[@"update"][@"review"]) || !IsDoctorCompatibility(report[@"update"][@"compatibility"])) return NO;
  NSDictionary *usageDetails = report[@"update"][@"usageDetails"];
  if (usageDetails != nil && usageDetails != NSNull.null) {
    if (![usageDetails isKindOfClass:[NSDictionary class]] || ![usageDetails[@"version"] isEqual:@1]
        || ![usageDetails[@"allowances"] isKindOfClass:[NSNumber class]] || [usageDetails[@"allowances"] integerValue] < 1
        || ![usageDetails[@"requests"] isKindOfClass:[NSArray class]]) return NO;
    for (id item in usageDetails[@"requests"]) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *request = item;
      if (![request[@"id"] isKindOfClass:[NSString class]]
          || !IsNullableString(request[@"model"]) || !IsNullableString(request[@"effort"])
          || !IsNullableString(request[@"configuredModel"]) || !IsNullableString(request[@"configuredEffort"])
          || !IsNullableString(request[@"stage"])) return NO;
      for (NSString *key in @[@"inputTokens", @"cachedInputTokens", @"outputTokens"]) {
        id value = request[key];
        if (value != nil && value != NSNull.null && (![value isKindOfClass:[NSNumber class]] || [value doubleValue] < 0)) return NO;
      }
    }
  }
  NSArray *actions = report[@"actions"];
  if (actions.count < 4 || actions.count > 9) return NO;
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (id item in actions) {
    if (![item isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *action = item;
    NSString *identifier = action[@"id"];
    if (![DoctorActionIds() containsObject:identifier]
        || [seen containsObject:identifier]
        || ![action[@"label"] isKindOfClass:[NSString class]]
        || ![action[@"enabled"] isKindOfClass:[NSNumber class]]
        || !IsStringArray(action[@"blockers"])) return NO;
    [seen addObject:identifier];
  }
  for (NSString *required in @[@"scan", @"repair", @"retry", @"update"]) {
    if (![seen containsObject:required]) return NO;
  }
  return YES;
}

static NSString *StringValue(id value, NSString *fallback) {
  return [value isKindOfClass:[NSString class]] && [value length] > 0 ? value : fallback;
}

static NSString *HealthStateLabel(NSString *state) {
  if ([state isEqual:@"healthy"]) return @"Healthy";
  if ([state isEqual:@"attention"]) return @"Needs attention";
  if ([state isEqual:@"blocked"]) return @"Blocked";
  return @"Unknown";
}

static NSString *UpdateStateLabel(NSDictionary *update) {
  NSDictionary *compatibility = [update[@"compatibility"] isKindOfClass:[NSDictionary class]] ? update[@"compatibility"] : nil;
  if ([update[@"phase"] isEqual:@"promotion_failed"] || [update[@"phase"] isEqual:@"stale"]) return @"Needs attention";
  if ([update[@"phase"] isEqual:@"updating"]) return @"Installing update";
  if ([update[@"phase"] isEqual:@"installed"]) return @"Update installed";
  if ([update[@"state"] isEqual:@"compatible"] && [update[@"phase"] isEqual:@"candidate_verified"] && [compatibility[@"status"] isEqual:@"passed"]) return @"Ready to install";
  NSString *state = StringValue(update[@"state"], @"not_checked");
  NSString *phase = StringValue(update[@"phase"], @"");
  NSDictionary *phases = @{@"preparing": @"Preparing candidate", @"resuming": @"Checking compatibility", @"comparing": @"Checking compatibility", @"applying_patches": @"Applying compatibility patches", @"checking": @"Checking compatibility", @"repairing": @"Repairing compatibility", @"candidate_verified": @"Ready to install", @"needs_attention": @"Needs attention"};
  if (phases[phase]) return phases[phase];
  if ([state isEqual:@"review_required"] && [phase isEqual:@"review_complete"]) {
    return @"Review finished—compatibility unresolved";
  }
  if ([state isEqual:@"not_checked"]) return @"Not checked";
  if ([state isEqual:@"checking"]) return @"Checking";
  if ([state isEqual:@"compatible"]) return @"Compatible";
  if ([state isEqual:@"fixes_required"]) return @"Fixes required";
  if ([state isEqual:@"review_required"]) return @"Review required";
  return @"Unknown";
}

static BOOL IsCompatibilityWorkflowInProgress(NSDictionary *update) {
  return [update[@"state"] isEqual:@"checking"] && [@[@"preparing", @"settling", @"discovering", @"registering", @"resuming", @"comparing", @"applying_patches", @"checking", @"repairing"] containsObject:update[@"phase"]];
}

static BOOL IsCompatibilityFinding(NSDictionary *finding) {
  NSString *stage = StringValue(finding[@"stage"], @"");
  return [stage isEqual:@"compatibility"] || [stage isEqual:@"candidate"];
}

static NSString *CompatibilityEmptyMessage(NSDictionary *update) {
  NSString *state = StringValue(update[@"state"], @"not_checked");
  if ([state isEqual:@"compatible"]) return @"No compatibility or candidate findings. The completed review cleared this update.";
  if ([state isEqual:@"not_checked"]) return @"Compatibility has not been checked. Current installation health does not clear an update.";
  if ([state isEqual:@"checking"]) return @"Compatibility review is still running. Current installation health does not clear the candidate.";
  return @"Compatibility remains unresolved. Current installation health does not clear this update.";
}

static NSArray<NSString *> *CompatibilityLines(NSDictionary *compatibility, NSDictionary *update) {
  if (![compatibility isKindOfClass:[NSDictionary class]]) return IsCompatibilityWorkflowInProgress(update) ? @[@"Checking compatibility evidence for this candidate. Installation remains unavailable until verification publishes a result."] : @[];
  NSString *status = StringValue(compatibility[@"status"], @"verification_unavailable");
  BOOL verifyingCandidate = [update[@"state"] isEqual:@"checking"] && (compatibility[@"binding"][@"candidateFingerprint"] == nil || compatibility[@"binding"][@"candidateFingerprint"] == NSNull.null);
  NSUInteger passed = 0;
  for (NSDictionary *check in compatibility[@"checks"]) if ([check[@"outcome"] isEqual:@"passed"]) passed++;
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithObject:verifyingCandidate ? @"Candidate verification is still running." : [status isEqual:@"passed"] ? ([update[@"phase"] isEqual:@"candidate_verified"] && [update[@"state"] isEqual:@"compatible"] ? @"All required compatibility checks passed. Ready to install." : @"Candidate compatibility checks passed. Installation status is shown above.") : [status isEqual:@"conflict"] ? @"A compatibility conflict needs repair before installation." : @"Required compatibility verification is unavailable."];
  [lines addObject:[NSString stringWithFormat:@"Required checks: %lu/%lu passed.", (unsigned long)passed, (unsigned long)[compatibility[@"checks"] count]]];
  for (NSDictionary *check in compatibility[@"checks"]) {
    if (![check isKindOfClass:[NSDictionary class]] || [check[@"outcome"] isEqual:@"passed"]) continue;
    NSArray *evidence = [check[@"evidence"] isKindOfClass:[NSArray class]] ? check[@"evidence"] : @[];
    NSArray *preview = [evidence subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)3, evidence.count))];
    NSString *evidenceLine = evidence.count ? [preview componentsJoinedByString:@"; "] : @"None supplied";
    if (evidence.count > preview.count) evidenceLine = [evidenceLine stringByAppendingFormat:@"; and %lu more. Full evidence is retained in Copy Report.", (unsigned long)(evidence.count - preview.count)];
    [lines addObject:[NSString stringWithFormat:@"%@ · %@\nExpected: %@\nObserved: %@\nNext: %@\nEvidence: %@", StringValue(check[@"id"], @"Compatibility check"), StringValue(check[@"owner"], @"owner unavailable"), StringValue(check[@"expected"], @"not reported"), StringValue(check[@"observed"], @"not reported"), StringValue(check[@"nextAction"], @"Inspect the report"), evidenceLine]];
  }
  for (NSDictionary *repair in compatibility[@"repairs"]) {
    if (![repair isKindOfClass:[NSDictionary class]] || [repair[@"status"] isEqual:@"completed"]) continue;
    [lines addObject:[NSString stringWithFormat:@"Repair %@: %@ · %@\nEvidence: %@", repair[@"attempt"] ?: @"?", StringValue(repair[@"conflictId"], @"conflict"), StringValue(repair[@"summary"], @"No summary"), StringValue(repair[@"evidence"], @"None supplied")]];
  }
  if ([compatibility[@"postInstallChecks"] count] && [status isEqual:@"passed"]) [lines addObject:[NSString stringWithFormat:@"After installation:\n%@", [compatibility[@"postInstallChecks"] componentsJoinedByString:@"\n"]]];
  return lines;
}

static NSString *EvidenceDescription(NSDictionary *evidence) {
  NSString *kind = StringValue(evidence[@"kind"], @"static");
  if ([kind isEqual:@"native_interaction"]) return @"Observed through native interaction.";
  if ([kind isEqual:@"upstream_documentation"]) return @"Documented by the upstream provider; not observed in the native app.";
  return @"Static source evidence; this is not an observation of the native app.";
}

static NSArray<NSString *> *UsageDetailsLines(NSDictionary *details) {
  if (![details isKindOfClass:[NSDictionary class]]) return @[];
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithObject:[NSString stringWithFormat:@"Recorded review usage across retained runs: %@ allowance(s). These records do not mean requests are running now. Cached input is included in input tokens, not added to them.", details[@"allowances"] ?: @"unknown"]];
  for (NSDictionary *request in details[@"requests"]) {
    if (![request isKindOfClass:[NSDictionary class]]) continue;
    [lines addObject:[NSString stringWithFormat:@"%@ · actual model: %@ · actual effort: %@\nRequested: %@ · completed: %@\nConfigured model: %@ · configured effort: %@\nInput: %@ · cached input: %@ · output: %@ · stage: %@",
      StringValue(request[@"id"], @"request"), StringValue(request[@"model"], @"unknown"), StringValue(request[@"effort"], @"unknown"),
      StringValue(request[@"reservedAt"], @"time unavailable"), StringValue(request[@"settledAt"], @"no completion recorded"),
      StringValue(request[@"configuredModel"], @"unknown"), StringValue(request[@"configuredEffort"], @"unknown"),
      request[@"inputTokens"] ?: @"unknown", request[@"cachedInputTokens"] ?: @"unknown", request[@"outputTokens"] ?: @"unknown", StringValue(request[@"stage"], @"unknown")]];
  }
  return lines;
}

static NSString *FindingSummary(NSDictionary *finding) {
  NSString *summary = [NSString stringWithFormat:@"%@ · %@\n%@",
    [StringValue(finding[@"severity"], @"info") uppercaseString],
    StringValue(finding[@"title"], @"Finding"),
    StringValue(finding[@"detail"], @"")];
  NSArray *evidence = [finding[@"evidence"] isKindOfClass:[NSArray class]] ? finding[@"evidence"] : @[];
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithObject:summary];
  for (id item in evidence) {
    if ([item isKindOfClass:[NSString class]]) [lines addObject:[NSString stringWithFormat:@"Evidence: %@", item]];
  }
  return [lines componentsJoinedByString:@"\n"];
}

static NSString *PauseActionLabel(id value) {
  NSString *action = StringValue(value, nil);
  if ([action isEqual:@"retry"]) return @"Retry the review";
  if ([action isEqual:@"sign_in"]) return @"Sign in to continue";
  if ([action isEqual:@"inspect_evidence"]) return @"Open the review details";
  if ([action isEqual:@"reconnect"]) return @"Reconnect account";
  if ([action isEqual:@"repair"]) return @"Repair Tweakers";
  return @"Open the review details";
}

static NSString *UnpublishedChangelogMessage(NSDictionary *update) {
  NSDictionary *execution = [update[@"execution"] isKindOfClass:[NSDictionary class]] ? update[@"execution"] : nil;
  NSDictionary *review = [update[@"review"] isKindOfClass:[NSDictionary class]] ? update[@"review"] : nil;
  NSDictionary *pause = [review[@"pause"] isKindOfClass:[NSDictionary class]] ? review[@"pause"] : nil;
  NSString *executionStatus = StringValue(execution[@"status"], @"unknown");
  if ([executionStatus isEqual:@"running"]) {
    return @"The current review has not published behavioral changes yet. It is still running.";
  }
  if ([executionStatus isEqual:@"superseded"]) {
    return @"No behavioral changelog is published for this superseded review. It cannot clear the current candidate.";
  }
  if (pause) {
    return [NSString stringWithFormat:@"The current review has not published behavioral changes. %@ Next: %@.",
      StringValue(pause[@"message"], @"A review action is required."),
      PauseActionLabel(pause[@"action"])];
  }
  if ([executionStatus isEqual:@"failed"]) {
    return @"The current review did not publish behavioral changes because it failed. Use the action help for the reported prerequisite.";
  }
  return @"No behavioral changelog has been published for the current update. It cannot clear the update for installation.";
}

static NSString *VersionAndBuild(NSDictionary *target, NSString *versionKey, NSString *buildKey) {
  NSString *version = StringValue(target[versionKey], nil);
  NSString *build = StringValue(target[buildKey], nil);
  if (version && build) return [NSString stringWithFormat:@"%@ (%@)", version, build];
  if (version) return version;
  if (build) return [NSString stringWithFormat:@"Build %@", build];
  return @"Not available";
}

static NSDictionary *ReportAction(NSDictionary *report, NSString *identifier) {
  for (id raw in report[@"actions"]) {
    if ([raw isKindOfClass:[NSDictionary class]] && [raw[@"id"] isEqual:identifier]) return raw;
  }
  return nil;
}

static NSString *ShortInstallBlockerSummary(NSArray<NSString *> *blockers) {
  if (blockers.count == 0) return @"Installation is unavailable until its required checks pass.";
  NSString *first = blockers.firstObject;
  if ([first isEqual:@"This candidate is already installed."]) return @"The verified update is installed.";
  NSString *count = [NSString stringWithFormat:@"%lu installation blocker%@ %@.", (unsigned long)blockers.count, blockers.count == 1 ? @"" : @"s", blockers.count == 1 ? @"remains" : @"remain"];
  if ([first containsString:@"ChatGPT for Chrome"] && [first containsString:@"tectonic"]) {
    return [NSString stringWithFormat:@"%@ Chrome and LaTeX helpers changed. Their compatibility checks are incomplete.", count];
  }
  for (NSString *blocker in blockers) if ([blocker containsString:@"Insufficient disk space"]) {
    return [NSString stringWithFormat:@"%@ Candidate preparation needs more disk space for rollback and reserve.", count];
  }
  if ([first hasPrefix:@"Unresolved change:"]) return [NSString stringWithFormat:@"%@ Compatibility evidence is still unresolved.", count];
  return [NSString stringWithFormat:@"%@ %@", count, [blockers componentsJoinedByString:@"\n"]];
}

static void FocusExistingDoctor(NSString *section) {
  [NSDistributedNotificationCenter.defaultCenter postNotificationName:kDoctorActivateNotification object:section userInfo:nil deliverImmediately:YES];
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:kDoctorBundleIdentifier]) {
    [application activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  }
}

static BOOL IsHexGeneration(NSString *value) {
  if (value.length != 64) return NO;
  return [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}

static BOOL IsManagerRuntimeDoctorExecutablePath(NSString *path, BOOL allowLegacyRawHelper) {
  NSString *prefix = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Tweakers/managers/com.thomashulihan.tweakers/runtime-generations"];
  NSString *standardized = path.stringByStandardizingPath;
  if (![standardized hasPrefix:[prefix stringByAppendingString:@"/"]]) return NO;
  NSString *relative = [standardized substringFromIndex:prefix.length + 1];
  NSArray<NSString *> *components = relative.pathComponents;
  if (components.count < 3 || !IsHexGeneration(components[0]) || ![components[1] isEqual:@"native"]) return NO;
  NSArray<NSString *> *expected = @[@"Tweakers Doctor.app", @"Contents", @"MacOS", @"Tweakers Doctor"];
  if (components.count == 2 + expected.count
      && [[components subarrayWithRange:NSMakeRange(2, expected.count)] isEqual:expected]) return YES;
  return allowLegacyRawHelper && components.count == 3 && [components[2] isEqual:@"Tweakers Doctor"];
}

static BOOL IsBundledDoctorExecutablePath(NSString *path) {
  NSString *suffix = @"/Contents/Resources/tweakers/native/Tweakers Doctor.app/Contents/MacOS/Tweakers Doctor";
  NSString *standardized = path.stringByStandardizingPath;
  if (![standardized hasSuffix:suffix]) return NO;
  NSString *outerApp = [standardized substringToIndex:standardized.length - suffix.length];
  return [outerApp.pathExtension isEqual:@"app"] && outerApp.lastPathComponent.length > 4;
}

static BOOL IsOwnedDoctorExecutablePath(NSString *path) {
  return IsBundledDoctorExecutablePath(path) || IsManagerRuntimeDoctorExecutablePath(path, YES);
}

static BOOL IsLegacyManagerDoctorExecutablePath(NSString *path) {
  return IsManagerRuntimeDoctorExecutablePath(path, YES)
    && !IsManagerRuntimeDoctorExecutablePath(path, NO);
}

static NSString *LauncherGeneration(NSString *launcherPath) {
  struct stat status {};
  if (stat(launcherPath.fileSystemRepresentation, &status) != 0) return nil;
  return [NSString stringWithFormat:@"%@\n%llu:%llu:%lld:%lld", launcherPath,
    (unsigned long long)status.st_dev, (unsigned long long)status.st_ino,
    (long long)status.st_size, (long long)status.st_mtimespec.tv_sec];
}

static BOOL DoctorProcessMatches(pid_t processIdentifier) {
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {};
  const int length = proc_pidpath(processIdentifier, executable, sizeof(executable));
  if (length <= 0) return NO;
  NSString *path = [NSString stringWithUTF8String:executable];
  if (!IsOwnedDoctorExecutablePath(path)) return NO;
  const BOOL legacyRawHelper = IsLegacyManagerDoctorExecutablePath(path);
  for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
    if (application.processIdentifier != processIdentifier) continue;
    return [application.bundleIdentifier isEqual:kDoctorBundleIdentifier]
      || (legacyRawHelper && application.bundleIdentifier == nil);
  }
  return NO;
}

static BOOL AcquireDoctorInstanceLock(NSString *launcherPath, NSString *section) {
  NSString *path = [NSString stringWithFormat:@"/tmp/com.therealityreport.tweakers.doctor.%u.lock", getuid()];
  const int descriptor = open(path.fileSystemRepresentation, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return NO;
  struct stat status {};
  if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) || status.st_uid != getuid()
      || status.st_nlink != 1 || (status.st_mode & 0077) != 0) {
    close(descriptor);
    return NO;
  }
  NSString *generation = LauncherGeneration(launcherPath);
  if (!generation) { close(descriptor); return NO; }
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    char metadata[4096] = {};
    const ssize_t count = pread(descriptor, metadata, sizeof(metadata) - 1, 0);
    NSString *existing = count > 0 ? [[NSString alloc] initWithBytes:metadata length:(NSUInteger)count encoding:NSUTF8StringEncoding] : nil;
    NSArray<NSString *> *lines = [existing componentsSeparatedByString:@"\n"];
    const pid_t existingPid = lines.count > 0 ? (pid_t)lines[0].intValue : 0;
    NSString *existingGeneration = lines.count > 1 ? [[lines subarrayWithRange:NSMakeRange(1, lines.count - 1)] componentsJoinedByString:@"\n"] : nil;
    if ([existingGeneration isEqual:generation]) {
      close(descriptor);
      FocusExistingDoctor(section);
      return NO;
    }
    if (existingPid > 1 && DoctorProcessMatches(existingPid)) kill(existingPid, SIGTERM);
    BOOL acquired = NO;
    for (int attempt = 0; attempt < 40; attempt += 1) {
      if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) { acquired = YES; break; }
      usleep(50 * 1000);
    }
    if (!acquired) { close(descriptor); return NO; }
  }
  NSString *metadata = [NSString stringWithFormat:@"%d\n%@", getpid(), generation];
  NSData *metadataData = [metadata dataUsingEncoding:NSUTF8StringEncoding];
  if (ftruncate(descriptor, 0) != 0 || pwrite(descriptor, metadataData.bytes, metadataData.length, 0) != (ssize_t)metadataData.length) {
    close(descriptor);
    return NO;
  }
  gDoctorInstanceLock = descriptor;
  return YES;
}

static void CloseOlderDoctorProcesses(void) {
  NSMutableArray<NSRunningApplication *> *older = [NSMutableArray array];
  for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
    if (application.processIdentifier == getpid()) continue;
    NSString *path = application.executableURL.path;
    if (!IsOwnedDoctorExecutablePath(path)) continue;
    NSString *bundleIdentifier = application.bundleIdentifier;
    const BOOL legacyRawHelper = IsLegacyManagerDoctorExecutablePath(path);
    if (![bundleIdentifier isEqual:kDoctorBundleIdentifier] && !(legacyRawHelper && bundleIdentifier == nil)) continue;
    [older addObject:application];
    [application terminate];
  }
  for (int attempt = 0; attempt < 20 && older.count > 0; attempt += 1) {
    [older filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSRunningApplication *application, NSDictionary *bindings) {
      (void)bindings;
      return !application.terminated;
    }]];
    if (older.count > 0) usleep(50 * 1000);
  }
  for (NSRunningApplication *application in older) [application forceTerminate];
}

@interface DoctorScrollDocument : NSView
@end
static NSArray<NSString *> *UpdaterEvidenceLines(NSDictionary *report) {
  NSDictionary *evidence = [report[@"updaterEvidence"] isKindOfClass:[NSDictionary class]] ? report[@"updaterEvidence"] : nil;
  if (![evidence[@"schemaVersion"] isEqual:@1]) return @[];
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithObjects:@"", @"APP SERVER COMPATIBILITY", nil];
  NSArray *interfaces = [evidence[@"interfaces"] isKindOfClass:[NSArray class]] ? evidence[@"interfaces"] : @[];
  for (id raw in interfaces) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *item = raw;
    [lines addObject:[NSString stringWithFormat:@"%@ · %@: %@", StringValue(item[@"owner"], @"Unknown owner"), StringValue(item[@"method"], @"Unknown method"), StringValue(item[@"status"], @"unresolved")]];
    if (IsStringArray(item[@"reasons"])) [lines addObjectsFromArray:item[@"reasons"]];
  }
  NSArray *checks = [evidence[@"checks"] isKindOfClass:[NSArray class]] ? evidence[@"checks"] : @[];
  for (id raw in checks) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    [lines addObject:[NSString stringWithFormat:@"%@: %@ — %@\nScope: %@", StringValue(raw[@"id"], @"Check"), StringValue(raw[@"state"], @"unsupported"), StringValue(raw[@"summary"], @""), StringValue(raw[@"scope"], @"")]];
  }
  NSDictionary *upstream = [evidence[@"upstream"] isKindOfClass:[NSDictionary class]] ? evidence[@"upstream"] : nil;
  [lines addObjectsFromArray:@[@"", @"OFFICIAL SOURCE CONTEXT (SUPPLEMENTARY)", StringValue(upstream[@"summary"], @"Unavailable")]];
  if ([upstream[@"url"] isKindOfClass:[NSString class]]) [lines addObject:upstream[@"url"]];
  return lines;
}

@implementation DoctorScrollDocument
- (BOOL)isFlipped { return YES; }
@end

@interface ManagerSidebarView : NSStackView
- (void)updateSidebarBackground;
@end
@implementation ManagerSidebarView
- (void)updateSidebarBackground {
  if (!self.layer) return;
  [self.effectiveAppearance performAsCurrentDrawingAppearance:^{
    self.layer.backgroundColor = NSColor.controlBackgroundColor.CGColor;
  }];
}
- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self updateSidebarBackground];
}
- (void)viewDidChangeEffectiveAppearance {
  [super viewDidChangeEffectiveAppearance];
  [self updateSidebarBackground];
}
@end

static NSString *EvidenceStatusLabel(NSString *status) {
  if ([status isEqual:@"observed"]) return @"Observed in app";
  if ([status isEqual:@"documented_upstream"]) return @"Documented upstream";
  return @"Inferred from code";
}

static NSArray<NSDictionary *> *TechnicalGroups(NSDictionary *adoption) {
  id groups = adoption[@"report"][@"changes"];
  return [groups isKindOfClass:[NSArray class]] ? groups : @[];
}
static NSArray<NSDictionary *> *ChangelogEntries(NSDictionary *adoption) {
  id entries = adoption[@"report"][@"changelog"][@"entries"];
  return [entries isKindOfClass:[NSArray class]] ? entries : @[];
}
static NSArray<NSString *> *DecisionGroupsForEntry(NSDictionary *adoption, NSString *identifier) {
  NSArray<NSDictionary *> *groups = TechnicalGroups(adoption);
  NSDictionary *entry = nil;
  for (NSDictionary *candidate in ChangelogEntries(adoption)) if ([candidate[@"id"] isEqual:identifier]) { entry = candidate; break; }
  NSMutableSet<NSString *> *ids = [NSMutableSet set];
  if (entry) { [ids addObjectsFromArray:entry[@"analysisGroupIds"] ?: @[]]; [ids addObjectsFromArray:entry[@"decisionDependencies"] ?: @[]]; }
  else for (NSDictionary *group in groups) if ([group[@"id"] isEqual:identifier]) { [ids addObject:identifier]; break; }
  if (ids.count == 0) return @[];
  BOOL changed = YES;
  while (changed) {
    NSUInteger size = ids.count;
    for (NSDictionary *sibling in ChangelogEntries(adoption)) {
      NSMutableArray *linked = [NSMutableArray arrayWithArray:sibling[@"analysisGroupIds"] ?: @[]];
      [linked addObjectsFromArray:sibling[@"decisionDependencies"] ?: @[]];
      for (NSString *groupId in linked) if ([ids containsObject:groupId]) { [ids addObjectsFromArray:linked]; break; }
    }
    changed = size != ids.count;
  }
  return [[ids allObjects] sortedArrayUsingSelector:@selector(compare:)];
}

@class TweakersDoctorDelegate;
@interface ManagerSectionController : NSObject
- (NSArray<NSView *> *)cardsForHost:(TweakersDoctorDelegate *)host presentation:(NSDictionary *)presentation;
@end
@interface OverviewSectionController : ManagerSectionController @end
@interface UpdatesSectionController : ManagerSectionController @end
@interface DoctorSectionController : ManagerSectionController @end

@interface TweakersDoctorDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate>
@property(nonatomic, copy) NSString *launcherPath;
@property(nonatomic, copy) NSString *launcherGeneration;
@property(nonatomic, copy) NSString *selectedSection;
@property(nonatomic, strong) NSDictionary<NSString *, ManagerSectionController *> *sectionControllers;
@property(nonatomic, strong) NSStackView *sidebar;
@property(nonatomic, strong) NSView *sidebarContainer;
@property(nonatomic, strong) NSLayoutConstraint *sidebarWidth;
@property(nonatomic, strong) NSArray<NSButton *> *sectionButtons;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSValue *> *sectionScrollOrigins;
@property(nonatomic, strong) NSTextField *sectionHeading;
@property(nonatomic, strong) NSTextField *sectionSubtitle;
@property(nonatomic, strong) NSTextField *freshnessLabel;
@property(nonatomic, strong) NSButton *sidebarToggle;
@property(nonatomic, strong) NSStackView *updateActionRow;
@property(nonatomic, strong) NSStackView *doctorActionRow;
@property(nonatomic, strong) NSStackView *footerActions;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSTextField *> *actionBlockerLabels;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextView *reportView;
@property(nonatomic, strong) NSScrollView *technicalReportScroll;
@property(nonatomic, strong) NSButton *technicalDisclosure;
@property(nonatomic, strong) NSButton *evidenceDisclosure;
@property(nonatomic, strong) NSStackView *reportStack;
@property(nonatomic, strong) NSStackView *summaryRow;
@property(nonatomic, strong) NSArray<NSLayoutConstraint *> *summaryWidths;
@property(nonatomic) BOOL summaryWide;
@property(nonatomic, strong) NSBox *adoptionBox;
@property(nonatomic, strong) NSStackView *reviewLayout;
@property(nonatomic, strong) NSScrollView *reviewTableScroll;
@property(nonatomic, strong) NSScrollView *reviewDetailScroll;
@property(nonatomic, strong) NSLayoutConstraint *reviewHorizontalTableWidth;
@property(nonatomic, strong) NSLayoutConstraint *reviewHorizontalDetailHeight;
@property(nonatomic, strong) NSLayoutConstraint *reviewVerticalTableWidth;
@property(nonatomic, strong) NSLayoutConstraint *reviewVerticalDetailWidth;
@property(nonatomic, strong) NSLayoutConstraint *reviewVerticalDetailHeight;
@property(nonatomic, strong) NSLayoutConstraint *reviewTableHeight;
@property(nonatomic) BOOL reviewIsVertical;
@property(nonatomic, strong) NSTableView *changeTable;
@property(nonatomic, strong) NSTextView *changeDetailView;
@property(nonatomic, strong) NSStackView *adoptionActionStack;
@property(nonatomic, strong) NSButton *acceptButton;
@property(nonatomic, strong) NSButton *preserveButton;
@property(nonatomic, strong) NSButton *acknowledgeUnknownButton;
@property(nonatomic, strong) NSPopUpButton *overridePopup;
@property(nonatomic, strong) NSButton *overrideButton;
@property(nonatomic, strong) NSButton *observeButton;
@property(nonatomic, strong) NSButton *deferResumeButton;
@property(nonatomic, copy) NSArray<NSDictionary *> *adoptionChanges;
@property(nonatomic, strong) NSTextField *activityLabel;
@property(nonatomic, strong) NSStackView *actionStack;
@property(nonatomic, strong) NSArray<NSView *> *actionButtons;
@property(nonatomic, strong) NSScrollView *bodyScroll;
@property(nonatomic, strong) NSStackView *bodyLayout;
@property(nonatomic, strong) NSButton *reportCopyButton;
@property(nonatomic, strong) NSDictionary *report;
@property(nonatomic, copy) NSString *renderedReportText;
@property(nonatomic, copy) NSString *renderedPresentationKey;
@property(nonatomic) BOOL busy;
@property(nonatomic) BOOL reportStale;
@property(nonatomic, copy) NSString *actionFailureNotice;
@property(nonatomic) BOOL preserveStatusPresentation;
@property(nonatomic, strong) NSTimer *statusRefreshTimer;
- (NSView *)sectionWithTitle:(NSString *)title lines:(NSArray<NSString *> *)lines;
- (NSView *)statusCardWithTitle:(NSString *)title status:(NSString *)status symbol:(NSString *)symbol lines:(NSArray<NSString *> *)lines;
- (void)addNavigation:(NSString *)title destination:(NSString *)destination toCard:(NSView *)card;
- (NSView *)changelogSection:(NSDictionary *)adoption fallbackLines:(NSArray<NSString *> *)fallbackLines;
@end

@implementation ManagerSectionController
- (NSArray<NSView *> *)cardsForHost:(TweakersDoctorDelegate *)host presentation:(NSDictionary *)presentation {
  (void)host; (void)presentation;
  return @[];
}
@end

@implementation OverviewSectionController
- (NSArray<NSView *> *)cardsForHost:(TweakersDoctorDelegate *)host presentation:(NSDictionary *)presentation {
  NSDictionary *report = presentation[@"report"];
  NSDictionary *update = report[@"update"];
  NSDictionary *target = report[@"target"];
  NSDictionary *healthReport = report[@"health"];
  NSDictionary *retry = ReportAction(report, @"retry");
  NSDictionary *scan = ReportAction(report, @"scan");
  NSDictionary *decide = ReportAction(report, @"decide");
  NSString *progress = StringValue(update[@"progress"], nil);
  NSString *healthStatus = HealthStateLabel(StringValue(healthReport[@"state"], @"unknown"));
  NSString *updateStatus = UpdateStateLabel(update);
  NSString *healthSymbol = [healthStatus isEqual:@"Healthy"] ? @"checkmark.circle" : [healthStatus isEqual:@"Blocked"] ? @"xmark.octagon" : @"exclamationmark.circle";
  NSString *updateSymbol = [updateStatus isEqual:@"Compatible"] ? @"checkmark.circle" : [updateStatus isEqual:@"Checking"] ? @"clock" : @"exclamationmark.circle";
  NSString *broker = StringValue(healthReport[@"broker"], @"unknown");
  NSString *brokerLine = [broker isEqual:@"not_running"] ? @"Accounts broker: fresh readiness is unavailable." : [NSString stringWithFormat:@"Accounts broker: %@.", broker];
  NSView *health = [host statusCardWithTitle:@"Current installation" status:healthStatus symbol:healthSymbol lines:@[
    [NSString stringWithFormat:@"Installed Tweakers: %@", VersionAndBuild(target, @"version", @"build")], brokerLine]];
  NSView *readiness = [host statusCardWithTitle:@"Update readiness" status:updateStatus symbol:updateSymbol lines:@[progress.length ? progress : @"No update work is running."]];
  NSString *nextText = nil;
  NSString *destination = @"doctor";
  if (host.reportStale) nextText = @"The Manager is unavailable. Retry the status check before taking any action; the saved findings remain readable.";
  else if (![healthReport[@"state"] isEqual:@"healthy"]) {
    nextText = [retry[@"enabled"] isEqual:@YES] ? @"Retry Tweakers is available in Doctor." : @"Open Doctor to review blockers. Retry Tweakers is currently unavailable.";
  } else if ([decide[@"enabled"] isEqual:@YES] && [update[@"state"] isEqual:@"review_required"]) {
    nextText = @"Review update changes in Updates before installation.";
    destination = @"updates";
  } else if ([scan[@"enabled"] isEqual:@YES]) {
    nextText = @"Check for updates is available in Updates.";
    destination = @"updates";
  } else nextText = @"No action is available in the current report. Open Doctor to review blockers.";
  NSView *next = [host sectionWithTitle:@"Next step" lines:@[nextText]];
  [host addNavigation:@"Open Doctor" destination:@"doctor" toCard:health];
  [host addNavigation:@"Open Updates" destination:@"updates" toCard:readiness];
  [host addNavigation:[destination isEqual:@"doctor"] ? @"Open Doctor" : @"Open Updates" destination:destination toCard:next];
  return @[health, readiness, next];
}
@end

@implementation UpdatesSectionController
- (NSArray<NSView *> *)cardsForHost:(TweakersDoctorDelegate *)host presentation:(NSDictionary *)presentation {
  NSDictionary *report = presentation[@"report"], *update = report[@"update"];
  NSDictionary *adoption = presentation[@"adoption"];
  NSDictionary *compatibility = [update[@"compatibility"] isKindOfClass:[NSDictionary class]] ? update[@"compatibility"] : nil;
  BOOL compatibilityWorkflow = compatibility || IsCompatibilityWorkflowInProgress(update);
  NSDictionary *sourceVersions = adoption[@"report"][@"sourceVersions"];
  NSDictionary *review = [update[@"review"] isKindOfClass:[NSDictionary class]] ? update[@"review"] : nil;
  NSDictionary *pause = [review[@"pause"] isKindOfClass:[NSDictionary class]] ? review[@"pause"] : nil;
  NSDictionary *install = ReportAction(report, @"update");
  NSArray<NSString *> *blockers = [install[@"blockers"] isKindOfClass:[NSArray class]] ? install[@"blockers"] : @[];
  NSString *statusText = host.reportStale ? @"Status unavailable" : UpdateStateLabel(update);
  NSMutableArray<NSString *> *summary = [NSMutableArray array];
  if ([sourceVersions isKindOfClass:[NSDictionary class]]) {
    [summary addObject:[NSString stringWithFormat:@"Installed %@ → candidate %@", VersionAndBuild(sourceVersions[@"before"], @"version", @"build"), VersionAndBuild(sourceVersions[@"after"], @"version", @"build")]];
  } else [summary addObject:[NSString stringWithFormat:@"Installed Tweakers: %@", VersionAndBuild(report[@"target"], @"version", @"build")]];
  if (!host.reportStale && [update[@"progress"] isKindOfClass:[NSString class]]) [summary addObject:update[@"progress"]];
  if (!compatibilityWorkflow && review) [summary addObject:[NSString stringWithFormat:@"Review: %@/%@ files, %@/%@ questions; %@ entries and %@ limitations reported.",
    review[@"files"][@"accounted"] ?: @"?", review[@"files"][@"total"] ?: @"?",
    review[@"questions"][@"completed"] ?: @"?", review[@"questions"][@"total"] ?: @"?",
    review[@"entries"] ?: @"?", review[@"limitations"] ?: @"?"]];
  if (!compatibilityWorkflow && pause) [summary addObject:[NSString stringWithFormat:@"Review paused. Next: %@.", PauseActionLabel(pause[@"action"])]];
  if (install && ![install[@"enabled"] isEqual:@YES] && ![update[@"state"] isEqual:@"checking"]) [summary addObject:ShortInstallBlockerSummary(blockers)];
  NSView *status = [host statusCardWithTitle:@"Update status" status:statusText
    symbol:([statusText isEqual:@"Compatible"] || [statusText isEqual:@"Ready to install"] || [statusText isEqual:@"Update installed"]) ? @"checkmark.circle" : IsCompatibilityWorkflowInProgress(update) ? @"clock" : @"exclamationmark.circle"
    lines:summary];
  NSView *installed = [host sectionWithTitle:@"Your app" lines:presentation[@"target"]];
  NSView *changelog = host.reportStale ? [host sectionWithTitle:@"Last saved update" lines:@[@"Live progress is unavailable. Reload status to find out whether the update check is still running."]] : [host changelogSection:adoption fallbackLines:presentation[@"changelog"]];
  if (compatibilityWorkflow) return @[status, [host sectionWithTitle:@"Compatibility" lines:CompatibilityLines(compatibility, update)], installed, changelog];
  return @[status, installed, changelog];
}
@end

@implementation DoctorSectionController
- (NSArray<NSView *> *)cardsForHost:(TweakersDoctorDelegate *)host presentation:(NSDictionary *)presentation {
  NSDictionary *report = presentation[@"report"];
  NSString *healthStatus = HealthStateLabel(StringValue(report[@"health"][@"state"], @"unknown"));
  NSMutableArray<NSDictionary *> *installation = [NSMutableArray array];
  for (NSDictionary *finding in report[@"findings"]) if ([finding isKindOfClass:[NSDictionary class]] && !IsCompatibilityFinding(finding)) [installation addObject:finding];
  [installation sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    NSDictionary *priority = @{@"error": @0, @"warning": @1, @"info": @2};
    return [priority[StringValue(left[@"severity"], @"info")] compare:priority[StringValue(right[@"severity"], @"info")]];
  }];
  NSMutableArray<NSString *> *findings = [NSMutableArray array];
  for (NSDictionary *finding in installation) [findings addObject:[NSString stringWithFormat:@"%@ · %@\n%@", [StringValue(finding[@"severity"], @"info") uppercaseString], StringValue(finding[@"title"], @"Finding"), StringValue(finding[@"detail"], @"")]];
  if (!findings.count) [findings addObject:@"No installation findings. The current health check found no repair step."];
  return @[[host statusCardWithTitle:@"Installation health" status:healthStatus symbol:[healthStatus isEqual:@"Healthy"] ? @"checkmark.circle" : [healthStatus isEqual:@"Blocked"] ? @"xmark.octagon" : @"exclamationmark.circle" lines:@[presentation[@"health"][1]]],
    [host sectionWithTitle:@"Findings, in priority order" lines:findings],
    [host sectionWithTitle:@"Installed app" lines:presentation[@"target"]]];
}
@end

@implementation TweakersDoctorDelegate

- (instancetype)initWithLauncherPath:(NSString *)launcherPath section:(NSString *)section {
  self = [super init];
  if (self) {
    _launcherPath = [launcherPath copy];
    _launcherGeneration = [LauncherGeneration(launcherPath) copy];
    _selectedSection = [section copy];
    _sectionControllers = @{@"overview": [[OverviewSectionController alloc] init],
      @"updates": [[UpdatesSectionController alloc] init], @"doctor": [[DoctorSectionController alloc] init]};
    _sectionScrollOrigins = [NSMutableDictionary dictionary];
    _actionBlockerLabels = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  [self installMenus];
  [self buildWindow];
  [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(activateDoctor:) name:kDoctorActivateNotification object:nil];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self refresh:nil];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)hasVisibleWindows {
  (void)sender;
  if (!hasVisibleWindows) {
    NSString *remembered = [NSUserDefaults.standardUserDefaults stringForKey:kManagerSectionDefaultsKey];
    [self selectSection:IsManagerSection(remembered) ? remembered : self.selectedSection];
    [self.window makeKeyAndOrderFront:nil];
    [self refresh:nil];
  }
  return YES;
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  [self updateButtons];
}

- (void)windowDidBecomeKey:(NSNotification *)notification {
  (void)notification;
  [self updateButtons];
}

- (void)windowWillClose:(NSNotification *)notification {
  (void)notification;
  [self.statusRefreshTimer invalidate];
  self.statusRefreshTimer = nil;
  [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
  [self.statusRefreshTimer invalidate];
  self.statusRefreshTimer = nil;
  [sender orderOut:nil];
  return NO;
}

- (void)activateDoctor:(NSNotification *)notification {
  if (IsManagerSection(notification.object)) [self selectSection:notification.object];
  [self updateButtons];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self refresh:nil];
}

- (void)installMenus {
  NSMenu *menuBar = [[NSMenu alloc] initWithTitle:@""];
  NSMenuItem *applicationItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:applicationItem];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Tweakers Manager"];
  [applicationMenu addItemWithTitle:@"Quit Tweakers Manager" action:@selector(terminate:) keyEquivalent:@"q"];
  applicationItem.submenu = applicationMenu;
  NSMenuItem *editItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:editItem];
  NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editItem.submenu = editMenu;
  NSMenuItem *windowItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:nil keyEquivalent:@""];
  NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
  for (NSArray *item in @[@[@"Compact", NSStringFromSelector(@selector(compactWindow:))], @[@"Standard", NSStringFromSelector(@selector(standardWindow:))]]) {
    NSMenuItem *sizeItem = [windowMenu addItemWithTitle:item[0] action:NSSelectorFromString(item[1]) keyEquivalent:@""];
    sizeItem.target = self;
  }
  windowItem.submenu = windowMenu;
  [menuBar addItem:windowItem];
  NSMenuItem *viewItem = [[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""];
  NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
  for (NSArray<NSString *> *item in @[@[@"Overview", @"overview"], @[@"Updates", @"updates"], @[@"Doctor", @"doctor"]]) {
    NSMenuItem *sectionItem = [viewMenu addItemWithTitle:item[0] action:@selector(selectSectionFromMenu:) keyEquivalent:@""];
    sectionItem.representedObject = item[1];
    sectionItem.target = self;
  }
  viewItem.submenu = viewMenu;
  [menuBar addItem:viewItem];
  NSApp.mainMenu = menuBar;
}

- (void)compactWindow:(id)sender {
  (void)sender;
  [self.window setContentSize:NSMakeSize(780, 580)];
  [self.window center];
  [self sizeScrollableContent];
}

- (void)standardWindow:(id)sender {
  (void)sender;
  NSRect available = self.window.screen.visibleFrame;
  [self.window setContentSize:NSMakeSize(MIN(1100, available.size.width - 40), MIN(760, available.size.height - 80))];
  [self.window center];
  [self sizeScrollableContent];
}

- (void)selectSectionFromMenu:(NSMenuItem *)sender {
  [self selectSection:sender.representedObject];
}

- (void)selectSectionFromButton:(NSButton *)sender {
  [self selectSection:sender.identifier];
}

- (void)selectSection:(NSString *)section {
  if (!IsManagerSection(section)) return;
  if (self.bodyScroll && IsManagerSection(self.selectedSection)) {
    self.sectionScrollOrigins[self.selectedSection] = [NSValue valueWithPoint:self.bodyScroll.contentView.bounds.origin];
  }
  self.selectedSection = section;
  [NSUserDefaults.standardUserDefaults setObject:section forKey:kManagerSectionDefaultsKey];
  for (NSButton *button in self.sectionButtons) {
    BOOL selected = [button.identifier isEqual:section];
    button.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
    button.font = [NSFont systemFontOfSize:13 weight:selected ? NSFontWeightSemibold : NSFontWeightRegular];
    button.accessibilityValue = selected ? @"Selected" : @"";
  }
  NSDictionary *headings = @{
    @"overview": @[@"Overview", @"Your installation, update readiness, and the next useful step."],
    @"updates": @[@"Updates", @"Verify candidate compatibility and install only when its checks pass."],
    @"doctor": @[@"Doctor", @"Prioritized findings and recovery for your installed app."],
  };
  NSArray<NSString *> *heading = headings[section];
  self.sectionHeading.stringValue = heading[0];
  self.sectionSubtitle.stringValue = heading[1];
  self.updateActionRow.hidden = ![section isEqual:@"updates"];
  self.doctorActionRow.hidden = ![section isEqual:@"doctor"];
  self.actionStack.hidden = [section isEqual:@"overview"];
  self.evidenceDisclosure.hidden = ![section isEqual:@"updates"] || [self adoption] == nil;
  self.adoptionBox.hidden = ![section isEqual:@"updates"] || [self adoption] == nil || self.evidenceDisclosure.state != NSControlStateValueOn;
  if (self.report) [self presentSectionReport:self.report];
  [self sizeScrollableContent];
  NSValue *origin = self.sectionScrollOrigins[section];
  [self restoreScrollView:self.bodyScroll origin:origin ? origin.pointValue : NSZeroPoint];
}

- (void)toggleSidebar:(id)sender {
  (void)sender;
  BOOL collapsed = self.sidebarWidth.constant > 0;
  self.sidebar.hidden = collapsed;
  self.sidebarWidth.constant = collapsed ? 0 : 200;
  [NSUserDefaults.standardUserDefaults setBool:collapsed forKey:kManagerSidebarCollapsedDefaultsKey];
  self.sidebarToggle.toolTip = collapsed ? @"Show Sidebar" : @"Hide Sidebar";
  self.sidebarToggle.accessibilityLabel = self.sidebarToggle.toolTip;
  [self.window.contentView layoutSubtreeIfNeeded];
  [self sizeScrollableContent];
}

- (NSBox *)buildAdoptionBox {
  NSBox *box = [[NSBox alloc] initWithFrame:NSZeroRect];
  box.boxType = NSBoxCustom;
  box.borderWidth = 1;
  box.borderColor = NSColor.separatorColor;
  box.cornerRadius = 8;
  box.fillColor = NSColor.controlBackgroundColor;
  box.titlePosition = NSNoTitle;
  [box setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
  box.hidden = YES;

  NSStackView *content = [NSStackView stackViewWithViews:@[]];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 8;
  content.edgeInsets = NSEdgeInsetsMake(16, 16, 16, 16);
  content.translatesAutoresizingMaskIntoConstraints = NO;
  [content setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
  NSTextField *heading = [NSTextField labelWithString:@"Evidence review and decisions"];
  heading.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  NSTextField *guidance = [NSTextField wrappingLabelWithString:@"These are analysis groups, not a feature list. Inspect supporting evidence here; accepting a group does not install the update."];
  guidance.textColor = NSColor.secondaryLabelColor;
  guidance.font = [NSFont systemFontOfSize:12];
  [content addArrangedSubview:heading];
  [content addArrangedSubview:guidance];

  NSStackView *review = [NSStackView stackViewWithViews:@[]];
  self.reviewLayout = review;
  review.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  review.alignment = NSLayoutAttributeTop;
  review.spacing = 10;
  self.changeTable = [[NSTableView alloc] initWithFrame:NSZeroRect];
  self.changeTable.delegate = self;
  self.changeTable.dataSource = self;
  self.changeTable.allowsMultipleSelection = NO;
  self.changeTable.allowsEmptySelection = NO;
  self.changeTable.headerView = nil;
  self.changeTable.intercellSpacing = NSMakeSize(8, 10);
  self.changeTable.usesAlternatingRowBackgroundColors = YES;
  self.changeTable.selectionHighlightStyle = NSTableViewSelectionHighlightStyleRegular;
  NSTableColumn *changeColumn = [[NSTableColumn alloc] initWithIdentifier:@"change"];
  changeColumn.title = @"Change";
  changeColumn.width = 300;
  [self.changeTable addTableColumn:changeColumn];
  NSScrollView *tableScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  self.reviewTableScroll = tableScroll;
  tableScroll.hasVerticalScroller = YES;
  tableScroll.borderType = NSBezelBorder;
  tableScroll.documentView = self.changeTable;
  tableScroll.translatesAutoresizingMaskIntoConstraints = NO;

  self.changeDetailView = [[NSTextView alloc] initWithFrame:NSZeroRect];
  self.changeDetailView.editable = NO;
  self.changeDetailView.selectable = YES;
  self.changeDetailView.font = [NSFont systemFontOfSize:13];
  self.changeDetailView.textContainerInset = NSMakeSize(16, 16);
  self.changeDetailView.string = @"Select a reported change to inspect its evidence and review state.";
  NSScrollView *detailScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  self.reviewDetailScroll = detailScroll;
  detailScroll.hasVerticalScroller = YES;
  detailScroll.borderType = NSBezelBorder;
  detailScroll.documentView = self.changeDetailView;
  detailScroll.translatesAutoresizingMaskIntoConstraints = NO;
  [review addArrangedSubview:tableScroll];
  [review addArrangedSubview:detailScroll];
  [content addArrangedSubview:review];

  NSStackView *decisionRow = [NSStackView stackViewWithViews:@[]];
  decisionRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  decisionRow.spacing = 7;
  self.acceptButton = [NSButton buttonWithTitle:@"Accept Selected" target:self action:@selector(acceptSelected:)];
  self.preserveButton = [NSButton buttonWithTitle:@"Request Preservation" target:self action:@selector(preserveSelected:)];
  self.acknowledgeUnknownButton = [NSButton buttonWithTitle:@"Acknowledge Unknown" target:self action:@selector(acknowledgeUnknown:)];
  self.overridePopup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
  [self.overridePopup addItemWithTitle:@"No verified overrides"];
  self.overrideButton = [NSButton buttonWithTitle:@"Use Override" target:self action:@selector(useOverride:)];
  [decisionRow addArrangedSubview:self.acceptButton];
  [decisionRow addArrangedSubview:self.preserveButton];
  [decisionRow addArrangedSubview:self.acknowledgeUnknownButton];
  NSStackView *overrideRow = [NSStackView stackViewWithViews:@[self.overridePopup, self.overrideButton]];
  overrideRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  overrideRow.spacing = 8;

  NSStackView *reviewRow = [NSStackView stackViewWithViews:@[]];
  reviewRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  reviewRow.spacing = 7;
  self.observeButton = [NSButton buttonWithTitle:@"Record Manual Observation…" target:self action:@selector(recordObservation:)];
  self.deferResumeButton = [NSButton buttonWithTitle:@"Defer Review" target:self action:@selector(toggleDeferred:)];
  [reviewRow addArrangedSubview:self.observeButton];
  [reviewRow addArrangedSubview:self.deferResumeButton];
  self.adoptionActionStack = [NSStackView stackViewWithViews:@[decisionRow, overrideRow, reviewRow]];
  self.adoptionActionStack.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.adoptionActionStack.alignment = NSLayoutAttributeLeading;
  self.adoptionActionStack.spacing = 7;
  [content addArrangedSubview:self.adoptionActionStack];

  [box.contentView addSubview:content];
  self.reviewHorizontalTableWidth = [tableScroll.widthAnchor constraintEqualToAnchor:review.widthAnchor multiplier:0.42];
  self.reviewHorizontalDetailHeight = [detailScroll.heightAnchor constraintEqualToAnchor:tableScroll.heightAnchor];
  self.reviewVerticalTableWidth = [tableScroll.widthAnchor constraintEqualToAnchor:review.widthAnchor];
  self.reviewVerticalDetailWidth = [detailScroll.widthAnchor constraintEqualToAnchor:review.widthAnchor];
  self.reviewVerticalDetailHeight = [detailScroll.heightAnchor constraintEqualToConstant:320];
  self.reviewTableHeight = [tableScroll.heightAnchor constraintEqualToConstant:340];
  [NSLayoutConstraint activateConstraints:@[
    [content.leadingAnchor constraintEqualToAnchor:box.contentView.leadingAnchor],
    [content.trailingAnchor constraintEqualToAnchor:box.contentView.trailingAnchor],
    [content.topAnchor constraintEqualToAnchor:box.contentView.topAnchor],
    [content.bottomAnchor constraintEqualToAnchor:box.contentView.bottomAnchor],
    [guidance.widthAnchor constraintEqualToAnchor:content.widthAnchor],
    [review.widthAnchor constraintEqualToAnchor:content.widthAnchor],
    self.reviewHorizontalTableWidth,
    self.reviewTableHeight,
    self.reviewHorizontalDetailHeight,
  ]];
  return box;
}

- (void)buildWindow {
  NSRect available = NSScreen.mainScreen.visibleFrame;
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, MIN(1040, MAX(500, available.size.width - 40)), MIN(760, MAX(420, available.size.height - 80)))
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Tweakers Manager";
  self.window.releasedWhenClosed = NO;
  self.window.delegate = self;
  self.window.contentMinSize = NSMakeSize(500, 420);
  self.window.backgroundColor = NSColor.windowBackgroundColor;
  self.window.titlebarAppearsTransparent = YES;
  if (![self.window setFrameUsingName:@"TweakersManagerWindow"]) [self.window center];
  [self.window setFrameAutosaveName:@"TweakersManagerWindow"];

  NSView *content = self.window.contentView;
  self.sidebarContainer = [[NSView alloc] initWithFrame:NSZeroRect];
  self.sidebarContainer.translatesAutoresizingMaskIntoConstraints = NO;
  [content addSubview:self.sidebarContainer];
  self.sidebar = [[ManagerSidebarView alloc] initWithFrame:NSZeroRect];
  self.sidebar.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.sidebar.alignment = NSLayoutAttributeLeading;
  self.sidebar.spacing = 8;
  self.sidebar.edgeInsets = NSEdgeInsetsMake(24, 16, 16, 16);
  self.sidebar.translatesAutoresizingMaskIntoConstraints = NO;
  self.sidebar.wantsLayer = YES;
  [self.sidebarContainer addSubview:self.sidebar];
  [(ManagerSidebarView *)self.sidebar updateSidebarBackground];
  NSTextField *sidebarTitle = [NSTextField labelWithString:@"TWEAKERS"];
  sidebarTitle.font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
  sidebarTitle.textColor = NSColor.secondaryLabelColor;
  [self.sidebar addArrangedSubview:sidebarTitle];
  NSMutableArray<NSButton *> *navigation = [NSMutableArray array];
  for (NSArray<NSString *> *entry in @[@[@"Overview", @"overview", @"square.grid.2x2"], @[@"Updates", @"updates", @"arrow.down.circle"], @[@"Doctor", @"doctor", @"cross.case"]]) {
    NSButton *button = [NSButton buttonWithTitle:entry[0] target:self action:@selector(selectSectionFromButton:)];
    button.identifier = entry[1];
    button.image = [NSImage imageWithSystemSymbolName:entry[2] accessibilityDescription:entry[0]];
    button.imagePosition = NSImageLeft;
    button.bezelStyle = NSBezelStyleRounded;
    button.font = [NSFont systemFontOfSize:13];
    button.alignment = NSTextAlignmentLeft;
    button.accessibilityLabel = entry[0];
    [self.sidebar addArrangedSubview:button];
    [button.widthAnchor constraintEqualToAnchor:self.sidebar.widthAnchor constant:-32].active = YES;
    [navigation addObject:button];
  }
  self.sectionButtons = navigation;
  self.sidebarWidth = [self.sidebarContainer.widthAnchor constraintEqualToConstant:200];
  NSScrollView *bodyScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  self.bodyScroll = bodyScroll;
  bodyScroll.hasVerticalScroller = YES;
  bodyScroll.drawsBackground = NO;
  bodyScroll.translatesAutoresizingMaskIntoConstraints = NO;
  DoctorScrollDocument *document = [[DoctorScrollDocument alloc] initWithFrame:NSZeroRect];
  document.autoresizingMask = NSViewWidthSizable;
  bodyScroll.documentView = document;
  [content addSubview:bodyScroll];
  NSStackView *layout = [NSStackView stackViewWithViews:@[]];
  self.bodyLayout = layout;
  layout.orientation = NSUserInterfaceLayoutOrientationVertical;
  layout.alignment = NSLayoutAttributeLeading;
  layout.spacing = 16;
  layout.translatesAutoresizingMaskIntoConstraints = NO;
  [document addSubview:layout];

  NSStackView *header = [NSStackView stackViewWithViews:@[]];
  header.orientation = NSUserInterfaceLayoutOrientationVertical;
  header.alignment = NSLayoutAttributeLeading;
  header.spacing = 4;
  NSStackView *titles = [NSStackView stackViewWithViews:@[]];
  titles.orientation = NSUserInterfaceLayoutOrientationVertical;
  titles.alignment = NSLayoutAttributeLeading;
  titles.spacing = 3;
  self.sectionHeading = [NSTextField labelWithString:@"Doctor"];
  self.sectionHeading.font = [NSFont systemFontOfSize:22 weight:NSFontWeightSemibold];
  self.sectionSubtitle = [NSTextField wrappingLabelWithString:@"Check your installation and follow its recovery steps."];
  self.sectionSubtitle.font = [NSFont systemFontOfSize:13];
  self.sectionSubtitle.textColor = NSColor.secondaryLabelColor;
  [titles addArrangedSubview:self.sectionHeading];
  [titles addArrangedSubview:self.sectionSubtitle];
  [header addArrangedSubview:titles];
  self.activityLabel = [NSTextField labelWithString:@"Loading Manager report…"];
  self.activityLabel.textColor = NSColor.secondaryLabelColor;
  self.freshnessLabel = [NSTextField wrappingLabelWithString:@""];
  self.freshnessLabel.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
  self.freshnessLabel.textColor = NSColor.systemOrangeColor;
  self.freshnessLabel.hidden = YES;

  self.reportStack = [NSStackView stackViewWithViews:@[]];
  self.reportStack.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.reportStack.alignment = NSLayoutAttributeLeading;
  self.reportStack.spacing = 10;
  self.reportStack.edgeInsets = NSEdgeInsetsMake(0, 0, 0, 0);
  self.reportStack.translatesAutoresizingMaskIntoConstraints = NO;

  self.adoptionBox = [self buildAdoptionBox];
  self.evidenceDisclosure = [NSButton checkboxWithTitle:@"Inspect analysis groups and review decisions" target:self action:@selector(toggleEvidenceReview:)];
  self.evidenceDisclosure.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];

  self.technicalDisclosure = [NSButton checkboxWithTitle:@"Show technical report" target:self action:@selector(toggleTechnicalReport:)];
  self.technicalDisclosure.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
  self.technicalDisclosure.toolTip = @"Show diagnostic details. Copy Report always includes the full report.";
  NSScrollView *reportScroll = [[NSScrollView alloc] initWithFrame:NSZeroRect];
  self.technicalReportScroll = reportScroll;
  reportScroll.hidden = YES;
  reportScroll.hasVerticalScroller = YES;
  reportScroll.borderType = NSBezelBorder;
  reportScroll.translatesAutoresizingMaskIntoConstraints = NO;
  self.reportView = [[NSTextView alloc] initWithFrame:NSZeroRect];
  self.reportView.editable = NO;
  self.reportView.selectable = YES;
  self.reportView.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
  self.reportView.textContainerInset = NSMakeSize(12, 12);
  self.reportView.textContainerInset = NSMakeSize(12, 12);
  self.reportView.string = @"Checking the independent installation…";
  reportScroll.documentView = self.reportView;

  self.actionStack = [NSStackView stackViewWithViews:@[]];
  self.actionStack.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.actionStack.alignment = NSLayoutAttributeLeading;
  self.actionStack.spacing = 8;
  for (NSString *action in PrimaryDoctorActionIds()) {
    NSButton *button = [NSButton buttonWithTitle:[action capitalizedString] target:self action:@selector(performDoctorAction:)];
    button.identifier = action;
    button.enabled = NO;
    [self.actionStack addArrangedSubview:button];
  }
  NSButton *refresh = [NSButton buttonWithTitle:@"Reload status" target:self action:@selector(refresh:)];
  self.sidebarToggle = [NSButton buttonWithTitle:@"" target:self action:@selector(toggleSidebar:)];
  self.sidebarToggle.image = [NSImage imageWithSystemSymbolName:@"sidebar.left" accessibilityDescription:@"Toggle sidebar"];
  self.sidebarToggle.toolTip = @"Hide Sidebar";
  self.sidebarToggle.accessibilityLabel = @"Hide Sidebar";
  self.reportCopyButton = [NSButton buttonWithTitle:@"Copy Report" target:self action:@selector(copyReport:)];
  self.reportCopyButton.enabled = NO;
  self.footerActions = [NSStackView stackViewWithViews:@[self.sidebarToggle, refresh, self.reportCopyButton]];
  self.footerActions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  self.footerActions.spacing = 8;
  self.footerActions.translatesAutoresizingMaskIntoConstraints = NO;

  [layout addArrangedSubview:header];
  [layout addArrangedSubview:self.activityLabel];
  [layout addArrangedSubview:self.freshnessLabel];
  [layout addArrangedSubview:self.reportStack];
  [layout addArrangedSubview:self.actionStack];
  [layout addArrangedSubview:self.evidenceDisclosure];
  [layout addArrangedSubview:self.adoptionBox];
  [layout addArrangedSubview:self.technicalDisclosure];
  [layout addArrangedSubview:reportScroll];
  // Each section presents its own guarded actions with blockers beside them.
  self.actionButtons = [self.actionStack.arrangedSubviews copy];
  for (NSView *button in self.actionButtons) {
    [self.actionStack removeArrangedSubview:button];
    [button removeFromSuperview];
  }
  self.actionStack.spacing = 16;
  self.updateActionRow = [NSStackView stackViewWithViews:@[]];
  self.doctorActionRow = [NSStackView stackViewWithViews:@[]];
  for (NSStackView *row in @[self.updateActionRow, self.doctorActionRow]) {
    row.orientation = NSUserInterfaceLayoutOrientationVertical;
    row.alignment = NSLayoutAttributeLeading;
    row.spacing = 8;
    [self.actionStack addArrangedSubview:row];
  }
  for (NSView *button in self.actionButtons) {
    NSString *identifier = button.identifier ?: @"";
    NSStackView *row = [@[@"scan", @"update", @"preview_before", @"preview_after"] containsObject:identifier] ? self.updateActionRow : self.doctorActionRow;
    NSStackView *actionLine = [NSStackView stackViewWithViews:@[button]];
    actionLine.orientation = NSUserInterfaceLayoutOrientationVertical;
    actionLine.alignment = NSLayoutAttributeLeading;
    actionLine.spacing = 2;
    NSTextField *blockers = [NSTextField wrappingLabelWithString:@""];
    blockers.font = [NSFont systemFontOfSize:12];
    blockers.textColor = NSColor.secondaryLabelColor;
    blockers.hidden = YES;
    self.actionBlockerLabels[identifier] = blockers;
    [actionLine addArrangedSubview:blockers];
    [row addArrangedSubview:actionLine];
    [actionLine.widthAnchor constraintEqualToAnchor:self.actionStack.widthAnchor].active = YES;
    [blockers.widthAnchor constraintEqualToAnchor:actionLine.widthAnchor].active = YES;
  }
  [content addSubview:self.footerActions];
  [NSLayoutConstraint activateConstraints:@[
    self.sidebarWidth,
    [self.sidebarContainer.leadingAnchor constraintEqualToAnchor:content.leadingAnchor],
    [self.sidebarContainer.topAnchor constraintEqualToAnchor:content.topAnchor],
    [self.sidebarContainer.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
    [self.sidebar.leadingAnchor constraintEqualToAnchor:self.sidebarContainer.leadingAnchor],
    [self.sidebar.topAnchor constraintEqualToAnchor:self.sidebarContainer.topAnchor],
    [self.sidebar.bottomAnchor constraintEqualToAnchor:self.sidebarContainer.bottomAnchor],
    [self.sidebar.widthAnchor constraintEqualToConstant:200],
    [bodyScroll.leadingAnchor constraintEqualToAnchor:self.sidebarContainer.trailingAnchor],
    [bodyScroll.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    [bodyScroll.topAnchor constraintEqualToAnchor:content.topAnchor],
    [bodyScroll.bottomAnchor constraintEqualToAnchor:self.footerActions.topAnchor constant:-8],
    [self.footerActions.leadingAnchor constraintEqualToAnchor:bodyScroll.leadingAnchor constant:20],
    [self.footerActions.trailingAnchor constraintLessThanOrEqualToAnchor:content.trailingAnchor constant:-16],
    [self.footerActions.bottomAnchor constraintEqualToAnchor:content.bottomAnchor constant:-8],
    [layout.leadingAnchor constraintEqualToAnchor:document.leadingAnchor constant:20],
    [layout.trailingAnchor constraintEqualToAnchor:document.trailingAnchor constant:-20],
    [layout.topAnchor constraintEqualToAnchor:document.topAnchor constant:20],
    [header.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [self.reportStack.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [self.actionStack.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [self.adoptionBox.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [reportScroll.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [reportScroll.heightAnchor constraintEqualToConstant:170],
  ]];
  if ([NSUserDefaults.standardUserDefaults boolForKey:kManagerSidebarCollapsedDefaultsKey]) [self toggleSidebar:nil];
  [self selectSection:self.selectedSection];
  [self sizeScrollableContent];
}

- (void)toggleEvidenceReview:(NSButton *)sender {
  self.adoptionBox.hidden = sender.state != NSControlStateValueOn || [self adoption] == nil;
  [self sizeScrollableContent];
}

- (void)revealSelectedChangeDetail {
  [self sizeScrollableContent];
  NSView *document = self.bodyScroll.documentView;
  if (!document || self.adoptionBox.hidden || !self.changeDetailView.window) return;
  NSRect detailRect = [self.changeDetailView convertRect:self.changeDetailView.bounds toView:document];
  [document scrollRectToVisible:NSInsetRect(detailRect, 0, -12)];
}

- (void)toggleTechnicalReport:(NSButton *)sender {
  self.technicalReportScroll.hidden = sender.state != NSControlStateValueOn;
  [self updateSelectedChangePresentation];
  [self sizeScrollableContent];
}

- (void)restoreScrollView:(NSScrollView *)scrollView origin:(NSPoint)origin {
  if (!scrollView || !scrollView.documentView) return;
  NSClipView *clipView = scrollView.contentView;
  NSSize documentSize = scrollView.documentView.frame.size;
  NSSize viewportSize = clipView.bounds.size;
  NSPoint clamped = NSMakePoint(MAX(0, MIN(origin.x, MAX(0, documentSize.width - viewportSize.width))),
    MAX(0, MIN(origin.y, MAX(0, documentSize.height - viewportSize.height))));
  [clipView scrollToPoint:clamped];
  [scrollView reflectScrolledClipView:clipView];
}

- (BOOL)configureReviewLayoutForPaneWidth:(CGFloat)paneWidth {
  if (!self.reviewLayout) return NO;
  BOOL vertical = paneWidth < 700;
  if (vertical == self.reviewIsVertical) return NO;
  [NSLayoutConstraint deactivateConstraints:vertical
    ? @[self.reviewHorizontalTableWidth, self.reviewHorizontalDetailHeight]
    : @[self.reviewVerticalTableWidth, self.reviewVerticalDetailWidth, self.reviewVerticalDetailHeight]];
  self.reviewIsVertical = vertical;
  self.reviewLayout.orientation = vertical ? NSUserInterfaceLayoutOrientationVertical : NSUserInterfaceLayoutOrientationHorizontal;
  self.reviewLayout.alignment = vertical ? NSLayoutAttributeLeading : NSLayoutAttributeTop;
  self.reviewTableHeight.constant = vertical ? 220 : 340;
  [NSLayoutConstraint activateConstraints:vertical
    ? @[self.reviewVerticalTableWidth, self.reviewVerticalDetailWidth, self.reviewVerticalDetailHeight]
    : @[self.reviewHorizontalTableWidth, self.reviewHorizontalDetailHeight]];
  return YES;
}

- (void)sizeScrollableContent {
  NSView *document = self.bodyScroll.documentView;
  CGFloat width = self.bodyScroll.contentView.bounds.size.width;
  NSPoint tableOrigin = self.reviewTableScroll.contentView.bounds.origin;
  NSPoint detailOrigin = self.reviewDetailScroll.contentView.bounds.origin;
  BOOL reviewChanged = [self configureReviewLayoutForPaneWidth:MAX(0, width - 72)];
  BOOL wide = width >= 960;
  if (self.summaryRow && (!self.summaryWidths || wide != self.summaryWide)) {
    [NSLayoutConstraint deactivateConstraints:self.summaryWidths ?: @[]];
    self.summaryWide = wide;
    self.summaryRow.orientation = wide ? NSUserInterfaceLayoutOrientationHorizontal : NSUserInterfaceLayoutOrientationVertical;
    self.summaryRow.alignment = wide ? NSLayoutAttributeTop : NSLayoutAttributeLeading;
    NSMutableArray *constraints = [NSMutableArray array];
    for (NSView *card in self.summaryRow.arrangedSubviews) {
      [constraints addObject:[card.widthAnchor constraintEqualToAnchor:self.summaryRow.widthAnchor multiplier:wide ? 0.5 : 1 constant:wide ? -6 : 0]];
    }
    self.summaryWidths = constraints;
    [NSLayoutConstraint activateConstraints:constraints];
  }
  [document setFrameSize:NSMakeSize(width, MAX(1, document.frame.size.height))];
  [document layoutSubtreeIfNeeded];
  [document setFrameSize:NSMakeSize(width, MAX(self.bodyScroll.contentView.bounds.size.height, self.bodyLayout.fittingSize.height + 40))];
  if (reviewChanged) {
    [self restoreScrollView:self.reviewTableScroll origin:tableOrigin];
    [self restoreScrollView:self.reviewDetailScroll origin:detailOrigin];
  }
}

- (void)windowDidResize:(NSNotification *)notification {
  (void)notification;
  [self sizeScrollableContent];
}

- (NSDictionary *)adoption {
  id value = self.report[@"adoption"];
  return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

- (NSDictionary *)selectedChange {
  NSInteger row = self.changeTable.selectedRow;
  return row >= 0 && row < (NSInteger)self.adoptionChanges.count ? self.adoptionChanges[(NSUInteger)row] : nil;
}

- (BOOL)confirmDecisionScope:(NSDictionary *)entry choice:(NSString *)choice {
  NSArray<NSString *> *scope = DecisionGroupsForEntry([self adoption], entry[@"id"]);
  if (scope.count == 0) return NO;
  NSMutableArray<NSString *> *siblings = [NSMutableArray array];
  for (NSDictionary *candidate in ChangelogEntries([self adoption])) {
    if ([candidate[@"id"] isEqual:entry[@"id"]]) continue;
    for (NSString *groupId in DecisionGroupsForEntry([self adoption], candidate[@"id"])) if ([scope containsObject:groupId]) { [siblings addObject:StringValue(candidate[@"title"], @"Untitled entry")]; break; }
  }
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"%@ “%@”?", choice.capitalizedString, StringValue(entry[@"title"], @"selected entry")];
  alert.informativeText = [NSString stringWithFormat:@"This applies to analysis groups: %@.%@", [scope componentsJoinedByString:@", "], siblings.count ? [NSString stringWithFormat:@" Coupled entries: %@.", [siblings componentsJoinedByString:@"; "]] : @""];
  [alert addButtonWithTitle:[choice capitalizedString]];
  [alert addButtonWithTitle:@"Cancel"];
  return [alert runModal] == NSAlertFirstButtonReturn;
}

- (BOOL)isActionEnabled:(NSString *)identifier {
  NSDictionary *action = [self actionsById][identifier];
  return !self.busy && !self.reportStale && [self verifiedLauncherAvailable] && [action[@"enabled"] isEqual:@YES];
}

- (BOOL)verifiedLauncherAvailable {
  return [NSFileManager.defaultManager isExecutableFileAtPath:self.launcherPath]
    && [self.launcherGeneration isEqual:LauncherGeneration(self.launcherPath)];
}

- (void)sendDecision:(NSString *)choice changeId:(NSString *)changeId overrideId:(NSString *)overrideId {
  NSDictionary *adoption = [self adoption];
  NSString *outerFingerprint = self.report[@"fingerprint"];
  NSString *reportFingerprint = adoption[@"report"][@"fingerprint"];
  if (![outerFingerprint isKindOfClass:[NSString class]]
      || ![reportFingerprint isKindOfClass:[NSString class]]
      || ![changeId isKindOfClass:[NSString class]]
      || ![self isActionEnabled:@"decide"]) return;
  NSMutableDictionary *decision = [@{
    @"reportFingerprint": reportFingerprint,
    @"changeId": changeId,
    @"choice": choice,
  } mutableCopy];
  if (overrideId.length > 0) decision[@"overrideId"] = overrideId;
  NSDictionary *request = @{
    @"schemaVersion": @1,
    @"action": @"decide",
    @"fingerprint": outerFingerprint,
    @"decision": decision,
  };
  NSData *input = [NSJSONSerialization dataWithJSONObject:request options:NSJSONWritingSortedKeys error:nil];
  if (input) [self runCommand:@"doctor-action" input:input];
}

- (void)acceptSelected:(id)sender {
  (void)sender;
  NSDictionary *change = [self selectedChange];
  if (change && [self confirmDecisionScope:change choice:@"accept"]) [self sendDecision:@"accept" changeId:change[@"id"] overrideId:nil];
}

- (void)preserveSelected:(id)sender {
  (void)sender;
  NSDictionary *change = [self selectedChange];
  if (change && [self confirmDecisionScope:change choice:@"request preservation"]) [self sendDecision:@"preserve" changeId:change[@"id"] overrideId:nil];
}

- (void)acknowledgeUnknown:(id)sender {
  (void)sender;
  NSDictionary *change = [self selectedChange];
  NSArray<NSString *> *scope = change ? DecisionGroupsForEntry([self adoption], change[@"id"]) : @[];
  BOOL eligible = NO;
  for (NSDictionary *group in TechnicalGroups([self adoption])) if ([scope containsObject:group[@"id"]] && [group[@"status"] isEqual:@"unknown"] && [group[@"unknownPolicy"] isEqual:@"acknowledgment"]) { eligible = YES; break; }
  if (!change || !eligible) return;
  if ([self confirmDecisionScope:change choice:@"acknowledge unknown behavior"]) [self sendDecision:@"acknowledge_unknown" changeId:change[@"id"] overrideId:nil];
}

- (void)useOverride:(id)sender {
  (void)sender;
  NSDictionary *change = [self selectedChange];
  NSString *overrideId = self.overridePopup.selectedItem.representedObject;
  if (change && [overrideId isKindOfClass:[NSString class]] && [self confirmDecisionScope:change choice:@"use this override"]) {
    [self sendDecision:@"override" changeId:change[@"id"] overrideId:overrideId];
  }
}

- (void)toggleDeferred:(id)sender {
  (void)sender;
  NSDictionary *adoption = [self adoption];
  if (!adoption) return;
  NSString *choice = [adoption[@"state"] isEqual:@"deferred"] ? @"resume" : @"defer";
  [self sendDecision:choice changeId:@"*" overrideId:nil];
}

- (void)recordObservation:(id)sender {
  (void)sender;
  NSDictionary *change = [self selectedChange];
  NSDictionary *adoption = [self adoption];
  NSArray<NSString *> *scope = change ? DecisionGroupsForEntry(adoption, change[@"id"]) : @[];
  if (!change || !adoption || ![self isActionEnabled:@"observe"] || scope.count != 1) return;

  NSTextField *beforeField = [NSTextField textFieldWithString:@""];
  beforeField.placeholderString = [NSString stringWithFormat:@"What you observed before (report: %@)", StringValue(change[@"before"], @"not described")];
  NSTextField *afterField = [NSTextField textFieldWithString:@""];
  afterField.placeholderString = [NSString stringWithFormat:@"What you observed after (report: %@)", StringValue(change[@"after"], @"not described")];
  NSTextField *conditionsField = [NSTextField textFieldWithString:@""];
  NSPopUpButton *outcomePopup = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
  [outcomePopup addItemsWithTitles:@[@"Matches report", @"Differs from report", @"Unavailable"]];
  NSArray<NSTextField *> *labels = @[
    [NSTextField labelWithString:@"Before"], [NSTextField labelWithString:@"After"],
    [NSTextField labelWithString:@"Conditions"], [NSTextField labelWithString:@"Outcome"],
  ];
  NSGridView *grid = [NSGridView gridViewWithViews:@[
    @[labels[0], beforeField], @[labels[1], afterField], @[labels[2], conditionsField], @[labels[3], outcomePopup],
  ]];
  grid.rowSpacing = 7;
  grid.columnSpacing = 10;
  [beforeField.widthAnchor constraintEqualToConstant:430].active = YES;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"Record observation for “%@”", StringValue(change[@"title"], @"selected change")];
  alert.informativeText = @"Enter what you manually observed. Tweakers will record this as user supplied evidence and will not open or inspect a candidate app.";
  alert.accessoryView = grid;
  [alert addButtonWithTitle:@"Record Observation"];
  [alert addButtonWithTitle:@"Cancel"];
  if ([alert runModal] != NSAlertFirstButtonReturn) return;
  if (![self isActionEnabled:@"observe"]) return;

  NSArray *outcomes = @[@"matches", @"differs", @"unavailable"];
  NSString *outerFingerprint = self.report[@"fingerprint"];
  NSString *reportFingerprint = adoption[@"report"][@"fingerprint"];
  NSDictionary *request = @{
    @"schemaVersion": @1,
    @"action": @"observe",
    @"fingerprint": outerFingerprint,
    @"observation": @{
      @"reportFingerprint": reportFingerprint,
      @"changeId": scope.firstObject,
      @"before": beforeField.stringValue,
      @"after": afterField.stringValue,
      @"conditions": conditionsField.stringValue,
      @"outcome": outcomes[(NSUInteger)outcomePopup.indexOfSelectedItem],
    },
  };
  NSData *input = [NSJSONSerialization dataWithJSONObject:request options:NSJSONWritingSortedKeys error:nil];
  if (input) [self runCommand:@"doctor-action" input:input];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
  return tableView == self.changeTable ? (NSInteger)self.adoptionChanges.count : 0;
}

- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)tableColumn row:(NSInteger)row {
  (void)tableColumn;
  if (tableView != self.changeTable || row < 0 || row >= (NSInteger)self.adoptionChanges.count) return nil;
  NSTextField *cell = [tableView makeViewWithIdentifier:@"change-cell" owner:self];
  if (!cell) {
    cell = [NSTextField wrappingLabelWithString:@""];
    cell.identifier = @"change-cell";
    cell.maximumNumberOfLines = 2;
    cell.lineBreakMode = NSLineBreakByTruncatingTail;
  }
  NSDictionary *change = self.adoptionChanges[(NSUInteger)row];
  cell.stringValue = [NSString stringWithFormat:@"%@ · %@", StringValue(change[@"category"], @"Changed"), StringValue(change[@"title"], @"Untitled change")];
  return cell;
}

- (CGFloat)tableView:(NSTableView *)tableView heightOfRow:(NSInteger)row {
  (void)tableView;
  (void)row;
  return 46;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
  if (notification.object == self.changeTable) [self updateSelectedChangePresentation];
}

- (BOOL)shouldRefreshRunningReview {
  NSDictionary *update = [self.report[@"update"] isKindOfClass:[NSDictionary class]] ? self.report[@"update"] : nil;
  return [update[@"execution"][@"status"] isEqual:@"running"] || [update[@"state"] isEqual:@"checking"] || [update[@"phase"] isEqual:@"updating"];
}

- (void)scheduleRunningReviewRefresh {
  [self.statusRefreshTimer invalidate];
  self.statusRefreshTimer = nil;
  if (!self.window.isVisible || self.busy || self.reportStale || !self.report) return;
  if (![self shouldRefreshRunningReview]) return; // Stable results wait for explicit reload or an action.
  NSTimeInterval interval = 5;
  __weak TweakersDoctorDelegate *weakSelf = self;
  self.statusRefreshTimer = [NSTimer scheduledTimerWithTimeInterval:interval repeats:NO block:^(NSTimer *timer) {
    TweakersDoctorDelegate *self = weakSelf;
    if (!self || timer != self.statusRefreshTimer || !self.window.isVisible || self.busy || self.reportStale) return;
    self.statusRefreshTimer = nil;
    self.preserveStatusPresentation = YES;
    [self runCommand:@"doctor-status" input:nil];
  }];
}

- (void)refresh:(id)sender {
  (void)sender;
  if (self.busy || !self.window.isVisible) return;
  self.preserveStatusPresentation = NO;
  [self runCommand:@"doctor-status" input:nil];
}

- (void)performDoctorAction:(NSButton *)sender {
  if (self.busy || self.reportStale || ![PrimaryDoctorActionIds() containsObject:sender.identifier] || !sender.enabled) return;
  if (![self verifiedLauncherAvailable]) { [self markReportUnavailable:@"The verified manager launcher changed or is unavailable."]; return; }
  NSString *fingerprint = self.report[@"fingerprint"];
  if (![fingerprint isKindOfClass:[NSString class]]) return;
  NSDictionary *request = @{
    @"schemaVersion": @1,
    @"action": sender.identifier,
    @"fingerprint": fingerprint,
  };
  NSData *input = [NSJSONSerialization dataWithJSONObject:request options:NSJSONWritingSortedKeys error:nil];
  if (input) [self runCommand:@"doctor-action" input:input];
}

- (void)copyReport:(id)sender {
  (void)sender;
  if (self.renderedReportText.length == 0) return;
  NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
  [pasteboard clearContents];
  [pasteboard setString:self.renderedReportText forType:NSPasteboardTypeString];
  self.activityLabel.stringValue = @"Report copied.";
}

- (void)markReportUnavailable:(NSString *)message {
  self.busy = NO;
  self.preserveStatusPresentation = NO;
  self.reportStale = YES;
  self.renderedPresentationKey = nil;
  [self.statusRefreshTimer invalidate];
  self.statusRefreshTimer = nil;
  self.activityLabel.stringValue = message;
  self.freshnessLabel.hidden = NO;
  self.freshnessLabel.stringValue = self.report ? [NSString stringWithFormat:@"Live status is unavailable. Last successful report: %@. Actions are disabled. Choose Reload status, or Copy Report for the saved evidence.", StringValue(self.report[@"generatedAt"], @"unknown")] : @"No verified report is available. Choose Reload status to reconnect.";
  for (NSView *view in self.footerActions.arrangedSubviews) if ([view isKindOfClass:[NSButton class]] && view != self.reportCopyButton && view != self.sidebarToggle) ((NSButton *)view).title = @"Reload status";
  if (self.report) [self updateReportPresentation:self.report];
  [self updateButtons];
}

- (void)runCommand:(NSString *)command input:(NSData *)input {
  if ([command isEqual:@"doctor-action"] && (self.reportStale || ![self verifiedLauncherAvailable])) {
    [self markReportUnavailable:@"The verified manager launcher changed or is unavailable."];
    return;
  }
  self.busy = YES;
  if (!self.preserveStatusPresentation) self.activityLabel.stringValue = [command isEqual:@"doctor-status"] ? @"Loading update and app status…" : @"Submitting action…";
  [self updateButtons];

  NSString *requestId = NSUUID.UUID.UUIDString.lowercaseString;
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:self.launcherPath isDirectory:NO];
  task.arguments = @[command, @"--request-id", requestId, @"--json"];
  NSPipe *output = [NSPipe pipe];
  task.standardOutput = output;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  if (input) {
    NSPipe *standardInput = [NSPipe pipe];
    task.standardInput = standardInput;
    [standardInput.fileHandleForWriting writeData:input];
    [standardInput.fileHandleForWriting closeFile];
  } else {
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
  }

  __weak TweakersDoctorDelegate *weakSelf = self;
  NSError *launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    [self markReportUnavailable:@"The verified manager launcher could not be started."];
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSData *data = [output.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    int terminationStatus = task.terminationStatus;
    dispatch_async(dispatch_get_main_queue(), ^{
      TweakersDoctorDelegate *self = weakSelf;
      if (!self) return;
      self.busy = NO;
      if (!self.window.isVisible) {
        self.preserveStatusPresentation = NO;
        return; // The durable manager request continues; reopen obtains its latest status.
      }
      if (terminationStatus != 0 && [command isEqual:@"doctor-action"]) {
        id failedResponse = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSDictionary *failure = [failedResponse isKindOfClass:[NSDictionary class]] && [failedResponse[@"error"] isKindOfClass:[NSDictionary class]] ? failedResponse[@"error"] : nil;
        NSString *reason = StringValue(failure[@"message"], @"The manager did not return a failure reason.");
        if (reason.length > 2000) reason = [reason substringToIndex:2000];
        self.actionFailureNotice = [NSString stringWithFormat:@"Action stopped: %@ Status was reloaded; no automatic retry was made.", reason];
        self.reportStale = YES;
        [self runCommand:@"doctor-status" input:nil];
        return; // Reconcile status only. Never replay a possibly dispatched action.
      }
      if (terminationStatus != 0) {
        [self markReportUnavailable:@"The verified manager could not complete this request."];
        return;
      }
      id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      if (!IsDoctorReport(value)) {
        [self markReportUnavailable:@"The manager returned an invalid report."];
        return;
      }
      NSPoint preservedScrollOrigin = self.bodyScroll.contentView.bounds.origin;
      NSScrollView *detailScroll = self.changeDetailView.enclosingScrollView;
      NSScrollView *tableScroll = self.changeTable.enclosingScrollView;
      NSPoint preservedDetailScrollOrigin = detailScroll.contentView.bounds.origin;
      NSPoint preservedTableScrollOrigin = tableScroll.contentView.bounds.origin;
      NSPoint preservedTechnicalScrollOrigin = self.technicalReportScroll.contentView.bounds.origin;
      self.preserveStatusPresentation = NO;
      self.reportStale = NO;
      for (NSView *view in self.footerActions.arrangedSubviews) if ([view isKindOfClass:[NSButton class]] && view != self.reportCopyButton && view != self.sidebarToggle) ((NSButton *)view).title = @"Reload status";
      self.report = value;
      [self updateReportPresentation:value];
      [self sizeScrollableContent];
      [self restoreScrollView:self.bodyScroll origin:preservedScrollOrigin];
      [self restoreScrollView:detailScroll origin:preservedDetailScrollOrigin];
      [self restoreScrollView:tableScroll origin:preservedTableScrollOrigin];
      [self restoreScrollView:self.technicalReportScroll origin:preservedTechnicalScrollOrigin];
      self.activityLabel.stringValue = self.actionFailureNotice ?: @"Status refreshed.";
      self.actionFailureNotice = nil;
      [self updateButtons];
      [self scheduleRunningReviewRefresh];
    });
  });
}

- (void)updateButtons {
  if (self.report && !self.busy && !self.reportStale && ![self verifiedLauncherAvailable]) {
    [self markReportUnavailable:@"The verified manager launcher changed or is unavailable."];
    return;
  }
  NSDictionary *actionsById = [self actionsById];
  for (NSView *view in self.actionButtons) {
    if (![view isKindOfClass:[NSButton class]]) continue;
    NSButton *button = (NSButton *)view;
    if (![PrimaryDoctorActionIds() containsObject:button.identifier]) continue;
    NSDictionary *action = actionsById[button.identifier];
    if ([action[@"label"] isKindOfClass:[NSString class]]) button.title = action[@"label"];
    NSView *actionLine = button.superview;
    actionLine.hidden = self.report != nil && action == nil;
    button.enabled = !self.busy && !self.reportStale && [action[@"enabled"] isEqual:@YES];
    NSArray *blockers = [action[@"blockers"] isKindOfClass:[NSArray class]] ? action[@"blockers"] : @[];
    button.toolTip = blockers.count > 0 ? [@"Help:\n" stringByAppendingString:[blockers componentsJoinedByString:@"\n"]] : nil;
    NSTextField *inlineBlockers = self.actionBlockerLabels[button.identifier];
    inlineBlockers.hidden = actionLine.hidden || self.reportStale || [action[@"enabled"] isEqual:@YES];
    inlineBlockers.stringValue = self.reportStale ? @"Unavailable: reconnect to the verified manager before taking an action." : [button.identifier isEqual:@"update"] && action && ![action[@"enabled"] isEqual:@YES] ? ShortInstallBlockerSummary(blockers) : blockers.count > 0 ? [blockers componentsJoinedByString:@"\n"] : action ? @"This action is currently unavailable." : @"Waiting for a verified report.";
  }
  self.reportCopyButton.enabled = self.renderedReportText.length > 0;
  [self updateAdoptionButtons];
  [self sizeScrollableContent];
}

- (NSDictionary *)actionsById {
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  for (id value in self.report[@"actions"]) {
    if (![value isKindOfClass:[NSDictionary class]]) continue;
    NSString *action = value[@"id"];
    if ([DoctorActionIds() containsObject:action]) result[action] = value;
  }
  return result;
}

- (void)updateAdoptionButtons {
  NSDictionary *adoption = [self adoption];
  NSDictionary *change = [self selectedChange];
  BOOL canDecide = adoption && change && [self isActionEnabled:@"decide"];
  BOOL canObserve = adoption && change && [self isActionEnabled:@"observe"];
  NSArray<NSString *> *scope = change ? DecisionGroupsForEntry(adoption, change[@"id"]) : @[];
  BOOL requiredUnknown = NO, unacknowledgedEligibleUnknown = NO;
  for (NSDictionary *group in TechnicalGroups(adoption)) if ([scope containsObject:group[@"id"]] && [group[@"status"] isEqual:@"unknown"]) {
    NSDictionary *decision = nil; for (NSDictionary *candidate in adoption[@"decisions"]) if ([candidate[@"changeId"] isEqual:group[@"id"]]) decision = candidate;
    if (![group[@"unknownPolicy"] isEqual:@"acknowledgment"]) requiredUnknown = YES;
    else if (![decision[@"choice"] isEqual:@"acknowledge_unknown"]) unacknowledgedEligibleUnknown = YES;
  }
  self.acceptButton.enabled = canDecide && !requiredUnknown && !unacknowledgedEligibleUnknown;
  self.preserveButton.enabled = canDecide;
  BOOL isAcknowledgableUnknown = unacknowledgedEligibleUnknown;
  self.acknowledgeUnknownButton.hidden = !isAcknowledgableUnknown;
  self.acknowledgeUnknownButton.enabled = canDecide && isAcknowledgableUnknown;
  self.observeButton.enabled = canObserve && scope.count == 1;
  self.deferResumeButton.enabled = adoption && [self isActionEnabled:@"decide"];
  self.deferResumeButton.title = [adoption[@"state"] isEqual:@"deferred"] ? @"Resume Review" : @"Defer Review";
  NSDictionary *group = scope.count == 1 ? [TechnicalGroups(adoption) filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"id == %@", scope.firstObject]].firstObject : nil;
  NSArray *overrides = [group[@"overrides"] isKindOfClass:[NSArray class]] ? group[@"overrides"] : @[];
  self.overridePopup.enabled = canDecide && overrides.count > 0;
  self.overrideButton.enabled = canDecide && overrides.count > 0;
}

- (void)updateAdoptionPresentation:(NSDictionary *)adoption {
  NSString *selectedId = [self selectedChange][@"id"];
  BOOL compatibilityFirst = [self.report[@"update"][@"compatibility"] isKindOfClass:[NSDictionary class]] || IsCompatibilityWorkflowInProgress(self.report[@"update"]);
  self.evidenceDisclosure.title = compatibilityFirst ? @"Optional changelog and preservation choices" : @"Inspect analysis groups and review decisions";
  self.evidenceDisclosure.hidden = adoption == nil || ![self.selectedSection isEqual:@"updates"];
  self.adoptionBox.hidden = self.evidenceDisclosure.hidden || self.evidenceDisclosure.state != NSControlStateValueOn;
  if (adoption) {
    NSMutableArray<NSDictionary *> *reviewItems = [NSMutableArray arrayWithArray:ChangelogEntries(adoption)];
    for (NSDictionary *unresolved in adoption[@"report"][@"changelog"][@"unresolved"] ?: @[]) {
      NSString *groupId = unresolved[@"groupId"];
      for (NSDictionary *group in TechnicalGroups(adoption)) if ([group[@"id"] isEqual:groupId]) {
        NSMutableDictionary *item = [group mutableCopy];
        item[@"category"] = compatibilityFirst ? @"Optional explanation unavailable" : @"Needs review";
        item[@"workflow"] = StringValue(unresolved[@"reason"], @"Behavioral changelog evidence is incomplete.");
        item[@"_technicalGroup"] = @YES;
        [reviewItems addObject:item];
        break;
      }
    }
    self.adoptionChanges = reviewItems;
  } else self.adoptionChanges = @[];
  [self.changeTable reloadData];
  NSInteger selection = NSNotFound;
  for (NSUInteger index = 0; index < self.adoptionChanges.count; index += 1) {
    if (selectedId && [self.adoptionChanges[index][@"id"] isEqual:selectedId]) { selection = (NSInteger)index; break; }
  }
  if (selection == NSNotFound && self.adoptionChanges.count > 0) selection = 0;
  if (selection != NSNotFound) [self.changeTable selectRowIndexes:[NSIndexSet indexSetWithIndex:(NSUInteger)selection] byExtendingSelection:NO];
  [self updateSelectedChangePresentation];
}

- (void)updateSelectedChangePresentation {
  NSDictionary *adoption = [self adoption];
  NSDictionary *change = [self selectedChange];
  [self.overridePopup removeAllItems];
  if (!change || !adoption) {
    [self.overridePopup addItemWithTitle:@"No verified overrides"];
    self.changeDetailView.string = @"Select a reported change to inspect its evidence and review state.";
    [self updateAdoptionButtons];
    return;
  }
  NSArray<NSString *> *scope = DecisionGroupsForEntry(adoption, change[@"id"]);
  NSDictionary *scopeGroup = scope.count == 1 ? [TechnicalGroups(adoption) filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"id == %@", scope.firstObject]].firstObject : nil;
  NSArray *overrides = [scopeGroup[@"overrides"] isKindOfClass:[NSArray class]] ? scopeGroup[@"overrides"] : @[];
  if (overrides.count == 0) {
    [self.overridePopup addItemWithTitle:@"No verified overrides"];
  } else {
    for (NSDictionary *override in overrides) {
      [self.overridePopup addItemWithTitle:StringValue(override[@"label"], StringValue(override[@"id"], @"Verified override"))];
      self.overridePopup.lastItem.representedObject = override[@"id"];
      self.overridePopup.lastItem.toolTip = StringValue(override[@"verificationFingerprint"], nil);
    }
  }
  NSDictionary *selectedDecision = nil;
  for (NSDictionary *decision in adoption[@"decisions"]) {
    if ([scope containsObject:decision[@"changeId"]]) selectedDecision = decision;
  }
  BOOL technicalGroup = [change[@"_technicalGroup"] isEqual:@YES];
  if (!technicalGroup) {
    NSMutableArray<NSString *> *compact = [NSMutableArray arrayWithArray:@[
      StringValue(change[@"title"], @"Untitled change"),
      [NSString stringWithFormat:@"Workflow: %@", StringValue(change[@"workflow"], StringValue(change[@"area"], @"Unspecified"))],
      [NSString stringWithFormat:@"Evidence: %@ · %@", EvidenceStatusLabel(StringValue(change[@"status"], @"inferred_from_code")), [change[@"origin"] isEqual:@"upstream"] ? @"Upstream" : @"Tweakers"],
      @"", @"BEFORE", StringValue(change[@"before"], @"Not described"),
      @"", @"AFTER", StringValue(change[@"after"], @"Not described"),
    ]];
    NSArray *references = [change[@"evidenceReferences"] isKindOfClass:[NSArray class]] ? change[@"evidenceReferences"] : @[];
    NSMutableArray<NSString *> *citations = [NSMutableArray array];
    for (NSDictionary *reference in references) {
      NSString *identifier = StringValue(reference[@"id"], nil);
      if (identifier) [citations addObject:identifier];
      if (citations.count == 3) break;
    }
    if (citations.count) {
      NSString *suffix = references.count > citations.count ? [NSString stringWithFormat:@" and %lu more", (unsigned long)(references.count - citations.count)] : @"";
      [compact addObject:[NSString stringWithFormat:@"Citations: %@%@.", [citations componentsJoinedByString:@"; "], suffix]];
    } else {
      [compact addObject:@"Citations: none reported."];
    }
    NSMutableOrderedSet<NSString *> *workflowLabels = [NSMutableOrderedSet orderedSet];
    for (NSDictionary *entry in ChangelogEntries(adoption)) {
      NSArray<NSString *> *entryScope = DecisionGroupsForEntry(adoption, entry[@"id"]);
      for (NSString *groupId in entryScope) if ([scope containsObject:groupId]) {
        [workflowLabels addObject:StringValue(entry[@"title"], @"Untitled workflow")];
        break;
      }
    }
    NSArray<NSString *> *shownWorkflows = [workflowLabels.array subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)4, workflowLabels.count))];
    NSString *workflowSummary = shownWorkflows.count ? [shownWorkflows componentsJoinedByString:@"; "] : @"No other behavioral workflow labels reported";
    if (workflowLabels.count > shownWorkflows.count) workflowSummary = [workflowSummary stringByAppendingFormat:@"; and %lu more", (unsigned long)(workflowLabels.count - shownWorkflows.count)];
    [compact addObjectsFromArray:@[@"", @"COUPLED SCOPE", [NSString stringWithFormat:@"%lu analysis group%@ affect%@ %lu workflow%@: %@.", (unsigned long)scope.count, scope.count == 1 ? @"" : @"s", scope.count == 1 ? @"s" : @"", (unsigned long)workflowLabels.count, workflowLabels.count == 1 ? @"" : @"s", workflowSummary]]];
    NSArray<NSString *> *entryLimitations = [change[@"limitations"] isKindOfClass:[NSArray class]] ? change[@"limitations"] : @[];
    if (entryLimitations.count) {
      NSUInteger shown = MIN((NSUInteger)3, entryLimitations.count);
      [compact addObjectsFromArray:@[@"", @"LIMITATIONS"]];
      [compact addObjectsFromArray:[entryLimitations subarrayWithRange:NSMakeRange(0, shown)]];
      if (entryLimitations.count > shown) [compact addObject:[NSString stringWithFormat:@"%lu more limitation%@ in the technical report.", (unsigned long)(entryLimitations.count - shown), entryLimitations.count - shown == 1 ? @"" : @"s"]];
    }
    [compact addObjectsFromArray:@[@"", @"AVAILABLE DECISIONS"]];
    if ([change[@"status"] isEqual:@"unknown"]) {
      [compact addObject:[change[@"unknownPolicy"] isEqual:@"acknowledgment"] ? @"Acknowledge unknown behavior, request preservation, or defer review." : @"Request preservation or defer review until required evidence is available."];
    } else {
      [compact addObject:@"Accept this change, request preservation, or defer review."];
    }
    if (selectedDecision) {
      NSString *choice = StringValue(selectedDecision[@"choice"], @"recorded");
      NSString *overrideId = StringValue(selectedDecision[@"overrideId"], nil);
      [compact addObject:overrideId ? [NSString stringWithFormat:@"Recorded decision: %@ (%@).", choice, overrideId] : [NSString stringWithFormat:@"Recorded decision: %@.", choice]];
    }
    NSUInteger blockingUnknowns = 0;
    for (NSDictionary *group in TechnicalGroups(adoption)) if ([scope containsObject:group[@"id"]] && [group[@"status"] isEqual:@"unknown"] && ![group[@"unknownPolicy"] isEqual:@"acknowledgment"]) blockingUnknowns++;
    [compact addObjectsFromArray:@[@"", @"RELEVANT BLOCKERS", blockingUnknowns ? [NSString stringWithFormat:@"%lu coupled analysis group%@ still ha%@ blocking unknown behavior. Open the group inspector for details.", (unsigned long)blockingUnknowns, blockingUnknowns == 1 ? @"" : @"s", blockingUnknowns == 1 ? @"s" : @"ve"] : @"No blocking unknown behavior is reported in this coupled scope. Global blockers remain in Show technical report."]];
    self.changeDetailView.string = [compact componentsJoinedByString:@"\n"];
    [self updateAdoptionButtons];
    return;
  }
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithArray:@[
    StringValue(change[@"title"], @"Untitled change"),
    [NSString stringWithFormat:@"Workflow: %@", StringValue(change[@"workflow"], StringValue(change[@"area"], @"Unspecified"))],
    [change[@"_technicalGroup"] isEqual:@YES] ? @"Evidence: Static file/code evidence · Technical inventory, not a behavioral changelog claim." : [NSString stringWithFormat:@"Evidence: %@ · %@", EvidenceStatusLabel(StringValue(change[@"status"], @"inferred_from_code")), [change[@"origin"] isEqual:@"upstream"] ? @"Upstream" : @"Tweakers"],
    @"", @"BEFORE", StringValue(change[@"before"], @"Not described"),
    @"", @"AFTER", StringValue(change[@"after"], @"Not described"),
    @"", @"DECISION SCOPE", scope.count ? [NSString stringWithFormat:@"Groups affected: %@", [scope componentsJoinedByString:@", "]] : @"No usable technical group scope.",
  ]];
  NSMutableArray<NSString *> *siblings = [NSMutableArray array];
  for (NSDictionary *entry in ChangelogEntries(adoption)) {
    if ([entry[@"id"] isEqual:change[@"id"]]) continue;
    for (NSString *groupId in DecisionGroupsForEntry(adoption, entry[@"id"])) if ([scope containsObject:groupId]) { [siblings addObject:StringValue(entry[@"title"], @"Untitled entry")]; break; }
  }
  [lines addObject:siblings.count ? [NSString stringWithFormat:@"Coupled entries: %@", [siblings componentsJoinedByString:@"; "]] : @"No coupled behavioral entries."];
  NSArray *entryLimitations = [change[@"limitations"] isKindOfClass:[NSArray class]] ? change[@"limitations"] : @[];
  if (entryLimitations.count) [lines addObjectsFromArray:@[@"", @"LIMITATIONS", [entryLimitations componentsJoinedByString:@"\n"]]];
  [lines addObjectsFromArray:@[@"", @"YOUR OPTIONS"]];
  BOOL compatibilityFirst = [self.report[@"update"][@"compatibility"] isKindOfClass:[NSDictionary class]] || IsCompatibilityWorkflowInProgress(self.report[@"update"]);
  if (compatibilityFirst && [change[@"status"] isEqual:@"unknown"]) {
    [lines addObject:@"This optional explanation is unavailable. It does not block installation and the compatibility check does not send these questions to a model. Explicit preservation requests and deferrals still apply."];
  } else if ([change[@"_technicalGroup"] isEqual:@YES] && ![change[@"status"] isEqual:@"unknown"]) {
    [lines addObject:@"This is a technical analysis group, not a user-facing changelog claim. Review its linked behavioral entries before deciding."];
  } else if ([change[@"status"] isEqual:@"unknown"]) {
    [lines addObject:[change[@"unknownPolicy"] isEqual:@"acknowledgment"]
      ? @"Acknowledge unknown behavior after reviewing this evidence."
      : @"Unknown behavior is blocking: add required evidence or request preservation."];
  } else {
    [lines addObject:@"Accept the reported change or request preservation."];
  }
  [lines addObject:scope.count == 1 ? @"A manual observation is separate user-supplied evidence for this one technical group." : @"Manual observation is unavailable until this entry maps to one technical group."];
  if (overrides.count == 0) [lines addObject:@"None available."];
  for (NSDictionary *override in overrides) {
    [lines addObject:[NSString stringWithFormat:@"%@ · %@\nVerification fingerprint: %@",
      StringValue(override[@"label"], @"Verified override"), StringValue(override[@"id"], @"identifier unavailable"),
      StringValue(override[@"verificationFingerprint"], @"unavailable")]];
  }
  [lines addObjectsFromArray:@[@"", @"TECHNICAL GROUPS"]];
  for (NSDictionary *group in TechnicalGroups(adoption)) if ([scope containsObject:group[@"id"]]) {
    [lines addObject:[NSString stringWithFormat:@"%@ · %@\n%@", StringValue(group[@"id"], @"identifier unavailable"), StringValue(group[@"title"], @"Untitled group"), StringValue(group[@"explanation"][@"summary"], @"No explanation summary reported.")]];
  }
  [lines addObjectsFromArray:@[@"", @"SELECTED DECISION"]];
  if (selectedDecision) {
    NSString *decisionLine = [NSString stringWithFormat:@"Choice: %@", selectedDecision[@"choice"]];
    NSString *overrideId = StringValue(selectedDecision[@"overrideId"], nil);
    [lines addObject:overrideId ? [decisionLine stringByAppendingFormat:@" (%@)", overrideId] : decisionLine];
  } else {
    [lines addObject:@"No decision recorded."];
  }
  [lines addObjectsFromArray:@[@"", @"MANUAL OBSERVATIONS"]];
  BOOL hasObservation = NO;
  for (NSDictionary *observation in adoption[@"observations"]) {
    if (![scope containsObject:observation[@"changeId"]]) continue;
    hasObservation = YES;
    [lines addObject:[NSString stringWithFormat:@"%@ · %@\nBefore: %@\nAfter: %@\nConditions: %@",
      StringValue(observation[@"outcome"], @"unknown"), StringValue(observation[@"recordedAt"], @"time unavailable"),
      StringValue(observation[@"before"], @""), StringValue(observation[@"after"], @""),
      StringValue(observation[@"conditions"], @"")]];
  }
  if (!hasObservation) [lines addObject:@"None recorded by the user."];
  NSDictionary *changeReport = adoption[@"report"];
  NSDictionary *coverage = changeReport[@"coverage"];
  [lines addObjectsFromArray:@[
    @"", @"REPORT COVERAGE",
    [NSString stringWithFormat:@"%@ total · %@ classified · %@ unresolved", coverage[@"total"], coverage[@"classified"], coverage[@"unresolved"]],
    @"", @"REPORT LIMITATIONS",
  ]];
  [lines addObjectsFromArray:UpdaterEvidenceLines(changeReport)];
  NSArray *limitations = changeReport[@"limitations"];
  [lines addObjectsFromArray:limitations.count > 0 ? limitations : @[@"None reported."]];
  [lines addObjectsFromArray:@[@"", @"ADOPTION BLOCKERS"]];
  NSArray *blockers = adoption[@"blockers"];
  [lines addObjectsFromArray:blockers.count > 0 ? blockers : @[@"None reported."]];
  self.changeDetailView.string = [lines componentsJoinedByString:@"\n"];
  [self updateAdoptionButtons];
}

- (NSView *)sectionWithTitle:(NSString *)title lines:(NSArray<NSString *> *)lines {
  NSBox *box = [[NSBox alloc] initWithFrame:NSZeroRect];
  box.boxType = NSBoxCustom;
  box.borderWidth = 1;
  box.borderColor = NSColor.separatorColor;
  box.cornerRadius = 8;
  box.fillColor = NSColor.controlBackgroundColor;
  box.titlePosition = NSNoTitle;
  NSStackView *content = [NSStackView stackViewWithViews:@[]];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 5;
  content.edgeInsets = NSEdgeInsetsMake(16, 16, 16, 16);
  content.translatesAutoresizingMaskIntoConstraints = NO;
  NSTextField *heading = [NSTextField labelWithString:title];
  heading.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  [content addArrangedSubview:heading];
  for (NSString *line in lines) {
    NSTextField *label = [NSTextField wrappingLabelWithString:line];
    label.textColor = NSColor.secondaryLabelColor;
    label.font = [NSFont systemFontOfSize:13];
    [content addArrangedSubview:label];
    [label.widthAnchor constraintEqualToAnchor:content.widthAnchor constant:-32].active = YES;
  }
  [box.contentView addSubview:content];
  [NSLayoutConstraint activateConstraints:@[
    [content.leadingAnchor constraintEqualToAnchor:box.contentView.leadingAnchor],
    [content.trailingAnchor constraintEqualToAnchor:box.contentView.trailingAnchor],
    [content.topAnchor constraintEqualToAnchor:box.contentView.topAnchor],
    [content.bottomAnchor constraintEqualToAnchor:box.contentView.bottomAnchor],
  ]];
  return box;
}

- (NSView *)statusCardWithTitle:(NSString *)title status:(NSString *)status symbol:(NSString *)symbol lines:(NSArray<NSString *> *)lines {
  NSBox *card = (NSBox *)[self sectionWithTitle:title lines:lines];
  NSStackView *content = card.contentView.subviews.firstObject;
  NSImageView *icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
  icon.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:status];
  icon.contentTintColor = [status isEqual:@"Healthy"] || [status isEqual:@"Compatible"] ? NSColor.systemGreenColor : NSColor.systemOrangeColor;
  [icon.widthAnchor constraintEqualToConstant:16].active = YES;
  [icon.heightAnchor constraintEqualToConstant:16].active = YES;
  NSTextField *label = [NSTextField labelWithString:status];
  label.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  NSStackView *row = [NSStackView stackViewWithViews:@[icon, label]];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.spacing = 8;
  [content insertArrangedSubview:row atIndex:MIN(1, content.arrangedSubviews.count)];
  return card;
}

- (void)selectChangelogEntry:(NSButton *)sender {
  [self selectSection:@"updates"];
  self.evidenceDisclosure.state = NSControlStateValueOn;
  self.adoptionBox.hidden = NO;
  for (NSUInteger index = 0; index < self.adoptionChanges.count; index += 1) if ([self.adoptionChanges[index][@"id"] isEqual:sender.identifier]) {
    [self.changeTable selectRowIndexes:[NSIndexSet indexSetWithIndex:index] byExtendingSelection:NO];
    [self updateSelectedChangePresentation];
    break;
  }
  [self sizeScrollableContent];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self revealSelectedChangeDetail];
  });
}

- (NSView *)changelogEntryRow:(NSDictionary *)entry {
  NSStackView *row = [NSStackView stackViewWithViews:@[]];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.alignment = NSLayoutAttributeTop;
  row.spacing = 12;
  row.edgeInsets = NSEdgeInsetsMake(8, 0, 8, 0);
  row.translatesAutoresizingMaskIntoConstraints = NO;
  NSStackView *copy = [NSStackView stackViewWithViews:@[]];
  copy.orientation = NSUserInterfaceLayoutOrientationVertical;
  copy.alignment = NSLayoutAttributeLeading;
  copy.spacing = 3;
  copy.translatesAutoresizingMaskIntoConstraints = NO;
  NSTextField *title = [NSTextField wrappingLabelWithString:StringValue(entry[@"title"], @"Update")];
  title.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  NSString *after = StringValue(entry[@"after"], @"");
  NSTextField *summary = [NSTextField wrappingLabelWithString:after.length ? after : StringValue(entry[@"workflow"], @"Review the update details.")];
  summary.font = [NSFont systemFontOfSize:12]; summary.textColor = NSColor.secondaryLabelColor;
  NSTextField *evidence = [NSTextField labelWithString:EvidenceStatusLabel(entry[@"status"])];
  evidence.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium]; evidence.textColor = NSColor.secondaryLabelColor;
  [copy addArrangedSubview:title]; [copy addArrangedSubview:summary]; [copy addArrangedSubview:evidence];
  NSButton *review = [NSButton buttonWithTitle:@"Review" target:self action:@selector(selectChangelogEntry:)];
  review.identifier = entry[@"id"]; review.bezelStyle = NSBezelStyleRounded;
  [row addArrangedSubview:copy]; [row addArrangedSubview:review];
  [NSLayoutConstraint activateConstraints:@[
    [copy.widthAnchor constraintLessThanOrEqualToAnchor:row.widthAnchor constant:-96],
    [title.widthAnchor constraintEqualToAnchor:copy.widthAnchor],
    [summary.widthAnchor constraintEqualToAnchor:copy.widthAnchor],
    [review.widthAnchor constraintGreaterThanOrEqualToConstant:64],
  ]];
  return row;
}

- (NSView *)changelogSection:(NSDictionary *)adoption fallbackLines:(NSArray<NSString *> *)fallbackLines {
  BOOL compatibilityFirst = [self.report[@"update"][@"compatibility"] isKindOfClass:[NSDictionary class]] || IsCompatibilityWorkflowInProgress(self.report[@"update"]);
  NSBox *box = (NSBox *)[self sectionWithTitle:compatibilityFirst ? @"Optional changelog and preservation choices" : @"What’s new" lines:@[]];
  NSStackView *content = [box.contentView.subviews.firstObject isKindOfClass:[NSStackView class]] ? box.contentView.subviews.firstObject : nil;
  if (!adoption || ![adoption[@"report"][@"changelog"] isKindOfClass:[NSDictionary class]]) {
    for (NSString *line in fallbackLines) [content addArrangedSubview:[NSTextField wrappingLabelWithString:line]];
    return box;
  }
  for (NSString *category in @[@"Added", @"Changed", @"Fixed", @"Removed", @"Deprecated", @"Security"]) {
    NSArray *entries = [ChangelogEntries(adoption) filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"category == %@", category]];
    if (!entries.count) continue;
    NSTextField *heading = [NSTextField labelWithString:category]; heading.font = [NSFont systemFontOfSize:12 weight:NSFontWeightSemibold]; [content addArrangedSubview:heading];
    for (NSDictionary *entry in entries) {
      NSView *row = [self changelogEntryRow:entry];
      [content addArrangedSubview:row];
      [row.widthAnchor constraintEqualToAnchor:content.widthAnchor constant:-32].active = YES;
    }
  }
  NSArray *unresolved = adoption[@"report"][@"changelog"][@"unresolved"];
  if (unresolved.count) {
    NSArray *entries = ChangelogEntries(adoption);
    if (compatibilityFirst) [content addArrangedSubview:[NSTextField wrappingLabelWithString:@"Optional source explanations are incomplete. They do not block installation, and update checks do not request these explanations from a model."]];
    else [content addArrangedSubview:[NSTextField wrappingLabelWithString:[NSString stringWithFormat:@"%lu supported changelog entr%@ ready. %lu technical area%@ still pending. Open Inspect analysis groups and review decisions for the evidence and next action.", (unsigned long)entries.count, entries.count == 1 ? @"y is" : @"ies are", (unsigned long)unresolved.count, unresolved.count == 1 ? @" is" : @"s are"]]];
  }
  return box;
}

- (void)updateReportPresentation:(NSDictionary *)report {
  NSString *formatted = [self formattedReport:report];
  NSString *presentationKey = [NSString stringWithFormat:@"%@|%@|%@|%d", StringValue(report[@"fingerprint"], @""), StringValue(report[@"generatedAt"], @""), formatted, self.reportStale];
  if ([presentationKey isEqual:self.renderedPresentationKey]) return;
  self.renderedPresentationKey = presentationKey;
  if (![formatted isEqual:self.renderedReportText]) {
    self.renderedReportText = formatted;
    self.reportView.string = formatted;
    [self updateAdoptionPresentation:[report[@"adoption"] isKindOfClass:[NSDictionary class]] ? report[@"adoption"] : nil];
  }
  [self presentSectionReport:report];
}

- (void)addNavigation:(NSString *)title destination:(NSString *)destination toCard:(NSView *)card {
  NSView *first = [card isKindOfClass:[NSBox class]] ? ((NSBox *)card).contentView.subviews.firstObject : card.subviews.firstObject;
  NSStackView *content = [first isKindOfClass:[NSStackView class]] ? (NSStackView *)first : nil;
  if (!content) return;
  NSButton *button = [NSButton buttonWithTitle:title target:self action:@selector(selectSectionFromButton:)];
  button.identifier = destination;
  button.font = [NSFont systemFontOfSize:13];
  [content addArrangedSubview:button];
}

- (NSButton *)buttonWithIdentifier:(NSString *)identifier inside:(NSView *)view {
  if ([view isKindOfClass:[NSButton class]] && [view.identifier isEqual:identifier]) return (NSButton *)view;
  for (NSView *child in view.subviews) {
    NSButton *match = [self buttonWithIdentifier:identifier inside:child];
    if (match) return match;
  }
  return nil;
}

- (void)presentSectionReport:(NSDictionary *)report {
  [self updateAdoptionPresentation:[report[@"adoption"] isKindOfClass:[NSDictionary class]] ? report[@"adoption"] : nil];
  NSString *focusedIdentifier = nil;
  NSResponder *firstResponder = self.window.firstResponder;
  if ([firstResponder isKindOfClass:[NSButton class]]) {
    NSView *ancestor = (NSView *)firstResponder;
    while (ancestor && ancestor != self.reportStack) ancestor = ancestor.superview;
    if (ancestor == self.reportStack) focusedIdentifier = [(NSButton *)firstResponder identifier];
  }
  for (NSView *view in [self.reportStack.arrangedSubviews copy]) {
    [self.reportStack removeArrangedSubview:view];
    [view removeFromSuperview];
  }
  NSDictionary *target = report[@"target"];
  NSDictionary *health = report[@"health"];
  NSDictionary *update = report[@"update"];
  NSArray<NSString *> *targetLines = @[
    [NSString stringWithFormat:@"Installed Tweakers  %@", VersionAndBuild(target, @"version", @"build")],
    [NSString stringWithFormat:@"Official app  %@", VersionAndBuild(target, @"nativeVersion", @"nativeBuild")],
    @"Your working installation stays in place until you approve an update.",
  ];
  NSArray<NSString *> *healthLines = @[
    HealthStateLabel(StringValue(health[@"state"], @"unknown")),
    [StringValue(health[@"broker"], @"unknown") isEqual:@"not_running"] ? ([ReportAction(report, @"retry")[@"enabled"] isEqual:@YES] ? @"The app connection is not running. Retry Tweakers is available." : @"The app connection is not running. Retry Tweakers is blocked; review the reported findings first.") : @"App health and update approval are checked separately.",
  ];
  NSMutableArray<NSString *> *updateLines = [NSMutableArray arrayWithArray:@[
    UpdateStateLabel(update),
  ]];
  NSDictionary *usage = [update[@"usage"] isKindOfClass:[NSDictionary class]] ? update[@"usage"] : nil;
  NSDictionary *usageDetails = [update[@"usageDetails"] isKindOfClass:[NSDictionary class]] ? update[@"usageDetails"] : nil;
  NSDictionary *reviewProgress = [update[@"review"] isKindOfClass:[NSDictionary class]] ? update[@"review"] : nil;
  NSDictionary *compatibility = [update[@"compatibility"] isKindOfClass:[NSDictionary class]] ? update[@"compatibility"] : nil;
  BOOL compatibilityWorkflow = compatibility || IsCompatibilityWorkflowInProgress(update);
  BOOL running = [update[@"execution"][@"status"] isEqual:@"running"];
  NSString *progress = StringValue(update[@"progress"], nil);
  if (progress.length) [updateLines addObject:progress];
  if (!compatibilityWorkflow && reviewProgress) {
    NSDictionary *files = reviewProgress[@"files"], *questions = reviewProgress[@"questions"];
    [updateLines addObject:[NSString stringWithFormat:@"Review: %@ · files %@/%@ · questions %@/%@ (%@ reused) · %@ entries · %@ limitations.",
      StringValue(reviewProgress[@"stage"], @"unknown"), files[@"accounted"] ?: @"unknown", files[@"total"] ?: @"unknown",
      questions[@"completed"] ?: @"unknown", questions[@"total"] ?: @"unknown", questions[@"reused"] ?: @"unknown",
      reviewProgress[@"entries"] ?: @"unknown", reviewProgress[@"limitations"] ?: @"unknown"]];
    NSDictionary *pause = [reviewProgress[@"pause"] isKindOfClass:[NSDictionary class]] ? reviewProgress[@"pause"] : nil;
    if (pause) [updateLines addObject:[NSString stringWithFormat:@"Review paused: %@\nNext: %@", StringValue(pause[@"message"], @"Review action is required."), PauseActionLabel(pause[@"action"])]];
  }
  if (compatibilityWorkflow) [updateLines addObjectsFromArray:CompatibilityLines(compatibility, update)];
  if (usage && running && [usage[@"inputTokens"] isEqual:@0] && [usage[@"outputTokens"] isEqual:@0] && [usageDetails[@"requests"] count] > 0) [updateLines addObject:@"No model usage has been recorded for the current running pass. The paired review ledger records earlier requests."];
  else if (usage) [updateLines addObject:[NSString stringWithFormat:@"This review run used %@ input / %@ output tokens. This is usage, not remaining allowance.", usage[@"inputTokens"] ?: @"unknown", usage[@"outputTokens"] ?: @"unknown"]];
  NSArray *requests = usageDetails[@"requests"];
  if ([requests isKindOfClass:[NSArray class]]) {
    long long input = 0, output = 0; NSUInteger missing = 0;
    for (NSDictionary *request in requests) {
      id requestInput = request[@"inputTokens"], requestOutput = request[@"outputTokens"];
      if ([requestInput isKindOfClass:[NSNumber class]]) input += [requestInput longLongValue];
      if ([requestOutput isKindOfClass:[NSNumber class]]) output += [requestOutput longLongValue];
      if (![requestInput isKindOfClass:[NSNumber class]] || ![requestOutput isKindOfClass:[NSNumber class]]) missing++;
    }
    [updateLines addObject:[NSString stringWithFormat:@"Paired review ledger: %lu requests · known subtotal %lld input / %lld output tokens%@. The ledger does not state remaining allowance.", (unsigned long)requests.count, input, output, missing ? [NSString stringWithFormat:@" · %lu request%@ missing usage values", (unsigned long)missing, missing == 1 ? @"" : @"s"] : @""]];
  }
  NSDictionary *sourceVersions = [self adoption][@"report"][@"sourceVersions"];
  if ([sourceVersions isKindOfClass:[NSDictionary class]]) [updateLines addObject:[NSString stringWithFormat:@"Review comparison: Installed %@ → candidate %@.", VersionAndBuild(sourceVersions[@"before"], @"version", @"build"), VersionAndBuild(sourceVersions[@"after"], @"version", @"build")]];
  if ([self adoption]) [updateLines addObject:[NSString stringWithFormat:@"Adoption state: %@", StringValue([self adoption][@"state"], @"unknown")]];
  [updateLines addObject:[NSString stringWithFormat:@"Report freshness: %@", StringValue(report[@"generatedAt"], @"unavailable")]];
  NSMutableArray<NSString *> *changelogLines = [NSMutableArray array];
  NSMutableOrderedSet<NSString *> *attentionLines = [NSMutableOrderedSet orderedSet];
  if (![health[@"state"] isEqual:@"healthy"]) [attentionLines addObject:[NSString stringWithFormat:@"App health: %@", HealthStateLabel(StringValue(health[@"state"], @"unknown"))]];
  for (NSDictionary *finding in report[@"findings"]) {
    if (![finding isKindOfClass:[NSDictionary class]] || [finding[@"severity"] isEqual:@"info"]) continue;
    [attentionLines addObject:FindingSummary(finding)];
  }
  if (!compatibilityWorkflow && reviewProgress[@"pause"]) [attentionLines addObject:[NSString stringWithFormat:@"Review: %@", StringValue(reviewProgress[@"pause"][@"message"], @"Action is required.")]];
  NSDictionary *adoption = [self adoption];
  NSDictionary *log = adoption[@"report"][@"changelog"];
  if (compatibilityWorkflow) {
    [changelogLines addObject:@"Optional changelog and preservation choices remain available in Evidence review. Compatibility determines whether this candidate can install."];
  } else if (running) {
    [changelogLines addObject:@"Review preparation is running. Behavioral changes will appear when the current review finishes."];
  } else if (![log isKindOfClass:[NSDictionary class]]) {
    [changelogLines addObject:UnpublishedChangelogMessage(update)];
  } else {
    for (NSString *category in @[@"Added", @"Changed", @"Fixed", @"Removed", @"Deprecated", @"Security"]) {
      (void)category;
    }
    NSArray *unresolved = log[@"unresolved"];
    if (unresolved.count) [changelogLines addObject:[NSString stringWithFormat:@"%lu supported changelog entr%@ ready. %lu technical area%@ still pending; select an item in Evidence review for its reason and next action.", (unsigned long)ChangelogEntries(adoption).count, ChangelogEntries(adoption).count == 1 ? @"y is" : @"ies are", (unsigned long)unresolved.count, unresolved.count == 1 ? @" is" : @"s are"]];
    if (changelogLines.count == 0) [changelogLines addObject:[adoption[@"state"] isEqual:@"review_required"] ? @"No behavioral entries are ready because the review still needs behavioral explanations. Open evidence review, resolve its listed gaps, then continue." : @"No validated behavioral changes were reported."];
  }
  if (!compatibilityWorkflow) [changelogLines addObject:@"Optional explanations do not establish compatibility. The update status above shows the required verification result."];
  for (NSDictionary *action in report[@"actions"]) {
    if ([action[@"id"] isEqual:@"update"] && ![action[@"enabled"] boolValue]) {
      NSArray *reasons = [action[@"blockers"] isKindOfClass:[NSArray class]] ? action[@"blockers"] : @[];
      if (reasons.count) [updateLines addObject:[NSString stringWithFormat:@"Before installation: %@", [reasons componentsJoinedByString:@"; "]]];
    }
  }
  [NSLayoutConstraint deactivateConstraints:self.summaryWidths ?: @[]];
  self.summaryWidths = nil;
  NSDictionary *presentation = @{@"report": report, @"adoption": adoption ?: @{},
    @"target": targetLines, @"health": healthLines, @"update": updateLines,
    @"changelog": changelogLines, @"attention": attentionLines.array};
  NSArray<NSView *> *cards = [self.sectionControllers[self.selectedSection] cardsForHost:self presentation:presentation];
  for (NSView *card in cards) {
    [self.reportStack addArrangedSubview:card];
    [card.widthAnchor constraintEqualToAnchor:self.reportStack.widthAnchor].active = YES;
  }
  if (focusedIdentifier) {
    NSButton *replacement = [self buttonWithIdentifier:focusedIdentifier inside:self.reportStack];
    if (!replacement) for (NSButton *navigation in self.sectionButtons) if ([navigation.identifier isEqual:self.selectedSection]) replacement = navigation;
    if (replacement) [self.window makeFirstResponder:replacement];
  }
  self.freshnessLabel.hidden = !self.reportStale;
  self.freshnessLabel.stringValue = self.reportStale ? [NSString stringWithFormat:@"Live status is unavailable. Last successful report: %@. Actions are disabled. Choose Reload status, or Copy Report for the saved evidence.", StringValue(self.report[@"generatedAt"], @"unknown")] : @"";
  [self sizeScrollableContent];
}

- (NSString *)formattedReport:(NSDictionary *)report {
  NSDictionary *target = report[@"target"];
  NSDictionary *health = report[@"health"];
  NSDictionary *update = report[@"update"];
  NSMutableArray<NSString *> *lines = [NSMutableArray arrayWithArray:@[
    @"TARGET",
    [NSString stringWithFormat:@"Tweakers app: %@", StringValue(target[@"appPath"], @"Not available")],
    [NSString stringWithFormat:@"Tweakers version: %@", VersionAndBuild(target, @"version", @"build")],
    [NSString stringWithFormat:@"Runtime root: %@", StringValue(target[@"runtimeRoot"], @"Not available")],
    [NSString stringWithFormat:@"Broker root: %@", StringValue(target[@"brokerRoot"], @"Not available")],
    [NSString stringWithFormat:@"Native app: %@", StringValue(target[@"nativeAppPath"], @"Not available")],
    [NSString stringWithFormat:@"Native version: %@", VersionAndBuild(target, @"nativeVersion", @"nativeBuild")],
    @"",
    @"CURRENT HEALTH",
    [NSString stringWithFormat:@"Status: %@", HealthStateLabel(StringValue(health[@"state"], @"unknown"))],
    [NSString stringWithFormat:@"Broker: %@", StringValue(health[@"broker"], @"unknown")],
    @"",
    @"UPDATE READINESS",
    [NSString stringWithFormat:@"Status: %@", UpdateStateLabel(update)],
    [NSString stringWithFormat:@"Progress: %@", StringValue(update[@"progress"], @"No update work is running.")],
  ]];
  NSString *candidateId = StringValue(update[@"candidateId"], nil);
  if (candidateId) [lines addObject:[NSString stringWithFormat:@"Candidate: %@", candidateId]];
  NSDictionary *usage = [update[@"usage"] isKindOfClass:[NSDictionary class]] ? update[@"usage"] : nil;
  if (usage && [update[@"execution"][@"status"] isEqual:@"running"] && [usage[@"inputTokens"] isEqual:@0] && [usage[@"outputTokens"] isEqual:@0] && [update[@"usageDetails"][@"requests"] count] > 0) [lines addObject:@"Review usage: no model usage recorded yet for the current running pass; see paired ledger for earlier requests."];
  else if (usage) [lines addObject:[NSString stringWithFormat:@"Review usage: %@ input tokens, %@ output tokens", usage[@"inputTokens"] ?: @"unavailable", usage[@"outputTokens"] ?: @"unavailable"]];
  [lines addObjectsFromArray:UsageDetailsLines(update[@"usageDetails"])];
  NSDictionary *execution = [update[@"execution"] isKindOfClass:[NSDictionary class]] ? update[@"execution"] : nil;
  if (execution) [lines addObject:[NSString stringWithFormat:@"Execution: %@ (%@); %@", StringValue(execution[@"status"], @"unknown"), StringValue(execution[@"trigger"], @"manual"), [execution[@"recoverable"] isEqual:@YES] ? @"recovery is available" : @"recovery is unavailable"]];
  for (NSArray<NSString *> *fingerprint in @[
    @[@"Source fingerprint", @"sourceFingerprint"],
    @[@"Tweakers fingerprint", @"tweakersFingerprint"],
    @[@"Candidate fingerprint", @"candidateFingerprint"],
    @[@"Review fingerprint", @"reviewFingerprint"],
  ]) {
    NSString *value = StringValue(update[fingerprint[1]], nil);
    if (value) [lines addObject:[NSString stringWithFormat:@"%@: %@", fingerprint[0], value]];
  }

  NSMutableArray<NSDictionary *> *installationFindings = [NSMutableArray array];
  NSMutableArray<NSDictionary *> *compatibilityFindings = [NSMutableArray array];
  NSArray *findings = report[@"findings"];
  for (NSDictionary *finding in findings) {
    if (![finding isKindOfClass:[NSDictionary class]]) continue;
    [(IsCompatibilityFinding(finding) ? compatibilityFindings : installationFindings) addObject:finding];
  }
  [lines addObjectsFromArray:@[@"", @"CURRENT INSTALLATION FINDINGS"]];
  if (installationFindings.count == 0) {
    [lines addObject:@"No current installation findings. The installed Tweakers app passed its current health checks."];
  }
  for (NSDictionary *finding in installationFindings) [lines addObject:FindingSummary(finding)];

  [lines addObjectsFromArray:@[@"", @"COMPATIBILITY AND CANDIDATE FINDINGS"]];
  if (compatibilityFindings.count == 0) [lines addObject:CompatibilityEmptyMessage(update)];
  for (NSDictionary *finding in compatibilityFindings) {
    [lines addObject:FindingSummary(finding)];
  }

  NSDictionary *adoption = [report[@"adoption"] isKindOfClass:[NSDictionary class]] ? report[@"adoption"] : nil;
  if (adoption) {
    NSDictionary *changeReport = adoption[@"report"];
    NSDictionary *coverage = changeReport[@"coverage"];
    [lines addObjectsFromArray:@[
      @"", @"UPDATE CHANGES",
      [NSString stringWithFormat:@"Review state: %@", StringValue(adoption[@"state"], @"unknown")],
      [NSString stringWithFormat:@"Coverage: %@ total, %@ classified, %@ unresolved", coverage[@"total"], coverage[@"classified"], coverage[@"unresolved"]],
      [NSString stringWithFormat:@"Report fingerprint: %@", StringValue(changeReport[@"fingerprint"], @"unavailable")],
    ]];
    [lines addObjectsFromArray:UpdaterEvidenceLines(changeReport)];
  NSArray *limitations = changeReport[@"limitations"];
    [lines addObject:@"Limitations:"];
    if (limitations.count == 0) [lines addObject:@"  None reported."];
    for (NSString *limitation in limitations) [lines addObject:[NSString stringWithFormat:@"  %@", limitation]];
    NSArray *adoptionBlockers = adoption[@"blockers"];
    [lines addObject:@"Adoption blockers:"];
    if (adoptionBlockers.count == 0) [lines addObject:@"  None reported."];
    for (NSString *blocker in adoptionBlockers) [lines addObject:[NSString stringWithFormat:@"  %@", blocker]];

    for (NSDictionary *change in changeReport[@"changes"]) {
      [lines addObjectsFromArray:@[
        @"",
        [NSString stringWithFormat:@"Technical analysis group: %@", StringValue(change[@"title"], @"Untitled change")],
        [NSString stringWithFormat:@"Area: %@", StringValue(change[@"area"], @"Unspecified")],
        [NSString stringWithFormat:@"Before: %@", StringValue(change[@"before"], @"Not described")],
        [NSString stringWithFormat:@"After: %@", StringValue(change[@"after"], @"Not described")],
        [NSString stringWithFormat:@"Dependencies: %@", [change[@"dependencies"] count] > 0 ? [change[@"dependencies"] componentsJoinedByString:@"; "] : @"None reported"],
        [NSString stringWithFormat:@"Compatibility: %@", [change[@"compatibility"] count] > 0 ? [change[@"compatibility"] componentsJoinedByString:@"; "] : @"No notes reported"],
      ]];
      NSDictionary *explanation = [change[@"explanation"] isKindOfClass:[NSDictionary class]] ? change[@"explanation"] : nil;
      if (explanation) {
        [lines addObject:[NSString stringWithFormat:@"Explanation: %@", StringValue(explanation[@"summary"], @"No explanation summary reported")]];
        for (NSDictionary *reference in explanation[@"evidenceReferences"]) {
          [lines addObject:[NSString stringWithFormat:@"Explanation evidence: %@ · %@", StringValue(reference[@"id"], @"identifier unavailable"), StringValue(reference[@"sha256"], @"hash unavailable")]];
        }
        for (NSDictionary *reference in explanation[@"sourceReferences"]) {
          [lines addObject:[NSString stringWithFormat:@"Explanation source: %@ · %@", StringValue(reference[@"path"], @"path unavailable"), StringValue(reference[@"sha256"], @"hash unavailable")]];
        }
      }
      for (NSDictionary *evidence in change[@"evidence"]) {
        [lines addObject:[NSString stringWithFormat:@"Static file/code evidence: %@ · %@ · %@ (before %@, after %@)",
          StringValue(evidence[@"artifact"], @"Artifact"), StringValue(evidence[@"path"], @"Path unavailable"),
          StringValue(evidence[@"detail"], @"No detail"), StringValue(evidence[@"beforeSha256"], @"unavailable"),
          StringValue(evidence[@"afterSha256"], @"unavailable")]];
      }
      NSDictionary *selectedDecision = nil;
      for (NSDictionary *decision in adoption[@"decisions"]) {
        if ([decision[@"changeId"] isEqual:change[@"id"]]) selectedDecision = decision;
      }
      if (selectedDecision) {
        NSString *overrideId = StringValue(selectedDecision[@"overrideId"], nil);
        [lines addObject:[NSString stringWithFormat:@"Decision: %@%@", selectedDecision[@"choice"],
          overrideId ? [NSString stringWithFormat:@" (%@)", overrideId] : @""]];
      } else {
        [lines addObject:@"Decision: not selected"];
      }
      for (NSDictionary *observation in adoption[@"observations"]) {
        if (![observation[@"changeId"] isEqual:change[@"id"]]) continue;
        [lines addObject:[NSString stringWithFormat:@"Manual observation: %@ · before %@ · after %@ · conditions %@",
          observation[@"outcome"], observation[@"before"], observation[@"after"], observation[@"conditions"]]];
      }
    }
  }

  [lines addObjectsFromArray:@[@"", @"ACTIONS AND BLOCKERS"]];
  for (NSDictionary *action in report[@"actions"]) {
    if (![action isKindOfClass:[NSDictionary class]]) continue;
    BOOL enabled = [action[@"enabled"] isEqual:@YES];
    [lines addObject:[NSString stringWithFormat:@"%@: %@", StringValue(action[@"label"], StringValue(action[@"id"], @"Action")), enabled ? @"available" : @"blocked"]];
    NSArray *blockers = [action[@"blockers"] isKindOfClass:[NSArray class]] ? action[@"blockers"] : @[];
    for (id blocker in blockers) if ([blocker isKindOfClass:[NSString class]]) [lines addObject:[NSString stringWithFormat:@"  %@", blocker]];
  }
  NSString *handoff = StringValue(update[@"handoff"], nil);
  if (handoff && ![update[@"execution"][@"status"] isEqual:@"running"]) [lines addObjectsFromArray:@[@"", @"HANDOFF", handoff]];
  return [lines componentsJoinedByString:@"\n"];
}

@end

static NSString *ValidatedLauncherPath(int argc, const char *argv[]) {
  if ((argc != 2 && argc != 4) || argv[1] == nullptr) return nil;
  if (argc == 4 && (argv[2] == nullptr || strcmp(argv[2], "--section") != 0 || argv[3] == nullptr
      || !IsManagerSection([NSString stringWithUTF8String:argv[3]]))) return nil;
  NSString *path = [NSString stringWithUTF8String:argv[1]];
  if (![path isAbsolutePath]) return nil;
  NSString *standardized = path.stringByStandardizingPath;
  BOOL directory = NO;
  if (![NSFileManager.defaultManager fileExistsAtPath:standardized isDirectory:&directory]
      || directory
      || ![NSFileManager.defaultManager isExecutableFileAtPath:standardized]) return nil;
  return standardized;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *launcherPath = ValidatedLauncherPath(argc, argv);
    if (!launcherPath) {
      fprintf(stderr, "usage: tweakers_doctor /absolute/path/to/verified-manager-launcher [--section overview|updates|doctor]\n");
      return 64;
    }
    NSString *section = argc == 4 ? [NSString stringWithUTF8String:argv[3]] : @"doctor";
    if (!AcquireDoctorInstanceLock(launcherPath, section)) return 0;
    CloseOlderDoctorProcesses();
    NSApplication *application = NSApplication.sharedApplication;
    application.activationPolicy = NSApplicationActivationPolicyRegular;
    TweakersDoctorDelegate *delegate = [[TweakersDoctorDelegate alloc] initWithLauncherPath:launcherPath section:section];
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
