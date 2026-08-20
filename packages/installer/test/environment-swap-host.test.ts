import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  bindVerifiedPreparedContentsExchange,
  loadVerifiedSwapHost,
  readSwapHostIdentity,
  replaceAppBundlePreservingIdentity,
  stagePreparedSwapHost,
  stagedNativeHostPath,
} from "../src/commands/install";
import { copyDirectoryPreservingModes } from "../src/fs-copy";
import { desktopVersionAdvanced } from "../src/desktop-version";

const SIGNED = {
  verify: () => ({ ok: true, output: "" }),
  signature: () => ({
    ok: true,
    adHoc: false,
    teamIdentifier: "2DC432GLL2",
    authority: ["Developer ID Application: Example"],
  }),
  designatedRequirement: () => 'designated => certificate leaf = H"abc123"',
} as unknown as Parameters<typeof readSwapHostIdentity>[1];

function stageHost(appRoot: string, bytes: string): string {
  const hostPath = stagedNativeHostPath(appRoot);
  mkdirSync(dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, bytes);
  return hostPath;
}

function withTempRoot<T>(prefix: string, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("swap host staging copies the first prepared payload that carries a signed host", () => {
  withTempRoot("tweaker-swap-stage-", (root) => {
    const candidate = join(root, "candidate.app");
    const rollback = join(root, "rollback.app");
    mkdirSync(rollback, { recursive: true });
    stageHost(candidate, "candidate-host-bytes");
    const destination = join(root, "prepared", "swap", "tweaker_native_host.node");

    const staged = stagePreparedSwapHost([candidate, rollback], destination, SIGNED);

    assert.notEqual(staged, null);
    assert.equal(staged!.sourceAppPath, candidate);
    assert.equal(readFileSync(destination, "utf8"), "candidate-host-bytes");
    assert.equal(
      staged!.identity.digest,
      createHash("sha256").update("candidate-host-bytes").digest("hex"),
    );
    assert.equal(staged!.identity.teamIdentifier, "2DC432GLL2");
    assert.equal(staged!.identity.certificateLeafHash, "abc123");
  });
});

test("swap host staging falls back to the rollback payload on the way out of Tweakers", () => {
  withTempRoot("tweaker-swap-rollback-source-", (root) => {
    const candidate = join(root, "candidate.app");
    const rollback = join(root, "rollback.app");
    mkdirSync(candidate, { recursive: true });
    stageHost(rollback, "rollback-host-bytes");
    const destination = join(root, "prepared", "swap", "tweaker_native_host.node");

    const staged = stagePreparedSwapHost([candidate, rollback], destination, SIGNED);

    assert.equal(staged?.sourceAppPath, rollback);
    assert.equal(readFileSync(destination, "utf8"), "rollback-host-bytes");
  });
});

test("swap host staging reports absence instead of failing a host-less transition", () => {
  withTempRoot("tweaker-swap-absent-", (root) => {
    const candidate = join(root, "candidate.app");
    const rollback = join(root, "rollback.app");
    mkdirSync(candidate, { recursive: true });
    mkdirSync(rollback, { recursive: true });

    assert.equal(
      stagePreparedSwapHost([candidate, rollback], join(root, "swap.node"), SIGNED),
      null,
    );
  });
});

test("a receipt-owned swap host survives deletion of the requested candidate", () => {
  withTempRoot("tweaker-swap-candidate-gone-", (root) => {
    const candidate = join(root, "candidate.app");
    stageHost(candidate, "candidate-host-bytes");
    const destination = join(root, "prepared", "swap", "tweaker_native_host.node");
    const staged = stagePreparedSwapHost([candidate], destination, SIGNED);
    assert.notEqual(staged, null);

    rmSync(candidate, { recursive: true, force: true });

    // The helper is the receipt's own copy, so its identity still verifies.
    const observed = readSwapHostIdentity(destination, SIGNED);
    assert.equal(observed.digest, staged!.identity.digest);
  });
});

test("swap host verification rejects digest drift, identity drift, and symlink aliases", () => {
  withTempRoot("tweaker-swap-tamper-", (root) => {
    const candidate = join(root, "candidate.app");
    stageHost(candidate, "candidate-host-bytes");
    const destination = join(root, "prepared", "swap", "tweaker_native_host.node");
    const staged = stagePreparedSwapHost([candidate], destination, SIGNED)!;
    const evidence = { ...staged.identity, path: destination };

    writeFileSync(destination, "tampered-host-bytes");
    assert.throws(
      () => loadVerifiedSwapHost(evidence, SIGNED),
      /digest does not match its prepared evidence/,
    );

    writeFileSync(destination, "candidate-host-bytes");
    const otherTeam = {
      ...SIGNED,
      signature: () => ({
        ok: true,
        adHoc: false,
        teamIdentifier: "OTHERTEAM1",
        authority: ["Developer ID Application: Example"],
      }),
    } as unknown as typeof SIGNED;
    assert.throws(
      () => loadVerifiedSwapHost(evidence, otherTeam),
      /signing identity does not match its prepared evidence/,
    );

    const aliasDirectory = join(root, "alias");
    mkdirSync(aliasDirectory, { recursive: true });
    const alias = join(aliasDirectory, "tweaker_native_host.node");
    symlinkSync(destination, alias);
    assert.throws(
      () => readSwapHostIdentity(alias, SIGNED),
      /must be a regular file/,
    );

    const unsigned = {
      ...SIGNED,
      verify: () => ({ ok: false, output: "code object is not signed at all" }),
    } as unknown as typeof SIGNED;
    assert.throws(
      () => readSwapHostIdentity(destination, unsigned),
      /failed strict verification/,
    );
  });
});

test("the atomic bundle exchange uses the caller's verified swap function", () => {
  withTempRoot("tweaker-swap-injected-", (root) => {
    const source = join(root, "source.app");
    const destination = join(root, "live.app");
    mkdirSync(join(source, "Contents"), { recursive: true });
    mkdirSync(join(destination, "Contents"), { recursive: true });
    writeFileSync(join(source, "Contents", "marker"), "incoming");
    writeFileSync(join(destination, "Contents", "marker"), "outgoing");
    const swapped: Array<[string, string]> = [];

    replaceAppBundlePreservingIdentity(source, destination, {
      swapDirectories: (first, second) => { swapped.push([first, second]); },
      validateDestination: () => true,
    });

    // Neither payload carries a native host, so the default resolver would have
    // refused; the injected receipt-owned helper is what makes this possible.
    assert.equal(swapped.length, 1);
    assert.equal(swapped[0][1], join(destination, "Contents"));
  });
});

test("the warm exchange primitive binds one verified native host to the exact prepared Contents pair", () => {
  withTempRoot("tweaker-warm-native-exchange-", (root) => {
    const live = join(root, "live.app", "Contents");
    const inactive = join(root, "inactive.app", "Contents");
    mkdirSync(live, { recursive: true });
    mkdirSync(inactive, { recursive: true });
    const calls: string[] = [];
    const exchange = bindVerifiedPreparedContentsExchange(
      live,
      inactive,
      {
        path: join(root, "prepared", "swap.node"),
        digest: "a".repeat(64),
        strict: true,
        designatedRequirement: "designated => example",
        teamIdentifier: "2DC432GLL2",
        authority: ["Developer ID Application: Example"],
        certificateLeafHash: "abc123",
      },
      {
        loadSwapHost: () => {
          calls.push("load-verified-host");
          return (first, second) => { calls.push(`native:${first}:${second}`); };
        },
      },
    );

    exchange(live, inactive);
    assert.deepEqual(calls, ["load-verified-host", `native:${live}:${inactive}`]);
    assert.throws(
      () => exchange(inactive, live),
      /bound to its exact prepared live\/inactive paths/,
    );
    assert.throws(
      () => bindVerifiedPreparedContentsExchange(
        live,
        join(root, "missing.app", "Contents"),
        {
          path: join(root, "prepared", "swap.node"),
          digest: "a".repeat(64),
          strict: true,
          designatedRequirement: "designated => example",
          teamIdentifier: "2DC432GLL2",
          authority: [],
          certificateLeafHash: null,
        },
        { loadSwapHost: () => () => undefined },
      ),
      /must be a real directory/,
    );
  });
});

test("app bundle replacement preserves payload modes under a restrictive umask", () => {
  withTempRoot("tweaker-swap-umask-", (root) => {
    const source = join(root, "source.app");
    const destination = join(root, "live.app");
    const nested = join(source, "Contents", "MacOS");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(destination, "Contents"), { recursive: true });
    const executable = join(nested, "ChatGPT");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
    chmodSync(nested, 0o755);
    const readable = join(source, "Contents", "Info.plist");
    writeFileSync(readable, "<plist/>");
    chmodSync(readable, 0o644);

    let incoming = "";
    const previous = process.umask(0o077);
    try {
      replaceAppBundlePreservingIdentity(source, destination, {
        swapDirectories: (first) => { incoming = first; },
        validateDestination: () => true,
        // Keep the copy on disk so its modes can be inspected.
        preserveOutgoing: join(root, "preserved"),
      });
    } finally {
      process.umask(previous);
    }

    const copied = join(root, "preserved");
    assert.equal(incoming.endsWith(".tweakers-contents-swap"), true);
    assert.equal(lstatSync(join(copied, "MacOS", "ChatGPT")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(copied, "MacOS")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(copied, "Info.plist")).mode & 0o7777, 0o644);
  });
});

test("directory copies keep file, directory, and symlink modes under umask 077", () => {
  withTempRoot("tweaker-copy-umask-", (root) => {
    const source = join(root, "source");
    const nested = join(source, "native");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(source, "index.js"), "module.exports = {};\n");
    chmodSync(join(source, "index.js"), 0o644);
    writeFileSync(join(nested, "host.node"), "binary");
    chmodSync(join(nested, "host.node"), 0o755);
    chmodSync(nested, 0o755);
    chmodSync(source, 0o755);
    symlinkSync("index.js", join(source, "alias.js"));

    const destination = join(root, "destination");
    const previous = process.umask(0o077);
    try {
      copyDirectoryPreservingModes(source, destination);
    } finally {
      process.umask(previous);
    }

    assert.equal(lstatSync(destination).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(destination, "native")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(destination, "index.js")).mode & 0o7777, 0o644);
    assert.equal(lstatSync(join(destination, "native", "host.node")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(join(destination, "alias.js")).isSymbolicLink(), true);
    assert.deepEqual(
      readdirSync(destination).sort(),
      ["alias.js", "index.js", "native"],
    );
  });
});

test("one stable receipt-owned helper path keeps a single module identity", () => {
  withTempRoot("tweaker-swap-single-path-", (root) => {
    const candidate = join(root, "candidate.app");
    stageHost(candidate, "candidate-host-bytes");
    const preparedRoot = join(root, "prepared");
    const destination = join(preparedRoot, "swap", "tweaker_native_host.node");

    const first = stagePreparedSwapHost([candidate], destination, SIGNED);
    const second = stagePreparedSwapHost([candidate], destination, SIGNED);

    // Restaging is idempotent onto the same path, so `require` resolves one
    // module and the addon's Objective-C classes register exactly once.
    assert.equal(first!.identity.digest, second!.identity.digest);
    assert.equal(relative(preparedRoot, destination), join("swap", "tweaker_native_host.node"));
    assert.equal(existsSync(destination), true);
    assert.equal(readdirSync(join(preparedRoot, "swap")).length, 1);
  });
});

test("desktop version comparison only advances on a real numeric increase", () => {
  assert.equal(
    desktopVersionAdvanced(
      { marketingVersion: "26.721.31836", build: "5828" },
      { marketingVersion: "26.721.41059", build: "5848" },
    ),
    true,
  );
  assert.equal(
    desktopVersionAdvanced(
      { marketingVersion: "26.721.41059", build: "5848" },
      { marketingVersion: "26.721.31836", build: "5828" },
    ),
    false,
  );
  assert.equal(
    desktopVersionAdvanced(
      { marketingVersion: "26.721.31836", build: "5828" },
      { marketingVersion: "26.721.31836", build: "5828" },
    ),
    false,
  );
  assert.equal(
    desktopVersionAdvanced(
      { marketingVersion: "26.721.31836", build: null },
      { marketingVersion: null, build: null },
    ),
    false,
  );
});
