import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverTweakTests, parseArguments, runTweakTests } from "./test-tweaks.mjs";

const ROOT_ALIASES = [
  "TWEAKER_HOME",
  "TWEAKERS_HOME",
  "TWEAKERS_USER_ROOT",
  "TWEAKER_USER_ROOT",
  "CODEX_PLUSPLUS_USER_ROOT",
  "CODEX_PLUSPLUS_HOME",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tweakers-test-discovery-"));
  mkdirSync(join(root, "tweaks"), { recursive: true });
  return root;
}

function writeTweak(root, folder, tests = []) {
  const tweakRoot = join(root, "tweaks", folder);
  mkdirSync(join(tweakRoot, "test", "fixtures"), { recursive: true });
  writeFileSync(join(tweakRoot, "manifest.json"), JSON.stringify({ id: `com.example.${folder}` }));
  for (const path of tests) {
    const target = join(tweakRoot, "test", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "import test from 'node:test'; test('fixture', () => {});\n");
  }
  writeFileSync(join(tweakRoot, "test", "fixtures", "payload.json"), "{}\n");
}

test("discovers manifest-owned tweak tests in stable repository-relative order", () => {
  const root = fixture();
  try {
    writeTweak(root, "zeta", ["z.test.mjs", "nested/a.test.cjs"]);
    writeTweak(root, "alpha", ["b.test.js", "a.test.js"]);
    mkdirSync(join(root, "tweaks", "fixture-only", "test"), { recursive: true });
    writeFileSync(join(root, "tweaks", "fixture-only", "test", "ignored.test.js"), "throw new Error('ignored');\n");
    assert.deepEqual(discoverTweakTests(root), [
      "tweaks/alpha/test/a.test.js",
      "tweaks/alpha/test/b.test.js",
      "tweaks/zeta/test/nested/a.test.cjs",
      "tweaks/zeta/test/z.test.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supports deterministic focused discovery for one tweak", () => {
  const root = fixture();
  try {
    writeTweak(root, "alpha", ["alpha.test.js"]);
    writeTweak(root, "beta", ["beta.test.js"]);
    assert.deepEqual(discoverTweakTests(root, { tweak: "beta" }), ["tweaks/beta/test/beta.test.js"]);
    assert.throws(() => discoverTweakTests(root, { tweak: "missing" }), /Unknown manifest-bearing tweak/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for missing coverage and symlinked test content", () => {
  const root = fixture();
  try {
    writeTweak(root, "untested");
    assert.throws(() => discoverTweakTests(root), /has no tests/);
    rmSync(join(root, "tweaks", "untested"), { recursive: true, force: true });
    writeTweak(root, "unsafe", ["safe.test.js"]);
    symlinkSync(join(root, "tweaks", "unsafe", "test", "safe.test.js"), join(root, "tweaks", "unsafe", "test", "linked.test.js"));
    assert.throws(() => discoverTweakTests(root), /must not contain symlinks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses only the documented list and focused options", () => {
  assert.deepEqual(parseArguments([]), { list: false, tweak: null });
  assert.deepEqual(parseArguments(["--list", "--tweak", "user-questions"]), { list: true, tweak: "user-questions" });
  assert.throws(() => parseArguments(["--tweak"]), /Unknown or incomplete/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown or incomplete/);
});

test("nested tweak test processes scrub inherited root aliases", () => {
  const root = fixture();
  const sentinelRoot = mkdtempSync(join(tmpdir(), "tweakers-nested-inherited-root-"));
  const previous = new Map(ROOT_ALIASES.map((name) => [name, process.env[name]]));
  try {
    writeTweak(root, "guarded", ["guarded.test.js"]);
    writeFileSync(
      join(root, "tweaks", "guarded", "test", "guarded.test.js"),
      `
        import assert from "node:assert/strict";
        import { existsSync } from "node:fs";
        import test from "node:test";
        const aliases = ${JSON.stringify(ROOT_ALIASES)};
        test("nested root guard", () => {
          assert.equal(process.env.TWEAKERS_TEST_ROOT_PRELOAD, "active");
          assert.ok(process.env.TWEAKERS_TEST_FALLBACK_ROOT);
          assert.equal(existsSync(process.env.TWEAKERS_TEST_FALLBACK_ROOT), true);
          assert.deepEqual(aliases.filter((name) => process.env[name] !== undefined), []);
        });
      `,
    );
    for (const name of ROOT_ALIASES) process.env[name] = sentinelRoot;
    assert.equal(runTweakTests(root), 0);
    assert.equal(existsSync(join(sentinelRoot, "state.json")), false);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(sentinelRoot, { recursive: true, force: true });
  }
});
