import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  nativeThreadInventoryFingerprint,
} from "../src/portable-continuity-projection.ts";
import {
  applyPortableHandoff,
  inspectPortableHandoff,
  portableContinuityPaths,
  previewPortableHandoff,
  recoverPortableHandoff,
  type PortableContinuityDependencies,
  type PortableEndpointV1,
  type PortableHandoffInputV2,
} from "../src/portable-settings-continuity.ts";

const NOW = "2026-09-05T19:30:00.000Z";
const SOURCE_KEY = `sha256:${"a".repeat(64)}` as const;
const DESTINATION_KEY = `sha256:${"b".repeat(64)}` as const;
const THREAD = "native-thread-alpha";
const INVENTORY_FINGERPRINT = nativeThreadInventoryFingerprint([THREAD]);

interface Fixture {
  root: string;
  input: Omit<PortableHandoffInputV2, "transactionId" | "apply">;
  deps: PortableContinuityDependencies;
  destinationGlobal: string;
  destinationProjects: string;
  destinationConfig: string;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-portable-continuity-"));
  chmodSync(root, 0o700);
  const sourceCodex = join(root, "source-codex");
  const sourceTweakers = join(root, "source-tweakers");
  const destinationCodex = join(root, "destination-codex");
  const destinationTweakers = join(root, "destination-tweakers");
  const globalRoot = join(root, "global");
  const sourceApp = join(root, "Source.app");
  const destinationApp = join(root, "Destination.app");
  for (const path of [
    sourceCodex, sourceTweakers, destinationCodex, destinationTweakers, globalRoot, sourceApp, destinationApp,
    join(sourceTweakers, "tweak-data", "co.tweakers.projects"),
    join(destinationTweakers, "tweak-data", "co.tweakers.projects"),
    join(destinationTweakers, "tweaks", "co.tweakers.projects"),
  ]) privateDirectory(path);

  privateJson(join(sourceCodex, ".codex-global-state.json"), {
    "local-projects": {
      "local-one": { id: "local-one", name: "One", rootPaths: ["/Users/example/Projects/one"], sourcePrivate: "never-copy" },
    },
    "electron-workspace-root-labels": { "/Users/example/Projects/one": "One" },
    "electron-persisted-atom-state": {
      "selected-project": { type: "local", projectId: "local-one" },
      "pinned-thread-ids": [THREAD],
      appearanceTheme: "dark",
      authorization: "source-only-secret",
    },
    sourceConnectionState: "never-copy",
  });
  const destinationGlobal = join(destinationCodex, ".codex-global-state.json");
  privateJson(destinationGlobal, {
    destinationOnly: "preserved",
    "electron-persisted-atom-state": { destinationConnection: "preserved" },
  });

  privateJson(join(sourceTweakers, "tweak-data", "co.tweakers.projects", "projects-v1.json"), {
    schemaVersion: 1,
    nodes: [
      { id: "group-one", type: "group", parentId: null, name: "Group", icon: { kind: "emoji", value: "📁" }, color: "#112233" },
      { id: "project-one", type: "project", parentId: "group-one", name: "Project", icon: { kind: "iconify", value: "lucide:folder" }, color: "#334455", pinnedTaskIds: [THREAD], connections: { token: "never-copy" } },
    ],
  });
  const destinationProjects = join(destinationTweakers, "tweak-data", "co.tweakers.projects", "projects-v1.json");

  privateJson(join(sourceTweakers, "config.json"), {
    tweaks: { "co.tweakers.projects": { enabled: true, credential: "never-copy" } },
    sourceOnly: "never-copy",
  });
  const destinationConfig = join(destinationTweakers, "config.json");
  privateJson(destinationConfig, { destinationOnly: "preserved" });
  privateJson(join(destinationTweakers, "tweaks", "co.tweakers.projects", "manifest.json"), { id: "co.tweakers.projects" });

  const source: PortableEndpointV1 = {
    endpointKey: SOURCE_KEY,
    appBundlePath: sourceApp,
    codexHomeRoot: sourceCodex,
    tweakersRoot: sourceTweakers,
    bundleSchemaFingerprint: CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  };
  const destination: PortableEndpointV1 = {
    endpointKey: DESTINATION_KEY,
    appBundlePath: destinationApp,
    codexHomeRoot: destinationCodex,
    tweakersRoot: destinationTweakers,
    bundleSchemaFingerprint: CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  };
  const deps: PortableContinuityDependencies = {
    readNativeThreadInventory: () => ({ state: "ready", fingerprint: INVENTORY_FINGERPRINT, threadIds: [THREAD] }),
    census: () => ({ observedAt: NOW, state: "zero", openFileCount: 0, unexpectedProcessCount: 0 }),
    wait: () => undefined,
    now: () => NOW,
    verifyBundleSchema: (endpoint) => endpoint.bundleSchemaFingerprint,
  };
  return {
    root,
    input: { globalRoot, source, destination, nativeThreadInventoryStateRoot: globalRoot },
    deps,
    destinationGlobal,
    destinationProjects,
    destinationConfig,
  };
}

function previewInput(f: Fixture, transactionId: string) {
  return { ...f.input, transactionId, apply: false as const };
}

function applyFromPreview(f: Fixture, transactionId: string, preview: ReturnType<typeof previewPortableHandoff>) {
  if (preview.intentFingerprint === null || preview.precondition === null) throw new Error("fixture preview did not produce an apply proof");
  return applyPortableHandoff({
    ...f.input,
    transactionId,
    apply: true,
    expectedIntentFingerprint: preview.intentFingerprint,
    precondition: preview.precondition,
  }, f.deps);
}

test("a proof-bound cold handoff publishes only portable state and a receipt last", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const transactionId = "portable-continuity-apply-a";
  // Native Codex and installed tweak containers use ordinary owner-owned modes.
  for (const root of [f.input.source.codexHomeRoot, f.input.destination.codexHomeRoot, join(f.input.destination.tweakersRoot, "tweaks")]) chmodSync(root, 0o755);
  const sourceGlobal = join(f.input.source.codexHomeRoot, ".codex-global-state.json");
  for (const path of [sourceGlobal, f.destinationGlobal]) chmodSync(path, 0o644);
  const sourceBytes = readFileSync(sourceGlobal);
  const sourceIdentity = lstatSync(f.input.source.codexHomeRoot);
  const preview = previewPortableHandoff(previewInput(f, transactionId), f.deps);
  assert.equal(preview.status, "preview");
  assert.equal(preview.precondition?.kind, "already-idle");

  const result = applyFromPreview(f, transactionId, preview);
  assert.equal(result.status, "applied");
  assert.equal(lstatSync(f.input.source.codexHomeRoot).ino, sourceIdentity.ino);
  assert.equal(lstatSync(f.input.source.codexHomeRoot).mode & 0o777, 0o755);
  assert.equal(lstatSync(f.input.destination.codexHomeRoot).mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(sourceGlobal), sourceBytes);
  assert.equal(lstatSync(sourceGlobal).mode & 0o777, 0o644);
  const global = readJson(f.destinationGlobal);
  const atoms = global["electron-persisted-atom-state"] as Record<string, unknown>;
  const config = readJson(f.destinationConfig);
  const projects = readJson(f.destinationProjects);
  assert.equal(global.destinationOnly, "preserved");
  assert.equal(atoms.destinationConnection, "preserved");
  assert.equal(Object.hasOwn(atoms, "authorization"), false);
  assert.equal(Object.hasOwn(global, "sourceConnectionState"), false);
  assert.deepEqual(atoms["pinned-thread-ids"], [THREAD]);
  assert.equal((config.tweaks as Record<string, Record<string, unknown>>)["co.tweakers.projects"]!.enabled, true);
  assert.equal(Object.hasOwn(config, "sourceOnly"), false);
  assert.equal(((projects.nodes as Array<Record<string, unknown>>)[1] as Record<string, unknown>).connections, undefined);

  const paths = portableContinuityPaths(f.input.globalRoot, transactionId);
  assert.equal(lstatSync(paths.receipt).mode & 0o077, 0, "completed receipt remains owner-only");
  assert.equal(inspectPortableHandoff({ globalRoot: f.input.globalRoot, transactionId }).status, "applied");
});

test("a changed destination invalidates a preview before the journal is created", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const transactionId = "portable-continuity-drift-a";
  const preview = previewPortableHandoff(previewInput(f, transactionId), f.deps);
  const original = readFileSync(f.destinationGlobal);
  privateJson(f.destinationGlobal, { destinationOnly: "changed-after-preview" });
  assert.throws(() => applyFromPreview(f, transactionId, preview), /preview-intent-mismatch/);
  assert.equal(readFileSync(f.destinationGlobal).toString("utf8"), '{\n  "destinationOnly": "changed-after-preview"\n}\n');
  assert.equal(inspectPortableHandoff({ globalRoot: f.input.globalRoot, transactionId }).status, "no-transaction");
  assert.notDeepEqual(readFileSync(f.destinationGlobal), original);
});

test("recovery refuses live writers and restores only journaled postimages", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const transactionId = "portable-continuity-recovery-a";
  const before = readFileSync(f.destinationGlobal);
  const preview = previewPortableHandoff(previewInput(f, transactionId), f.deps);
  let publishingBoundaries = 0;
  const interrupted: PortableContinuityDependencies = {
    ...f.deps,
    beforePhase(phase) {
      if (phase === "publishing" && ++publishingBoundaries === 2) throw new Error("simulated interruption after first rename");
    },
  };
  if (preview.intentFingerprint === null || preview.precondition === null) throw new Error("fixture preview did not produce an apply proof");
  assert.throws(() => applyPortableHandoff({
    ...f.input, transactionId, apply: true, expectedIntentFingerprint: preview.intentFingerprint, precondition: preview.precondition,
  }, interrupted), /simulated interruption/);
  assert.notDeepEqual(readFileSync(f.destinationGlobal), before, "the test interrupted after the first durable publish");

  const liveWriter: PortableContinuityDependencies = {
    ...f.deps,
    census: () => ({ observedAt: NOW, state: "running", openFileCount: 1, unexpectedProcessCount: 1 }),
  };
  assert.throws(() => recoverPortableHandoff({ globalRoot: f.input.globalRoot, transactionId }, liveWriter), /writers-not-zero/);
  assert.notDeepEqual(readFileSync(f.destinationGlobal), before, "recovery leaves a live writer's state untouched");

  const recovered = recoverPortableHandoff({ globalRoot: f.input.globalRoot, transactionId }, f.deps);
  assert.equal(recovered.status, "rolled-back");
  assert.deepEqual(readFileSync(f.destinationGlobal), before);
});


test("native content permits only owned safe modes while broker metadata stays private", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const input = previewInput(f, "portable-native-modes");
  chmodSync(f.input.source.codexHomeRoot, 0o775);
  assert.throws(() => previewPortableHandoff(input, f.deps), /source-codex-root-unsafe/);
  chmodSync(f.input.source.codexHomeRoot, 0o755);
  chmodSync(f.destinationGlobal, 0o666);
  assert.throws(() => previewPortableHandoff(input, f.deps), /global-state-unsafe/);
  chmodSync(f.destinationGlobal, 0o644);
  chmodSync(join(f.input.destination.tweakersRoot, "tweaks"), 0o775);
  assert.throws(() => previewPortableHandoff(input, f.deps), /tweaks-root-unsafe/);
  chmodSync(join(f.input.destination.tweakersRoot, "tweaks"), 0o755);
  chmodSync(f.input.globalRoot, 0o755);
  assert.throws(() => previewPortableHandoff(input, f.deps), /global-root-unsafe/);
});

test("a busy endpoint defers mutable artifact reads without hiding a pending transaction", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const input = previewInput(f, "portable-busy-native");
  writeFileSync(join(f.input.source.codexHomeRoot, ".codex-global-state.json"), "in-progress native write");
  const busy: PortableContinuityDependencies = { ...f.deps,
    census: () => ({ observedAt: NOW, state: "running", openFileCount: 0, unexpectedProcessCount: 0 }),
    readNativeThreadInventory: () => { throw new Error("busy inventory must not be scanned"); },
  };
  assert.throws(() => previewPortableHandoff(input, busy), /writers-not-zero/);
  const paths = portableContinuityPaths(f.input.globalRoot, input.transactionId);
  privateJson(paths.journal, { retained: true });
  assert.throws(() => previewPortableHandoff(input, busy), /incomplete-transaction-requires-recovery/);
});
