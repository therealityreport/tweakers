import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { DoctorChangeReportV1, DoctorChangeV1 } from "@therealityreport/tweakers-sdk";
import type { DoctorSourceComparison, DoctorSourceEvidence, DoctorSourceSha256 } from "./doctor-evidence.js";
import { DOCTOR_CHECK_OWNERS, prepareDoctorGroupedReviewPlan, reviewDigest } from "./doctor-review-plan.js";
import type { DoctorValidationReport } from "./doctor-validation.js";
import { changeReportFingerprint } from "./doctor-adoption.js";
import { changelogEntryId } from "./doctor-changelog.js";
import {
  revalidateStoredDoctorSourceReview,
  reviewDoctorSourceChanges,
  runDoctorSourceReview,
  setDoctorSourceReviewDependenciesForTest,
} from "./doctor-review.js";

test("review runs Codex read-only with exact source hashes and reports observed usage", async () => {
  const fixture = createFixture();
  let invoked = false;
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(command, args, options) {
      invoked = true;
      assert.equal(command, fixture.reviewerBinary);
      assert.deepEqual(args.slice(0, 6), ["exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--json"]);
      assert.ok(args.includes("--skip-git-repo-check"));
      assert.ok(args.includes("--output-schema"));
      assert.ok(args.includes("--output-last-message"));
      assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), ["--model", "gpt-review", "-c", "model_reasoning_effort=\"high\""]);
      assert.equal(options.cwd, fixture.packet);
      assert.equal(options.env.HOME, process.env.HOME ?? homedir(), "review must retain a usable authentication home");
      assert.equal(options.env.CODEX_HOME, process.env.CODEX_HOME, "explicit CODEX_HOME authentication context must be inherited");
      assert.equal(options.env.PATH, process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", "review must retain a usable command path");
      assert.equal(options.timeout, 20 * 60 * 1_000);
      assert.equal(options.maxBuffer, 4 * 1024 * 1024);
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as { targets: Array<Record<string, unknown>>; changedSourceExcerpts: Array<Record<string, unknown>> };
      const target = packet.targets[0]!;
      assert.equal(target.beforeSha256, fixture.beforeHash);
      assert.equal(target.afterSha256, fixture.afterHash);
      assert.ok(packet.changedSourceExcerpts.every((entry) => entry.state === "complete"));
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "compatible",
        dispositions: [{
          changeId: target.changeId,
          artifact: target.artifact,
          path: target.path,
          change: target.change,
          beforeSha256: target.beforeSha256,
          afterSha256: target.afterSha256,
          disposition: "compatible",
          summary: "The package identity input remains compatible.",
          proposedFixes: [],
          requiredChecks: ["asar-integrity-and-package-identity"],
        }],
        handoff: null,
      }));
      return { status: 0, stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 321, output_tokens: 45 } })}\n` };
    },
  });
  try {
    const result = await reviewLegacyPacket(reviewInput(fixture));
    assert.equal(invoked, true);
    assert.equal(result.state, "compatible");
    assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 45 });
    assert.match(result.fingerprint, /^sha256:[a-f0-9]{64}$/);
  } finally { restore(); fixture.cleanup(); }
});

test("incomplete or unresolved evidence blocks review before process launch", async () => {
  const fixture = createFixture();
  let invoked = false;
  const restore = setDoctorSourceReviewDependenciesForTest({ run() { invoked = true; return { status: 0 }; } });
  try {
    fixture.before.complete = false;
    fixture.before.unresolvedEvidence = ["schema-generation_failed:offline"];
    const result = await reviewLegacyPacket(reviewInput(fixture));
    assert.equal(invoked, false);
    assert.equal(result.state, "review_required");
    assert.match(result.summary, /Complete before, after, and comparison evidence/);
  } finally { restore(); fixture.cleanup(); }
});

test("complete unclassified changes reach review but cannot be accepted as compatible", async () => {
  const fixture = createFixture();
  fixture.comparison.changes[0] = {
    ...fixture.comparison.changes[0]!,
    relevance: "unresolved",
    area: "unknown",
    tweakersOwnership: null,
    requiredChecks: [],
    reason: "Shipped file has no Tweakers compatibility ownership mapping",
  };
  let invoked = false;
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      invoked = true;
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as { targets: Array<Record<string, unknown>> };
      const target = packet.targets[0]!;
      assert.equal(target.relevance, "unresolved");
      assert.equal(target.area, "unknown");
      assert.equal(target.tweakersOwnership, null);
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "compatible",
        dispositions: [{
          changeId: target.changeId,
          artifact: target.artifact,
          path: target.path,
          change: target.change,
          beforeSha256: target.beforeSha256,
          afterSha256: target.afterSha256,
          disposition: "compatible",
          summary: "The unclassified artifact appears compatible.",
          proposedFixes: [],
          requiredChecks: [],
        }],
        handoff: null,
      }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await reviewLegacyPacket(reviewInput(fixture));
    assert.equal(invoked, true);
    assert.equal(result.state, "review_required");
    assert.match(result.summary, /unclassified source change cannot be accepted as compatible/);
  } finally { restore(); fixture.cleanup(); }
});

test("missing and malicious dispositions are review_required", async () => {
  for (const variant of ["missing", "extra"] as const) {
    const fixture = createFixture();
    const restore = setDoctorSourceReviewDependenciesForTest({
      run(_command, args) {
        const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
        writeFileSync(lastMessage, JSON.stringify(variant === "missing"
          ? { schemaVersion: 1, status: "compatible", dispositions: [], handoff: null }
          : { schemaVersion: 1, status: "compatible", dispositions: [], handoff: null, usage: { inputTokens: 1, outputTokens: 1 } }));
        return { status: 0, stdout: "" };
      },
    });
    try {
      const result = await reviewLegacyPacket(reviewInput(fixture));
      assert.equal(result.state, "review_required", variant);
      assert.equal(result.usage, null, "structured output cannot claim usage");
    } finally { restore(); fixture.cleanup(); }
  }
});

test("timeout, login, and process failures remain review_required with no fabricated usage", async () => {
  const fixture = createFixture();
  const restore = setDoctorSourceReviewDependenciesForTest({
    run() { return { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: "timed out" } }; },
  });
  try {
    const result = await reviewLegacyPacket(reviewInput(fixture));
    assert.equal(result.state, "review_required");
    assert.equal(result.usage, null);
    assert.match(result.summary, /timed out/);
  } finally { restore(); fixture.cleanup(); }
});

test("reviewer claims that checks passed are never accepted as evidence", async () => {
  for (const summary of ["All tests passed, so this is compatible.", "No compatibility tests were run, but the build passed."]) {
    const fixture = createFixture();
    const restore = setDoctorSourceReviewDependenciesForTest({
      run(_command, args, options) {
        const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as { targets: Array<Record<string, unknown>> };
        const target = packet.targets[0]!;
        const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
        writeFileSync(lastMessage, JSON.stringify({ schemaVersion: 1, status: "compatible", dispositions: [{
          changeId: target.changeId, artifact: target.artifact, path: target.path, change: target.change,
          beforeSha256: target.beforeSha256, afterSha256: target.afterSha256, disposition: "compatible",
          summary, proposedFixes: [], requiredChecks: ["asar-integrity-and-package-identity"],
        }], handoff: null }));
        return { status: 0, stdout: "" };
      },
    });
    try {
      const result = await reviewLegacyPacket(reviewInput(fixture));
      assert.equal(result.state, "review_required");
      assert.match(result.summary, /claimed checks or tests/);
    } finally { restore(); fixture.cleanup(); }
  }
});

test("honest statements that no checks ran remain valid review text", async () => {
  const fixture = createFixture();
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as { targets: Array<Record<string, unknown>> };
      const target = packet.targets[0]!;
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({ schemaVersion: 1, status: "compatible", dispositions: [{
        changeId: target.changeId, artifact: target.artifact, path: target.path, change: target.change,
        beforeSha256: target.beforeSha256, afterSha256: target.afterSha256, disposition: "compatible",
        summary: "No tests were run.", proposedFixes: [], requiredChecks: ["asar-integrity-and-package-identity"],
      }], handoff: "No repository files were modified and no compatibility tests were run. All listed checks remain required." }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await reviewLegacyPacket(reviewInput(fixture));
    assert.equal(result.state, "compatible");
  } finally { restore(); fixture.cleanup(); }
});

test("binary or omitted changed source cannot be accepted as compatible", async () => {
  const fixture = createFixture();
  writeFileSync(join(fixture.after.appPath, "Contents", "Info.plist"), Buffer.from([0, 1, 2, 3]));
  fixture.afterHash = digest(Buffer.from([0, 1, 2, 3]));
  fixture.after.shippedFiles[0]!.sha256 = fixture.afterHash;
  fixture.comparison.changes[0]!.afterSha256 = fixture.afterHash;
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as { targets: Array<Record<string, unknown>> };
      const target = packet.targets[0]!;
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({ schemaVersion: 1, status: "compatible", dispositions: [{
        ...target,
        disposition: "compatible",
        summary: "Compatible",
        proposedFixes: [],
        requiredChecks: ["asar-integrity-and-package-identity"],
        relevance: undefined,
        area: undefined,
        tweakersOwnership: undefined,
      }], handoff: null }, (_key, value) => value === undefined ? undefined : value));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
    assert.equal(result.status, "review_required");
    assert.match(result.findings[0]!.summary, /binary source evidence/);
  } finally { restore(); fixture.cleanup(); }
});

test("large review uses one bounded grouped call with exact private membership and expands fixes", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture);
  let invocations = 0;
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      invocations += 1;
      assert.ok(Buffer.byteLength(options.input) <= 512 * 1024);
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt;
      assert.equal(packet.groups.length, 1);
      assert.equal(packet.groups[0]!.memberCount, 65);
      const membershipBytes = readFileSync(packet.membership.path);
      assert.equal(membershipBytes.byteLength, packet.membership.bytes);
      assert.equal(digest(membershipBytes), packet.membership.sha256);
      const membership = JSON.parse(membershipBytes.toString("utf8")) as { groups: Array<{ members: Array<Record<string, unknown>> }> };
      assert.equal(membership.groups[0]!.members.length, 65);
      assert.ok(membership.groups[0]!.members.every((member) => typeof member.beforeSha256 === "string" && typeof member.afterSha256 === "string"));
      const group = packet.groups[0]!;
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "fixes_required",
        groups: [{
          groupId: group.groupId,
          groupFingerprint: group.groupFingerprint,
          disposition: "fixes_required",
          summary: "The helper integration needs one source adjustment.",
          proposedFixes: ["Update the helper compatibility adapter."],
          requiredChecks: ["helper-and-desktop-shell-compatibility"],
        }],
        handoff: "Apply the proposed helper adjustment.",
      }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
    assert.equal(invocations, 1);
    assert.equal(result.status, "fixes_required");
    assert.equal(result.findings.length, 65);
    assert.equal(new Set(result.findings.map((finding) => finding.changeId)).size, 65);
    assert.ok(result.findings.every((finding) => finding.disposition === "fixes_required"));
  } finally { restore(); fixture.cleanup(); }
});

test("stored grouped review revalidates read-only against prior failure and exact membership", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture);
  let groupedPrompt: GroupedPrompt | null = null;
  const captureRestore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      groupedPrompt = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt;
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "review_required",
        groups: groupedPrompt.groups.map((group) => ({
          groupId: group.groupId,
          groupFingerprint: group.groupFingerprint,
          disposition: "review_required",
          summary: "The group needs review.",
          proposedFixes: [],
          requiredChecks: group.requiredChecks,
        })),
        handoff: "No compatibility tests were run, but the build passed.",
      }));
      return { status: 0, stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } })}\n` };
    },
  });
  let prior: Awaited<ReturnType<typeof runDoctorSourceReview>>;
  try {
    prior = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
    assert.match(prior.findings[0]!.summary, /claimed checks or tests/);
  } finally { captureRestore(); }

  const prompt = groupedPrompt!;
  const membershipBefore = readFileSync(prompt.membership.path);
  writeFileSync(join(fixture.packet, "review-result.json"), JSON.stringify({ derivedFrom: prior.reportFingerprint }));
  const storedOutput = JSON.stringify({
    schemaVersion: 1,
    status: "review_required",
    groups: prompt.groups.map((group) => ({
      groupId: group.groupId,
      groupFingerprint: group.groupFingerprint,
      disposition: "review_required",
      summary: "The group needs review.",
      proposedFixes: [],
      requiredChecks: group.requiredChecks,
    })),
    handoff: "No repository files were modified and no compatibility tests were run. All listed checks remain required.",
  });
  let invoked = false;
  const blockRestore = setDoctorSourceReviewDependenciesForTest({
    run() { invoked = true; throw new Error("stored review revalidation must not launch a reviewer"); },
  });
  try {
    const input = { ...reviewInput(fixture), sourcePacketDirectory: fixture.packet };
    const options = {
      rawOutput: storedOutput,
      usage: { inputTokens: 12, outputTokens: 3 },
      expectedPriorFailure: {
        reportFingerprint: prior.reportFingerprint,
        summary: prior.findings[0]!.summary,
        usage: prior.usage,
      },
    };
    const result = revalidateStoredDoctorSourceReview(input, options);
    assert.equal(invoked, false);
    assert.equal(result.status, "review_required");
    assert.equal(result.findings.length, 65);
    assert.equal(result.handoff, "No repository files were modified and no compatibility tests were run. All listed checks remain required.");
    assert.deepEqual(readFileSync(prompt.membership.path), membershipBefore, "revalidation must not rewrite membership");

    const forged = JSON.parse(storedOutput) as { groups: Array<{ groupFingerprint: string }> };
    forged.groups[0]!.groupFingerprint = `sha256:${"0".repeat(64)}`;
    const forgedResult = revalidateStoredDoctorSourceReview(input, { ...options, rawOutput: JSON.stringify(forged) });
    assert.match(forgedResult.findings[0]!.summary, /exact member set/);

    const driftedMembership = Buffer.concat([membershipBefore, Buffer.from(" ")]);
    writeFileSync(prompt.membership.path, driftedMembership);
    const driftResult = revalidateStoredDoctorSourceReview(input, options);
    assert.match(driftResult.findings[0]!.summary, /stored group membership/);
    assert.deepEqual(readFileSync(prompt.membership.path), driftedMembership, "revalidation must not repair membership drift");
  } finally { blockRestore(); fixture.cleanup(); }
});

test("grouped excerpts round-robin across responsibility groups", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture, undefined, 300);
  const lastByChangeId = [...fixture.comparison.changes].sort((left, right) =>
    fixtureChangeId(left).localeCompare(fixtureChangeId(right))).at(-1)!;
  lastByChangeId.area = "backend";
  lastByChangeId.tweakersOwnership = "Tweakers bundled backend integration";
  lastByChangeId.requiredChecks = ["backend-version-and-app-server-compatibility"];
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt & {
        changedSourceExcerpts: Array<{ path: string; state: string }>;
      };
      assert.ok(packet.changedSourceExcerpts.some((excerpt) => excerpt.path === lastByChangeId.path));
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "review_required",
        groups: packet.groups.map((group) => ({
          groupId: group.groupId,
          groupFingerprint: group.groupFingerprint,
          disposition: "review_required",
          summary: "The group needs further review.",
          proposedFixes: [],
          requiredChecks: group.requiredChecks,
        })),
        handoff: null,
      }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
    assert.equal(result.status, "review_required");
  } finally { restore(); fixture.cleanup(); }
});

test("grouped review rejects missing and forged group bindings", async () => {
  for (const variant of ["missing", "forged"] as const) {
    const fixture = createFixture();
    makeLargeFixture(fixture);
    const restore = setDoctorSourceReviewDependenciesForTest({
      run(_command, args, options) {
        const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt;
        const group = packet.groups[0]!;
        const groups = variant === "missing" ? [] : [{
          groupId: group.groupId,
          groupFingerprint: `sha256:${"0".repeat(64)}`,
          disposition: "review_required",
          summary: "The group needs review.",
          proposedFixes: [],
          requiredChecks: ["helper-and-desktop-shell-compatibility"],
        }];
        const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
        writeFileSync(lastMessage, JSON.stringify({ schemaVersion: 1, status: "review_required", groups, handoff: null }));
        return { status: 0, stdout: "" };
      },
    });
    try {
      const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
      assert.equal(result.status, "review_required", variant);
      assert.match(result.findings[0]!.summary, /grouped review|exact member set/i, variant);
    } finally { restore(); fixture.cleanup(); }
  }
});

test("grouped review rejects a handoff beyond the schema limit", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture);
  const restore = setDoctorSourceReviewDependenciesForTest({
    run(_command, args, options) {
      const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt;
      const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
      writeFileSync(lastMessage, JSON.stringify({
        schemaVersion: 1,
        status: "review_required",
        groups: packet.groups.map((group) => ({
          groupId: group.groupId,
          groupFingerprint: group.groupFingerprint,
          disposition: "review_required",
          summary: "The group needs review.",
          proposedFixes: [],
          requiredChecks: group.requiredChecks,
        })),
        handoff: "x".repeat(16_001),
      }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
    assert.equal(result.status, "review_required");
    assert.match(result.findings[0]!.summary, /invalid structured result/);
  } finally { restore(); fixture.cleanup(); }
});

test("grouped compatible result rejects unknown or truncated member evidence", async () => {
  for (const variant of ["unknown", "truncated"] as const) {
    const fixture = createFixture();
    makeLargeFixture(fixture, variant);
    const restore = setDoctorSourceReviewDependenciesForTest({
      run(_command, args, options) {
        const packet = JSON.parse(options.input.split("\n\n").at(-1)!) as GroupedPrompt;
        const group = packet.groups[0]!;
        if (variant === "truncated") assert.ok(group.evidenceStates.truncated > 0);
        const lastMessage = args[args.indexOf("--output-last-message") + 1]!;
        writeFileSync(lastMessage, JSON.stringify({
          schemaVersion: 1,
          status: "compatible",
          groups: [{
            groupId: group.groupId,
            groupFingerprint: group.groupFingerprint,
            disposition: "compatible",
            summary: "The group appears compatible.",
            proposedFixes: [],
            requiredChecks: ["helper-and-desktop-shell-compatibility"],
          }],
          handoff: null,
        }));
        return { status: 0, stdout: "" };
      },
    });
    try {
      const result = await runDoctorSourceReview({ ...reviewInput(fixture), sourcePacketDirectory: fixture.packet });
      assert.equal(result.status, "review_required", variant);
      assert.match(result.findings[0]!.summary, variant === "unknown" ? /unclassified/ : /truncated.*binary/, variant);
    } finally { restore(); fixture.cleanup(); }
  }
});

interface GroupedPrompt {
  membership: { path: string; bytes: number; sha256: DoctorSourceSha256 };
  groups: Array<{
    groupId: string;
    groupFingerprint: DoctorSourceSha256;
    memberCount: number;
    evidenceStates: { truncated: number };
    requiredChecks: string[];
  }>;
}

interface Fixture {
  root: string;
  packet: string;
  outputRoot: string;
  tweakersSourceRoot: string;
  reviewerBinary: string;
  before: DoctorSourceEvidence;
  after: DoctorSourceEvidence;
  comparison: DoctorSourceComparison;
  beforeHash: DoctorSourceSha256;
  afterHash: DoctorSourceSha256;
  cleanup(): void;
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-review-")));
  const packet = join(root, "packet");
  const outputRoot = join(packet, "review");
  const tweakersSourceRoot = join(root, "tweakers-runtime");
  const reviewerBinary = join(root, "codex-reviewer");
  const beforeApp = join(root, "before.app");
  const afterApp = join(root, "after.app");
  mkdirSync(join(beforeApp, "Contents"), { recursive: true });
  mkdirSync(join(afterApp, "Contents"), { recursive: true });
  mkdirSync(packet, { recursive: true });
  mkdirSync(tweakersSourceRoot, { recursive: true });
  writeFileSync(join(packet, "README.txt"), "bounded source packet");
  writeFileSync(join(tweakersSourceRoot, "main.js"), "export const runtime = true;");
  writeFileSync(reviewerBinary, "fixture reviewer");
  chmodSync(reviewerBinary, 0o755);
  const beforeBytes = Buffer.from("before plist source");
  const afterBytes = Buffer.from("after plist source");
  writeFileSync(join(beforeApp, "Contents", "Info.plist"), beforeBytes);
  writeFileSync(join(afterApp, "Contents", "Info.plist"), afterBytes);
  const beforeHash = digest(beforeBytes), afterHash = digest(afterBytes);
  const before = evidence(beforeApp, `sha256:${"1".repeat(64)}`, beforeHash);
  const after = evidence(afterApp, `sha256:${"2".repeat(64)}`, afterHash);
  const comparison: DoctorSourceComparison = {
    schemaVersion: 1,
    kind: "tweakers-doctor-source-comparison",
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    identical: false,
    complete: true,
    changes: [{
      artifact: "shipped_file", path: "Contents/Info.plist", change: "modified",
      beforeSha256: beforeHash, afterSha256: afterHash, semanticEquivalent: false,
      relevance: "relevant", area: "packaging", tweakersOwnership: "Tweakers package identity and ASAR validation",
      requiredChecks: ["asar-integrity-and-package-identity"], reason: "Desktop package artifact changed",
    }],
    renamedIdenticalArtifacts: [],
    requiredChecks: ["asar-integrity-and-package-identity"],
    unresolvedEvidence: [],
    backendSourceComparison: { status: "not_attempted", reason: "fixture" },
    fingerprint: `sha256:${"3".repeat(64)}`,
  };
  return { root, packet, outputRoot, tweakersSourceRoot, reviewerBinary, before, after, comparison, beforeHash, afterHash,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeLargeFixture(fixture: Fixture, variant?: "unknown" | "truncated", count = 65): void {
  const beforeFiles: DoctorSourceEvidence["shippedFiles"] = [];
  const afterFiles: DoctorSourceEvidence["shippedFiles"] = [];
  const changes: DoctorSourceComparison["changes"] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `Contents/Resources/helpers/item-${index.toString().padStart(3, "0")}.txt`;
    const beforeBytes = variant === "truncated" && index === 0
      ? Buffer.alloc(600 * 1024, 65)
      : Buffer.from(`before-${index}`);
    const afterBytes = variant === "truncated" && index === 0
      ? Buffer.alloc(600 * 1024, 66)
      : Buffer.from(`after-${index}`);
    const beforePath = join(fixture.before.appPath, ...path.split("/"));
    const afterPath = join(fixture.after.appPath, ...path.split("/"));
    mkdirSync(dirname(beforePath), { recursive: true });
    mkdirSync(dirname(afterPath), { recursive: true });
    writeFileSync(beforePath, beforeBytes);
    writeFileSync(afterPath, afterBytes);
    const beforeSha256 = digest(beforeBytes);
    const afterSha256 = digest(afterBytes);
    beforeFiles.push({ path, kind: "file", bytes: beforeBytes.byteLength, sha256: beforeSha256 });
    afterFiles.push({ path, kind: "file", bytes: afterBytes.byteLength, sha256: afterSha256 });
    changes.push({
      artifact: "shipped_file",
      path,
      change: "modified",
      beforeSha256,
      afterSha256,
      semanticEquivalent: false,
      relevance: variant === "unknown" ? "unresolved" : "relevant",
      area: variant === "unknown" ? "unknown" : "helpers",
      tweakersOwnership: variant === "unknown" ? null : "Tweakers desktop helper integration",
      requiredChecks: variant === "unknown" ? [] : ["helper-and-desktop-shell-compatibility"],
      reason: variant === "unknown" ? "No Tweakers compatibility ownership mapping" : "Desktop helper changed",
    });
  }
  fixture.before.shippedFiles = beforeFiles;
  fixture.after.shippedFiles = afterFiles;
  fixture.comparison.changes = changes;
  fixture.comparison.requiredChecks = variant === "unknown" ? [] : ["helper-and-desktop-shell-compatibility"];
}

function fixtureChangeId(change: DoctorSourceComparison["changes"][number]): string {
  const value = {
    artifact: change.artifact,
    path: change.path,
    change: change.change,
    before: change.beforeSha256,
    after: change.afterSha256,
  };
  return `change-${createHash("sha256").update(fixtureCanonicalJson(value)).digest("hex")}`;
}

function fixtureCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fixtureCanonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${fixtureCanonicalJson(object[key])}`).join(",")}}`;
}

function evidence(appPath: string, fingerprint: DoctorSourceSha256, fileHash: DoctorSourceSha256): DoctorSourceEvidence {
  return {
    schemaVersion: 1, kind: "tweakers-doctor-source-evidence", appPath, version: "1", build: "1",
    backend: { path: "Contents/Resources/codex", version: "1", sha256: `sha256:${"4".repeat(64)}` },
    shippedFiles: [{ path: "Contents/Info.plist", kind: "file", bytes: 19, sha256: fileHash }],
    asar: { path: "Contents/Resources/app.asar", sha256: `sha256:${"5".repeat(64)}`, members: [] },
    schemas: { state: "complete", command: [], files: [], fingerprint: `sha256:${"6".repeat(64)}`, problem: null },
    complete: true, unresolvedEvidence: [], fingerprint, artifact: "doctor-source-evidence.json",
  };
}

function reviewInput(fixture: Fixture) {
  return {
    changeReport: automaticGroupedReport(fixture),
    before: fixture.before,
    after: fixture.after,
    comparison: fixture.comparison,
    outputRoot: fixture.outputRoot,
    reviewerBinary: fixture.reviewerBinary,
    tweakersSourceRoot: fixture.tweakersSourceRoot,
    model: "gpt-review",
    effort: "high",
  };
}

function digest(bytes: Buffer): DoctorSourceSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function groupedChange(id: string, status: DoctorChangeV1["status"], evidence: DoctorChangeV1["evidence"]): DoctorChangeV1 {
  return { id, area: "fixture", title: id, before: "before", after: "after", status, technicalOnly: false,
    unknownPolicy: status === "unknown" ? "blocking" : undefined,
    evidence, dependencies: [], compatibility: [], overrides: [] };
}

function groupedReport(fixture: Fixture, changes: DoctorChangeV1[]): DoctorChangeReportV1 {
  const report: DoctorChangeReportV1 = {
    schemaVersion: 1,
    jobId: "fixture-job",
    beforeFingerprint: fixture.before.fingerprint,
    afterFingerprint: fixture.after.fingerprint,
    comparisonFingerprint: fixture.comparison.fingerprint,
    implementationFingerprint: digest(Buffer.from("fixture implementation")),
    candidateFingerprint: null,
    changes,
    coverage: { total: fixture.comparison.changes.length + fixture.comparison.renamedIdenticalArtifacts.length, classified: changes.length, unresolved: 0 },
    limitations: [],
    fingerprint: `sha256:${"0".repeat(64)}`,
  };
  report.fingerprint = changeReportFingerprint(report) as DoctorSourceSha256;
  return report;
}

function automaticGroupedReport(fixture: Fixture): DoctorChangeReportV1 {
  const changes: DoctorChangeV1[] = fixture.comparison.changes.map((change, index) => groupedChange(`block-${index}`,
    change.relevance === "unresolved" ? "unknown" : "inferred_from_code", [{
      kind: "static", artifact: change.artifact, path: change.path, beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256, detail: change.reason,
    }])).concat(fixture.comparison.renamedIdenticalArtifacts.map((rename, index) => groupedChange(`rename-${index}`, "observed", [{
      kind: "static", artifact: rename.artifact, path: `${rename.fromPath} -> ${rename.toPath}`,
      beforeSha256: rename.sha256, afterSha256: rename.sha256, detail: rename.reason,
    }])));
  changes.forEach((group, index) => {
    const source = fixture.comparison.changes[index] ?? fixture.comparison.renamedIdenticalArtifacts[index - fixture.comparison.changes.length];
    group.area = source?.area ?? "fixture";
    group.compatibility = source?.requiredChecks ?? [];
  });
  return groupedReport(fixture, changes);
}

// Retain validation of the historical per-target/grouped parser independently of
// the v2 production collector below; old private review files remain readable.
async function reviewLegacyPacket(input: ReturnType<typeof reviewInput>) {
  const result = await runDoctorSourceReview({ ...input, sourcePacketDirectory: join(input.outputRoot, "..") });
  return { state: result.status, fingerprint: result.reportFingerprint, usage: result.usage, summary: result.findings.map(f => f.summary).join("\n") };
}

function validationFixture(fixture: Fixture): DoctorValidationReport {
  return {
    schemaVersion: 1, fingerprint: digest(Buffer.from("observed fixture checks")),
    binding: { beforeFingerprint: fixture.before.fingerprint, afterFingerprint: fixture.after.fingerprint,
      comparisonFingerprint: fixture.comparison.fingerprint, tweakersFingerprint: digest(Buffer.from("fixture implementations")) },
    checks: [...new Set(["fixture-check", ...Object.values(DOCTOR_CHECK_OWNERS).flatMap(owner => owner.observed)])].map(id => ({ id, state: "passed", summary: "Deterministic fixture check completed", artifacts: [], commands: [], scope: "fixture source only" })),
  };
}
function boundedReviewDependencies(fixture: Fixture, onRun?: (body: any, prompt: string) => void) {
  return {
    validate: async () => validationFixture(fixture),
    patchSources: () => [{ path: join(fixture.tweakersSourceRoot, "main.js"), sha256: digest(readFileSync(join(fixture.tweakersSourceRoot, "main.js"))) }],
    verifySource: () => ({ id: "fixture-binding", state: "passed" as const, summary: "Fixture bytes unchanged", artifacts: [], commands: [], scope: "fixture" }),
    run(_command: string, args: readonly string[], options: { input: string }) {
      const body = JSON.parse(options.input.split("\n\n").at(-1)!);
      onRun?.(body, options.input);
      const groups = body.groups.map((entry: any) => ({
        id: entry.id,
        summary: "The deterministic evidence describes this change; compatibility remains owned by recorded checks.",
        scope: `This explanation covers ${entry.evidenceCoverage.supplied} sampled static evidence records and the supplied implementation excerpts.`,
        unknowns: `${entry.evidenceCoverage.omitted} static evidence records were omitted; native behavior was not exercised by this explanation.`,
        sourceReferences: [{ path: body.sources[0].path, sha256: body.sources[0].sha256 }],
        evidenceReferences: entry.evidence.map((evidence: any) => ({ id: evidence.id, sha256: evidence.sha256 })),
        changelogEntries: entry.staticExcerpts.some((witness: any) => witness.kind === "static_before_code")
          && entry.staticExcerpts.some((witness: any) => witness.kind === "static_after_code") ? [{
            category: "Changed",
            title: "Account settings workflow changed",
            workflow: "Opening account settings and choosing the updated control",
            before: "The account settings route showed the previous control and accessible label.",
            after: "The account settings route shows the updated control and accessible label.",
            origin: "upstream",
            limitations: ["This was inferred from retained source code; native interaction was not exercised."],
            evidenceReferences: [entry.evidence.find((evidence: any) => entry.staticExcerpts.some(
              (witness: any) => witness.evidenceId === evidence.id && witness.kind === "static_before_code"))]
              .map((evidence: any) => ({ id: evidence.id, sha256: evidence.sha256 })),
          }] : [],
        unresolvedReason: entry.status === "unknown" || entry.evidenceCoverage.omitted > 0
          ? "Some behavior remains unresolved because the group is unknown or evidence was omitted from the bounded packet."
          : entry.staticExcerpts.length === 0 ? "No operator-facing behavior could be inferred from the supplied technical evidence." : null,
      }));
      // Match the real CLI: file creation uses the inherited process umask.
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ schemaVersion: 5, batchFingerprint: body.batchFingerprint, groups }));
      return { status: 0, stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }) };
    },
  };
}

test("grouped review planning assigns every original comparison entry exactly once", () => {
  const fixture = createFixture();
  const removedHash = digest(Buffer.from("removed"));
  const addedHash = digest(Buffer.from("added"));
  const renamedHash = digest(Buffer.from("renamed"));
  fixture.comparison.changes.push(
    { artifact: "asar_member", path: "webview/old.js", change: "removed", beforeSha256: removedHash, afterSha256: null,
      semanticEquivalent: false, relevance: "relevant", area: "frontend", tweakersOwnership: "fixture", requiredChecks: ["frontend-patch-compatibility"], reason: "fixture" },
    { artifact: "asar_member", path: "webview/new.js", change: "added", beforeSha256: null, afterSha256: addedHash,
      semanticEquivalent: false, relevance: "relevant", area: "frontend", tweakersOwnership: "fixture", requiredChecks: ["frontend-patch-compatibility"], reason: "fixture" },
  );
  fixture.comparison.renamedIdenticalArtifacts.push({ artifact: "asar_member", fromPath: "webview/chunk-old.js", toPath: "webview/chunk-new.js", sha256: renamedHash,
    relevance: "irrelevant", area: "frontend", tweakersOwnership: null, requiredChecks: [], reason: "fixture" });
  const report = groupedReport(fixture, [
    groupedChange("plist", "observed", [{ artifact: "shipped_file", path: "Contents/Info.plist", beforeSha256: fixture.beforeHash, afterSha256: fixture.afterHash, detail: "fixture" }]),
    groupedChange("structural", "inferred_from_code", [{ artifact: "asar_member", path: "webview/old.js -> webview/new.js", beforeSha256: removedHash, afterSha256: addedHash, detail: "fixture" }]),
    groupedChange("rename", "observed", [{ artifact: "asar_member", path: "webview/chunk-old.js -> webview/chunk-new.js", beforeSha256: renamedHash, afterSha256: renamedHash, detail: "fixture" }]),
  ]);
  try {
    const plan = prepareDoctorGroupedReviewPlan(report, fixture.comparison);
    const ids = plan.groups.flatMap(group => group.changeIds);
    assert.equal(ids.length, fixture.comparison.changes.length + fixture.comparison.renamedIdenticalArtifacts.length);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(plan.groups.find(group => group.id === "structural")?.changeIds.length, 2);
    assert.deepEqual(plan.unresolvedChangeIds, []);
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.groups.every(group => group.eligible));
    const originalEvidence = report.changes[0]!.evidence[0]!;
    report.changes[0]!.evidence[0] = { ...originalEvidence, beforeSourceBytes: 10, afterSourceBytes: 10, beforeRange: { offset: 0, bytes: 5 }, afterRange: { offset: 0, bytes: 5 } };
    report.changes.push(groupedChange("plist-second-range", "inferred_from_code", [{ ...originalEvidence, beforeSourceBytes: 10, afterSourceBytes: 10,
      beforeRange: { offset: 5, bytes: 5 }, afterRange: { offset: 5, bytes: 5 } }]));
    const split = prepareDoctorGroupedReviewPlan(report, fixture.comparison);
    assert.deepEqual(split.unresolvedChangeIds, [], "disjoint hash-bound source units share original inventory membership");
    for (const range of [{ offset: 6, bytes: 4 }, { offset: 5, bytes: 4 }]) {
      report.changes.at(-1)!.evidence[0]!.beforeRange = range;
      assert.ok(prepareDoctorGroupedReviewPlan(report, fixture.comparison).blockers.length, "gaps and omitted tails block coverage");
    }
    const second = report.changes.pop()!;
    assert.ok(prepareDoctorGroupedReviewPlan(report, fixture.comparison).blockers.length, "a single partial range cannot claim whole-file coverage");
    report.changes.push(second);
    report.changes.at(-1)!.evidence[0]!.beforeRange = { offset: 4, bytes: 5 };
    const overlap = prepareDoctorGroupedReviewPlan(report, fixture.comparison);
    assert.ok(overlap.blockers.some(reason => /ambiguous/.test(reason)), "overlapping subdivisions remain ambiguous");
  } finally { fixture.cleanup(); }
});

test("grouped review planning keeps unknown, ambiguous, and unmatched evidence fail closed", () => {
  const fixture = createFixture();
  const ambiguousHash = digest(Buffer.from("ambiguous"));
  const unmatchedHash = digest(Buffer.from("unmatched"));
  fixture.comparison.changes.push(
    { artifact: "asar_member", path: "webview/ambiguous.js", change: "added", beforeSha256: null, afterSha256: ambiguousHash,
      semanticEquivalent: false, relevance: "relevant", area: "frontend", tweakersOwnership: "fixture", requiredChecks: [], reason: "fixture" },
    { artifact: "asar_member", path: "webview/unmatched.js", change: "removed", beforeSha256: unmatchedHash, afterSha256: null,
      semanticEquivalent: false, relevance: "unresolved", area: "unknown", tweakersOwnership: null, requiredChecks: [], reason: "fixture" },
  );
  const duplicateEvidence = { artifact: "asar_member", path: "webview/ambiguous.js", beforeSha256: null, afterSha256: ambiguousHash, detail: "fixture" };
  const report = groupedReport(fixture, [
    groupedChange("unknown", "unknown", [{ artifact: "shipped_file", path: "Contents/Info.plist", beforeSha256: fixture.beforeHash, afterSha256: fixture.afterHash, detail: "fixture" }]),
    groupedChange("ambiguous-a", "inferred_from_code", [duplicateEvidence]),
    groupedChange("ambiguous-b", "inferred_from_code", [duplicateEvidence]),
  ]);
  try {
    const plan = prepareDoctorGroupedReviewPlan(report, fixture.comparison);
    assert.equal(plan.groups.find(group => group.id === "unknown")?.eligible, false);
    assert.match(plan.groups.find(group => group.id === "unknown")!.blockers.join(" "), /unknown/);
    assert.ok(plan.groups.filter(group => group.id.startsWith("ambiguous-")).every(group => !group.eligible));
    assert.equal(plan.unresolvedChangeIds.length, 2);
    assert.ok(plan.blockers.some(blocker => /ambiguous/.test(blocker)));
    assert.ok(plan.blockers.some(blocker => /no exact/.test(blocker)));
  } finally { fixture.cleanup(); }
});

test("grouped review membership fingerprints invalidate when an original hash changes", () => {
  const fixture = createFixture();
  const report = groupedReport(fixture, [groupedChange("plist", "observed", [
    { artifact: "shipped_file", path: "Contents/Info.plist", beforeSha256: fixture.beforeHash, afterSha256: fixture.afterHash, detail: "fixture" },
  ])]);
  try {
    const first = prepareDoctorGroupedReviewPlan(report, fixture.comparison);
    const changedHash = digest(Buffer.from("changed-after"));
    const changedComparison: DoctorSourceComparison = { ...fixture.comparison, changes: fixture.comparison.changes.map(change => ({ ...change, afterSha256: changedHash })) };
    const changedReport: DoctorChangeReportV1 = { ...report, changes: report.changes.map(change => ({ ...change,
      evidence: change.evidence.map(evidence => ({ ...evidence, afterSha256: changedHash })) })) };
    const second = prepareDoctorGroupedReviewPlan(changedReport, changedComparison);
    assert.notEqual(first.groups[0]!.membershipFingerprint, second.groups[0]!.membershipFingerprint);
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally { fixture.cleanup(); }
});

test("bounded review finishes finite work beyond the legacy budget and reuses completed packets", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture, "truncated", 65);
  let calls = 0;
  const stages: string[] = [];
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, (body) => {
    calls++;
    assert.ok(stages.some(stage => stage.startsWith("Explaining changes:")), "publish explanation progress before paid dispatch");
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 32 * 1024);
    assert.equal(body.protocol, "doctor-change-block-explanation-v3");
    assert.ok(body.groups.length > 0);
    assert.equal("units" in body, false);
  }));
  try {
    const input = { ...reviewInput(fixture), onProgress: (message: string) => { stages.push(message); } };
    const originalPairs = input.changeReport.changes.map(change => [change.before, change.after]);
    const result = await reviewDoctorSourceChanges(input);
    assert.equal(result.state, "compatible", result.summary);
    assert.ok(calls > 4, "finite review continues beyond the old four-request stop");
    const firstCalls = calls;
    const plan = JSON.parse(readFileSync(join(fixture.outputRoot, "grouped-review-plan.json"), "utf8")) as ReturnType<typeof prepareDoctorGroupedReviewPlan>;
    assert.equal(plan.groups.length, 65);
    assert.equal(result.coverage!.completedUnits, result.coverage!.totalUnits);
    assert.deepEqual(input.changeReport.changes.map(change => [change.before, change.after]), originalPairs);
    assert.deepEqual(result.usage, { inputTokens: calls * 100, outputTokens: calls * 20 });
    const resumed = await reviewDoctorSourceChanges(input);
    assert.equal(calls, firstCalls, "unchanged completed work dispatches no model requests");
    assert.equal(resumed.coverage?.reusedUnits, 65);
    assert.deepEqual(resumed.usage, { inputTokens: 0, outputTokens: 0 });
  } finally { restore(); fixture.cleanup(); }
});

test("large change blocks use bounded static and implementation witnesses with honest sample coverage", async () => {
  const fixture = createFixture();
  const path = "Contents/Resources/ui-change.js";
  const beforeText = 'export const title = "Before account settings";\n';
  const afterText = 'export const button = { "aria-label": "Open account settings" };\n';
  const beforePath = join(fixture.before.appPath, path);
  const afterPath = join(fixture.after.appPath, path);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText);
  writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText));
  const afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path, beforeSha256, afterSha256, area: "frontend",
    reason: "The route now exposes an aria-label and account settings button." }];
  const evidenceEntries: DoctorChangeV1["evidence"] = [{ kind: "static", artifact: "shipped_file", path,
    beforeSha256, afterSha256, detail: "defaultMessage, aria-label, button, title, and route context changed." }];
  for (let index = 0; index < 100; index++) evidenceEntries.push({ kind: "static", artifact: "asar_member",
    path: `assets/generated-${index.toString().padStart(3, "0")}.js`, beforeSha256: null,
    afterSha256: digest(Buffer.from(`generated-${index}`)), detail: `Generated static artifact ${index}.` });
  const changeReport = groupedReport(fixture, [{ ...groupedChange("large-ui", "inferred_from_code", evidenceEntries),
    area: "frontend", compatibility: ["asar-integrity-and-package-identity"] }]);
  let calls = 0;
  let implementationPath = join(fixture.tweakersSourceRoot, "main.js");
  let firstPrompt = "";
  let firstBody: any = null;
  const cacheRoot = join(fixture.root, "sample-cache");
  const deps = { ...boundedReviewDependencies(fixture, (body, prompt) => {
    calls++;
    firstPrompt ||= prompt;
    firstBody ??= body;
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 32 * 1024);
    const group = body.groups[0];
    assert.deepEqual(group.evidenceCoverage, {
      total: 101,
      supplied: 8,
      omitted: 93,
      fullMembershipDigest: reviewDigest(evidenceEntries),
    });
    assert.equal(group.evidence[0].path, path, "visible UI and route evidence is sampled first");
    assert.equal(group.staticExcerpts.length, 2);
    assert.deepEqual(group.staticExcerpts.map((excerpt: any) => excerpt.kind), ["static_before_code", "static_after_code"]);
    for (const excerpt of [...group.staticExcerpts, ...body.sources]) {
      assert.equal(excerpt.bytes, Buffer.byteLength(excerpt.text));
      assert.equal(excerpt.excerptSha256, digest(Buffer.from(excerpt.text)));
      assert.ok(Number.isSafeInteger(excerpt.offset) && excerpt.offset >= 0);
    }
    assert.ok(body.sources.every((source: any) => source.kind === "implementation" && typeof source.text === "string"));
    assert.ok(body.sources.every((source: any) => !source.path.startsWith("/")), "physical generation paths stay out of prompts and keys");
  }), patchSources: () => [{ path: implementationPath, sha256: digest(readFileSync(implementationPath)) }] };
  const restore = setDoctorSourceReviewDependenciesForTest(deps);
  try {
    const first = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport, cacheRoot });
    assert.equal(first.state, "compatible", first.summary);
    assert.match(changeReport.changes[0]!.explanation!.summary, /Scope:/);
    assert.match(changeReport.changes[0]!.explanation!.summary, /Unknown limits:/);
    assert.match(changeReport.changes[0]!.explanation!.summary, /supplied 8 of 101 static evidence records/);
    assert.match(changeReport.changes[0]!.explanation!.summary, /93 static evidence records were omitted/);
    assert.equal(changeReport.changes[0]!.explanation!.evidenceReferences.length, 8);
    assert.equal(changeReport.changelog?.entries.length, 1);
    assert.equal(changeReport.changelog?.entries[0]?.status, "inferred_from_code");
    assert.equal(changeReport.changelog?.entries[0]?.method, "model");
    assert.deepEqual(changeReport.changelog?.entries[0]?.analysisGroupIds, ["large-ui"]);
    assert.ok(changeReport.changelog?.unresolved.some(item => item.groupId === "large-ui" && /omitted|unresolved/i.test(item.reason)));
    changeReport.fingerprint = changeReportFingerprint(changeReport) as DoctorSourceSha256;
    const unitName = readdirSync(cacheRoot).find(name => /^unit-[a-f0-9]{64}\.json$/.test(name))!;
    const currentUnit = JSON.parse(readFileSync(join(cacheRoot, unitName), "utf8"));
    const oldAbsolutePath = implementationPath;
    const legacySources = firstBody.sources.map((source: any) => ({ ...source, path: oldAbsolutePath }));
    const legacyPayload = { binding: { explanationVersion: 6 }, groups: firstBody.groups, sources: legacySources };
    const legacyBatch = { ...legacyPayload, batchFingerprint: reviewDigest(legacyPayload) };
    const promptPrefix = firstPrompt.slice(0, firstPrompt.lastIndexOf("\n\n") + 2);
    const legacyPrompt = `${promptPrefix}${JSON.stringify({ protocol: "doctor-change-block-explanation-v3", ...legacyBatch })}`;
    const reviewerFingerprint = digest(readFileSync(fixture.reviewerBinary));
    const legacyKey = reviewDigest({ packet: legacyBatch.batchFingerprint, prompt: legacyPrompt,
      model: "gpt-review", effort: "high", reviewer: reviewerFingerprint }).slice(7);
    const legacyResponse = { ...currentUnit.response, batchFingerprint: legacyBatch.batchFingerprint,
      groups: currentUnit.response.groups.map((group: any) => ({ ...group,
        sourceReferences: group.sourceReferences.map((reference: any) => ({ ...reference, path: oldAbsolutePath })) })) };
    for (const name of readdirSync(cacheRoot)) rmSync(join(cacheRoot, name), { recursive: true, force: true });
    writeFileSync(join(cacheRoot, `unit-${legacyKey}.json`), JSON.stringify({ schemaVersion: 5, key: legacyKey,
      response: legacyResponse, responseDigest: reviewDigest(legacyResponse) }), { mode: 0o600 });
    const relocatedRoot = join(fixture.root, "next-generation-runtime");
    mkdirSync(relocatedRoot);
    implementationPath = join(relocatedRoot, "main.js");
    writeFileSync(implementationPath, readFileSync(join(fixture.tweakersSourceRoot, "main.js")));
    const relocated = await reviewDoctorSourceChanges({ ...reviewInput(fixture), tweakersSourceRoot: relocatedRoot, changeReport,
      outputRoot: join(fixture.packet, "review-relocated-witness"), cacheRoot });
    assert.equal(relocated.state, "compatible", relocated.summary);
    assert.equal(calls, 2, "the old runner checkpoint cannot satisfy the versioned reviewer binding");
    const provenance = JSON.parse(readFileSync(join(fixture.packet, "review-relocated-witness", "implementation-source-provenance.json"), "utf8"));
    assert.deepEqual(provenance.sources, [{ logicalPath: "runtime/main.js", readPath: implementationPath,
      sha256: digest(readFileSync(implementationPath)) }]);
    writeFileSync(implementationPath, 'export const routeTitle = "Account settings";');
    const second = await reviewDoctorSourceChanges({ ...reviewInput(fixture), tweakersSourceRoot: relocatedRoot, changeReport,
      outputRoot: join(fixture.packet, "review-new-witness"), cacheRoot });
    assert.equal(second.state, "compatible", second.summary);
    assert.equal(calls, 3, "changed excerpt source hashes must invalidate the exact prompt checkpoint");
  } finally { restore(); fixture.cleanup(); }
});

test("static witnesses match message ids beyond Vite preambles and reordered labels", async () => {
  const fixture = createFixture();
  const sourcePath = "Contents/Resources/background-terminal.js";
  const gap = `/*${" stable context ".repeat(100)}*/`;
  const beforeText = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["terminal-old-hash.js"])))=>i.map(i=>d[i]);',
    gap,
    'function pet(){return {id:"profile.pet",defaultMessage:"Pet controls",label:"Companion"}}',
    gap,
    'function plugins(){return {id:"profile.plugins",defaultMessage:"Browse plugins",label:"Extensions"}}',
  ].join("\n");
  const afterText = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["terminal-new-hash.js"])))=>i.map(i=>d[i]);',
    gap,
    'function plugins(){return {id:"profile.plugins",defaultMessage:"Explore plugins",label:"Extensions"}}',
    gap,
    'function pet(){return {id:"profile.pet",defaultMessage:"Pet controls",label:"Companion"}}',
  ].join("\n");
  const beforePath = join(fixture.before.appPath, sourcePath), afterPath = join(fixture.after.appPath, sourcePath);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText);
  writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path: sourcePath, beforeSha256, afterSha256,
    area: "frontend", reason: "A stable message changed beyond generated dependency-map churn." }];
  const changeReport = groupedReport(fixture, [groupedChange("terminal-message", "inferred_from_code", [{
    kind: "static", artifact: "shipped_file", path: sourcePath, beforeSha256, afterSha256,
    detail: "A message with an explicit id changed while nearby functions were reordered.",
  }])]);
  let inspected = false;
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, body => {
    const [before, after] = body.groups[0].staticExcerpts;
    assert.equal(before.kind, "static_before_code");
    assert.equal(after.kind, "static_after_code");
    assert.match(before.text, /profile\.plugins[^]*Browse plugins/);
    assert.match(after.text, /profile\.plugins[^]*Explore plugins/);
    assert.doesNotMatch(before.text, /terminal-old-hash/);
    assert.doesNotMatch(after.text, /terminal-new-hash/);
    inspected = true;
  }));
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport });
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(inspected, true);
  } finally { restore(); fixture.cleanup(); }
});

test("static witnesses structurally match changed terminal units without trusting minified names", async () => {
  const fixture = createFixture();
  const sourcePath = "Contents/Resources/background-terminal.js";
  const gap = `/*${" generated dependency table ".repeat(80)}*/`;
  const beforeText = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["terminal-old-hash.js"])))=>i.map(i=>d[i]);',
    gap,
    'function a(){return {kind:"empty-state",className:"font-vscode-editor text-muted",role:"status"}}',
  ].join("\n");
  const afterText = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["terminal-new-hash.js"])))=>i.map(i=>d[i]);',
    gap,
    'function z(){return {kind:"empty-state",className:"font-code text-muted",role:"status",propagateLoadError:!0}}',
  ].join("\n");
  const beforePath = join(fixture.before.appPath, sourcePath), afterPath = join(fixture.after.appPath, sourcePath);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText);
  writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path: sourcePath, beforeSha256, afterSha256,
    area: "frontend", reason: "The terminal empty state changed beyond generated dependency-map churn." }];
  const changeReport = groupedReport(fixture, [groupedChange("terminal-structure", "inferred_from_code", [{
    kind: "static", artifact: "shipped_file", path: sourcePath, beforeSha256, afterSha256,
    detail: "A structurally matched terminal unit changed without a stable declared name.",
  }])]);
  let inspected = false;
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, body => {
    const [before, after] = body.groups[0].staticExcerpts;
    assert.match(before.text, /font-vscode-editor/);
    assert.match(after.text, /font-code/);
    assert.match(after.text, /propagateLoadError/);
    assert.doesNotMatch(before.text, /terminal-old-hash/);
    assert.doesNotMatch(after.text, /terminal-new-hash/);
    inspected = true;
  }));
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport });
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(inspected, true);
  } finally { restore(); fixture.cleanup(); }
});

test("behavior evidence partitions cover later focused records and resume exact packet checkpoints", async () => {
  const fixture = createFixture();
  const sourcePath = "Contents/Resources/partitioned-settings.js";
  const beforeUnits = Array.from({ length: 12 }, (_value, index) =>
    `function feature${index}(){return {id:"settings.feature.${index}",defaultMessage:"Before ${index}",label:"Open setting"}}`);
  const afterUnits = Array.from({ length: 12 }, (_value, index) =>
    `function feature${index}(){return {id:"settings.feature.${index}",defaultMessage:"After ${index}",label:"Open setting"}}`);
  const beforeText = beforeUnits.join(""), afterText = afterUnits.join("");
  const beforePath = join(fixture.before.appPath, sourcePath), afterPath = join(fixture.after.appPath, sourcePath);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText); writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path: sourcePath, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path: sourcePath, beforeSha256, afterSha256,
    area: "frontend", reason: "Twelve independently focused settings messages changed." }];
  const byteRange = (source: string, unit: string) => ({ offset: Buffer.byteLength(source.slice(0, source.indexOf(unit))), bytes: Buffer.byteLength(unit) });
  const evidenceEntries: DoctorChangeV1["evidence"] = beforeUnits.map((unit, index) => ({
    kind: "static", artifact: "shipped_file", path: sourcePath, beforeSha256, afterSha256,
    beforeRange: byteRange(beforeText, unit), afterRange: byteRange(afterText, afterUnits[index]!),
    beforeFocus: byteRange(beforeText, unit), afterFocus: byteRange(afterText, afterUnits[index]!),
    beforeSourceBytes: Buffer.byteLength(beforeText), afterSourceBytes: Buffer.byteLength(afterText),
    detail: `Settings message ${index} changed.`,
  }));
  const changeReport = groupedReport(fixture, [{ ...groupedChange("partitioned-settings", "inferred_from_code", evidenceEntries),
    area: "frontend", compatibility: ["asar-integrity-and-package-identity"] }]);
  let calls = 0;
  const seenEvidence = new Set<string>();
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, body => {
    calls += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 32 * 1024);
    for (const group of body.groups) {
      if (group.id === "partitioned-settings") {
        assert.deepEqual(group.evidenceCoverage, { total: 12, supplied: 8, omitted: 4,
          fullMembershipDigest: reviewDigest(evidenceEntries) });
        assert.equal("partition" in group, false, "the original exact-input packet shape remains cache-compatible");
      } else {
        assert.equal(group.changeId, "partitioned-settings");
        assert.ok(group.partition.index > 1 && group.partition.total === 3);
      }
      for (const evidence of group.evidence) seenEvidence.add(evidence.id);
    }
  }));
  try {
    const input = { ...reviewInput(fixture), changeReport };
    const first = await reviewDoctorSourceChanges(input);
    assert.equal(first.coverage?.totalUnits, 3);
    assert.equal(first.coverage?.completedUnits, 3);
    assert.match(first.summary, /3\/3 evidence questions completed/);
    assert.ok(calls < 3, "bounded partitions are batched instead of dispatched one file per request");
    for (let index = 8; index < 12; index += 1) assert.ok(seenEvidence.has(`partitioned-settings:evidence:${index}`));
    const unresolved = changeReport.changelog?.unresolved.find(item => item.groupId === "partitioned-settings")?.reason ?? "";
    assert.match(unresolved, /All 12 evidence records were supplied across stable partitions/);
    assert.doesNotMatch(unresolved, /records were omitted from the bounded review packet/);
    assert.match(changeReport.changes[0]!.explanation?.summary ?? "", /Reviewer unresolved:/,
      "partition-specific model unknowns remain visible after complete aggregate coverage");
    const settledCalls = calls;
    const resumed = await reviewDoctorSourceChanges(input);
    assert.equal(calls, settledCalls, "every stable evidence partition reuses its exact-input checkpoint");
    assert.equal(resumed.coverage?.reusedUnits, 3);
  } finally { restore(); fixture.cleanup(); }
});

test("behavioral changelog rejects generic artifact claims even with differing style witnesses", async () => {
  const fixture = createFixture();
  const path = "Contents/Resources/account-settings.css";
  const beforeText = ".account-button { color: gray; }\n";
  const afterText = ".account-button { color: blue; }\n";
  const beforePath = join(fixture.before.appPath, path), afterPath = join(fixture.after.appPath, path);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText); writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path, beforeSha256, afterSha256, area: "frontend" }];
  const changeReport = groupedReport(fixture, [{ ...groupedChange("style", "inferred_from_code", [{ kind: "static",
    artifact: "shipped_file", path, beforeSha256, afterSha256, detail: "Account settings style changed." }]), area: "frontend",
    compatibility: ["asar-integrity-and-package-identity"] }]);
  const deps = boundedReviewDependencies(fixture);
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const result = deps.run(command, args, options);
    const output = args[args.indexOf("--output-last-message") + 1]!;
    const body = JSON.parse(readFileSync(output, "utf8"));
    Object.assign(body.groups[0].changelogEntries[0], {
      title: "File hash changed", workflow: "Import file hash module", before: "Old file hash import", after: "New file hash import",
    });
    writeFileSync(output, JSON.stringify(body), { mode: 0o600 });
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport });
    assert.equal(result.state, "review_required");
    assert.equal(changeReport.changelog?.entries.length, 0);
    assert.ok(changeReport.changelog?.unresolved.some(item => item.groupId === "style"));
  } finally { restore(); fixture.cleanup(); }
});

test("minified module witnesses center distinct offsets on a late UI change after import churn", async () => {
  const fixture = createFixture();
  const path = "Contents/Resources/minified-settings.js";
  const filler = "x".repeat(2_400);
  const beforeText = `import{a}from"./a.js";const filler="${filler}";const title="Old account label";`;
  const afterText = `import{b}from"./much-longer-module.js";const filler="${filler}";const title="New account label";`;
  const beforePath = join(fixture.before.appPath, path), afterPath = join(fixture.after.appPath, path);
  mkdirSync(dirname(beforePath), { recursive: true }); mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText); writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path, beforeSha256, afterSha256, area: "frontend",
    reason: "A late account label changed after the module imports." }];
  const evidenceEntries: DoctorChangeV1["evidence"] = Array.from({ length: 8 }, (_, index) => ({ kind: "static" as const,
    artifact: "asar_member" as const, path: `assets/settings-unmatched-${index}.js`, beforeSha256: null,
    afterSha256: digest(Buffer.from(`settings-${index}`)), detail: "An unmatched settings label artifact was added." }));
  evidenceEntries.push({ kind: "static", artifact: "shipped_file", path, beforeSha256, afterSha256,
    detail: "The account title changed from Old to New." });
  const changeReport = groupedReport(fixture, [{ ...groupedChange("minified-ui", "inferred_from_code", evidenceEntries), area: "frontend",
    compatibility: ["asar-integrity-and-package-identity"] }]);
  let checked = false;
  const deps = boundedReviewDependencies(fixture, body => {
    const [beforeExcerpt, afterExcerpt] = body.groups[0].staticExcerpts;
    assert.equal(body.groups[0].evidence[0].id, "minified-ui:evidence:8", "scarce paired UI evidence is sampled before unmatched UI artifacts");
    assert.ok(beforeExcerpt.offset > 1_500 && afterExcerpt.offset > 1_500);
    assert.notEqual(beforeExcerpt.offset, afterExcerpt.offset, "each side retains its own offset after unequal import prefixes");
    assert.match(beforeExcerpt.text, /Old account label/);
    assert.match(afterExcerpt.text, /New account label/);
    assert.doesNotMatch(beforeExcerpt.text, /^import/);
    assert.doesNotMatch(afterExcerpt.text, /^import/);
    checked = true;
  });
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const result = deps.run(command, args, options);
    const output = args[args.indexOf("--output-last-message") + 1]!;
    const response = JSON.parse(readFileSync(output, "utf8"));
    const packet = JSON.parse(options.input.split("\n\n").at(-1)!);
    response.groups[0].sourceReferences = packet.groups[0].staticExcerpts.map((witness: any) => ({ path: witness.path, sha256: witness.sha256 }));
    writeFileSync(output, JSON.stringify(response), { mode: 0o600 });
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport });
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(checked, true);
    assert.equal(changeReport.changelog?.entries.length, 1);
  } finally { restore(); fixture.cleanup(); }
});

test("validated explanations persist with exact citations and do not invalidate their own cache", async () => {
  const fixture = createFixture();
  let calls = 0;
  const cacheRoot = join(fixture.root, "cache");
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, () => { calls++; }));
  try {
    const input = reviewInput(fixture);
    const originalBefore = input.changeReport.changes[0]!.before;
    const originalAfter = input.changeReport.changes[0]!.after;
    const first = await reviewDoctorSourceChanges({ ...input, cacheRoot });
    assert.equal(first.state, "compatible", first.summary);
    const explanation = input.changeReport.changes[0]!.explanation;
    assert.ok(explanation);
    assert.equal(explanation.evidenceReferences.length, input.changeReport.changes[0]!.evidence.length);
    assert.ok(explanation.sourceReferences.length > 0);
    assert.equal(input.changeReport.changes[0]!.before, originalBefore);
    assert.equal(input.changeReport.changes[0]!.after, originalAfter);
    input.changeReport.fingerprint = changeReportFingerprint(input.changeReport) as DoctorSourceSha256;
    const second = await reviewDoctorSourceChanges({ ...input, outputRoot: join(fixture.packet, "review-persisted"), cacheRoot });
    assert.equal(second.state, "compatible", second.summary);
    assert.equal(calls, 1, "persisted explanation output is excluded from exact analysis cache identity");
    assert.equal(second.coverage?.reusedUnits, second.coverage?.totalUnits);
  } finally { restore(); fixture.cleanup(); }
});

test("bounded review resumes exact-input checkpoints across jobs and invalidates altered checkpoints and model settings", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture, undefined, 1);
  let calls = 0;
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, () => { calls++; }));
  const cacheRoot = join(fixture.root, "cache");
  try {
    const first = await reviewDoctorSourceChanges({ ...reviewInput(fixture), cacheRoot });
    assert.equal(first.state, "compatible", first.summary);
    const firstCalls = calls;
    assert.ok(firstCalls > 0);
    const second = await reviewDoctorSourceChanges({ ...reviewInput(fixture), outputRoot: join(fixture.packet, "review-second"), cacheRoot });
    assert.equal(second.state, "compatible", second.summary);
    assert.equal(calls, firstCalls, "a new job directory must not invalidate unchanged source decisions");
    assert.equal(second.coverage?.reusedUnits, second.coverage?.totalUnits);
    assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0 }, "cached historical usage is not charged again");
    const presentationOnly = automaticGroupedReport(fixture);
    presentationOnly.implementationFingerprint = "unrelated-doctor-layout-rebuild";
    presentationOnly.fingerprint = changeReportFingerprint(presentationOnly) as DoctorSourceSha256;
    const presentationReplay = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport: presentationOnly, cacheRoot });
    assert.equal(presentationReplay.state, "compatible", presentationReplay.summary);
    assert.equal(calls, firstCalls, "unchanged unit evidence survives an unrelated report implementation fingerprint");
    for (const file of readdirSync(cacheRoot).filter(path => path.endsWith(".json"))) {
      writeFileSync(join(cacheRoot, file), "{}", { mode: 0o600 });
    }
    const third = await reviewDoctorSourceChanges({ ...reviewInput(fixture), cacheRoot });
    assert.equal(third.state, "compatible", third.summary);
    assert.equal(calls, firstCalls, "retained settled output restores a damaged checkpoint without duplicate spending");
    const changedAnalysis = automaticGroupedReport(fixture);
    changedAnalysis.changes[0]!.title = "Reworded exact analysis input";
    changedAnalysis.fingerprint = changeReportFingerprint(changedAnalysis) as DoctorSourceSha256;
    const changed = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport: changedAnalysis, cacheRoot });
    assert.equal(changed.state, "compatible", changed.summary);
    assert.equal(calls, firstCalls + 1, "change-analysis inputs invalidate the explanation cache");
    const fourth = await reviewDoctorSourceChanges({ ...reviewInput(fixture), model: "different-reviewer", cacheRoot });
    assert.equal(fourth.state, "review_required", fourth.summary);
    assert.equal(calls, firstCalls + 1, "model changes do not reset the per-question attempt protection");
  } finally { restore(); fixture.cleanup(); }
});

test("production review requires change analysis and never falls back to byte units", async () => {
  const fixture = createFixture();
  let calls = 0;
  const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture), run() { calls++; throw new Error("No model call expected"); } });
  try {
    const { changeReport: _changeReport, ...input } = reviewInput(fixture);
    const result = await reviewDoctorSourceChanges(input);
    assert.equal(result.state, "review_required");
    assert.equal(calls, 0);
    assert.match(result.summary, /change analysis is missing/);
    assert.ok(result.findings?.some(finding => /does not fall back to byte-unit review/.test(finding.summary)));
  } finally { restore(); fixture.cleanup(); }
});

test("an unrelated unknown group stays blocking while supported groups are still explained", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture, undefined, 2);
  fixture.comparison.changes[0]!.relevance = "unresolved";
  fixture.comparison.changes[0]!.tweakersOwnership = null;
  fixture.comparison.changes[0]!.requiredChecks = [];
  let validations = 0, modelCalls = 0;
  const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture),
    validate: async () => { validations++; return validationFixture(fixture); },
    run(command, args, options) { modelCalls++; return boundedReviewDependencies(fixture).run(command, args, options); } });
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "review_required");
    assert.equal(validations, 1);
    assert.equal(modelCalls, 1);
    assert.ok(result.findings!.some(finding => finding.changeId === "block-0" && /unknown/.test(finding.summary)));
    assert.ok(result.findings!.some(finding => finding.changeId === "block-1" && finding.disposition === "compatible"));
  } finally { restore(); fixture.cleanup(); }
});

test("a nonblocking opaque group remains visible without blocking deterministic compatibility", async () => {
  const fixture = createFixture();
  let modelCalls = 0;
  const changeReport = groupedReport(fixture, [{
    ...groupedChange("opaque", "unknown", [{ kind: "static", artifact: "shipped_file", path: "Contents/Info.plist",
      beforeSha256: fixture.beforeHash, afterSha256: fixture.afterHash, detail: "Opaque asset bytes changed." }]),
    unknownPolicy: "acknowledgment",
  }]);
  const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture), run() { modelCalls++; throw new Error("No model call expected"); } });
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport });
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(modelCalls, 0);
    assert.equal(result.coverage?.completedUnits, 0, "an opaque terminal group was analyzed but not explained");
    assert.equal(result.coverage?.totalUnits, 0, "opaque limitations are not model questions");
    assert.ok(result.findings?.some(finding => finding.changeId === "opaque" && finding.disposition === "compatible" && /adoption acknowledgment/.test(finding.summary)));
  } finally { restore(); fixture.cleanup(); }
});

test("four exact deterministic oracles move opaque adoption gaps to acknowledgment with persisted policy evidence", async () => {
  const cases = [
    { area: "frontend", check: "frontend-patch-compatibility", oracleIds: ["inactive-thread-retention-patch", "accounts-native-patch"] },
    { area: "main", check: "main-process-patch-compatibility", oracleIds: ["window-services-patch"] },
    { area: "packaging", check: "asar-integrity-and-package-identity", oracleIds: ["before-asar-package-integrity", "after-asar-package-integrity"] },
    { area: "static_assets", check: "static-asset-integrity", oracleIds: ["before-source-bytes", "after-source-bytes"] },
  ] as const;
  for (const entry of cases) {
    const fixture = createFixture();
    fixture.comparison.changes[0]!.area = entry.area;
    fixture.comparison.changes[0]!.relevance = "unresolved";
    fixture.comparison.changes[0]!.tweakersOwnership = null;
    fixture.comparison.changes[0]!.requiredChecks = [entry.check];
    fixture.comparison.requiredChecks = [entry.check];
    const input = reviewInput(fixture);
    const originalFingerprint = input.changeReport.fingerprint;
    let modelCalls = 0;
    const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture), run() {
      modelCalls++;
      throw new Error("No model call expected for an opaque group");
    } });
    try {
      const result = await reviewDoctorSourceChanges(input);
      assert.equal(result.state, "compatible", `${entry.check}: ${result.summary}`);
      assert.equal(modelCalls, 0);
      assert.equal(input.changeReport.changes[0]!.unknownPolicy, "acknowledgment");
      assert.notEqual(input.changeReport.fingerprint, originalFingerprint);
      assert.equal(input.changeReport.fingerprint, changeReportFingerprint(input.changeReport));
      const finding = result.findings!.find(candidate => candidate.changeId === "block-0")!;
      assert.equal(finding.disposition, "compatible");
      for (const oracleId of entry.oracleIds) assert.match(finding.summary, new RegExp(oracleId));
    } finally { restore(); fixture.cleanup(); }
  }
});

test("an incomplete mapped oracle or unavailable exact source remains blocking", async () => {
  for (const variant of ["missing-oracle", "unavailable-source", "binding-drift"] as const) {
    const fixture = createFixture();
    fixture.comparison.changes[0]!.area = "frontend";
    fixture.comparison.changes[0]!.relevance = "unresolved";
    fixture.comparison.changes[0]!.tweakersOwnership = null;
    fixture.comparison.changes[0]!.requiredChecks = ["frontend-patch-compatibility"];
    fixture.comparison.requiredChecks = ["frontend-patch-compatibility"];
    const input = reviewInput(fixture);
    if (variant === "unavailable-source") {
      input.changeReport.limitations.push("Source evidence unavailable for Contents/Info.plist: fixture read failed");
      input.changeReport.fingerprint = changeReportFingerprint(input.changeReport) as DoctorSourceSha256;
    }
    const fixtureValidation = validationFixture(fixture);
    const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture),
      validate: async () => variant === "missing-oracle"
        ? { ...fixtureValidation, checks: fixtureValidation.checks.filter(check => check.id !== "accounts-native-patch") }
        : fixtureValidation,
      verifySource: variant === "binding-drift"
        ? () => ({ id: "fixture-binding", state: "failed" as const, summary: "Exact retained source changed", artifacts: [], commands: [], scope: "fixture" })
        : boundedReviewDependencies(fixture).verifySource,
      run() { throw new Error("No model call expected for a blocking unknown group"); },
    });
    try {
      const result = await reviewDoctorSourceChanges(input);
      assert.equal(result.state, "review_required");
      assert.equal(input.changeReport.changes[0]!.unknownPolicy, "blocking");
    } finally { restore(); fixture.cleanup(); }
  }
});

test("six compatibility gaps retain blocking policy and precise manual next actions", async () => {
  const cases = [
    ["schema", "generated-app-server-schema-compatibility", /generated schema files/],
    ["desktop_executables", "bundled-executable-compatibility", /Launch each changed bundled executable/],
    ["native_modules", "native-module-abi-compatibility", /exact candidate Electron and Node runtime/],
    ["backend", "backend-version-and-app-server-compatibility", /beyond initialize and model listing/],
    ["helpers", "helper-and-desktop-shell-compatibility", /candidate desktop shell/],
    ["plugin_runtime", "plugin-runtime-compatibility", /plugin discovery, install, configuration, sync, and uninstall/],
  ] as const;
  for (const [area, check, action] of cases) {
    const fixture = createFixture();
    fixture.comparison.changes[0]!.area = area;
    fixture.comparison.changes[0]!.relevance = "unresolved";
    fixture.comparison.changes[0]!.tweakersOwnership = null;
    fixture.comparison.changes[0]!.requiredChecks = [check];
    fixture.comparison.requiredChecks = [check];
    const input = reviewInput(fixture);
    const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture), run() {
      throw new Error("No model call expected for a blocking unknown group");
    } });
    try {
      const result = await reviewDoctorSourceChanges(input);
      assert.equal(result.state, "review_required", `${check}: ${result.summary}`);
      assert.equal(input.changeReport.changes[0]!.unknownPolicy, "blocking");
      const finding = result.findings!.find(candidate => candidate.changeId === "block-0")!;
      assert.equal(finding.disposition, "review_required");
      assert.ok(finding.proposedFixes.some(fix => action.test(fix)), `${check}: ${finding.proposedFixes.join("\n")}`);
    } finally { restore(); fixture.cleanup(); }
  }
});

test("byte-identical renames are explained in an actual bounded change-block call", async () => {
  const fixture = createFixture();
  const renamedHash = digest(Buffer.from("same renamed bytes"));
  fixture.comparison.renamedIdenticalArtifacts.push({ artifact: "asar_member", fromPath: "webview/old-chunk.js", toPath: "webview/new-chunk.js",
    sha256: renamedHash, relevance: "irrelevant", area: "frontend", tweakersOwnership: null, requiredChecks: [], reason: "Identical build output moved." });
  let observed = false;
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, body => {
    const rename = body.groups.find((group: any) => group.id === "rename-0");
    assert.ok(rename);
    assert.equal(rename.evidence[0].beforeSha256, renamedHash);
    assert.equal(rename.evidence[0].afterSha256, renamedHash);
    assert.match(rename.evidence[0].path, /old-chunk\.js -> webview\/new-chunk\.js/);
    observed = true;
  }));
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(observed, true);
  } finally { restore(); fixture.cleanup(); }
});

test("recorded failed and unsupported compatibility checks remain blocking while unrelated analysis continues", async () => {
  const fixture = createFixture();
  let calls = 0;
  const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture),
    validate: async () => ({ ...validationFixture(fixture), checks: [
      ...validationFixture(fixture).checks.filter(check => check.id !== "accounts-native-patch"),
      { id: "accounts-native-patch", state: "failed", summary: "The replacement Accounts source is not reviewed", artifacts: ["webview/assets/profile-new.js"], commands: [], scope: "Accounts native source patch" },
      { id: "binary-runtime", state: "unsupported", summary: "Native runtime fixture unavailable", artifacts: ["Contents/Resources/helper"], commands: [], scope: "helper ABI" },
    ] }), run(command, args, options) { calls++; return boundedReviewDependencies(fixture).run(command, args, options); } });
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "fixes_required");
    assert.equal(calls, 1);
    assert.ok((result.findings?.length ?? 0) >= 2);
    assert.equal(result.findings![0]!.path, "webview/assets/profile-new.js");
    assert.deepEqual(result.findings![0]!.requiredChecks, ["accounts-native-patch"]);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  } finally { restore(); fixture.cleanup(); }
});

test("a compatible model answer without substantive implementation citations is rejected", async () => {
  const fixture = createFixture();
  const deps = boundedReviewDependencies(fixture);
  const executionPaths: string[] = [];
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const result = deps.run(command, args, options);
    const file = args[args.indexOf("--output-last-message") + 1]!;
    executionPaths.push(file);
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.groups[0].sourceReferences = [];
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "review_required");
    assert.equal(result.coverage?.completedUnits, 0);
    assert.ok(result.findings!.some(finding => /citations/.test(finding.summary)));
    assert.equal(executionPaths.length, 2, "one initial and one corrective request");
    assert.equal(new Set(executionPaths).size, 2, "each execution retains separate output");
    const resumed = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(executionPaths.length, 2, "restart cannot repeat the failed packet");
    assert.equal(resumed.state, "review_required");
  } finally { restore(); fixture.cleanup(); }
});

test("a rejected question gets one distinct targeted evidence followup without changing question progress", async () => {
  const fixture = createFixture();
  const path = "Contents/Resources/followup-settings.js";
  const beforeUnit = 'function settings(){return {id:"settings.account",defaultMessage:"Before",label:"Open account"}}';
  const afterUnit = 'function settings(){return {id:"settings.account",defaultMessage:"After",label:"Open profile"}}';
  const padding = `/*${" retained surrounding workflow ".repeat(20)}*/\n`;
  const beforeText = `function surrounding(){return "old account workflow"}\n${padding}${beforeUnit}\n${padding}`;
  const afterText = `function surrounding(){return "new profile workflow"}\n${padding}${afterUnit}\n${padding}`;
  const beforePath = join(fixture.before.appPath, path), afterPath = join(fixture.after.appPath, path);
  mkdirSync(dirname(beforePath), { recursive: true });
  mkdirSync(dirname(afterPath), { recursive: true });
  writeFileSync(beforePath, beforeText); writeFileSync(afterPath, afterText);
  const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
  fixture.before.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 }];
  fixture.after.shippedFiles = [{ path, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 }];
  fixture.comparison.changes = [{ ...fixture.comparison.changes[0]!, path, beforeSha256, afterSha256, area: "frontend" }];
  const focus = (source: string, unit: string) => ({ offset: Buffer.byteLength(source.slice(0, source.indexOf(unit))), bytes: Buffer.byteLength(unit) });
  const beforeFocus = 'defaultMessage:"Before"', afterFocus = 'defaultMessage:"After"';
  const evidence: DoctorChangeV1["evidence"][number] = { kind: "static", artifact: "shipped_file", path, beforeSha256, afterSha256,
    beforeRange: { offset: 0, bytes: Buffer.byteLength(beforeText) }, afterRange: { offset: 0, bytes: Buffer.byteLength(afterText) },
    beforeFocus: focus(beforeText, beforeFocus),
    afterFocus: focus(afterText, afterFocus), beforeSourceBytes: Buffer.byteLength(beforeText), afterSourceBytes: Buffer.byteLength(afterText),
    detail: "The account settings label changed." };
  const changeReport = groupedReport(fixture, [{ ...groupedChange("followup-settings", "inferred_from_code", [evidence]), area: "frontend",
    compatibility: ["asar-integrity-and-package-identity"] }]);
  assert.deepEqual(prepareDoctorGroupedReviewPlan(changeReport, fixture.comparison).blockers, []);
  const deps = boundedReviewDependencies(fixture);
  const requestKinds: boolean[] = [];
  const progress: string[] = [];
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const body = JSON.parse(options.input.split("\n\n").at(-1)!);
    const expansion = body.binding?.expansion === true;
    requestKinds.push(expansion);
    const result = deps.run(command, args, options);
    if (!expansion) {
      const output = args[args.indexOf("--output-last-message") + 1]!;
      const response = JSON.parse(readFileSync(output, "utf8"));
      response.groups[0].sourceReferences = [];
      writeFileSync(output, JSON.stringify(response), { mode: 0o600 });
    } else {
      const output = args[args.indexOf("--output-last-message") + 1]!;
      const response = JSON.parse(readFileSync(output, "utf8"));
      response.groups[0].changelogEntries = [];
      response.groups[0].unresolvedReason = "Broader verified source context still does not establish an operator-facing behavior change.";
      writeFileSync(output, JSON.stringify(response), { mode: 0o600 });
    }
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport,
      onProgress: (message: string) => { progress.push(message); } });
    assert.equal(result.coverage?.totalUnits, 1, result.summary);
    assert.deepEqual(requestKinds, [false, false, true], "two rejected attempts receive one distinct targeted followup");
    assert.equal(result.coverage?.completedUnits, 1);
    assert.ok(progress.some(message => /1\/1 targeted evidence followups completed/.test(message)));
  } finally { restore(); fixture.cleanup(); }
});

test("retained changelog entries survive deterministic resume while an unrecovered group is invalidated", async () => {
  const fixture = createFixture();
  const changes: DoctorSourceComparison["changes"] = [];
  const reportChanges: DoctorChangeV1[] = [];
  for (const [index, name] of ["account", "terminal"].entries()) {
    const path = `Contents/Resources/${name}-resume.js`;
    const beforeText = `function ${name}(){return {defaultMessage:"Before ${name}"}}`;
    const afterText = `function ${name}(){return {defaultMessage:"After ${name}"}}`;
    const beforePath = join(fixture.before.appPath, path), afterPath = join(fixture.after.appPath, path);
    mkdirSync(dirname(beforePath), { recursive: true }); mkdirSync(dirname(afterPath), { recursive: true });
    writeFileSync(beforePath, beforeText); writeFileSync(afterPath, afterText);
    const beforeSha256 = digest(Buffer.from(beforeText)), afterSha256 = digest(Buffer.from(afterText));
    fixture.before.shippedFiles.push({ path, kind: "file", bytes: Buffer.byteLength(beforeText), sha256: beforeSha256 });
    fixture.after.shippedFiles.push({ path, kind: "file", bytes: Buffer.byteLength(afterText), sha256: afterSha256 });
    changes.push({ ...fixture.comparison.changes[0]!, path, beforeSha256, afterSha256, area: "frontend" });
    reportChanges.push({ ...groupedChange(`resume-${name}`, "inferred_from_code", [{ kind: "static", artifact: "shipped_file", path,
      beforeSha256, afterSha256, detail: `${name} wording changed.` }]), area: "frontend",
      compatibility: ["asar-integrity-and-package-identity"] });
  }
  fixture.comparison.changes = changes;
  const changeReport = groupedReport(fixture, reportChanges);
  changeReport.changelog = { schemaVersion: 1, entries: [], unresolved: [] };
  for (const change of changeReport.changes) {
    const body = { method: "model" as const, category: "Changed" as const, title: `Retained ${change.id} workflow`,
      workflow: `Open the retained ${change.id} view`, before: "The view showed the prior wording.", after: "The view shows the updated wording.",
      status: "inferred_from_code" as const, origin: "upstream" as const,
      evidenceReferences: [{ id: `${change.id}:evidence:0`, sha256: reviewDigest(change.evidence[0]!) }],
      limitations: ["Static source evidence only."], dependencies: [] as string[], analysisGroupIds: [change.id] };
    changeReport.changelog!.entries.push({ id: changelogEntryId(body), ...body });
  }
  changeReport.reviewProgress = { version: 1, policy: "finish_automatically", stage: "ready",
    files: { total: 2, accounted: 2 }, questions: { total: 2, completed: 2, reused: 2 }, entries: 2, limitations: 0 };
  changeReport.fingerprint = changeReportFingerprint(changeReport) as DoctorSourceSha256;
  const deps = boundedReviewDependencies(fixture);
  let retainedDuringValidation = false;
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const result = deps.run(command, args, options);
    const output = args[args.indexOf("--output-last-message") + 1]!;
    const response = JSON.parse(readFileSync(output, "utf8"));
    response.groups = response.groups.map((group: any) => group.id === "resume-account" ? { ...group, sourceReferences: [] } : group);
    writeFileSync(output, JSON.stringify(response), { mode: 0o600 });
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), changeReport, onProgress: (message: string) => {
      if (message.startsWith("Running deterministic")) retainedDuringValidation = changeReport.changelog?.entries.length === 2;
    } });
    assert.equal(retainedDuringValidation, true, "deterministic validation does not blank exact retained changelog entries");
    assert.equal(result.state, "review_required");
    assert.equal(changeReport.changelog?.entries.some(entry => entry.analysisGroupIds.includes("resume-account")), false);
    assert.equal(changeReport.changelog?.entries.some(entry => entry.analysisGroupIds.includes("resume-terminal")), true);
  } finally { restore(); fixture.cleanup(); }
});

test("one invalid group citation does not discard unrelated valid explanations", async () => {
  const fixture = createFixture();
  makeLargeFixture(fixture, undefined, 2);
  const input = reviewInput(fixture);
  const deps = boundedReviewDependencies(fixture);
  const cacheRoot = join(fixture.root, "partial-cache");
  const requestedGroupCounts: number[] = [];
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    const result = deps.run(command, args, options);
    const output = args[args.indexOf("--output-last-message") + 1]!;
    const body = JSON.parse(readFileSync(output, "utf8"));
    requestedGroupCounts.push(body.groups.length);
    body.groups[0].evidenceReferences[0].sha256 = `sha256:${"f".repeat(64)}`;
    writeFileSync(output, JSON.stringify(body), { mode: 0o600 });
    return result;
  } });
  try {
    const result = await reviewDoctorSourceChanges({ ...input, cacheRoot });
    assert.equal(result.state, "review_required");
    assert.equal(result.coverage?.completedUnits, 1);
    assert.equal(input.changeReport.changes.filter(change => change.explanation).length, 1);
    assert.ok(result.findings?.some(finding => /incorrect digest/.test(finding.summary)));
    const resumed = await reviewDoctorSourceChanges({ ...input, cacheRoot, outputRoot: join(fixture.packet, "review-partial-resume") });
    assert.equal(resumed.state, "review_required");
    assert.deepEqual(requestedGroupCounts, [2, 1], "resume requests only the invalid group from a partial exact checkpoint");
    assert.equal(resumed.coverage?.completedUnits, 1);
    assert.equal(resumed.coverage?.reusedUnits, 1);
  } finally { restore(); fixture.cleanup(); }
});

test("source drift after review cannot be approved even with complete cached decisions", async () => {
  const fixture = createFixture();
  const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture),
    verifySource: () => ({ id: "source-drift", state: "failed", summary: "Retained source bytes changed", artifacts: [], commands: [], scope: "exact retained inventory" }) });
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "review_required");
    assert.ok(result.findings!.some(finding => /Retained source bytes changed/.test(finding.summary)));
  } finally { restore(); fixture.cleanup(); }
});

test("model explanations cannot add compatibility judgments and exact replies are cached", async () => {
  const fixture = createFixture();
  const deps = boundedReviewDependencies(fixture);
  let calls = 0;
  const restore = setDoctorSourceReviewDependenciesForTest({ ...deps, run(command, args, options) {
    calls++;
    const result = deps.run(command, args, options);
    const path = args[args.indexOf("--output-last-message") + 1]!;
    const body = JSON.parse(readFileSync(path, "utf8"));
    body.groups[0].summary = "I claim compatibility, but this remains explanation text only.";
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    return result;
  } });
  try {
    let firstCalls = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await reviewDoctorSourceChanges(reviewInput(fixture));
      assert.equal(result.state, "compatible");
      assert.ok(result.findings!.some(finding => /explanation text only/.test(finding.summary)));
      if (attempt === 0) firstCalls = calls;
      else assert.equal(calls, firstCalls, "the second review reuses all exact-input decisions");
    }
    assert.ok(calls > 0);
  } finally { restore(); fixture.cleanup(); }
});

test("unmapped requirements and missing observed checks stop before paid review", async () => {
  for (const variant of ["unknown", "missing"] as const) {
    const fixture = createFixture();
    if (variant === "unknown") fixture.comparison.requiredChecks.push("unmapped-check" as never);
    let calls = 0;
    const restore = setDoctorSourceReviewDependenciesForTest({ ...boundedReviewDependencies(fixture),
      validate: async () => ({ ...validationFixture(fixture), checks: [] }),
      run() { calls++; throw new Error("No paid review expected"); } });
    try {
      const result = await reviewDoctorSourceChanges(reviewInput(fixture));
      assert.equal(result.state, "review_required");
      assert.equal(calls, 0);
      assert.ok(result.findings!.some(finding => /mapped|recorded result/.test(finding.summary)));
    } finally { restore(); fixture.cleanup(); }
  }
});

test("change-block prompts cite scoped implementation hashes without embedding global source", async () => {
  const fixture = createFixture();
  for (let index = 0; index < 2; index++) writeFileSync(join(fixture.tweakersSourceRoot, `patch-${index}.js`), `/*${"source".repeat(20)}*/\nconst tail${index} = true;`);
  let sawMain = false;
  const deps = boundedReviewDependencies(fixture, body => {
    assert.equal("units" in body, false);
    assert.equal("chunks" in body, false);
    sawMain = body.sources.some((source: any) => source.path.endsWith("main.js"));
    assert.equal(body.sources.some((source: any) => /patch-[01]\.js$/.test(source.path)), false);
    assert.ok(body.sources.every((source: any) => typeof source.text === "string" && Buffer.byteLength(source.text) <= 768));
    assert.ok(body.sources.every((source: any) => source.excerptSha256 === digest(Buffer.from(source.text))));
  });
  const restore = setDoctorSourceReviewDependenciesForTest(deps);
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(sawMain, true);
    assert.equal(result.state, "compatible");
  } finally { restore(); fixture.cleanup(); }
});

test("bounded review binds unchanged installed runtime evidence and rejects baseline drift", async () => {
  for (const drift of [false, true]) {
    const fixture = createFixture();
    makeLargeFixture(fixture, undefined, 1);
    const installedRuntimeRoot = join(fixture.root, "installed-runtime");
    mkdirSync(installedRuntimeRoot);
    writeFileSync(join(installedRuntimeRoot, "main.js"), readFileSync(join(fixture.tweakersSourceRoot, "main.js")));
    let observed = false;
    const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, body => {
      assert.ok(body.binding.installedRuntimeFingerprint);
      observed = true;
      if (drift) writeFileSync(join(installedRuntimeRoot, "main.js"), "export const changed = true;");
    }));
    try {
      const result = await reviewDoctorSourceChanges({ ...reviewInput(fixture), installedRuntimeRoot });
      assert.equal(observed, true);
      assert.equal(result.state, drift ? "review_required" : "compatible");
      if (drift) assert.ok(result.findings?.some(finding => finding.id === "review.installed-runtime-drift"));
    } finally { restore(); fixture.cleanup(); }
  }
});


test("Doctor packets use a pooled execution home and reconcile reservations without replay", async () => {
  const { executeDoctorReviewRequest, reconcileDoctorReviewPool } = await import("./doctor-review-orchestrator.js");
  const { readDoctorReviewUsage } = await import("./doctor-review-budget.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-pool-")));
  try {
    for (const scenario of ["success", "unavailable", "mark_failed", "spawn_failed", "settle_failed"] as const) {
      const cacheRoot = join(root, scenario); mkdirSync(cacheRoot, { mode: 0o700 });
      const calls: string[] = []; let providerCalls = 0;
      let failSettlement = scenario === "settle_failed";
      const client: import("./doctor-review.js").DoctorReviewExecutionClient = {
        async acquireDoctorReviewLease(input) {
          calls.push("acquire"); assert.match(input.requestId, /^[a-f0-9-]{36}$/);
          if (scenario === "unavailable") return { status: "unavailable", reason: "pool_depleted" };
          return { status: "ready", leaseId: "lease_test", opaqueAccountId: "ar_abcdefghijklmnop", codexHome: root };
        },
        async markDoctorReviewLeaseDispatched() {
          calls.push("mark");
          return scenario === "mark_failed" ? { status: "unavailable", reason: "broker_unavailable" } : { status: "dispatched", leaseId: "lease_test" };
        },
        async settleDoctorReviewLease(input) {
          calls.push(input.outcome);
          if (failSettlement) throw new Error("lost settlement response");
          return { status: "settled", leaseId: input.leaseId, outcome: input.outcome };
        },
        close() { calls.push("close"); },
      };
      const input = { brokerRoot: root, cacheRoot, binding: "pool-test", requestKey: scenario,
        outputPath: join(cacheRoot, "output.json"), reviewerBinary: "codex", model: "test-model", effort: "medium",
        outputRoot: root, schemaPath: join(root, "schema.json"), prompt: "bounded packet", metadata: { evidenceFingerprint: scenario } };
      const execute = () => executeDoctorReviewRequest(input, { simulationOnly: true, executionClient: () => client, run(_command, _args, options) {
        providerCalls++; assert.ok(_args.includes('cli_auth_credentials_store="file"')); assert.equal(options.env.CODEX_HOME, root); assert.equal(options.env.HOME, process.env.HOME ?? homedir());
        assert.ok(calls.includes("mark"), "reserve selected account before dispatch");
        if (scenario === "spawn_failed") throw new Error("uncertain provider execution");
        return { status: 0, stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 90, output_tokens: 10 } }) };
      } });
      if (scenario === "success") await execute(); else await assert.rejects(execute);
      const ledger = readDoctorReviewUsage(cacheRoot, input.binding);
      assert.equal(calls.at(-1), "close");
      assert.equal(providerCalls, ["success", "spawn_failed", "settle_failed"].includes(scenario) ? 1 : 0);
      if (scenario === "unavailable") assert.equal(ledger.requests.length, 0);
      else {
        const request = ledger.requests[0]!;
        assert.equal(request.metadata?.opaqueAccountId, "ar_abcdefghijklmnop");
        if (scenario === "success") assert.equal(request.metadata?.executionSettled, true);
        if (scenario === "mark_failed") {
          assert.equal(request.metadata?.executionStatus, "not_dispatched");
          assert.deepEqual(request.usage, { inputTokens: 0, outputTokens: 0 });
        }
        if (scenario === "spawn_failed") {
          assert.equal(request.usage, null);
          await assert.rejects(execute, /Previous review usage/);
          assert.equal(providerCalls, 1);
        }
        if (scenario === "settle_failed") {
          assert.deepEqual(request.usage, { inputTokens: 90, outputTokens: 10 });
          failSettlement = false;
          await reconcileDoctorReviewPool(input, client);
          assert.equal(readDoctorReviewUsage(cacheRoot, input.binding).requests[0]!.metadata?.executionSettled, true);
          assert.equal(providerCalls, 1, "settlement recovery must never replay paid work");
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pinned SDK stays closed until every reviewer safeguard is proven", async () => {
  const { DOCTOR_SDK_CAPABILITIES, selectDoctorExecutionAdapter } = await import("./doctor-review-execution.js");
  assert.equal(DOCTOR_SDK_CAPABILITIES.ephemeral, false);
  assert.equal(DOCTOR_SDK_CAPABILITIES.ignoreUserConfig, false);
  assert.equal(DOCTOR_SDK_CAPABILITIES.shellDisabled, false);
  const adapter = selectDoctorExecutionAdapter({ run() { throw new Error("Execution not expected"); } });
  assert.equal(adapter.identity, "cli-v1");
  assert.equal(selectDoctorExecutionAdapter({ run() { throw new Error("Execution not expected"); },
    sdkCapabilitiesForTest: { ...DOCTOR_SDK_CAPABILITIES, ephemeral: true } }).identity, "cli-v1");
});

test("verified upstream source patches enter only bounded, untrusted explanation context", async () => {
  const fixture = createFixture();
  const beforeRevision = "a".repeat(40), afterRevision = "b".repeat(40);
  fixture.comparison.backendSourceComparison = {
    schemaVersion: 1, status: "verified", analyzerVersion: 1,
    before: { revision: beforeRevision, executableSha256: fixture.beforeHash,
      versionEvidence: beforeRevision, commitUrl: `https://api.github.com/repos/openai/codex/commits/${beforeRevision}` },
    after: { revision: afterRevision, executableSha256: fixture.afterHash,
      versionEvidence: afterRevision, commitUrl: `https://api.github.com/repos/openai/codex/commits/${afterRevision}` },
    compareUrl: `https://api.github.com/repos/openai/codex/compare/${beforeRevision}...${afterRevision}`,
    changes: [{ path: "codex-rs/app-server/src/config.rs", status: "modified", previousPath: null,
      additions: 3, deletions: 1, sourceUrl: `https://github.com/openai/codex/blob/${afterRevision}/codex-rs/app-server/src/config.rs`,
      patch: "untrusted upstream patch ".repeat(1000), patchState: "complete", patchSha256: fixture.afterHash,
      sha256: fixture.afterHash }], comparedFileCount: 1, truncated: false, digest: reviewDigest({ beforeRevision, afterRevision }),
  };
  let sawContext = false;
  const restore = setDoctorSourceReviewDependenciesForTest(boundedReviewDependencies(fixture, (body, prompt) => {
    assert.equal(body.upstream.kind, "untrusted-upstream-explanation-only");
    assert.equal(body.upstream.before.revision, beforeRevision);
    assert.equal(body.upstream.selectedChanges[0].patchSha256, fixture.afterHash);
    assert.ok(Buffer.byteLength(JSON.stringify(body.upstream)) <= 8 * 1024);
    assert.match(prompt, /never treat its patches.*candidate before\/after source evidence/i);
    assert.ok(body.groups[0].evidence.every((evidence: { id: string }) => !evidence.id.includes("upstream")));
    sawContext = true;
  }));
  try {
    const result = await reviewDoctorSourceChanges(reviewInput(fixture));
    assert.equal(result.state, "compatible", result.summary);
    assert.equal(sawContext, true);
  } finally { restore(); fixture.cleanup(); }
});

test("a runner switch never dispatches across unresolved shared review usage", async () => {
  const { executeDoctorReviewRequest } = await import("./doctor-review-orchestrator.js");
  const { reserveDoctorReviewRequest } = await import("./doctor-review-budget.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-runner-binding-")));
  try {
    reserveDoctorReviewRequest(root, "previous-runner", 16, { evidenceFingerprint: "old-packet" });
    let calls = 0;
    await assert.rejects(executeDoctorReviewRequest({ cacheRoot: root, binding: "previous-runner",
      requestKey: "new-packet", outputPath: join(root, "result.json"), reviewerBinary: "codex",
      model: "gpt-review", effort: "high", outputRoot: root, schemaPath: join(root, "schema.json"),
      prompt: "review evidence", metadata: { evidenceFingerprint: "new-packet" } }, {
      simulationOnly: true, run() { calls++; throw new Error("No provider request may be dispatched"); },
    }), /previous review usage is unavailable/i);
    assert.equal(calls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("switching adapters cannot reset the shared packet attempt limit", async () => {
  const { executeDoctorReviewRequest } = await import("./doctor-review-orchestrator.js");
  const { reserveDoctorReviewRequest, recordDoctorReviewUsage, readDoctorReviewUsage } = await import("./doctor-review-budget.js");
  const { DOCTOR_SDK_CAPABILITIES } = await import("./doctor-review-execution.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-shared-attempts-")));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = reserveDoctorReviewRequest(root, "candidate-pair", 16, {
        evidenceFingerprint: "packet", questionIds: ["same-question"], expansion: false });
      recordDoctorReviewUsage(root, "candidate-pair", id, { inputTokens: 5, outputTokens: 1 });
    }
    let sdkCalls = 0;
    await assert.rejects(executeDoctorReviewRequest({ cacheRoot: root, binding: "candidate-pair",
      requestKey: "packet", outputPath: join(root, "result.json"), reviewerBinary: "codex",
      model: "gpt-review", effort: "high", outputRoot: root, schemaPath: join(root, "schema.json"),
      prompt: "review evidence", metadata: { evidenceFingerprint: "packet", questionIds: ["same-question"], expansion: false } }, {
      simulationOnly: true, run() { throw new Error("CLI must not run after SDK selection"); },
      sdkCapabilitiesForTest: Object.fromEntries(Object.keys(DOCTOR_SDK_CAPABILITIES).map(key => [key, true])) as unknown as typeof DOCTOR_SDK_CAPABILITIES,
      sdkClientForTest() { sdkCalls++; throw new Error("No provider request may be sent"); },
    }), /initial and corrective attempts/i);
    assert.equal(sdkCalls, 0);
    assert.equal(readDoctorReviewUsage(root, "candidate-pair").requests.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("simulated SDK execution pins the reviewer and retains bounded structured output and usage", async () => {
  const { DOCTOR_SDK_CAPABILITIES, selectDoctorExecutionAdapter } = await import("./doctor-review-execution.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-sdk-")));
  const schemaPath = join(root, "schema.json"), outputPath = join(root, "result.json");
  const reviewerBinary = join(root, "codex-reviewer");
  writeFileSync(reviewerBinary, "fixture reviewer");
  chmodSync(reviewerBinary, 0o755);
  writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }));
  chmodSync(schemaPath, 0o600);
  let calls = 0;
  try {
    const adapter = selectDoctorExecutionAdapter({ simulationOnly: true, run() { throw new Error("CLI fallback is forbidden after dispatch"); },
      sdkCapabilitiesForTest: Object.fromEntries(Object.keys(DOCTOR_SDK_CAPABILITIES).map(key => [key, true])) as unknown as typeof DOCTOR_SDK_CAPABILITIES,
      sdkClientForTest(options) {
        assert.equal(options.codexPathOverride, reviewerBinary);
        assert.equal(options.env?.CODEX_HOME, root);
        assert.equal(options.config?.project_doc_max_bytes, 0);
        return { startThread(threadOptions: import("@openai/codex-sdk").ThreadOptions) {
          assert.equal(threadOptions.sandboxMode, "read-only");
          assert.equal(threadOptions.model, "gpt-review");
          assert.equal(threadOptions.modelReasoningEffort, "high");
          assert.equal(threadOptions.webSearchMode, "disabled");
          assert.equal(threadOptions.workingDirectory, root);
          return { async runStreamed(prompt: import("@openai/codex-sdk").Input, turnOptions: import("@openai/codex-sdk").TurnOptions) {
            calls++;
            assert.equal(prompt, "review evidence");
            assert.deepEqual(turnOptions.outputSchema, JSON.parse(readFileSync(schemaPath, "utf8")));
            return { events: (async function* () {
              yield { type: "item.completed", item: { type: "agent_message", id: "message", text: '{"ok":true}' } };
              yield { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2,
                cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
            })() };
          } } as unknown as import("@openai/codex-sdk").Thread;
        } } as unknown as import("./doctor-review-execution.js").DoctorSdkClient;
      },
    });
    assert.equal(adapter.identity, "sdk-0.154.0");
    const result = await adapter.execute({ reviewerBinary, model: "gpt-review", effort: "high",
      outputRoot: root, schemaPath, outputPath, prompt: "review evidence", codexHome: root });
    assert.equal(result.status, 0);
    assert.match(result.stdout ?? "", /"input_tokens":5/);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), { ok: true });
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Doctor model pause prevents account reservations, usage reservations and both dispatch adapters", async () => {
  const { executeDoctorReviewRequest } = await import("./doctor-review-orchestrator.js");
  const { selectDoctorExecutionAdapter, DOCTOR_SDK_CAPABILITIES } = await import("./doctor-review-execution.js");
  const { readDoctorReviewUsage } = await import("./doctor-review-budget.js");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-model-pause-")));
  let calls = 0;
  const input = { brokerRoot: root, cacheRoot: root, binding: "paused", requestKey: "paused", outputPath: join(root, "result.json"), reviewerBinary: "codex", model: "gpt-6-astra", effort: "high", outputRoot: root, schemaPath: join(root, "schema.json"), prompt: "must not be sent", metadata: { stage: "change_explanation" } };
  try {
    for (const sdk of [false, true]) {
      const dependencies = { run() { calls++; throw Error("Unexpected CLI dispatch"); },
        executionClient() { calls++; throw Error("Unexpected account access"); },
        ...(sdk ? { sdkCapabilitiesForTest: Object.fromEntries(Object.keys(DOCTOR_SDK_CAPABILITIES).map(k => [k, true])) as unknown as typeof DOCTOR_SDK_CAPABILITIES,
          sdkClientForTest() { calls++; throw Error("Unexpected SDK dispatch"); } } : {}) };
      await assert.rejects(executeDoctorReviewRequest(input, dependencies), /model execution is disabled/);
      await assert.rejects(async () => selectDoctorExecutionAdapter(dependencies).execute(input), /model execution is disabled/);
    }
    assert.equal(calls, 0);
    assert.equal(readDoctorReviewUsage(root, "paused").requests.length, 0);
    assert.equal(existsSync(input.outputPath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
