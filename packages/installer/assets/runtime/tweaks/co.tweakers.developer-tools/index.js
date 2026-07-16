"use strict";

const IPC = "developer-tools";
const SERVICE = "__tweakersDeveloperToolsServiceV1";
const HANDLER = "__tweakersDeveloperToolsHandlerV1";
const SCHEMA_VERSION = 1;
const REPO = "https://github.com/openai/codex.git";
const SECRET = /(token|secret|password|credential|api[_-]?key|authorization|cookie)/i;

module.exports = {
  start(api) { return api.process === "main" ? startMain(api) : startRenderer(api); },
  stop() {
    if (typeof window === "undefined") {
      globalThis[SERVICE]?.dispose?.();
      globalThis[SERVICE] = null;
      const off = globalThis[HANDLER]; if (typeof off === "function") off();
      globalThis[HANDLER] = null;
    }
    this._page?.unregister?.(); this._page = null;
  },
  _test: { parseConfig, scanConfig, scanSource, mergeCapabilities, setTomlValue, redact, stableId },
};

function startMain(api) {
  const service = createService(api);
  globalThis[SERVICE] = service;
  if (!globalThis[HANDLER]) globalThis[HANDLER] = api.ipc.handle?.(IPC, (message) => globalThis[SERVICE]?.handle(message) || fail("unavailable")) || true;
  api.log.info("Developer Tools service ready");
}

function createService(api) {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const crypto = require("node:crypto");
  const cp = require("node:child_process");
  const dataDir = api.fs.dataDir;
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const modelPath = discoverModelPath(fs, path, configPath);
  const checkout = path.join(dataDir, "openai-codex-source");
  const cachePath = path.join(dataDir, "snapshot.json");
  const backupDir = path.join(dataDir, "backups");
  let disposed = false;

  function revision(contents) { return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 24); }
  function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
  function git(args) { return cp.execFileSync("git", args, { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  function sourceStatus() {
    const exists = fs.existsSync(path.join(checkout, ".git"));
    let commit = null; try { if (exists) commit = git(["-C", checkout, "rev-parse", "HEAD"]); } catch {}
    return { repository: REPO, path: checkout, exists, commit, scannerSchemaVersion: SCHEMA_VERSION };
  }
  function snapshot(refresh) {
    const warnings = [];
    try {
      const config = readText(configPath);
      const caps = scanConfig(config, configPath);
      caps.push(...scanModels(readText(modelPath), modelPath));
      caps.push(...scanSource(fs, path, checkout));
      const runtime = runtimeCapabilities(api);
      caps.push(...runtime);
      const value = { schemaVersion: SCHEMA_VERSION, scannedAt: new Date().toISOString(), revision: revision(config), stale: false, source: sourceStatus(), capabilities: mergeCapabilities(caps), warnings };
      fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(value, null, 2));
      return value;
    } catch (error) {
      const cached = readJson(fs, cachePath);
      if (cached) return { ...cached, stale: true, warnings: [`Refresh failed: ${safeError(error)}`] };
      throw error;
    }
  }
  function backup(file, contents) {
    fs.mkdirSync(backupDir, { recursive: true });
    const id = `${Date.now()}-${path.basename(file).replace(/[^a-z0-9._-]/gi, "_")}`;
    fs.writeFileSync(path.join(backupDir, `${id}.json`), JSON.stringify({ id, file, contents, createdAt: new Date().toISOString() })); return id;
  }
  function atomicWrite(file, contents) {
    const temp = `${file}.developer-tools-${process.pid}.tmp`; fs.writeFileSync(temp, contents, { mode: 0o600 }); fs.renameSync(temp, file);
  }
  function mutate(message) {
    const current = readText(configPath); const currentRevision = revision(current);
    if (message.expectedRevision !== currentRevision) return fail("stale-revision");
    const cap = scanConfig(current, configPath).find((item) => item.id === message.id);
    if (!cap || cap.control.method !== "config") return fail("unsupported");
    if (cap.risk !== "ordinary" && message.confirmed !== true) return fail("confirmation-required");
    const next = setTomlValue(current, cap.control.section, cap.control.key, !!message.enabled);
    const backupId = backup(configPath, current);
    try {
      atomicWrite(configPath, next);
      const parsed = parseConfig(readText(configPath));
      if (parsed[cap.control.section]?.[cap.control.key] !== !!message.enabled) throw new Error("write-validation-failed");
      return { ok: true, capability: scanConfig(next, configPath).find((item) => item.id === message.id), revision: revision(next), backupId, restart: cap.restart };
    } catch (error) { atomicWrite(configPath, current); return fail("write-failed", safeError(error)); }
  }
  function backups() { fs.mkdirSync(backupDir, { recursive: true }); return fs.readdirSync(backupDir).filter((x) => x.endsWith(".json")).map((x) => readJson(fs, path.join(backupDir, x))).filter(Boolean).map(({ contents, ...item }) => item).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  function rollback(id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return fail("invalid-backup");
    const record = readJson(fs, path.join(backupDir, `${id}.json`)); if (!record || record.file !== configPath) return fail("invalid-backup");
    backup(configPath, readText(configPath)); atomicWrite(configPath, record.contents); return { ok: true, revision: revision(record.contents) };
  }
  return { dispose() { disposed = true; }, async handle(message) {
    if (disposed) return fail("unavailable");
    try {
      if (message?.action === "getSnapshot" || message?.action === "refresh") return { ok: true, snapshot: snapshot(message.action === "refresh") };
      if (message?.action === "setCapability") return mutate(message);
      if (message?.action === "listBackups") return { ok: true, backups: backups() };
      if (message?.action === "rollback") return rollback(message.backupId);
      if (message?.action === "getSourceStatus") return { ok: true, source: sourceStatus() };
      if (message?.action === "refreshSource") {
        fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(path.join(checkout, ".git"))) git(["clone", "--depth", "1", "--filter=blob:none", REPO, checkout]);
        else { git(["-C", checkout, "fetch", "--depth", "1", "origin", "main"]); git(["-C", checkout, "reset", "--hard", "FETCH_HEAD"]); }
        return { ok: true, source: sourceStatus(), snapshot: snapshot(true) };
      }
      return fail("invalid-request");
    } catch (error) { return fail("operation-failed", safeError(error)); }
  }};
}

function parseConfig(text) {
  const out = {}; let section = "root"; out.root = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const header = raw.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/); if (header) { section = header[1]; out[section] ||= {}; continue; }
    const pair = raw.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false|"(?:[^"\\]|\\.)*"|-?\d+)\s*(?:#.*)?$/); if (!pair) continue;
    let value = pair[2]; if (value === "true" || value === "false") value = value === "true"; else if (/^-?\d+$/.test(value)) value = Number(value); else { try { value = JSON.parse(value); } catch {} }
    out[section][pair[1]] = value;
  }
  return out;
}

function scanConfig(text, file) {
  const parsed = parseConfig(text); const out = [];
  for (const [section, values] of Object.entries(parsed)) for (const [key, value] of Object.entries(values)) {
    if (SECRET.test(key)) continue;
    const cliFeature = section === "features" || section.startsWith("features.");
    if (cliFeature) continue;
    const category = section.startsWith("tools") ? "Tools" : null;
    if (!category) continue;
    const toggle = typeof value === "boolean";
    out.push(capability({ id: stableId(section, key), name: title(key), category, configured: value, state: toggle ? (value ? "enabled" : "disabled") : "enabled", source: { kind: "config", path: file, detail: `[${section}] ${key}` }, control: toggle ? { method: "config", section, key } : { method: "unsupported" }, risk: /(sandbox|approval|danger|network|shell|exec)/i.test(key) ? "risky" : "ordinary", restart: "restart" }));
  }
  return out;
}

function scanModels(text, file) {
  if (!text || text.length > 20 * 1024 * 1024) return [];
  let json; try { json = JSON.parse(text); } catch { return []; }
  const models = Array.isArray(json) ? json : Array.isArray(json.models) ? json.models : [];
  return models.filter((m) => m && typeof m === "object" && !SECRET.test(JSON.stringify(Object.keys(m)))).map((m, i) => capability({ id: `model.${stableId("model", m.slug || m.id || m.name || i)}`, name: String(m.display_name || m.name || m.slug || m.id || `Model ${i + 1}`), category: "Models", configured: m.visibility ?? m.enabled ?? "available", state: m.enabled === false || m.visibility === "hidden" ? "hidden" : "enabled", source: { kind: "model-catalog", path: file, detail: String(m.slug || m.id || "catalog entry") }, control: { method: "unsupported" }, risk: "ordinary", restart: "new-task" }));
}

function scanSource(fs, path, root) {
  if (!fs.existsSync(root)) return [];
  const out = []; const queue = [root]; let files = 0;
  while (queue.length && files < 2500) {
    const dir = queue.shift(); let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if ([".git", "target", "node_modules", "vendor"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name); if (entry.isDirectory()) { queue.push(full); continue; }
      if (!/\.(rs|ts|tsx|js|json|toml)$/.test(entry.name)) continue; files++;
      let text = ""; try { if (fs.statSync(full).size < 1024 * 1024) text = fs.readFileSync(full, "utf8"); } catch {}
      const patterns = [/Feature::([A-Za-z0-9_]+)/g, /(?:feature|tool|experimental)[_-](?:flag[_-])?["']?([A-Za-z][A-Za-z0-9_-]{2,})/gi, /"(request_user_input|spawn_agent|send_message|wait_agent|update_plan)"/g];
      for (const re of patterns) { let m; while ((m = re.exec(text))) { const name = m[1]; out.push(capability({ id: `source.${stableId("source", name)}`, name: title(name), category: "Source Evidence", configured: null, state: "unsupported", source: { kind: "source", path: path.relative(root, full), detail: name }, control: { method: "unsupported" }, risk: "ordinary", restart: "unknown" })); } }
    }
  }
  return out;
}

function runtimeCapabilities(api) { try { const info = api.codex?.runtime?.getCapabilities?.(); return info && typeof info.then !== "function" ? Object.entries(info).map(([key, value]) => capability({ id: `runtime.${stableId("runtime", key)}`, name: title(key), category: "Runtime", configured: !!value, state: value ? "enabled" : "unavailable", source: { kind: "runtime", path: "installed Codex", detail: key }, control: { method: "unsupported" }, risk: "ordinary", restart: "unknown" })) : []; } catch { return []; } }
function capability(x) { return { schemaVersion: SCHEMA_VERSION, description: "Discovered from current Codex configuration or source.", defaultValue: null, changedFromDefault: false, effectiveLayer: x.source.kind, sources: [x.source], compatibility: { status: "observed", evidence: x.source.detail }, ...x }; }
function mergeCapabilities(items) { const map = new Map(); for (const raw of items) { const item = redact(raw); const old = map.get(item.id); if (!old) map.set(item.id, item); else old.sources.push(...item.sources.filter((s) => !old.sources.some((x) => x.path === s.path && x.detail === s.detail))); } return [...map.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)); }
function setTomlValue(text, section, key, value) { const lines = String(text).split(/\r?\n/); let start = -1, end = lines.length; for (let i = 0; i < lines.length; i++) { const h = lines[i].match(/^\s*\[([^\]]+)\]/); if (!h) continue; if (start >= 0) { end = i; break; } if (h[1] === section) start = i; } if (start < 0) return `${text.replace(/\s*$/, "")}\n\n[${section}]\n${key} = ${value}\n`; const re = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=.*$`); for (let i = start + 1; i < end; i++) if (re.test(lines[i])) { const indent = lines[i].match(/^\s*/)[0]; lines[i] = `${indent}${key} = ${value}`; return lines.join("\n"); } lines.splice(end, 0, `${key} = ${value}`); return lines.join("\n"); }
function discoverModelPath(fs, path, configPath) { const parsed = parseConfig(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : ""); const configured = parsed.root?.model_catalog_json; return typeof configured === "string" ? configured : path.join(require("node:os").homedir(), ".codex", "models_cache.json"); }
function readJson(fs, file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function stableId(section, key) { return `${String(section).toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${String(key).toLowerCase().replace(/[^a-z0-9]+/g, ".")}`.replace(/^\.|\.$/g, ""); }
function title(value) { return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== "object") return typeof value === "string" && SECRET.test(value) ? "[redacted]" : value; const out = {}; for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? "[redacted]" : redact(v); return out; }
function safeError(error) { return String(error?.message || error || "unknown error").replace(/(?:gh[opsu]_[A-Za-z0-9_]+|Bearer\s+\S+)/g, "[redacted]").slice(0, 500); }
function fail(code, message) { return { ok: false, error: { code, message: message || code } }; }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function startRenderer(api) {
  module.exports._page = api.settings.registerPage({ id: "developer-tools", title: "Developer Tools", description: "Inspect Codex tools, models, runtime capabilities, and source evidence. Codex CLI feature controls live in Config.", iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 3h6l.5 3 2.5 1.5-1.5 2.5 1.5 2.5-2.5 1.5-.5 3H7l-.5-3L4 12.5 5.5 10 4 7.5 6.5 6 7 3Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.4"/></svg>', render(root) { return renderPage(api, root); } });
}

function renderPage(api, root) {
  let disposed = false, snapshot = null, query = "", category = "All", state = "All", changed = false;
  root.textContent = "Loading developer capabilities…";
  const load = (action = "getSnapshot") => api.ipc.invoke(IPC, { action }).then((r) => { if (!disposed) { if (!r?.ok) throw new Error(r?.error?.message); snapshot = r.snapshot; draw(); } }).catch((e) => { if (!disposed) root.textContent = `Developer Tools unavailable: ${e.message}`; });
  function draw() {
    root.textContent = "";
    const ownership = el("div", "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary");
    ownership.append(el("span", "min-w-0 flex-1", "Codex CLI feature flags are managed in Tweakers Config, where they are checked against the selected runtime."));
    ownership.append(button("Open Config", () => { const target = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Config"); target?.click(); }));
    root.append(ownership);
    const toolbar = el("div", "flex flex-wrap items-center gap-2");
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Search tools and features"; search.value = query; search.className = "border-token-border bg-token-foreground/5 h-token-button-composer min-w-[240px] flex-1 rounded-md border px-3 text-sm text-token-text-primary"; search.addEventListener("input", () => { query = search.value; draw(); });
    const categorySelect = select(["All", ...new Set(snapshot.capabilities.map((x) => x.category))], category, (v) => { category = v; draw(); });
    const stateSelect = select(["All", "enabled", "disabled", "hidden", "unavailable", "unsupported", "unknown"], state, (v) => { state = v; draw(); });
    const refresh = button("Refresh", () => load("refresh")); const source = button("Refresh source", () => api.ipc.invoke(IPC, { action: "refreshSource" }).then((r) => { if (!r.ok) throw new Error(r.error.message); snapshot = r.snapshot; draw(); }).catch((e) => window.alert(e.message)));
    const check = document.createElement("label"); check.className = "flex items-center gap-2 text-sm text-token-text-secondary"; const box = document.createElement("input"); box.type = "checkbox"; box.checked = changed; box.addEventListener("change", () => { changed = box.checked; draw(); }); check.append(box, document.createTextNode("Changed from default"));
    toolbar.append(search, categorySelect, stateSelect, check, refresh, source); root.append(toolbar);
    if (snapshot.stale || snapshot.warnings.length) root.append(el("div", "mt-3 rounded-md bg-token-charts-yellow/10 p-3 text-sm text-token-text-primary", snapshot.warnings.join(" ") || "Showing cached inventory."));
    const meta = el("div", "mt-3 text-sm text-token-text-secondary", `${snapshot.capabilities.length} capabilities · scanned ${new Date(snapshot.scannedAt).toLocaleString()} · source ${snapshot.source.commit?.slice(0, 8) || "not downloaded"}`); root.append(meta);
    const list = snapshot.capabilities.filter((x) => (!query || `${x.name} ${x.id} ${x.description}`.toLowerCase().includes(query.toLowerCase())) && (category === "All" || x.category === category) && (state === "All" || x.state === state) && (!changed || x.changedFromDefault));
    const groups = new Map(); for (const item of list) { if (!groups.has(item.category)) groups.set(item.category, []); groups.get(item.category).push(item); }
    for (const [name, items] of groups) { root.append(el("div", "mt-5 text-base font-medium text-token-text-primary", name)); const card = el("div", "border-token-border mt-2 flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border"); for (const item of items) card.append(capabilityRow(api, snapshot, item, load)); root.append(card); }
    if (!list.length) root.append(el("div", "mt-6 text-sm text-token-text-secondary", "No capabilities match these filters."));
  }
  void load(); return () => { disposed = true; root.textContent = ""; };
}

function capabilityRow(api, snapshot, item, reload) {
  const row = el("div", "flex items-start justify-between gap-4 p-3"); const left = el("div", "min-w-0 flex-1");
  const heading = el("div", "flex flex-wrap items-center gap-2"); heading.append(el("span", "text-sm text-token-text-primary", item.name), badge(item.state), badge(item.risk), badge(item.restart)); left.append(heading, el("div", "mt-1 text-sm text-token-text-secondary", `${item.id} · ${item.effectiveLayer}`));
  const details = document.createElement("details"); details.className = "mt-2 text-sm text-token-text-secondary"; const summary = document.createElement("summary"); summary.className = "cursor-pointer"; summary.textContent = "Evidence and sources"; details.append(summary); for (const source of item.sources) details.append(el("div", "mt-1 break-all", `${source.kind}: ${source.path} · ${source.detail}`)); left.append(details); row.append(left);
  if (item.control.method === "config" && typeof item.configured === "boolean") { const toggle = switchControl(item.configured, async (enabled, apply) => { if (item.risk !== "ordinary" && !window.confirm(`Change risky capability “${item.name}”? A backup will be created.`)) return apply(item.configured); toggle.disabled = true; const result = await api.ipc.invoke(IPC, { action: "setCapability", id: item.id, enabled, expectedRevision: snapshot.revision, confirmed: item.risk !== "ordinary" }); toggle.disabled = false; if (!result?.ok) { apply(item.configured); window.alert(`Could not update ${item.name}: ${result?.error?.message || "unknown error"}`); return; } if (result.restart === "restart") window.alert(`${item.name} changed. Restart Codex for it to take effect.`); reload(); }); row.append(toggle); }
  else row.append(el("span", "shrink-0 text-sm text-token-text-secondary", "Read only")); return row;
}
function switchControl(initial, onChange) { const btn = document.createElement("button"); btn.type = "button"; btn.setAttribute("role", "switch"); const pill = document.createElement("span"), knob = document.createElement("span"); knob.className = "h-4 w-4 rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform"; pill.append(knob); const apply = (on) => { btn.setAttribute("aria-checked", String(on)); btn.className = "inline-flex cursor-interaction items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"; pill.className = `relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors ${on ? "bg-token-charts-blue" : "bg-token-foreground/20"}`; knob.style.transform = on ? "translateX(14px)" : "translateX(2px)"; }; apply(initial); btn.append(pill); btn.addEventListener("click", () => onChange(btn.getAttribute("aria-checked") !== "true", apply)); return btn; }
function select(options, value, change) { const node = document.createElement("select"); node.className = "border-token-border bg-token-foreground/5 h-token-button-composer rounded-md border px-2 text-sm text-token-text-primary"; for (const option of options) { const el = document.createElement("option"); el.value = option; el.textContent = option; el.selected = option === value; node.append(el); } node.addEventListener("change", () => change(node.value)); return node; }
function button(text, action) { const node = el("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary", text); node.type = "button"; node.addEventListener("click", action); return node; }
function badge(text) { return el("span", "rounded-full bg-token-foreground/5 px-2 py-0.5 text-xs text-token-text-secondary", text); }
function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
