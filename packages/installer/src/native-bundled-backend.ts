import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { suppliedCodeSigningCertificateLeafHash, isMachOMagic, verifySignature } from "./codesign.js";
import { sealOfficialSourceTree, type OfficialSourceTreeSeal } from "./official-source-registration.js";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "./variant-generation.js";

export const NATIVE_CODEX_CLI_ROOT = "Contents/Resources/codex-cli";
export const NATIVE_CODEX_BACKEND = `${NATIVE_CODEX_CLI_ROOT}/CodexCLI.app/Contents/MacOS/codex`;
export const NATIVE_CODE_MODE_HOST = `${NATIVE_CODEX_CLI_ROOT}/bin/codex-code-mode-host`;

interface NativeExecutableBinding { relativePath: string; sha256: string; certificateSha1: string; }
/** Official supplied bytes, never a Cargo/build receipt or managed backend selection. */
export interface OfficialBundledBackendClosure {
  kind: "official-bundled";
  sourceAppRoot: string;
  resourceRelativePath: typeof NATIVE_CODEX_CLI_ROOT;
  resourceTree: OfficialSourceTreeSeal;
  backend: NativeExecutableBinding;
  codeModeHost: NativeExecutableBinding;
  custody?: { kind: "consumed-source"; candidateAppRoot: string; sourceFingerprint: VariantGenerationFingerprint };
}

export interface NativeBundledBackendSignaturePort {
  certificate(path: string): string;
  verify(path: string, certificateSha1?: string): { ok: boolean; output: string };
}
const signaturePort: NativeBundledBackendSignaturePort = {
  certificate: suppliedCodeSigningCertificateLeafHash,
  verify: verifySignature,
};

function physicalExecutable(appRoot: string, relativePath: string): string {
  const path = join(appRoot, relativePath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)
    || realpathSync(path) !== join(realpathSync(appRoot), relativePath)) {
    throw new Error("Official bundled executable must be a physical executable file in its native layout");
  }
  const fd = openSync(path, "r"), header = Buffer.alloc(4);
  try {
    if (readSync(fd, header, 0, 4, 0) !== 4 || !isMachOMagic(header.readUInt32BE())) {
      throw new Error("Official bundled executable must be Mach-O; shell launchers are not backends");
    }
  } finally { closeSync(fd); }
  return path;
}

function executableBinding(appRoot: string, relativePath: string, port: NativeBundledBackendSignaturePort): NativeExecutableBinding {
  const path = physicalExecutable(appRoot, relativePath);
  const certificateSha1 = port.certificate(path).toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(certificateSha1) || !port.verify(path, certificateSha1).ok) {
    throw new Error("Official bundled executable signature is invalid");
  }
  return { relativePath, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), certificateSha1 };
}

/** Caller first proves that this app is the pristine, trusted official source. */
export function captureOfficialBundledBackendClosure(sourceAppRoot: string, port = signaturePort): OfficialBundledBackendClosure | undefined {
  if (!isAbsolute(sourceAppRoot) || resolve(sourceAppRoot) !== sourceAppRoot) throw new Error("Official bundled source must be exact and absolute");
  const root = join(sourceAppRoot, NATIVE_CODEX_CLI_ROOT);
  // Historical flat desktop layouts retain their established signing path.
  if (!existsSync(root)) {
    try { lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    throw new Error("Official native resource root is not resolvable");
  }
  const resourceTree = sealOfficialSourceTree(root);
  const closure: OfficialBundledBackendClosure = {
    kind: "official-bundled", sourceAppRoot, resourceRelativePath: NATIVE_CODEX_CLI_ROOT, resourceTree,
    backend: executableBinding(sourceAppRoot, NATIVE_CODEX_BACKEND, port),
    codeModeHost: executableBinding(sourceAppRoot, NATIVE_CODE_MODE_HOST, port),
  };
  assertOfficialBundledBackendClosure(sourceAppRoot, closure, port);
  return closure;
}

export function assertOfficialBundledBackendClosure(appRoot: string, closure: OfficialBundledBackendClosure, port = signaturePort): void {
  if (closure.kind !== "official-bundled" || closure.resourceRelativePath !== NATIVE_CODEX_CLI_ROOT
    || closure.backend.relativePath !== NATIVE_CODEX_BACKEND || closure.codeModeHost.relativePath !== NATIVE_CODE_MODE_HOST) {
    throw new Error("Unsupported official bundled native closure layout");
  }
  if (JSON.stringify(sealOfficialSourceTree(join(appRoot, NATIVE_CODEX_CLI_ROOT))) !== JSON.stringify(closure.resourceTree)) {
    throw new Error("Official bundled native resource closure changed");
  }
  for (const binding of [closure.backend, closure.codeModeHost]) {
    if (JSON.stringify(executableBinding(appRoot, binding.relativePath, port)) !== JSON.stringify(binding)) {
      throw new Error("Official bundled native executable bytes or signature changed");
    }
  }
}

/** Only the existing source-consumption builder may bind this authorized move. */
export function bindConsumedOfficialBundledBackendClosure(closure: OfficialBundledBackendClosure,
  candidateAppRoot: string, sourceFingerprint: VariantGenerationFingerprint, port = signaturePort,
  observedCandidateFingerprint = fingerprintVariantGeneration(candidateAppRoot)): OfficialBundledBackendClosure {
  if (!isAbsolute(candidateAppRoot) || resolve(candidateAppRoot) !== candidateAppRoot
    || existsSync(closure.sourceAppRoot)
    || JSON.stringify(observedCandidateFingerprint) !== JSON.stringify(sourceFingerprint)) {
    throw new Error("Consumed official source custody does not match the unchanged candidate");
  }
  assertOfficialBundledBackendClosure(candidateAppRoot, closure, port);
  return { ...closure, custody: { kind: "consumed-source", candidateAppRoot, sourceFingerprint } };
}

export function assertOfficialBundledBackendSigningClosure(appRoot: string, closure: OfficialBundledBackendClosure, port = signaturePort): void {
  const source = closure.custody?.kind === "consumed-source" ? closure.custody.candidateAppRoot : closure.sourceAppRoot;
  if (closure.custody && source !== appRoot) throw new Error("Consumed official source custody is bound to another candidate");
  assertOfficialBundledBackendClosure(source, closure, port);
  if (source !== appRoot) assertOfficialBundledBackendClosure(appRoot, closure, port);
}

/** Fixed bounded exclusion; sibling names and arbitrary caller-selected roots never qualify. */
export function isPreservedOfficialBundledBackendPath(appRoot: string, path: string, closure?: OfficialBundledBackendClosure): boolean {
  if (!closure) return false;
  if (closure.resourceRelativePath !== NATIVE_CODEX_CLI_ROOT) throw new Error("Unsupported official bundled native closure layout");
  const root = join(resolve(appRoot), NATIVE_CODEX_CLI_ROOT), target = resolve(path);
  return target === root || target.startsWith(`${root}/`);
}
