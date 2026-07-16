const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tweak = require("../index.js");
const { parseConfig, scanConfig, scanSource, mergeCapabilities, setTomlValue, redact } = tweak._test;

test("routes CLI features out of Developer Tools and preserves non-CLI tool controls", () => {
  const text = `[features]\ndefault_mode_request_user_input = true\njs_repl = false\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 8\n[tools.request_user_input]\nenabled = true\n`;
  const caps = scanConfig(text, "/tmp/config.toml");
  assert.equal(caps.some((x) => x.id.startsWith("features.")), false);
  assert.equal(caps.find((x) => x.category === "Tools").name, "Enabled");
  assert.equal(caps.find((x) => x.category === "Tools").control.method, "config");
});

test("structured edits preserve unrelated comments and sections", () => {
  const text = `# keep me\nmodel = "gpt"\n\n[features]\n# feature note\nhooks = true\n\n[mcp_servers.example]\nenabled = true\n`;
  const next = setTomlValue(text, "features", "hooks", false);
  assert.match(next, /# keep me/); assert.match(next, /# feature note/); assert.match(next, /\[mcp_servers\.example\]\nenabled = true/);
  assert.equal(parseConfig(next).features.hooks, false);
});

test("feature values remain parseable but are excluded from the Developer Tools snapshot", () => {
  assert.equal(parseConfig("[features]\nhooks = true\n").features.hooks, true);
  assert.deepEqual(scanConfig("[features]\nhooks = true\n", "/tmp/config.toml"), []);
});

test("source-discovered CLI symbols are evidence, not duplicate feature controls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-tools-source-"));
  try {
    fs.writeFileSync(path.join(root, "flags.rs"), "Feature::JsRepl\nrequest_user_input\n");
    const capabilities = scanSource(fs, path, root);
    assert.ok(capabilities.length > 0);
    assert.ok(capabilities.every((item) => item.category === "Source Evidence"));
    assert.ok(capabilities.every((item) => item.control.method === "unsupported"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicates retain evidence and secrets are redacted", () => {
  const base = scanConfig("[tools]\nrequest_user_input = true\n", "/a")[0];
  const other = { ...base, sources: [{ kind: "source", path: "b.rs", detail: "hooks" }] };
  assert.equal(mergeCapabilities([base, other])[0].sources.length, 2);
  assert.equal(redact({ token: "abc", nested: { api_key: "def" } }).token, "[redacted]");
});
