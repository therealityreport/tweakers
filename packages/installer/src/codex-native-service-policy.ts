import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "acorn";
import { patchReviewedStartupPolicySource, REVIEWED_STARTUP_POLICY_PATH, REVIEWED_STARTUP_POLICY_20398_PATH } from "./codex-startup-policy.js";

type Callable = (...args: any[]) => any;
type NativeClass = { prototype: Record<string, any> };

export interface DerivedNativeServiceBindings {
  initialState: Record<string, unknown>;
  featureTransform: Callable;
  featureStore: Callable;
  pluginReconciler: Callable;
  spawn: Callable;
  nodeReplConfig: Callable;
  workerFactory: Callable;
  managedService: NativeClass;
  chronicleFacade: NativeClass;
  appshotFacade: NativeClass;
  appshotHotkeys: NativeClass;
  workerBus: NativeClass;
  workerManager: NativeClass;
}

/**
 * Serialized into the reviewed native boot entry, before any native service is
 * constructed. Keep this factory self-contained: the derived app has none of
 * the installer's module imports. It changes only this process's availability;
 * persisted native settings and the genuine desktop's recorder are untouched.
 */
export function createDerivedNativeServicePolicy(bindings: DerivedNativeServiceBindings) {
  const unavailable = () => new Error("Native recording and computer use are unavailable in Tweakers; use the native desktop.");
  const deny = () => { throw unavailable(); };
  const reject = () => Promise.reject(unavailable());
  const mask = (flags: Record<string, unknown>) => ({
    ...flags, appshotsEnabled: false, computerUse: false, computerUseAutoInstall: false, skysight: false,
  });
  const chronicleMethods = ["getState", "retryActivation", "setEnabled", "pause", "resume", "getSettings", "updateSettings", "listApplications", "resolveApplications", "listHistory", "listHistorySuggestions", "listHistorySummaryIntervals", "clearHistory"];
  // Validate the complete installation boundary before modifying any prototype.
  const requirements: [NativeClass, string[]][] = [
    [bindings.managedService, ["setAppshotsEnabled", "setEnabledFeatures", "ensureServicePid", "ensureServicePidForEnabledFeatures"]],
    [bindings.chronicleFacade, chronicleMethods],
    [bindings.appshotFacade, ["setHotkey", "requestFinalUpdate"]],
    [bindings.appshotHotkeys, ["getState", "setEnabled", "setHotkey"]],
    [bindings.workerBus, ["requestFromHost", "handleMessage"]],
    [bindings.workerManager, ["ensureWorker"]],
  ];
  for (const [type, methods] of requirements) {
    for (const name of methods) {
      if (typeof type?.prototype?.[name] !== "function") throw new Error(`Derived native-service policy cannot install: missing ${name}`);
    }
  }
  const managed = bindings.managedService.prototype;
  managed.setAppshotsEnabled = managed.setEnabledFeatures = function (this: any) {
    this.appshotsEnabled = false;
    this.computerUseEnabled = false;
    this.skysightEnabled = false;
    return Promise.resolve();
  };
  managed.ensureServicePid = managed.ensureServicePidForEnabledFeatures = reject;
  for (const name of chronicleMethods) bindings.chronicleFacade.prototype[name] = reject;
  bindings.appshotFacade.prototype.setHotkey = deny;
  bindings.appshotFacade.prototype.requestFinalUpdate = reject;

  const hotkeys = bindings.appshotHotkeys.prototype;
  const getHotkeyState = hotkeys.getState;
  // The original constructor calls getState before registering a shortcut.
  // Preserve its configured value, but prevent both initial and later admission.
  hotkeys.getState = function (this: any, ...args: any[]) {
    return { ...getHotkeyState.apply(this, args), supported: false, isActive: false };
  };
  hotkeys.setEnabled = function (this: any) { this.enabled = false; return Promise.resolve(); };
  hotkeys.setHotkey = deny;

  const manager = bindings.workerManager.prototype;
  const ensureWorker = manager.ensureWorker;
  manager.ensureWorker = function (this: any, ...args: any[]) {
    if (this.id === "computer-use") throw unavailable();
    return ensureWorker.apply(this, args);
  };
  const bus = bindings.workerBus.prototype;
  const requestFromHost = bus.requestFromHost;
  const handleMessage = bus.handleMessage;
  bus.requestFromHost = function (this: any, ...args: any[]) {
    if (this.workerId === "computer-use") return reject();
    return requestFromHost.apply(this, args);
  };
  bus.handleMessage = function (this: any, ...args: any[]) {
    if (this.workerId === "computer-use") return reject();
    return handleMessage.apply(this, args);
  };
  return {
    initialState: mask(bindings.initialState),
    featureTransform: function (this: unknown, ...args: any[]) { return mask(bindings.featureTransform.apply(this, args)); },
    featureStore: function (this: unknown, flags: Record<string, unknown>, ...args: any[]) { return bindings.featureStore.call(this, mask(flags), ...args); },
    // No bundled reconciliation may observe/write the shared native plugin set.
    // Other plugin managers and their user-installed plugins are not modified.
    pluginReconciler: (..._args: any[]): Record<string, Callable> => ({
      reconcileComputerHistoryPluginInstallation: async () => {},
      reconcileExternalPluginState: async () => {},
      reconcileRemoteSshHost: async () => {},
      reloadBundledPlugins: async () => {},
      setDesktopFeatureAvailability: async () => {},
      waitForPendingReconcile: async () => {},
    }),
    spawn: reject,
    nodeReplConfig: function (this: unknown, config: Record<string, unknown>, ...args: any[]) { return bindings.nodeReplConfig.call(this, { ...config, computerUse: false }, ...args); },
    workerFactory: function (this: unknown, ...args: any[]) {
      const workers = bindings.workerFactory.apply(this, args);
      workers.requestComputerUseWorker = reject;
      workers.requestComputerUseCaptureUpdate = reject;
      return workers;
    },
  };
}

const POLICY_MARKER = "__tweakersDerivedNativeServicePolicyV1";
type Gate = Exclude<keyof DerivedNativeServiceBindings, "initialState"> | "boot";
interface SourceProfile {
  id: string;
  initialState: string;
  initialExpression: string;
  gates: Record<Gate, readonly [name: string, sha256: string]>;
}

// Gate hashes were reviewed against signed native 20156/20052/12947 and the pristine
// 10954 official-source baseline, not reconstructed from patched app bytes.
// Boot's first original statement is fingerprinted because Accounts/window
// bridges legitimately patch later statements in the same boot body.
const SOURCE_PROFILES: readonly SourceProfile[] = [
{
  "id": "native20398",
  "initialState": "yi",
  "initialExpression": "{..._i}",
  "gates": {
    "boot": [
      "d0e",
      "e00614772748937a757c303411aa72c9c3fe9fd07915d36af4830b31223e1852"
    ],
    "featureTransform": [
      "ki",
      "f2b9e0abcbe1273ab3ebdf9b96ddc8981fa70c4b2a9e1b764edaca9ebb963d67"
    ],
    "featureStore": [
      "Oi",
      "2b3ac2c540c5f8d3ef82bd20e52cae53af7202100089bcf6e74b405036b3a910"
    ],
    "pluginReconciler": [
      "Rie",
      "091d8055efcf6f72fa9f0563c663bab065966f937a3b4ffb2715f9bf81826003"
    ],
    "spawn": [
      "Wre",
      "863af4400e2ac138de3ae9d6c81e380e0c89542c338485f4b454ff808b75cf9a"
    ],
    "nodeReplConfig": [
      "Dc",
      "b29b1c4d3228c020520af82930392fac97c0e4fc4c4ba6ced54e6f6d71db929a"
    ],
    "workerFactory": [
      "U1e",
      "5cad623fb91d6bdda432a653f0eeacbd196847b524012e57b6d6d5ca703fb994"
    ],
    "managedService": [
      "oae",
      "9b524a333b430ae067d110e77a4f429225690956745fd186be618fdeb47ec86a"
    ],
    "chronicleFacade": [
      "ipe",
      "0e4335d391b4a578870363ead7f69cfdf238f3957679650f994047a672607ebc"
    ],
    "appshotFacade": [
      "Sue",
      "e3d3dffa2b73b0c5761d9c7b1e3b32ca396a10ea2db5fd2bb68b2f49720cb62f"
    ],
    "appshotHotkeys": [
      "QZe",
      "42f883094bcf1e110c04ef39eb611b10b149c592eb91549e79876e77a7fdad3b"
    ],
    "workerBus": [
      "H9",
      "567dca9041b7c3ea7c33c314700da43c217e5bfde519a0a37632c85a3a9b4dc3"
    ],
    "workerManager": [
      "H1e",
      "6f1ca7026d393ef4d532bd5377992283939f9f9c92b086db455eab288444f371"
    ]
  }
},
  {
    "id": "native20052",
    "initialState": "Si",
    "initialExpression": "{...bi}",
    "gates": {
      "boot": [
        "u0e",
        "e00614772748937a757c303411aa72c9c3fe9fd07915d36af4830b31223e1852"
      ],
      "featureTransform": [
        "Mi",
        "86cadeb95c5f072a5ed0962484528d89d594c670d5ec658de49a479e236fd713"
      ],
      "featureStore": [
        "ji",
        "a3b7c79296c803d0043b1b29913d09830e273a56fdb76992ac9d2ea6b7dd2393"
      ],
      "pluginReconciler": [
        "sie",
        "6f2a5f3f324f701fc45222a40e2d88dc769ecbf415c57f66dd57bafcc731e3d9"
      ],
      "spawn": [
        "pd",
        "e427b5a5ddfb1dc45d2fdb2cbd721bee27ed067856f5bf9c664219e10ef35e80"
      ],
      "nodeReplConfig": [
        "ac",
        "782bbcc121101a34c8b5513f730d4673bbc0ccb45d7a70de21431d47964ed4c4"
      ],
      "workerFactory": [
        "H1e",
        "7747596b026e1b3b3d7846ce61de4fbc6edd7c20867a7cb630169a88b4bbb4e7"
      ],
      "managedService": [
        "kie",
        "75d6f01bc42364618abdf5b07579aa84b2151d14828fff0b6da2e4312945c923"
      ],
      "chronicleFacade": [
        "rS",
        "4c63aec6d95baa4a1bb41e3416e26fb0a4ac7a1924ae6bb0c5d7011e6d40870d"
      ],
      "appshotFacade": [
        "Qfe",
        "e3d3dffa2b73b0c5761d9c7b1e3b32ca396a10ea2db5fd2bb68b2f49720cb62f"
      ],
      "appshotHotkeys": [
        "ZZe",
        "79cf3ba1dd56e9e10b23ef2b3959ee0d26ae89003c980fd2ee34d0a60449eea0"
      ],
      "workerBus": [
        "H9",
        "df2e77e48d5f7e5130a7dcd0d32dd8b9c8205a4609f6d2cf22bc8ab0f76e0300"
      ],
      "workerManager": [
        "V1e",
        "b5e14fa37693d80ca785f81d50ac903b846e5bb26d82fa08789660674198b8eb"
      ]
    }
  },
  { id: "native12947", initialState: "ei", initialExpression: "{...Qr}", gates: {
    boot: ["NQe", "b0643db10c8fb215a83d065fa97a70e9a2ca6133d56b9d14a18a172e71b13500"],
    featureTransform: ["ui", "1ced5345bc84a2638d39f9676bbe4cc2563f09307ff3657f1a0b40cab15ee7c1"],
    featureStore: ["li", "0541a5b0dee0a2953668c0d6ded3a9583b2bff4ab2ed40afa771c22e7162bc95"],
    pluginReconciler: ["Eie", "4262e49df094f5bab7ebddb4982becbb08288abdf058ce1c8b6e7570481b7a12"],
    spawn: ["Mre", "0210135d8f9d0b3ebde00a7352396c63ed51b7bff8ba65c267536166e83dfa7f"],
    nodeReplConfig: ["rc", "c6e0f5001419c542a08e608ab45b75a238aa657b58867cf8bbf37a1077cf1f37"],
    workerFactory: ["dQe", "a4b58c2d9b1d8a589ffe9c103845ba0f3996d119ec9b206df73d4a0810861ae7"],
    managedService: ["Jie", "445e18db605deda2bb74e2c22a1837cffe51b6a88ea757ee98c86612df58d0f6"],
    chronicleFacade: ["vfe", "ded4fbd92cb367a26cc8a366cd0fc88d1c0bbbe6d44a81fd97cb288811ee6b05"],
    appshotFacade: ["Mle", "ea1b8b794969a58dd437dac5064933660444417de6c5242bd5903f3916a10961"],
    appshotHotkeys: ["xYe", "3a79470e4f7d60d0c7d2e38492e711106803713b6080af5af925fbb564875fb8"],
    workerBus: ["H9", "d95e30c1b9db61bc97437155ea0d3b1b01becd85241e4403d7f435c2df9973db"],
    workerManager: ["uQe", "b4a3a5f0dac4303b2b04d994ca7a72a93dd4e19f05405fdb77997fa7f115287c"],
  } },
  { id: "Tweakers10954", initialState: "br", initialExpression: "{...vr}", gates: {
    boot: ["Ust", "0080386ebc1c8d93e368b8d7cac82e90f96bf3224e1368482554edcb4bf66f5d"],
    featureTransform: ["Ar", "90f4e20bc4039622a647502001faec203f94eb6a6a83a72537a7b8248e95c6df"],
    featureStore: ["kr", "0a6097c540d29108afee6bf88e0831e7c78d136d21a4af4a9dd53e1e1e998836"],
    pluginReconciler: ["ioe", "0bed4b0bf6d48ae253a03ae27b4fe9733335778c9371a71f3417f37cecb40e8e"],
    spawn: ["ec", "14d3c755151b2b87dd708f82e308c3849eec9737425d2e70a89198295daf72b9"],
    nodeReplConfig: ["bie", "709afb37a70e119d35d358e9a820a8789c5681e8d38b182acd924813bafa2a21"],
    workerFactory: ["xst", "6c23e0b81de4624bb0ebdcc816c208401b487b646f7fbc5a6040d21e71a6a9ec"],
    managedService: ["Eoe", "194a49e5fc821d7c8d148f9712fa4c389af98fd4eabe4cc7fc89194e50f275d5"],
    chronicleFacade: ["IO", "190d3c7625f4ce4233774e3e75a57731676b52cbe9f22b771d0862060946da8f"],
    appshotFacade: ["yOe", "229e0ce9162a8b073ddac68e1ea9d7da67ec771546b1d54ae637212a2358e72e"],
    appshotHotkeys: ["Pit", "574b78f9fa505dd026641b7bf5b63ea3e1079c9eb0fd75e7707ee8098bb9e244"],
    workerBus: ["H9", "1c71785b61c0dd3464bacae5704f59747bef95abc5de0e07982f6a3cc0411390"],
    workerManager: ["bst", "0fd9acd0227319708cf8d3b5861f51baa98ff09214a1f518aa691e4ff609ffa2"],
  } },
];

interface AstNode {
  type: string; start: number; end: number;
  id?: { name: string };
  init?: AstNode;
  body?: { start: number; body: AstNode[] };
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function allNodes(root: unknown): AstNode[] {
  const nodes: AstNode[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if ("type" in value) nodes.push(value as AstNode);
    Object.values(value).forEach(visit);
  };
  visit(root);
  return nodes;
}

function bootstrap(profile: SourceProfile): string {
  const refs = Object.entries(profile.gates).filter(([gate]) => gate !== "boot");
  const argumentsSource = [`initialState:${profile.initialState}`, ...refs.map(([gate, [name]]) => `${gate}:${name}`)].join(",");
  const assignments = ["featureTransform", "featureStore", "pluginReconciler", "spawn", "nodeReplConfig", "workerFactory"].map(gate => `${profile.gates[gate as Gate][0]}=${POLICY_MARKER}.${gate};`).join("");
  // tsx/esbuild may emit local __name annotations when the installer runs from
  // source. Match the established Accounts factory serialization convention.
  return `{const ${POLICY_MARKER}=((__name)=>(${createDerivedNativeServicePolicy.toString()})({${argumentsSource}}))((fn)=>fn);${profile.initialState}=${POLICY_MARKER}.initialState;${assignments}}`;
}

export function patchCodexNativeServicePolicySource(source: string): { source: string; changed: boolean; profile: string } {
  let nodes: AstNode[];
  try { nodes = allNodes(parse(source, { ecmaVersion: "latest", sourceType: "script" })); }
  catch { throw new Error("Derived native-service policy: unsupported or ambiguous vendor source"); }
  // A boot gate name alone cannot select a profile: a retained carrier may
  // declare another profile's boot name for an unrelated function. Only the
  // reviewed boot fingerprint (original or already-installed form) selects.
  const reviewedBoot = (profile: SourceProfile): boolean => {
    const [name, fingerprint] = profile.gates.boot;
    const matches = nodes.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name);
    const body = matches.length === 1 ? matches[0]!.body?.body ?? [] : [];
    const first = body[0];
    if (!first) return false;
    const original = source.slice(first.start, first.end) === bootstrap(profile) ? body[1] : first;
    return !!original && sha256(source.slice(original.start, original.end)) === fingerprint;
  };
  const candidates = SOURCE_PROFILES.filter(reviewedBoot);
  if (candidates.length !== 1) throw new Error("Derived native-service policy: unsupported or ambiguous vendor source profile");
  const profile = candidates[0]!;
  const expectedBootstrap = bootstrap(profile);
  let boot: AstNode | undefined;
  let alreadyPatched = false;
  for (const [gate, [name, fingerprint]] of Object.entries(profile.gates)) {
    const matches = nodes.filter(node => node.id?.name === name && (node.type === "FunctionDeclaration" || node.type === "VariableDeclarator" && node.init?.type === "ClassExpression"));
    if (matches.length !== 1) throw new Error(`Derived native-service policy: ambiguous or missing ${gate} gate`);
    const node = matches[0]!.type === "VariableDeclarator" ? matches[0]!.init! : matches[0]!;
    let text = source.slice(node.start, node.end);
    if (gate === "boot") {
      boot = node;
      const first = node.body?.body[0];
      if (!first) throw new Error("Derived native-service policy: unsupported empty boot");
      if (source.slice(first.start, first.end) === expectedBootstrap) {
        alreadyPatched = true;
        const originalFirst = node.body!.body[1];
        if (!originalFirst) throw new Error("Derived native-service policy: unsupported empty original boot");
        text = source.slice(originalFirst.start, originalFirst.end);
      } else text = source.slice(first.start, first.end);
    }
    if (sha256(text) !== fingerprint) throw new Error(`Derived native-service policy: unsupported ${gate} fingerprint (${profile.id})`);
  }
  const initial = nodes.filter(node => node.type === "VariableDeclarator" && node.id?.name === profile.initialState);
  if (initial.length !== 1 || !initial[0]!.init || source.slice(initial[0]!.init!.start, initial[0]!.init!.end) !== profile.initialExpression) {
    throw new Error("Derived native-service policy: unsupported initial feature state");
  }
  // A marker without the exact reviewed bootstrap cannot establish installation.
  const markerDeclarations = nodes.filter(node => node.type === "VariableDeclarator" && node.id?.name === POLICY_MARKER);
  if (markerDeclarations.length !== (alreadyPatched ? 1 : 0)) throw new Error("Derived native-service policy: ambiguous bootstrap marker");
  if (alreadyPatched) return { source, changed: false, profile: profile.id };
  const insertion = boot!.body!.start + 1;
  return { source: source.slice(0, insertion) + expectedBootstrap + source.slice(insertion), changed: true, profile: profile.id };
}

// Reviewed vendor entry chains. Fingerprint both intermediate modules so an
// unrelated main chunk, changed startup order, or unknown layout fails closed.
const ENTRY_CHAINS = [
{
  "entry": "036bde993c50a1a34d0f7a0ee4f3d57b5592b4cfe3b2a87b4022b263bf0367aa",
  "bootstrap": ".vite/build/bootstrap-DOZRFVdo.js",
  "bootstrapHash": "8602f1022fc835148268e8cdfcfb939d8ab5a969e4fd0b4141e264ce8ec4be4d",
  "main": ".vite/build/main-CwxgTOle.js"
},
  {
    "entry": "36b8494989d89f9b063a27f10b60119243c8e4cc8abd2ef8a9743c507d15019c",
    "bootstrap": ".vite/build/bootstrap-CooIJpZm.js",
    "bootstrapHash": "d1ab6d0bb5aabf4d56a3cb39d979dc1145e41b47be6821b967cba3802af3fbf0",
    "main": ".vite/build/main-CqEoQDOU.js"
  },
  {
    "entry": "24286bb6b5fe449e6d4f1b8cfc061c35be57e54fe4ea0802b3e257f32c45fc33",
    "bootstrap": ".vite/build/bootstrap-Du6FqCuH.js",
    "bootstrapHash": "7c8665efb642d0683d42bb0c2b4ac6c80bfd3c19eecd0fa0ee5a8a9934fa17c4",
    "main": ".vite/build/main-39FdJ_vp.js"
  },
  {
    "entry": "5df795f25c3541029b9e90b205767fbc76da559864bd3df1f00d6eee97179edc",
    "bootstrap": ".vite/build/bootstrap-C4dRql4x.js",
    "bootstrapHash": "0757af0981f4552ca79ed1a364eafa6a73e71a92e65ea4fce747c7b6c715ed4a",
    "main": ".vite/build/main-C-Mhak1n.js"
  },
  {
    "entry": "57b58f5aa3b268487a9410ae83626daefde98d604fe608827a64e9f1c7727784",
    "bootstrap": ".vite/build/bootstrap-D3_zvIvQ.js",
    "bootstrapHash": "35d486c724973490ad66921f6a451ac6aa59d14e31f977f0486ef9574976177e",
    "main": ".vite/build/main-lQ71Zm1D.js"
  },
  {
    "entry": "1ef64d429d6399c51d8f2042652925a1e586ac8c70f3b0c156203f894574dd7b",
    "bootstrap": ".vite/build/bootstrap-D18rbfeM.js",
    "bootstrapHash": "d51325ac1db018c4cd867225c0efe5cded678268cd9eee9270d05dfd48f4bcad",
    "main": ".vite/build/main-vwle0m1s.js"
  }
];

function reviewedSourcePath(root: string, entry: string): string {
  const base = resolve(root);
  const path = resolve(base, entry);
  const rel = relative(base, path);
  if (isAbsolute(entry) || rel === ".." || rel.startsWith(`..${sep}`) || !existsSync(path)
    || !lstatSync(path).isFile() || realpathSync(path) !== resolve(realpathSync(base), rel)) {
    throw new Error("Derived native-service policy: unsupported native entry path");
  }
  return path;
}

/** Only called by the derived-identity loader path, never by a native install. */
export function patchCodexNativeServicePolicyInExtractedApp(root: string, originalMain: string) {
  let path = reviewedSourcePath(root, originalMain);
  if (originalMain === ".vite/build/early-bootstrap.js") {
    const chain = ENTRY_CHAINS.find(candidate => candidate.entry === sha256(readFileSync(path, "utf8")));
    if (!chain) throw new Error("Derived native-service policy: unsupported early bootstrap");
    const bootstrapPath = reviewedSourcePath(root, chain.bootstrap);
    if (sha256(readFileSync(bootstrapPath, "utf8")) !== chain.bootstrapHash) {
      throw new Error("Derived native-service policy: unsupported native bootstrap");
    }
    if (chain.main === ".vite/build/main-CqEoQDOU.js" || chain.main === ".vite/build/main-CwxgTOle.js") {
      const policyCarrier = chain.main === ".vite/build/main-CwxgTOle.js" ? REVIEWED_STARTUP_POLICY_20398_PATH : REVIEWED_STARTUP_POLICY_PATH;
      const policyPath = reviewedSourcePath(root, policyCarrier);
      const policy = patchReviewedStartupPolicySource(readFileSync(policyPath, "utf8"), policyCarrier);
      if (policy.changed) writeFileSync(policyPath, policy.source);
    }
    path = reviewedSourcePath(root, chain.main);
  }
  const result = patchCodexNativeServicePolicySource(readFileSync(path, "utf8"));
  if (result.changed) writeFileSync(path, result.source);
  return { changed: result.changed, profile: result.profile };
}
