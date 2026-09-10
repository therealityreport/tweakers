import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  PortableContinuityProjectionError,
  assertSupportedPortableDesktopSchema,
  mergePortableEndpointProjections,
  nativeThreadInventoryFingerprint,
  type NativeThreadInventoryV1,
  type PortableEndpointStateV1,
} from "../src/portable-continuity-projection.ts";

const SOURCE = `sha256:${"a".repeat(64)}` as const;
const DESTINATION = `sha256:${"b".repeat(64)}` as const;
const THREAD = "native-thread-alpha";
const INVENTORY: NativeThreadInventoryV1 = {
  version: 1,
  threadIds: [THREAD],
  fingerprint: nativeThreadInventoryFingerprint([THREAD]),
};
const OPTIONS = { nativeThreadInventory: INVENTORY, knownTweakIds: ["co.tweakers.projects"] };
const NOW = "2026-09-05T19:30:00.000Z";

function endpoint(endpointKey: typeof SOURCE | typeof DESTINATION, overrides: Partial<PortableEndpointStateV1> = {}): PortableEndpointStateV1 {
  return {
    endpointKey,
    bundleSchemaFingerprint: CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
    globalState: {
      "local-projects": {
        "local-one": {
          id: "local-one",
          name: "One",
          rootPaths: ["/Users/example/Projects/one"],
          privateSourceMarker: "never-projected",
        },
      },
      "electron-workspace-root-labels": { "/Users/example/Projects/one": "One" },
      "electron-persisted-atom-state": {
        "selected-project": { type: "local", projectId: "local-one" },
        "project-appearances": { "local-one": { theme: "dark", color: "#112233" } },
        "pinned-thread-ids": [THREAD],
        "pinned-project-ids": ["local-one"],
        "sidebar-project-thread-orders": { "local-one": { threadIds: [THREAD], sortKey: "recent" } },
        "sidebar-thread-metadata": { [THREAD]: { title: "Presentation title", isArchived: false } },
        "thread-project-assignments": { [THREAD]: { projectKind: "local", projectId: "local-one" } },
        "thread-workspace-root-hints": { [THREAD]: "/Users/example/Projects/one" },
        "projectless-thread-ids": [],
        "project-order": ["local-one"],
        appearanceTheme: "dark",
        appearanceLightChromeTheme: "#ffffff",
        appearanceDarkChromeTheme: "#000000",
        localeOverride: "en-US",
        authorization: "source-only-secret",
      },
      sourceOnlyRemoteState: "never-projected",
    },
    projects: {
      schemaVersion: 1,
      nodes: [
        { id: "group-one", type: "group", parentId: null, name: "Group", icon: { kind: "emoji", value: "📁" }, color: "#112233" },
        {
          id: "project-one", type: "project", parentId: "group-one", name: "Project", icon: { kind: "iconify", value: "lucide:folder" },
          color: "#334455", taskSort: "updated-desc", pinnedTaskIds: [THREAD], connections: { private: "never-projected" },
        },
      ],
    },
    config: { tweaks: { "co.tweakers.projects": { enabled: true, credential: "never-projected" } }, sourceOnly: "never-projected" },
    ...overrides,
  };
}

function merge(source: PortableEndpointStateV1, destination: PortableEndpointStateV1, ledger = null) {
  return mergePortableEndpointProjections({ source, destination, options: OPTIONS, ledger, observedAt: NOW });
}

test("strict projection copies only registered presentation fields and preserves destination-owned state", () => {
  const source = endpoint(SOURCE);
  const destination = endpoint(DESTINATION, {
    globalState: {
      "local-projects": {
        "local-one": { id: "local-one", name: "One", rootPaths: ["/Users/example/Projects/one"], destinationOnly: true },
      },
      targetOnly: "preserved",
      "electron-persisted-atom-state": { destinationConnection: "preserved" },
    },
    projects: null,
    config: { destinationOnly: "preserved" },
  });

  const result = merge(source, destination);
  const global = result.candidate.globalState as Record<string, unknown>;
  const atoms = global["electron-persisted-atom-state"] as Record<string, unknown>;
  const config = result.candidate.config as Record<string, unknown>;
  const projects = result.candidate.projects as { nodes: Array<Record<string, unknown>> };

  assert.equal(global.targetOnly, "preserved");
  assert.equal((global["local-projects"] as Record<string, Record<string, unknown>>)["local-one"]!.destinationOnly, true);
  assert.equal(atoms.destinationConnection, "preserved");
  assert.equal(Object.hasOwn(atoms, "authorization"), false);
  assert.equal(Object.hasOwn(global, "sourceOnlyRemoteState"), false);
  assert.deepEqual(atoms["pinned-thread-ids"], [THREAD], "native IDs are retained verbatim");
  assert.equal((config.tweaks as Record<string, Record<string, unknown>>)["co.tweakers.projects"]!.enabled, true);
  assert.equal(Object.hasOwn(config, "sourceOnly"), false);
  assert.equal(projects.nodes.some((node) => node.connections !== undefined), false, "source connection definitions are excluded from the portable projection");
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.selectedFields.some((field) => field.fieldId.startsWith("config.tweak-enabled") && field.writesDestination), true);
});

test("unproven native IDs conflict atomically and never enter the candidate", () => {
  const source = endpoint(SOURCE);
  const sourceGlobal = structuredClone(source.globalState) as Record<string, unknown>;
  ((sourceGlobal["electron-persisted-atom-state"] as Record<string, unknown>)["pinned-thread-ids"] as string[]).push("outside-proven-inventory");
  source.globalState = sourceGlobal;
  const destination = endpoint(DESTINATION, { globalState: { "local-projects": {}, "electron-persisted-atom-state": {} }, projects: null, config: null });

  const result = merge(source, destination);
  assert.equal(result.conflicts.some((conflict) => conflict.reason === "unproven-native-id"), true);
  const atoms = (result.candidate.globalState as Record<string, unknown>)["electron-persisted-atom-state"] as Record<string, unknown>;
  assert.equal(Object.hasOwn(atoms, "pinned-thread-ids"), false);
});

test("ledger baselines propagate a source tombstone, then preserve a dual edit as a conflict", () => {
  const initialSource = endpoint(SOURCE);
  const initialDestination = endpoint(DESTINATION);
  const seeded = merge(initialSource, initialDestination);

  const deletingSource = endpoint(SOURCE, { globalState: { "local-projects": {}, "electron-persisted-atom-state": {} }, projects: null, config: null });
  const deletion = merge(deletingSource, initialDestination, seeded.nextLedger);
  const deletionProjects = (deletion.candidate.globalState as Record<string, unknown>)["local-projects"] as Record<string, unknown>;
  assert.equal(Object.hasOwn(deletionProjects, "local-one"), false, "a first-class tombstone removes the stale destination field");

  const sourceEdit = endpoint(SOURCE);
  const destinationEdit = endpoint(DESTINATION);
  ((sourceEdit.globalState as Record<string, unknown>)["local-projects"] as Record<string, Record<string, unknown>>)["local-one"]!.name = "Source change";
  ((destinationEdit.globalState as Record<string, unknown>)["local-projects"] as Record<string, Record<string, unknown>>)["local-one"]!.name = "Destination change";
  const conflict = merge(sourceEdit, destinationEdit, seeded.nextLedger);
  assert.equal(conflict.conflicts.some((entry) => entry.reason === "dual-edit"), true);
  const candidateProjects = (conflict.candidate.globalState as Record<string, unknown>)["local-projects"] as Record<string, Record<string, unknown>>;
  assert.equal(candidateProjects["local-one"]!.name, "Destination change");
});

test("only the verified official desktop schema is accepted", () => {
  assert.doesNotThrow(() => assertSupportedPortableDesktopSchema(CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1));
  assert.throws(
    () => assertSupportedPortableDesktopSchema(`sha256:${"0".repeat(64)}`),
    (error: unknown) => error instanceof PortableContinuityProjectionError && error.code === "unsupported-schema",
  );
});
