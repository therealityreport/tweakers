import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, tokenizer } from "acorn";
import { resolveSealedManagerManagedRuntimeAssets, resolveSealedManagerRuntimeAssets, verifySealedManagerManagedRuntimeAssets, verifySealedManagerRuntimeAssets } from "./manager-runtime-assets.js";

export interface DoctorImplementationScopes {
  version: 1;
  construction: string;
  verification: string;
  promotion: string;
  payload: string;
}
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value, (_, item) => typeof item === "bigint" ? { bigint: item.toString() } : item)).digest("hex")}`;
const tokens = (source: string): unknown => Array.from(tokenizer(source, { ecmaVersion: "latest", sourceType: "module" })).map(t => [t.type.label, (t as unknown as {value?: unknown}).value ?? null]);

/** Hash the reachable declarations, import wiring and module initialization, not a UI bundle. */
export function doctorCodeScopeFingerprint(root: string, entries: Array<[string, string[]]>): string {
  const modules = new Map<string, { source: string; nodes: Map<string, any>; imports: Map<string, [string, string]>; exports: Map<string, string>; initial: any[] }>();
  const selected = new Map<string, unknown>();
  const wildcardExports = new Map<string, string[]>();
  const initializationImports = new Map<string, string[]>();
  const inert = (node: any): boolean => !node || ["ArrowFunctionExpression", "FunctionExpression", "Literal"].includes(node.type)
    || node.type === "ArrayExpression" && node.elements.every(inert)
    || node.type === "ObjectExpression" && node.properties.every((p: any) => p.type === "Property" && (!p.computed || inert(p.key)) && inert(p.value));
  const load = (name: string) => {
    if (modules.has(name)) return modules.get(name)!;
    const path = join(root, `${name}.js`);
    const sourcePath = !existsSync(path) && existsSync(join(root, `${name}.ts`)) ? join(root, `${name}.ts`) : path;
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error(`Scoped implementation input missing: ${sourcePath}`);
    let source = readFileSync(sourcePath, "utf8");
    if (sourcePath.endsWith(".ts")) {
      // Development only. Sealed Managers always inspect their verified emitted modules.
      const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
      source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    }
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as any;
    const data = { source, nodes: new Map<string, any>(), imports: new Map<string, [string, string]>(), exports: new Map<string, string>(), initial: [] as any[] };
    modules.set(name, data);
    initializationImports.set(name, []);
    wildcardExports.set(name, []);
    for (const statement of ast.body) {
      if (statement.type === "ImportDeclaration") {
        initializationImports.get(name)!.push(statement.source.value);
        for (const spec of statement.specifiers) data.imports.set(spec.local.name, [statement.source.value, spec.type === "ImportDefaultSpecifier" ? "default" : spec.type === "ImportNamespaceSpecifier" ? "*" : spec.imported.name]);
        if (!statement.specifiers.length) data.initial.push(statement);
        continue;
      }
      if (statement.type === "ExportAllDeclaration") { wildcardExports.get(name)!.push(statement.source.value); initializationImports.get(name)!.push(statement.source.value); continue; }
      const node = statement.type.startsWith("Export") ? statement.declaration : statement;
      if (statement.type === "ExportNamedDeclaration" && !node) {
        for (const spec of statement.specifiers) {
          data.exports.set(spec.exported.name, spec.local.name);
          if (statement.source) data.imports.set(spec.local.name, [statement.source.value, spec.local.name]);
        }
        continue;
      }
      if (!node) throw new Error(`Unsupported scoped declaration in ${name}`);
      if (node.type === "ClassDeclaration" && node.body.body.some((item: any) => item.static || item.type === "StaticBlock")) data.initial.push(node);
      if (node.id?.name) { data.nodes.set(node.id.name, node); if (statement.type.startsWith("Export")) data.exports.set(statement.type === "ExportDefaultDeclaration" ? "default" : node.id.name, node.id.name); }
      else if (node.type === "VariableDeclaration") {
        for (const item of node.declarations) {
          if (item.id.type !== "Identifier") throw new Error(`Unsupported module binding in ${name}`);
          data.nodes.set(item.id.name, node);
          if (item.init && !inert(item.init)) data.initial.push(node);
          if (statement.type.startsWith("Export")) data.exports.set(item.id.name, item.id.name);
        }
      } else if (statement.type === "ExportDefaultDeclaration") { data.nodes.set("default", node); data.exports.set("default", "default"); }
      else data.initial.push(node);
    }
    return data;
  };
  const dependency = (from: string, path: string, symbol: string): void => {
    if (!path.startsWith(".")) {
      if (path.startsWith("node:")) { selected.set(`external:${path}`, { node: process.versions.node, v8: process.versions.v8 }); return; }
      const entry = createRequire(join(root, "scope-resolution.cjs")).resolve(path);
      let directory = dirname(entry);
      while (!existsSync(join(directory, "package.json"))) {
        const parent = dirname(directory); if (parent === directory) throw new Error(`Scoped package manifest missing: ${path}`); directory = parent;
      }
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      selected.set(`external:${path}`, { name: pkg.name, version: pkg.version, entry: relative(directory, entry), sha256: digest(readFileSync(entry).toString("base64")) }); return;
    }
    const name = relative(root, resolve(root, dirname(from), path)).replace(/\.js$/, "");
    if (name.startsWith("..")) throw new Error(`Scoped dependency escapes installer modules: ${path}`);
    visit(name, symbol, true);
  };
  const walk = (name: string, node: any): void => {
    if (!node || typeof node !== "object") return;
    const data = load(name);
    if (node.type === "Identifier") {
      if (data.imports.has(node.name)) {
        const imported = data.imports.get(node.name)!;
        selected.set(`${name}:import:${node.name}`, imported);
        dependency(name, ...imported);
      } else if (data.nodes.has(node.name)) visit(name, node.name);
    }
    if (node.type === "CallExpression" && (node.callee?.name === "require" || node.callee?.type === "CallExpression" && node.callee.callee?.name === "createRequire" || node.callee?.type === "MemberExpression" && node.callee.object?.name === "require" && node.callee.property?.name === "resolve")) {
      if (typeof node.arguments[0]?.value === "string") dependency(name, node.arguments[0].value, "*");
      else {
        const argument = data.source.slice(node.arguments[0]?.start, node.arguments[0]?.end).replace(/\s/g, "").replace(/,\)/g, ")");
        const runtimeLoaders: Record<string, string[]> = {
          "commands/install": ["evidence.path", "runtimeModulePath"],
          "commands/create-variant": ['join(sourceRuntimeRoot,"account-router","shared-native-mode.js")'],
          "doctor-validation": ["adapterPath"],
          "protected-update-quarantine": ["bootstrapPath"],
          "protected-acceptance-coordinator": ["bootstrapPath"],
          "doctor-review": ['join(packagedRuntimeAssetsRoot(),"account-router","broker-socket.js")'],
          "doctor-independent": ['join(packagedRuntimeAssetsRoot(),"account-router","doctor-storage.js")', 'join(packagedRuntimeAssetsRoot(),"account-router","doctor-auth.js")'],
          "manager-action-adapter": ['join(assets.root,"packages","installer","assets","runtime","account-router","transfer-recovery.js")'],
        };
        if (!runtimeLoaders[name]?.includes(argument)) throw new Error(`Unbound dynamic scoped loader: ${name}: ${argument}`);
        selected.set(`${name}:runtime-loader:${argument}`, "functional-runtime-payload-and-candidate-receipt");
      }
    }
    if (node.type === "ImportExpression") {
      if (typeof node.source.value !== "string") throw new Error(`Nonliteral scoped import in ${name}`);
      dependency(name, node.source.value, "*");
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(v => walk(name, v)); else if (value && typeof value === "object") walk(name, value);
  };
  const initialized = new Set<string>();
  const visit = (name: string, requested: string, exported = false): void => {
    const data = load(name);
    // The binding algorithm is a verification-policy leaf, not a dependency on
    // every operation it can fingerprint (which would recouple promotion).
    if (name === "doctor-implementation") { selected.set(name, tokens(data.source)); return; }
    if (!initialized.has(name)) {
      initialized.add(name);
      for (const path of initializationImports.get(name) ?? []) dependency(name, path, "@initialization");
      data.initial.forEach((node, index) => { selected.set(`${name}:init:${index}`, tokens(data.source.slice(node.start, node.end))); if (node.type === "ImportDeclaration") dependency(name, node.source.value, "*"); else walk(name, node); });
    }
    if (requested === "@initialization") return;
    if (requested === "*") { for (const symbol of data.exports.keys()) visit(name, symbol, true); for (const path of wildcardExports.get(name) ?? []) dependency(name, path, "*"); return; }
    const symbol = exported ? data.exports.get(requested) : requested;
    if (!symbol) {
      const matches = (wildcardExports.get(name) ?? []).filter(path => load(relative(root, resolve(root, dirname(name), path)).replace(/\.js$/, "")).exports.has(requested));
      if (matches.length !== 1) throw new Error(`Scoped export missing or ambiguous: ${name}:${requested}`);
      selected.set(`${name}:export:${requested}`, matches[0]); dependency(name, matches[0]!, requested); return;
    }
    if (data.imports.has(symbol)) { dependency(name, ...data.imports.get(symbol)!); return; }
    const key = `${name}:${symbol}`;
    if (selected.has(key)) return;
    let node = data.nodes.get(symbol);
    if (!node) throw new Error(`Scoped declaration missing: ${key}`);
    // Candidate construction enters install only with candidateContext. Bind its
    // exact dispatch guard and the candidate implementation, not live installation.
    if (name === "commands/install" && symbol === "install") {
      const first = node.body?.body?.[0];
      if (first?.type !== "IfStatement" || data.source.slice(first.start, first.end).replace(/\s/g, "") !== "if(opts.candidateContext)returninstallCandidateInPlace(opts);") throw new Error("Candidate install dispatch changed; scoped dependency mapping must be reviewed");
      node = first;
    }
    selected.set(key, tokens(data.source.slice(node.start, node.end)));
    walk(name, node);
  };
  for (const [name, symbols] of entries) for (const symbol of symbols) visit(name, symbol);
  // Lock data includes exact resolved transitive external versions/integrities.
  let packageRoot = resolve(root);
  while (!existsSync(join(packageRoot, "package-lock.json"))) {
    const parent = dirname(packageRoot); if (parent === packageRoot) throw new Error("Scoped dependency lock is unavailable"); packageRoot = parent;
  }
  selected.set("dependencies", JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8")));
  return digest([...selected].sort(([a], [b]) => a.localeCompare(b)));
}

/** Separately published Manager presentation and self-describing metadata are not patch payload. */
export function doctorCandidatePayloadFingerprint(root: string): string {
  const rows: unknown[] = [];
  const walk = (path: string): void => {
    const name = relative(root, path);
    if (name === "runtime-fingerprint.json" || name === "native/Tweakers Doctor.app") return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { rows.push([name, "link", readlinkSync(path)]); return; }
    // Sealed publication removes write bits. Preserve behavior-relevant execute
    // bits here; the signed package independently binds every actual mode bit.
    if (stat.isDirectory()) { rows.push([name, "directory"]); for (const entry of readdirSync(path).sort()) walk(join(path, entry)); return; }
    if (!stat.isFile()) throw new Error(`Unsupported candidate payload: ${name}`);
    rows.push([name, stat.mode & 0o111, digest(readFileSync(path).toString("base64"))]);
  };
  walk(root); return digest(rows);
}
export function doctorImplementationScopes(moduleRoot?: string, runtimeRoot?: string): DoctorImplementationScopes {
  const managed = resolveSealedManagerManagedRuntimeAssets();
  const own = dirname(fileURLToPath(import.meta.url));
  const root = moduleRoot ?? (managed ? join(managed.root, "packages", "installer", "dist") : own);
  const runtime = runtimeRoot ?? resolveSealedManagerRuntimeAssets()?.root ?? join(root, "..", "assets", "runtime");
  const payload = doctorCandidatePayloadFingerprint(runtime);
  const construction = digest({ version: 1, payload, code: doctorCodeScopeFingerprint(root, [["commands/create-variant", ["createTweakersVariantCandidateOnly"]]]) });
  const verification = digest({ version: 1, construction, code: doctorCodeScopeFingerprint(root, [["doctor-validation", ["collectDoctorValidation"]], ["doctor-compatibility", ["DOCTOR_CORE_CHECKS", "makeDoctorCompatibility", "assertDoctorCompatibility"]]]) });
  const promotion = digest({ code: doctorCodeScopeFingerprint(root, [["commands/create-variant", ["createTweakersVariant"]], ["doctor-approval", ["consumeDoctorCandidateApproval"]], ["manager-action-adapter", ["createSealedTweakersManagerActionAdapter"]]]), payload });
  return { version: 1, construction, verification, promotion, payload };
}
export function sameDoctorCandidateImplementation(a: DoctorImplementationScopes | undefined, b: DoctorImplementationScopes): boolean {
  return a?.version === 1 && a.construction === b.construction && a.verification === b.verification && a.payload === b.payload;
}

/** Full seal verification is required at execution/approval boundaries, not idle UI reads. */
export function verifyDoctorImplementationAssets(): void {
  const managed = resolveSealedManagerManagedRuntimeAssets();
  const runtime = resolveSealedManagerRuntimeAssets();
  if (managed) verifySealedManagerManagedRuntimeAssets(managed);
  if (runtime) verifySealedManagerRuntimeAssets(runtime);
}
