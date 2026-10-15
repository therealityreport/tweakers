"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertAcceptedRuntimeRepairFilesystemOwner = assertAcceptedRuntimeRepairFilesystemOwner;
exports.assertAcceptedRuntimeRepairMutableConfig = assertAcceptedRuntimeRepairMutableConfig;
exports.assertAcceptedRuntimeRepairReadSize = assertAcceptedRuntimeRepairReadSize;
exports.readAcceptedRuntimeRepairImmutableAttestation = readAcceptedRuntimeRepairImmutableAttestation;
exports.readAcceptedRuntimeRepairSealedSourceCustody = readAcceptedRuntimeRepairSealedSourceCustody;
exports.assertAcceptedRuntimeRepairBundledSourceDelta = assertAcceptedRuntimeRepairBundledSourceDelta;
exports.readAcceptedRuntimeRepairBootstrap = readAcceptedRuntimeRepairBootstrap;
exports.readAcceptedRuntimeRepairHistoricalBootstrap = readAcceptedRuntimeRepairHistoricalBootstrap;
exports.readSupersededNativeReplacementHistoricalBootstrap = readSupersededNativeReplacementHistoricalBootstrap;
exports.assertAcceptedRuntimeRepairChallengeCurrent = assertAcceptedRuntimeRepairChallengeCurrent;
exports.assertAcceptedRuntimeRepairExpectationProjection = assertAcceptedRuntimeRepairExpectationProjection;
/** Initialization gate for a Manager-authenticated bounded runtime repair.
 * This module runs inside loaded main.js. It is not a pre-entry code authenticator.
 */
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const tweakers_sdk_1 = require("@therealityreport/tweakers-sdk");
const transfer_recovery_1 = require("./account-router/transfer-recovery");
const sha = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(`Accepted runtime repair initialization: ${message}`); };
const equal = (actual, expected, message) => {
    if (!(0, node_util_1.isDeepStrictEqual)(actual, expected))
        fail(message);
};
const canonical = (path) => (0, node_path_1.isAbsolute)(path) && (0, node_path_1.resolve)(path) === path;
const contractDeps = { isCanonicalAbsolutePath: canonical, sha256: sha };
/** The system app parent has different ownership from private Manager evidence. */
function assertAcceptedRuntimeRepairFilesystemOwner(input) {
    const systemRoot = input.path === input.root && input.root === "/Applications" && !input.privateLeaf && input.uid === 0;
    if (input.symlink || (input.uid !== input.currentUid && !systemRoot)
        || (input.mode & (systemRoot ? 0o002 : 0o022)) !== 0
        || (input.privateLeaf && (input.mode & 0o077) !== 0))
        fail("unsafe custody owner, mode or alias");
}
/** Config has open tweak namespaces; normal startup retains mutable user preferences. */
function assertAcceptedRuntimeRepairMutableConfig(value) {
    const config = object(value);
    for (const key of ["tweaker", "tweaks", "tweakUpdateChecks", "tweakHealth"]) {
        if (Object.hasOwn(config, key))
            object(config[key]);
    }
    if (Object.hasOwn(config, "tweaks"))
        for (const value of Object.values(config.tweaks)) {
            const tweak = object(value);
            if (Object.hasOwn(tweak, "enabled") && typeof tweak.enabled !== "boolean")
                fail("mutable tweak toggle is malformed");
        }
}
function safePath(root, path, privateLeaf) {
    if (!canonical(root) || !canonical(path) || (path !== root && !path.startsWith(`${root}/`)) || (0, node_fs_1.realpathSync)(root) !== root)
        fail("noncanonical custody path");
    for (let cursor = path;; cursor = (0, node_path_1.dirname)(cursor)) {
        const stat = (0, node_fs_1.lstatSync)(cursor);
        assertAcceptedRuntimeRepairFilesystemOwner({ root, path: cursor, uid: stat.uid, mode: stat.mode,
            currentUid: process.getuid?.(), privateLeaf, symlink: stat.isSymbolicLink() });
        if (cursor !== path && !stat.isDirectory())
            fail("nondirectory custody ancestor");
        if (cursor === root)
            break;
    }
}
function attestationAlias(root, path, identity) {
    if ((0, node_path_1.dirname)((0, node_path_1.dirname)(path)) !== (0, node_path_1.join)(root, "codex-source", "accepted")
        || !["accepted-build.json", "review-manifest.json"].includes((0, node_path_1.basename)(path)) || (identity.mode & 0o777) !== 0o600)
        fail("unsupported immutable attestation path or mode");
    if (identity.nlink === 1)
        return null;
    if (identity.nlink !== 2)
        fail("immutable attestation has unknown links");
    const escaped = (0, node_path_1.basename)(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\.${escaped}\\.[1-9][0-9]*\\.[0-9]+\\.tmp$`);
    const aliases = (0, node_fs_1.readdirSync)((0, node_path_1.dirname)(path)).filter(name => {
        if (!pattern.test(name))
            return false;
        const candidate = (0, node_path_1.join)((0, node_path_1.dirname)(path), name), stat = (0, node_fs_1.lstatSync)(candidate);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino)
            return false;
        safePath(root, candidate, true);
        if (!stat.isFile() || stat.nlink !== 2 || stat.uid !== identity.uid || stat.gid !== identity.gid || stat.mode !== identity.mode)
            fail("retained publisher alias changed");
        return true;
    });
    if (aliases.length !== 1)
        fail("immutable attestation lacks its exact retained publisher link");
    return (0, node_path_1.join)((0, node_path_1.dirname)(path), aliases[0]);
}
function bytes(root, path, privateFile = true, maximum = 32 * 1024 * 1024, acceptedAttestation = false) {
    safePath(root, path, privateFile);
    const namedBefore = (0, node_fs_1.lstatSync)(path);
    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    try {
        const before = (0, node_fs_1.fstatSync)(fd);
        assertAcceptedRuntimeRepairReadSize(before.size, maximum === 512 * 1024 * 1024 ? "generated-payload" : "json-proof");
        if (!before.isFile() || (before.nlink !== 1 && !(acceptedAttestation && before.nlink === 2)) || before.size > maximum
            || before.dev !== namedBefore.dev || before.ino !== namedBefore.ino)
            fail("unsafe regular file");
        const publisherAlias = acceptedAttestation ? attestationAlias(root, path, before) : null;
        const result = (0, node_fs_1.readFileSync)(fd), after = (0, node_fs_1.fstatSync)(fd), named = (0, node_fs_1.lstatSync)(path);
        for (const key of ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"]) {
            if (before[key] !== after[key] || before[key] !== named[key])
                fail("custody file changed during read");
        }
        if (named.isSymbolicLink())
            fail("custody file became linked");
        if (acceptedAttestation && attestationAlias(root, path, named) !== publisherAlias)
            fail("retained publisher alias changed during read");
        return result;
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
/** Fixed raw-binary allowance does not raise durable JSON/proof limits. */
function assertAcceptedRuntimeRepairReadSize(size, kind) {
    if (kind !== "json-proof" && kind !== "generated-payload")
        fail("unknown file read policy");
    const maximum = (kind === "generated-payload" ? 512 : 32) * 1024 * 1024;
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum)
        fail("file exceeds its bounded read policy");
}
function json(root, path, privateFile = true) {
    return parsed(bytes(root, path, privateFile));
}
function parsed(value) { return (0, tweakers_sdk_1.parseAcceptedRuntimeRepairJson)(new TextDecoder("utf-8", { fatal: true }).decode(value)); }
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail("expected a record");
    return value;
}
function exact(value, keys) {
    const item = object(value);
    equal(Object.keys(item).sort(), keys.sort(), "unexpected record fields");
    return item;
}
function verifySignature(path, identifier, trustedLeaf) {
    const clauses = [identifier ? `identifier "${identifier}"` : null, trustedLeaf ? `certificate leaf = H"${trustedLeaf.toLowerCase()}"` : null].filter(Boolean);
    const result = (0, node_child_process_1.spawnSync)("/usr/bin/codesign", ["--verify", "--strict", ...(clauses.length ? [`-R=${clauses.join(" and ")}`] : []), path], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.signal || result.status !== 0)
        fail("actual strict signature verification failed");
}
function generation(root, path, expected, deps) {
    safePath(root, path, false);
    equal(deps.fingerprint(path), expected, "generation fingerprint changed");
}
function fileRef(root, ref, privateFile = true) {
    const result = bytes(root, ref.path, privateFile);
    if (sha(result) !== ref.sha256)
        fail("retained file digest changed");
    return result;
}
/** Closed compatibility with the durable immutable publisher's retained temporary links. */
function readAcceptedRuntimeRepairImmutableAttestation(root, path, expectedSha256) {
    const result = bytes(root, path, true, 32 * 1024 * 1024, true);
    if (sha(result) !== expectedSha256)
        fail("original immutable attestation changed");
    return result;
}
const SOURCE_CHECKS = [
    ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/installer/tsconfig.json"],
    ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/runtime/tsconfig.json"],
    ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/sdk/tsconfig.json"],
    ["--import", "./scripts/test-root-preload.mjs", "--import", "tsx", "--test", "--test-concurrency=2", "--test-name-pattern=accepted runtime repair|schema6|schema5 is explicit",
        "packages/installer/test/accepted-runtime-repair.test.ts", "packages/installer/test/runtime-repair-source-custody.test.ts",
        "packages/installer/test/runtime-ready-receipt.test.ts", "packages/runtime/test/accepted-runtime-repair-contract.test.ts",
        "packages/installer/test/manager-historical-continuations.test.ts",
        "packages/installer/test/manager-action-adapter.test.ts", "packages/installer/test/manager-cli.test.ts",
        "packages/installer/test/generation-retention.test.ts",
        "packages/runtime/test/accepted-runtime-repair-bootstrap.test.ts", "packages/runtime/test/desktop-update-startup.test.ts"],
    ["--test", "scripts/verify-runtime-repair-source.test.mjs"],
];
const REVIEWED_SOURCES = new Set([
    "packages/sdk/src/accepted-backend-transition-contract.ts", "packages/sdk/src/accepted-runtime-repair-contract.ts", "packages/sdk/src/index.ts",
    "packages/runtime/src/accepted-runtime-repair-bootstrap.ts", "packages/runtime/src/desktop-update-startup.ts", "packages/runtime/src/main.ts",
    "packages/runtime/src/account-router/transfer-recovery.ts", "packages/runtime/src/account-router/native-transfer.ts", "packages/runtime/src/account-router/native-source-retirement.ts",
    "packages/installer/src/accepted-runtime-repair.ts", "packages/installer/src/runtime-repair-source-custody.ts",
    "packages/installer/src/shared-native-backend-transition.ts", "packages/installer/src/prebuilt-combined-candidate.ts",
    "packages/installer/src/commands/create-variant.ts", "packages/installer/src/runtime-ready-receipt.ts",
    "packages/installer/src/manager-recovery-evidence.ts", "packages/installer/src/manager-action-adapter.ts",
    "packages/installer/src/manager-historical-continuations.ts",
    "packages/installer/src/generation-retention.ts",
    "packages/installer/src/doctor-updates.ts", "packages/installer/src/doctor-approval.ts", "packages/installer/src/doctor-store.ts",
    "packages/installer/src/doctor-implementation.ts", "packages/installer/src/cli.ts", "packages/installer/src/manager-cli.ts",
    "packages/installer/scripts/copy-assets.mjs", "scripts/verify-runtime-repair-source.mjs",
]);
const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validRelative = (value) => typeof value === "string" && value.length > 0 && value.length < 4096
    && !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
/** Read fixed data from a fully verified worker; this never executes installer code or claims compiler authenticity. */
function readAcceptedRuntimeRepairSealedSourceCustody(root, moduleRoot, baseline) {
    const record = exact(json(root, (0, node_path_1.join)(moduleRoot, "runtime-repair-source-custody.json"), false), ["version", "kind", "checkReceipt", "sourceFiles", "packagedRuntime", "generatedFiles"]);
    if (record.version !== 1 || record.kind !== "tweakers-runtime-repair-source-custody" || !Array.isArray(record.sourceFiles)
        || record.sourceFiles.length < 1 || record.sourceFiles.length > 100_000)
        fail("sealed source custody schema changed");
    const sourceMap = new Map();
    let previous = "";
    for (const value of record.sourceFiles) {
        const source = exact(value, ["relativePath", "mode", "sha256"]);
        if (!validRelative(source.relativePath) || !validHash(source.sha256) || !Number.isInteger(source.mode) || source.mode < 0 || source.mode > 0o777
            || (previous && previous.localeCompare(source.relativePath) >= 0))
            fail("sealed source inventory changed");
        previous = source.relativePath;
        sourceMap.set(source.relativePath, source.sha256);
    }
    const checkRef = exact(record.checkReceipt, ["relativePath", "sha256"]);
    if (checkRef.relativePath !== "runtime-repair-source-evidence/checks.json" || !validHash(checkRef.sha256))
        fail("source checks escaped fixed evidence");
    const checkBytes = fileRef(root, { path: (0, node_path_1.join)(moduleRoot, checkRef.relativePath), sha256: checkRef.sha256 }, false);
    const checks = exact(parsed(checkBytes), ["version", "kind", "checkoutRoot", "sourceFiles", "inputIdentity", "node", "dependencyIdentity", "environmentIdentity", "inputSnapshots", "checks"]);
    if (checks.version !== 1 || checks.kind !== "tweakers-runtime-repair-source-checks" || typeof checks.checkoutRoot !== "string" || !canonical(checks.checkoutRoot)
        || checks.inputIdentity !== sha(JSON.stringify(record.sourceFiles)) || !validHash(checks.dependencyIdentity) || !validHash(checks.environmentIdentity)
        || !Array.isArray(checks.checks) || checks.checks.length !== SOURCE_CHECKS.length)
        fail("sealed source checks changed");
    equal(checks.sourceFiles, record.sourceFiles, "checks changed source inventory");
    const node = exact(checks.node, ["path", "sha256", "version"]);
    if (typeof node.path !== "string" || !canonical(node.path) || !validHash(node.sha256) || typeof node.version !== "string"
        || node.version.length < 1 || node.version.length >= 100)
        fail("source check Node identity changed");
    let runId;
    for (const [index, value] of checks.checks.entries()) {
        const check = exact(value, ["command", "argv", "cwd", "startedAt", "completedAt", "exitCode", "stdout", "stderr"]);
        if (check.command !== node.path || check.cwd !== checks.checkoutRoot || check.exitCode !== 0 || typeof check.startedAt !== "string" || typeof check.completedAt !== "string"
            || !Number.isFinite(Date.parse(check.startedAt)) || !Number.isFinite(Date.parse(check.completedAt))
            || Date.parse(check.completedAt) < Date.parse(check.startedAt))
            fail("source checks lack actual passing command evidence");
        equal(check.argv, SOURCE_CHECKS[index], "source checks changed fixed commands");
        for (const stream of ["stdout", "stderr"]) {
            const ref = exact(check[stream], ["relativePath", "sha256"]);
            if (typeof ref.relativePath !== "string" || !validHash(ref.sha256)
                || !new RegExp(`^logs/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/${index}\\.${stream}\\.log$`).test(ref.relativePath))
                fail("source log escaped exact run");
            const id = ref.relativePath.split("/")[1];
            if (runId && runId !== id)
                fail("source checks combine separate runs");
            runId = id;
            fileRef(root, { path: (0, node_path_1.join)(moduleRoot, "runtime-repair-source-evidence", ref.relativePath), sha256: ref.sha256 }, false);
        }
    }
    const snapshots = exact(checks.inputSnapshots, ["before", "after"]);
    let before;
    const expectedSnapshot = { sourceFiles: checks.sourceFiles, inputIdentity: checks.inputIdentity, dependencyIdentity: checks.dependencyIdentity,
        environmentIdentity: checks.environmentIdentity, node: checks.node };
    for (const side of ["before", "after"]) {
        const ref = exact(snapshots[side], ["relativePath", "sha256"]);
        if (ref.relativePath !== `logs/${runId}/inputs-${side}.json` || !validHash(ref.sha256))
            fail("input snapshots escaped check run");
        const raw = fileRef(root, { path: (0, node_path_1.join)(moduleRoot, "runtime-repair-source-evidence", ref.relativePath), sha256: ref.sha256 }, false);
        equal(parsed(raw), expectedSnapshot, "actual source check inputs changed");
        if (before)
            equal(raw, before, "source check inputs changed during run");
        before = raw;
    }
    equal(exact(record.packagedRuntime, ["fingerprint", "fileCount", "documentSha256"]), baseline, "packaged runtime differs from sealed worker baseline");
    if (!Array.isArray(record.generatedFiles) || record.generatedFiles.length < 1 || record.generatedFiles.length >= 8192)
        fail("sealed compiler mappings absent");
    const managedRoot = (0, node_path_1.resolve)(moduleRoot, "../../.."), generated = new Set();
    for (const value of record.generatedFiles) {
        const file = exact(value, ["relativePath", "mode", "sha256", "sealedMode", "mappingKind", "sourceInputs"]);
        if (!validRelative(file.relativePath) || !validHash(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
            || file.sealedMode !== ((file.mode & 0o100) ? 0o500 : 0o400) || !["tsc-source-map", "esbuild-source-map", "paired-tsc-declaration"].includes(file.mappingKind)
            || generated.has(file.relativePath) || !Array.isArray(file.sourceInputs) || file.sourceInputs.length < 1)
            fail("sealed compiler mapping changed");
        generated.add(file.relativePath);
        const inputs = new Set();
        for (const value of file.sourceInputs) {
            const input = exact(value, ["relativeSourcePath", "sha256"]);
            if (sourceMap.get(input.relativeSourcePath) !== input.sha256 || inputs.has(input.relativeSourcePath))
                fail("compiler mapping changed verified input");
            inputs.add(input.relativeSourcePath);
        }
        const path = (0, node_path_1.join)(managedRoot, file.relativePath);
        fileRef(root, { path, sha256: file.sha256 }, false);
        if (((0, node_fs_1.lstatSync)(path).mode & 0o777) !== file.sealedMode)
            fail("compiler output sealed mode changed");
    }
    return record;
}
function generatedInventory(root, managedRoot) {
    const output = [];
    const walk = (path) => {
        const name = (0, node_path_1.relative)(managedRoot, path), stat = (0, node_fs_1.lstatSync)(path);
        if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
            fail("unsafe generated inventory entry");
        if (name === "managed-runtime-fingerprint.json" || name === "packages/installer/dist/runtime-repair-source-custody.json"
            || name === "packages/installer/dist/runtime-repair-source-evidence")
            return;
        if (stat.isDirectory())
            for (const entry of (0, node_fs_1.readdirSync)(path).sort())
                walk((0, node_path_1.join)(path, entry));
        else if (stat.isFile())
            output.push({ relativePath: name, mode: stat.mode & 0o777, sha256: sha(bytes(root, path, false, 512 * 1024 * 1024)) });
        else
            fail("unsupported generated inventory entry");
    };
    walk(managedRoot);
    return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
/** Recompute the bounded complete generated delta, rather than accepting a caller's changed-file list. */
function verifySourceDelta(root, childRoot, intent, original, repaired, custody, originalCandidate, deps) {
    const delta = intent.authority.sourceDelta;
    if (delta.originalSourceVerification.path !== (0, node_path_1.join)(childRoot, "original-sealed-source-verification.json")
        || delta.repairedSourceVerification.path !== (0, node_path_1.join)(repaired.moduleRoot, "runtime-repair-source-custody.json")
        || delta.reviewedDelta.path !== (0, node_path_1.join)(childRoot, "reviewed-generated-delta.json"))
        fail("source verification escaped fixed custody");
    const proof = exact(parsed(fileRef(root, delta.originalSourceVerification)), ["version", "kind", "qualification", "worker", "moduleRoot", "runtimeRoot",
        "moduleGeneration", "runtimeGeneration", "candidateReceipt", "candidateReceiptBundleGeneration"]);
    equal(proof, { version: 1, kind: "tweakers-runtime-repair-original-sealed-verification",
        qualification: "retained-sealed-module-and-runtime-not-historical-raw-ts", worker: intent.authority.originalWorker,
        moduleRoot: original.moduleRoot, runtimeRoot: original.runtimeRoot, moduleGeneration: deps.fingerprint(original.moduleRoot),
        runtimeGeneration: deps.fingerprint(original.runtimeRoot), candidateReceipt: originalCandidate.json,
        candidateReceiptBundleGeneration: originalCandidate.bundleGeneration }, "original source verification fabricated or changed retained custody");
    equal(parsed(fileRef(root, delta.repairedSourceVerification, false)), custody, "repaired source verification differs from fixed sealed record");
    const oldRoot = (0, node_path_1.resolve)(original.moduleRoot, "../../.."), newRoot = (0, node_path_1.resolve)(repaired.moduleRoot, "../../..");
    const before = generatedInventory(root, oldRoot), after = generatedInventory(root, newRoot);
    const old = new Map(before.map(file => [file.relativePath, file])), current = new Map(after.map(file => [file.relativePath, file]));
    for (const path of old.keys())
        if (!current.has(path))
            fail("repair removed an unreviewed generated file");
    const changes = [];
    for (const file of after) {
        const previous = old.get(file.relativePath);
        if (previous && previous.mode === file.mode && previous.sha256 === file.sha256)
            continue;
        if (file.relativePath === "packages/installer/assets/runtime/runtime-fingerprint.json") {
            if (file.sha256 !== custody.packagedRuntime.documentSha256 || !previous || previous.mode !== file.mode)
                fail("runtime metadata changed outside build projection");
            changes.push({ relativePath: file.relativePath, before: previous, after: file, sourceInputs: [] });
            continue;
        }
        const mapped = custody.generatedFiles.find((item) => item.relativePath === file.relativePath);
        if (!mapped || mapped.sha256 !== file.sha256 || mapped.sealedMode !== file.mode
            || !mapped.sourceInputs.some((input) => REVIEWED_SOURCES.has(input.relativeSourcePath)))
            fail("generated delta lacks reviewed compiler input");
        if (mapped.mappingKind === "esbuild-source-map") {
            if (!previous)
                fail("new bundle lacks retained original source inputs");
            verifyBundledSourceDelta(root, oldRoot, newRoot, file.relativePath);
        }
        changes.push({ relativePath: file.relativePath, before: previous ?? null, after: file, sourceInputs: mapped.sourceInputs });
    }
    if (changes.length < 1)
        fail("runtime repair has no generated delta");
    equal(parsed(fileRef(root, delta.reviewedDelta)), { version: 1, kind: "tweakers-runtime-repair-reviewed-generated-delta",
        originalInventorySha256: sha(JSON.stringify(before)), repairedInventorySha256: sha(JSON.stringify(after)), changes }, "reviewed generated delta changed");
    equal(delta.changedGeneratedFiles, changes.map(change => ({ path: (0, node_path_1.join)(newRoot, change.relativePath), sha256: change.after.sha256 })), "changed files differ from complete reviewed delta");
}
function verifyBundledSourceDelta(root, beforeRoot, afterRoot, path) {
    const before = bytes(root, (0, node_path_1.join)(beforeRoot, path), false), after = bytes(root, (0, node_path_1.join)(afterRoot, path), false);
    const external = (directory) => path.endsWith(".js") && (0, node_fs_1.existsSync)((0, node_path_1.join)(directory, path + ".map"))
        ? bytes(root, (0, node_path_1.join)(directory, path + ".map"), false) : undefined;
    assertAcceptedRuntimeRepairBundledSourceDelta(before, after, path, external(beforeRoot), external(afterRoot));
}
/** A bundle containing an approved file does not grant permission to change its other embedded inputs. */
function assertAcceptedRuntimeRepairBundledSourceDelta(beforeBytes, afterBytes, path, beforeExternalMap, afterExternalMap) {
    const generatedPath = path.replace(/\.js\.map$/, ".js");
    const mappedPath = generatedPath.startsWith("packages/installer/assets/runtime/")
        ? generatedPath.replace("packages/installer/assets/runtime/", "packages/runtime/dist/") : generatedPath;
    if (!["packages/runtime/dist/", "packages/installer/dist/", "packages/sdk/dist/"].some(prefix => mappedPath.startsWith(prefix)))
        fail("unknown bundled output group");
    const inputs = (payload, externalMap) => {
        const inline = /\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(payload.toString("utf8"));
        const map = object(parsed(inline ? Buffer.from(inline[1], "base64") : externalMap ?? payload));
        if (map.version !== 3 || !Array.isArray(map.sources) || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length
            || (map.sourceRoot !== undefined && map.sourceRoot !== ""))
            fail("retained bundle lacks complete source inputs");
        const result = new Map();
        for (const [index, source] of map.sources.entries()) {
            if (typeof source !== "string" || (0, node_path_1.isAbsolute)(source) || /^[a-z]+:/i.test(source) || typeof map.sourcesContent[index] !== "string")
                fail("foreign retained bundle input");
            const name = (0, node_path_1.relative)("/fixed-checkout", (0, node_path_1.resolve)("/fixed-checkout", (0, node_path_1.dirname)(mappedPath), source));
            if (!validRelative(name) || result.has(name))
                fail("ambiguous retained bundle input");
            result.set(name, sha(map.sourcesContent[index]));
        }
        return result;
    };
    const before = inputs(beforeBytes, beforeExternalMap), after = inputs(afterBytes, afterExternalMap);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(name) !== after.get(name) && !REVIEWED_SOURCES.has(name))
            fail("unreviewed bundled source changed");
    }
}
/** Fully hash a sealed runtime tree; never execute retained JavaScript. */
function runtimeTree(root, path, documentName, expected) {
    safePath(root, path, true);
    const document = object(json(root, (0, node_path_1.join)(path, documentName), false));
    const hash = (0, node_crypto_1.createHash)("sha256");
    let fileCount = 0;
    const managed = documentName === "managed-runtime-fingerprint.json";
    const addManaged = (type, name, mode, payload) => {
        hash.update(`${type}\0${name}\0${(mode & 0o7777).toString(8)}\0${payload.length}\0`).update(payload);
    };
    const walk = (directory) => {
        if (managed)
            addManaged("directory", (0, node_path_1.relative)(path, directory), (0, node_fs_1.lstatSync)(directory).mode, Buffer.alloc(0));
        for (const entry of (0, node_fs_1.readdirSync)(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === ".DS_Store" || (!managed && entry.name.startsWith("._")))
                continue;
            const full = (0, node_path_1.join)(directory, entry.name), name = (0, node_path_1.relative)(path, full), stat = (0, node_fs_1.lstatSync)(full);
            if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
                fail("unsafe sealed tree entry");
            if (name === documentName)
                continue;
            if (stat.isDirectory())
                walk(full);
            else if (stat.isFile()) {
                const payload = bytes(root, full, false, 512 * 1024 * 1024);
                if (managed)
                    addManaged("file", name, stat.mode, payload);
                else
                    hash.update(name).update("\0").update(payload).update("\0");
                fileCount++;
            }
            else
                fail("unsupported sealed tree entry");
        }
    };
    if (managed) {
        for (const name of ["package.json", "package-lock.json", "bin", "node_modules", "packages/installer/package.json", "packages/installer/dist", "packages/installer/assets", "packages/sdk/package.json", "packages/sdk/dist"]) {
            const full = (0, node_path_1.join)(path, name);
            if (!(0, node_fs_1.existsSync)(full)) {
                hash.update(`missing\0${name}\0`);
                continue;
            }
            if ((0, node_fs_1.lstatSync)(full).isDirectory())
                walk(full);
            else {
                addManaged("file", name, (0, node_fs_1.lstatSync)(full).mode, bytes(root, full, false));
                fileCount++;
            }
        }
    }
    else
        walk(path);
    if (document.schemaVersion !== 1 || document.fingerprint !== expected || !Number.isSafeInteger(document.fileCount)
        || document.fileCount !== fileCount || hash.digest("hex") !== expected)
        fail("sealed runtime fingerprint changed");
}
function worker(root, custody, deps, trustedLeaf) {
    const generationRoot = (0, node_path_1.join)(root, "managers", "com.thomashulihan.tweakers", "generations", custody.generationId);
    const launcher = (0, node_path_1.join)(generationRoot, "Tweakers Manager Launcher");
    if (custody.launcherPath !== launcher || sha(bytes(root, launcher, false)) !== custody.launcherSha256)
        fail("worker launcher binding changed");
    const sealPath = (0, node_path_1.join)(generationRoot, "target.seal"), sealBytes = bytes(root, sealPath, false);
    if (sha(sealBytes) !== custody.sealSha256)
        fail("worker seal changed");
    const lines = sealBytes.toString("utf8").split("\n");
    const keys = ["manager-id", "protocol-version", "generation-id", "launcher-sha256", "node-path", "node-sha256", "manager-sha256", "managed-runtime-fingerprint"];
    if (lines.length !== 10 || lines[0] !== "TWEAKERS_MANAGER_TARGET_SEAL_V1" || lines[9] !== "")
        fail("worker seal schema changed");
    const values = keys.map((key, index) => { const line = lines[index + 1]; if (!line.startsWith(`${key}=`))
        fail("worker seal field changed"); return line.slice(key.length + 1); });
    if (values[0] !== "com.thomashulihan.tweakers" || values[1] !== "1" || values[2] !== custody.generationId
        || values[3] !== custody.launcherSha256 || values[4] !== custody.nodePath || values[5] !== custody.nodeSha256
        || !/^[a-f0-9]{64}$/.test(values[6]) || !/^[a-f0-9]{64}$/.test(values[7]))
        fail("worker seal custody changed");
    const preimage = ["TWEAKERS_MANAGER_GENERATION_V1", ...keys.filter(key => key !== "generation-id").map(key => `${key}=${values[keys.indexOf(key)]}`), ""].join("\n");
    if (sha(preimage) !== custody.generationId)
        fail("worker generation identity changed");
    const bundle = bytes(root, (0, node_path_1.join)(generationRoot, "manager.mjs"), false);
    if (sha(bundle) !== values[6])
        fail("worker bundle changed");
    const marker = (name) => {
        const matches = [...bundle.toString("utf8").matchAll(new RegExp(`(?:^|\\n)//# ${name}=([a-f0-9]{64})\\n`, "g"))];
        if (matches.length !== 1)
            fail("worker runtime marker is ambiguous");
        return matches[0][1];
    };
    const runtime = marker("TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1"), managed = marker("TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1");
    if (managed !== values[7])
        fail("worker managed runtime binding changed");
    const manager = (0, node_path_1.dirname)((0, node_path_1.dirname)(generationRoot));
    runtimeTree(root, (0, node_path_1.join)(manager, "runtime-generations", runtime), "runtime-fingerprint.json", runtime);
    runtimeTree(root, (0, node_path_1.join)(manager, "managed-runtime-generations", managed), "managed-runtime-fingerprint.json", managed);
    const moduleRoot = (0, node_path_1.join)(manager, "managed-runtime-generations", managed, "packages", "installer", "dist");
    const compiled = bytes(root, (0, node_path_1.join)(moduleRoot, "manager-descriptor.js"), false).toString("utf8");
    const matches = [...compiled.matchAll(/const PINNED_MANAGER_DESIGNATED_REQUIREMENT\s*=\s*'identifier "com\.therealityreport\.tweakers\.manager-launcher" and certificate leaf = H"([a-f0-9]{40})"';?/g)];
    if (matches.length !== 1)
        fail("original compiled signer anchor is ambiguous");
    const leaf = matches[0][1].toUpperCase();
    if (trustedLeaf && leaf !== trustedLeaf)
        fail("authorized worker changed the original signer anchor");
    (deps.verifySignature ?? verifySignature)(launcher, "com.therealityreport.tweakers.manager-launcher", trustedLeaf ?? leaf);
    // Node may be outside Manager custody but must retain its canonical exact file identity.
    if (!canonical(custody.nodePath) || (0, node_fs_1.realpathSync)(custody.nodePath) !== custody.nodePath)
        fail("worker Node is redirected");
    if (sha(bytes((0, node_path_1.dirname)(custody.nodePath), custody.nodePath, false, 512 * 1024 * 1024)) !== custody.nodeSha256)
        fail("worker Node changed");
    return { moduleRoot, runtimeRoot: (0, node_path_1.join)(manager, "runtime-generations", runtime), leaf };
}
/** Resolve only the fixed operation head; absence preserves ordinary schema5 startup. */
function readAcceptedRuntimeRepairBootstrap(input, deps) {
    return readRepairBootstrap(input, deps, false);
}
/** Retained history only. The caller must first verify a different ordinary current promotion. */
function readAcceptedRuntimeRepairHistoricalBootstrap(input, deps) {
    return readRepairBootstrap(input, deps, true);
}
/** Authenticate only a failed, superseded promotion. Its signed handoff grants
 * no readiness, fallback, acceptance, or permission to change a live generation. */
function readSupersededNativeReplacementHistoricalBootstrap(input, deps) {
    const { managerRoot, userRoot, target, operationId, promotionId } = input;
    const validId = (id) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
    if (!validId(operationId) || !validId(promotionId) || userRoot !== (0, node_path_1.join)(managerRoot, "variants", "tweakers") || !canonical(target))
        fail("native replacement crosses fixed history");
    const root = (0, node_path_1.join)(managerRoot, "transactions", "native-replacements", operationId);
    try {
        (0, node_fs_1.lstatSync)(root);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        let ancestor = (0, node_path_1.dirname)(root);
        while (!(0, node_fs_1.existsSync)(ancestor) && ancestor !== managerRoot)
            ancestor = (0, node_path_1.dirname)(ancestor);
        safePath(managerRoot, ancestor, false);
        return null;
    }
    safePath(managerRoot, root, true);
    const signed = (name) => {
        const bundle = (0, node_path_1.join)(root, `${name}.bundle`);
        safePath(managerRoot, bundle, true);
        (deps.verifySignature ?? verifySignature)(bundle, `com.thomashulihan.tweakers.native-replacement.${name}`, tweakers_sdk_1.NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1);
        return json(managerRoot, (0, node_path_1.join)(bundle, "Contents", "Resources", "receipt.json"));
    };
    const intent = exact(signed("intent"), ["version", "kind", "operationId", "promotionId", "repairId", "replacementId", "createdAt", "trustedLeafSha1", "worker", "originalOperation", "retained", "unchanged", "previousApp", "nativeRequest"]);
    if (intent.version !== 1 || intent.kind !== "tweakers-native-replacement-intent" || intent.operationId !== operationId || intent.promotionId !== promotionId
        || !validId(intent.replacementId) || (intent.repairId !== null && !validId(intent.repairId)) || intent.trustedLeafSha1 !== tweakers_sdk_1.NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1
        || (intent.nativeRequest === null ? intent.repairId !== null : intent.nativeRequest?.version !== 2 || intent.nativeRequest.officialBundled?.transactionId !== intent.replacementId)
        || intent.originalOperation?.operationId !== operationId || !Array.isArray(intent.retained) || intent.retained.length < 3 || intent.retained.length > 32
        || !Array.isArray(intent.unchanged) || intent.unchanged.length < 5 || intent.unchanged.length > 32)
        fail("native replacement signed history binding changed");
    const failed = (0, tweakers_sdk_1.supersededNativeReplacementOperationProjection)(intent.originalOperation, intent.createdAt);
    equal(json(managerRoot, (0, node_path_1.join)(root, "intent.json")), intent, "native replacement signed draft differs");
    equal(signed("settlement"), { version: 1, kind: "tweakers-native-replacement-settlement", operationId, promotionId, repairId: intent.repairId,
        intentSha256: sha(canonicalJson(intent)), originalOperation: failed, retiredApp: intent.previousApp, originalPromotionAccepted: false }, "native replacement settlement differs");
    equal(json(managerRoot, (0, node_path_1.join)(managerRoot, "transactions", "manager-operations", `${operationId}.json`)), failed, "native replacement original failure changed");
    const seen = new Set();
    for (const item of intent.retained) {
        const entry = exact(item, ["path", "generation"]);
        if (typeof entry.path !== "string" || seen.has(entry.path) || !entry.path.startsWith(managerRoot + "/"))
            fail("native replacement retained path changed");
        seen.add(entry.path);
        generation(managerRoot, entry.path, entry.generation, deps);
    }
    const journalPath = (0, node_path_1.join)(userRoot, "transactions", "variant-promotion", `${promotionId}.json`);
    if (!seen.has(journalPath))
        fail("native replacement omitted its original journal");
    const originalJournal = object(json(managerRoot, journalPath));
    (0, tweakers_sdk_1.assertAcceptedBackendTransitionJournalBindingContract)(originalJournal.acceptedBackendTransition, contractDeps);
    if (originalJournal.id !== promotionId || originalJournal.userRoot !== userRoot || originalJournal.target !== target || originalJournal.phase !== "app:promoted"
        || originalJournal.acceptedBackendTransition.operationId !== operationId || (intent.repairId === null && originalJournal.acceptedBackendTransition.lane.version !== 2))
        fail("native replacement retained journal crosses operation");
    const prior = intent.unchanged.filter((entry) => entry.path === (0, node_path_1.join)(userRoot, "transactions", "variant-promotion", "active.json"));
    if (prior.length !== 1 || !(0, node_util_1.isDeepStrictEqual)(prior[0].generation, originalJournal.activeReceipt.previous))
        fail("native replacement prior receipt binding changed");
    return { originalJournal, priorActiveReceipt: prior[0].generation };
}
function readRepairBootstrap(input, deps, historical, retained) {
    const { managerRoot, userRoot, target, operationId, promotionId } = input;
    const headPath = retained
        ? (0, node_path_1.join)(userRoot, "builds", promotionId, "runtime-repair", "accepted", "operations", retained.predecessor.binding.repairId, "head.json")
        : (0, node_path_1.join)(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.runtime-repair-head.json`);
    // lstat sees dangling links; only a genuine ENOENT may mean no child.
    try {
        (0, node_fs_1.lstatSync)(headPath);
    }
    catch (error) {
        if (retained || error.code !== "ENOENT")
            throw error;
        // An absent leaf behind a dangling/redirected ancestor is not absence of authority.
        let ancestor = (0, node_path_1.dirname)(headPath);
        for (;;) {
            try {
                (0, node_fs_1.lstatSync)(ancestor);
                break;
            }
            catch (cause) {
                if (cause.code !== "ENOENT" || ancestor === managerRoot)
                    throw cause;
                ancestor = (0, node_path_1.dirname)(ancestor);
            }
        }
        safePath(managerRoot, ancestor, true);
        return null;
    }
    if (userRoot !== (0, node_path_1.join)(managerRoot, "variants", "tweakers"))
        fail("variant custody is outside Manager");
    const headBytes = bytes(managerRoot, headPath), head = parsed(headBytes);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairHeadContract)(head);
    if (retained && (head.version !== 1 || sha(headBytes) !== retained.predecessor.binding.headSha256
        || head.repairId !== retained.predecessor.binding.repairId || head.intentSha256 !== retained.predecessor.binding.intentSha256))
        fail("predecessor is not the exact initial child");
    if (head.operationId !== operationId || head.promotionId !== promotionId)
        fail("head crosses original operation");
    const childRoot = (0, node_path_1.join)(userRoot, "builds", promotionId, "runtime-repair", "accepted", "operations", head.repairId);
    const intentBytes = bytes(managerRoot, (0, node_path_1.join)(childRoot, "intent.json"));
    if (sha(intentBytes) !== head.intentSha256)
        fail("head intent digest changed");
    const intent = parsed(intentBytes);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairIntentContract)(intent, contractDeps);
    if (intent.version !== head.version)
        fail("head and intent versions differ");
    equal(intent.prior, head.prior, "head predecessor differs from signed intent");
    for (const key of ["operationId", "promotionId", "repairId"])
        equal(intent[key], head[key], "intent crosses head");
    equal(bytes(managerRoot, (0, node_path_1.join)(childRoot, "head.json")), headBytes, "immutable head snapshot changed");
    const publication = json(managerRoot, (0, node_path_1.join)(childRoot, "publication.json"));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairPublicationContract)(publication);
    for (const key of ["operationId", "promotionId", "repairId", "intentSha256"])
        equal(publication[key], head[key], "publication crosses head");
    if (publication.phase !== "challenge:published" && publication.phase !== "committed")
        fail("publication gap refuses startup");
    if (retained && (publication.phase !== "challenge:published" || retained.predecessor.publication.path !== (0, node_path_1.join)(childRoot, "publication.json")))
        fail("predecessor was accepted or publication escaped custody");
    if (retained)
        fileRef(managerRoot, retained.predecessor.publication);
    const authority = intent.authority;
    const originalOperation = object(parsed(fileRef(managerRoot, authority.originals.operation.snapshot)));
    if (originalOperation.operationId !== operationId || originalOperation.actionId !== "refresh.independent" || originalOperation.phase !== "recovery-required"
        || originalOperation.moduleIdentity?.state !== "resolved" || originalOperation.moduleIdentity.path !== authority.originalWorker.launcherPath
        || originalOperation.moduleIdentity.sha256 !== authority.originalWorker.launcherSha256 || !originalOperation.consumedAt)
        fail("original consumed operation custody changed");
    if (authority.originals.operation.sourcePath !== (0, node_path_1.join)(managerRoot, "transactions", "manager-operations", `${operationId}.json`)
        || authority.originals.operation.snapshot.path !== (0, node_path_1.join)(childRoot, "original-operation.json")
        || authority.originals.journal.sourcePath !== (0, node_path_1.join)(userRoot, "transactions", "variant-promotion", `${promotionId}.json`)
        || authority.originals.journal.snapshot.path !== (0, node_path_1.join)(childRoot, "original-journal.json")
        || authority.originals.expectation.sourcePath !== (0, node_path_1.join)(userRoot, "runtime-ready-expectation.json")
        || authority.originals.expectation.snapshot.path !== (0, node_path_1.join)(childRoot, "original-expectation.json")
        || authority.originals.custody.path !== (0, node_path_1.join)(childRoot, "original-custody.json"))
        fail("origin snapshots escaped fixed custody");
    for (const origin of [authority.originals.operation, authority.originals.journal, authority.originals.expectation]) {
        if (origin.sourceSha256AtCapture !== origin.snapshot.sha256)
            fail("origin snapshot changed captured bytes");
    }
    const currentOperation = object(json(managerRoot, authority.originals.operation.sourcePath));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairOriginalOperationProjection)(originalOperation, currentOperation);
    if (publication.phase === "challenge:published" && currentOperation.phase !== "recovery-required"
        && !(retained && retained.currentPhase === "committed" && currentOperation.phase === "completed"))
        fail("completed original operation cannot launch provisionally");
    if (historical && ((!retained && publication.phase !== "committed") || currentOperation.phase !== "completed"))
        fail("historical repair is not fully settled");
    const originalWorker = worker(managerRoot, authority.originalWorker, deps, null);
    if (authority.originalTrustedLeafSha1 !== originalWorker.leaf)
        fail("child attempted to select its trusted leaf");
    const authorizedWorker = worker(managerRoot, authority.authorizedWorker, deps, originalWorker.leaf);
    if (authority.repairedBaseline.sourceRoot !== authorizedWorker.runtimeRoot
        || authority.repairedRuntime.evidence.sourceRoot !== (0, node_path_1.join)(childRoot, "next-runtime"))
        fail("repaired source path authority changed");
    for (const [binding, sealedRoot] of [[authority.originalAcceptedBaseline, originalWorker.runtimeRoot], [authority.repairedBaseline, authorizedWorker.runtimeRoot]]) {
        const documentBytes = bytes(managerRoot, (0, node_path_1.join)(sealedRoot, "runtime-fingerprint.json"), false), document = object(parsed(documentBytes));
        if (document.fingerprint !== binding.fingerprint || document.fileCount !== binding.fileCount || sha(documentBytes) !== binding.documentSha256)
            fail("accepted sealed baseline changed");
    }
    const sourceCustody = readAcceptedRuntimeRepairSealedSourceCustody(managerRoot, authorizedWorker.moduleRoot, {
        fingerprint: authority.repairedBaseline.fingerprint, fileCount: authority.repairedBaseline.fileCount,
        documentSha256: authority.repairedBaseline.documentSha256,
    });
    const receiptBundle = (0, node_path_1.join)(childRoot, "receipt", "TweakersRuntimeRepairReceipt.bundle");
    generation(managerRoot, receiptBundle, intent.authorityReceipt.bundleGeneration, deps);
    (deps.verifySignature ?? verifySignature)(receiptBundle, "co.tweakers.accepted-runtime-repair", originalWorker.leaf);
    const receiptBytes = bytes(managerRoot, (0, node_path_1.join)(receiptBundle, "Contents", "Resources", "runtime-repair.json"), false);
    if (sha(receiptBytes) !== intent.authorityReceipt.jsonSha256)
        fail("signed authority bytes changed");
    if (retained && intent.authorityReceipt.jsonSha256 !== retained.predecessor.binding.authorityReceiptSha256)
        fail("predecessor signed receipt differs from current binding");
    equal(parsed(receiptBytes), authority, "signed authority differs from intent");
    const custody = parsed(fileRef(managerRoot, authority.originals.custody));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairOriginalCustodyContract)(custody, contractDeps);
    if (custody.operationId !== operationId || custody.promotionId !== promotionId || custody.trustedLeafSha1 !== originalWorker.leaf)
        fail("original signed custody crosses operation");
    equal(custody.originalWorker, authority.originalWorker, "original worker custody differs");
    const originalBundle = custody.originalCandidateReceipt.bundlePath;
    generation(managerRoot, originalBundle, custody.originalCandidateReceipt.bundleGeneration, deps);
    (deps.verifySignature ?? verifySignature)(originalBundle, "co.tweakers.candidate-receipt", originalWorker.leaf);
    if (custody.originalCandidateReceipt.json.path !== (0, node_path_1.join)(originalBundle, "Contents", "Resources", "variant-candidate-receipt.json"))
        fail("original receipt path changed");
    const originalReceipt = object(parsed(fileRef(managerRoot, custody.originalCandidateReceipt.json, false)));
    if (originalReceipt.id !== custody.originalCandidateReceipt.id || originalReceipt.signingIdentityHash !== originalWorker.leaf
        || custody.originalCandidateReceipt.signingIdentityHash !== originalWorker.leaf)
        fail("original candidate signer changed");
    const originalJournalBytes = fileRef(managerRoot, authority.originals.journal.snapshot);
    const originalJournal = object(parsed(originalJournalBytes));
    if (originalJournal.id !== promotionId || originalJournal.userRoot !== userRoot || originalJournal.target !== target
        || originalJournal.phase !== "app:promoted" || originalJournal.acceptedBackendTransition?.operationId !== operationId)
        fail("original journal crosses custody");
    (0, tweakers_sdk_1.assertAcceptedBackendTransitionJournalBindingContract)(originalJournal.acceptedBackendTransition, contractDeps);
    equal(originalReceipt.acceptedBackendTransition, originalJournal.acceptedBackendTransition.lane, "original signed accepted lane changed");
    const originalIdentity = exact(originalReceipt.identity, ["appTarget", "userRoot", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot"]);
    if (originalIdentity.appTarget !== target || originalIdentity.userRoot !== userRoot
        || originalIdentity.accountsBrokerRoot !== originalJournal.acceptedBackendTransition.lane.identity.brokerRoot)
        fail("original signed desktop identity changed");
    const lane = originalJournal.acceptedBackendTransition.lane;
    if (lane.version !== 1)
        return fail("historical runtime repair requires its original custom-backend authority");
    if (authority.unchanged.backendSha256 !== lane.authority.backend.sha256
        || authority.unchanged.helperSha256 !== lane.authority.closure.codeModeHost.sha256)
        fail("repair changed the accepted executable pair");
    equal(authority.unchanged.backendSignature, lane.authority.backend.signature, "repair changed accepted backend signature facts");
    equal(authority.unchanged.helperSignature, lane.authority.closure.codeModeHost.signature, "repair changed accepted helper signature facts");
    equal(authority.unchanged.resources, lane.authority.closure.resources, "repair changed accepted resources");
    equal(authority.originalAcceptedBaseline, lane.authority.runtime, "repair changed original accepted baseline authority");
    if (!Array.isArray(originalJournal.entries))
        fail("original journal generations absent");
    for (const [name, expected] of [["runtime", authority.priorRuntime], ["app", authority.unchanged.app],
        ["tweaks", authority.unchanged.tweaks], ["state.json", authority.unchanged.state], ["config.json", authority.unchanged.config]]) {
        equal(originalJournal.entries.find((entry) => entry.name === name)?.desired, expected, "repair changed an original desired generation");
    }
    equal(originalJournal.activeReceipt.previous, authority.unchanged.priorActiveReceipt, "repair changed original prior active receipt");
    const accepted = authority.originals.acceptedBuildReceipt;
    if (accepted.path !== lane.authority.acceptedBuildReceipt.path || accepted.sha256 !== lane.authority.acceptedBuildReceipt.sha256
        || accepted.path !== (0, node_path_1.join)(managerRoot, "codex-source", "accepted", lane.authority.transactionId, "accepted-build.json"))
        fail("original accepted receipt escaped durable custody");
    readAcceptedRuntimeRepairImmutableAttestation(managerRoot, accepted.path, accepted.sha256);
    if (authority.originals.recoveryBinding.path !== (0, node_path_1.join)(managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.json`))
        fail("original recovery binding escaped custody");
    const recoveryBinding = exact(parsed(fileRef(managerRoot, authority.originals.recoveryBinding)), ["schemaVersion", "kind", "operationId", "promotionId", "userRoot", "target", "generation", "journal", "receiptRefs", "dependencyPaths", "createdAt"]);
    if (recoveryBinding.schemaVersion !== 1 || recoveryBinding.kind !== "tweakers-manager-recovery-binding"
        || recoveryBinding.operationId !== operationId || recoveryBinding.promotionId !== promotionId || recoveryBinding.userRoot !== userRoot
        || recoveryBinding.target !== target)
        fail("original recovery binding crosses operation");
    const journalBinding = exact(recoveryBinding.journal, ["path", "identitySha256"]);
    const { phase: _originalPhase, ...journalIdentity } = originalJournal;
    if (journalBinding.path !== authority.originals.journal.sourcePath || journalBinding.identitySha256 !== sha(canonicalJson(journalIdentity)))
        fail("original recovery journal identity changed");
    const recoveryGeneration = exact(recoveryBinding.generation, ["appSha256", "runtimeFingerprint", "activeReceiptSha256"]);
    if (recoveryGeneration.appSha256 !== authority.unchanged.app.sha256 || recoveryGeneration.activeReceiptSha256 !== originalJournal.activeReceipt.desired.sha256
        || typeof recoveryGeneration.runtimeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(recoveryGeneration.runtimeFingerprint))
        fail("original recovery generation changed");
    if (!Array.isArray(recoveryBinding.dependencyPaths) || recoveryBinding.dependencyPaths.some((path) => typeof path !== "string" || !canonical(path))
        || !Number.isFinite(Date.parse(recoveryBinding.createdAt)))
        fail("original recovery dependency binding changed");
    equal(recoveryBinding.receiptRefs, originalOperation.receiptRefs, "original operation receipt custody changed");
    equal(originalReceipt.artifacts?.app, authority.unchanged.app, "original signed app generation changed");
    if (!historical) {
        (deps.verifySignature ?? verifySignature)(target, "com.therealityreport.tweakers", originalWorker.leaf);
        generation((0, node_path_1.dirname)(target), target, authority.unchanged.app, deps);
        for (const [name, expected] of [["tweaks", authority.unchanged.tweaks], ["state.json", authority.unchanged.state]])
            generation(managerRoot, (0, node_path_1.join)(userRoot, name), expected, deps);
        const settled = (publication.phase === "committed" || retained?.currentPhase === "committed") && currentOperation.phase === "completed";
        if (settled)
            assertAcceptedRuntimeRepairMutableConfig(json(managerRoot, (0, node_path_1.join)(userRoot, "config.json")));
        else
            generation(managerRoot, (0, node_path_1.join)(userRoot, "config.json"), authority.unchanged.config, deps);
        generation(managerRoot, retained?.installedRuntimePath ?? (0, node_path_1.join)(userRoot, "runtime"), authority.repairedRuntime.generation, deps);
    }
    let predecessor = null;
    if (authority.version === 2) {
        if (retained || head.version !== 2 || authority.predecessor.binding.repairId === head.repairId)
            fail("repair lineage exceeds the one successor bound");
        predecessor = readRepairBootstrap(input, deps, historical, { predecessor: authority.predecessor,
            installedRuntimePath: (0, node_path_1.join)(childRoot, "prior-runtime"), currentPhase: publication.phase });
        if (!predecessor || predecessor.head.version !== 1 || predecessor.intent.version !== 1)
            return fail("repair lacks its authenticated initial predecessor");
        equal(authority.predecessor.installedRuntime, predecessor.intent.authority.repairedRuntime.generation, "predecessor archive differs from signed installed runtime");
        const predecessorChallenge = object(predecessor.provisionalExpectation);
        if (authority.authorizedWorker.generationId === predecessor.intent.authority.authorizedWorker.generationId
            || (0, node_util_1.isDeepStrictEqual)(authority.repairedRuntime.generation, authority.predecessor.installedRuntime)
            || Date.parse(authority.createdAt) < Date.parse(predecessorChallenge.createdAt)
            || Date.parse(intent.createdAt) < Date.parse(predecessorChallenge.createdAt))
            fail("successor reused its predecessor worker runtime or challenge time");
        for (const key of ["originalWorker", "originalTrustedLeafSha1", "unchanged", "priorRuntime", "originalAcceptedBaseline", "completedCas"]) {
            equal(authority[key], predecessor.intent.authority[key], "successor changed original custody or accepted pair");
        }
        for (const key of ["operation", "journal", "expectation"]) {
            equal(fileRef(managerRoot, authority.originals[key].snapshot), fileRef(managerRoot, predecessor.intent.authority.originals[key].snapshot), "successor changed original snapshot bytes");
        }
        equal(fileRef(managerRoot, authority.originals.custody), fileRef(managerRoot, predecessor.intent.authority.originals.custody), "successor changed original custody snapshot");
        for (const key of ["acceptedBuildReceipt", "recoveryBinding", "preparedCasIntent"]) {
            equal(authority.originals[key], predecessor.intent.authority.originals[key], "successor changed original retained references");
        }
    }
    generation(managerRoot, (0, node_path_1.join)(childRoot, "prior-runtime"), authority.version === 2 ? authority.predecessor.installedRuntime : authority.priorRuntime, deps);
    runtimeTree(managerRoot, (0, node_path_1.join)(childRoot, "prior-runtime"), "runtime-fingerprint.json", predecessor?.intent.authority.repairedRuntime.evidence.fingerprint ?? recoveryGeneration.runtimeFingerprint);
    equal(custody.priorRuntime, authority.priorRuntime, "prior runtime differs from original custody");
    equal(custody.originalAcceptedBaseline, authority.originalAcceptedBaseline, "accepted baseline differs from original custody");
    for (const key of ["app", "tweaks", "state", "config", "priorActiveReceipt"])
        equal(custody.unchanged[key], authority.unchanged[key], "unchanged original custody differs");
    const installedRuntime = retained?.installedRuntimePath ?? (0, node_path_1.join)(userRoot, "runtime");
    generation(managerRoot, authority.recovery.root, authority.recovery.generation, deps);
    if (sha(bytes(managerRoot, (0, node_path_1.join)(authority.recovery.root, "accounts-transfer-validation.v1.json"))) !== authority.recovery.validationSha256)
        fail("Accounts recovery validation changed");
    if (!historical) {
        runtimeTree(managerRoot, installedRuntime, "runtime-fingerprint.json", authority.repairedRuntime.evidence.fingerprint);
        if (sha(bytes(managerRoot, (0, node_path_1.join)(installedRuntime, "runtime-fingerprint.json"), false)) !== authority.repairedRuntime.evidence.documentSha256)
            fail("runtime document changed");
        const markerBytes = bytes(managerRoot, (0, node_path_1.join)(installedRuntime, "accounts-transfer-recovery.v1.json")), marker = object(parsed(markerBytes));
        if (sha(markerBytes) !== authority.recovery.markerSha256 || marker.recoveryRuntimeRoot !== authority.recovery.root
            || marker.sourceRuntimeFingerprint !== authority.repairedBaseline.fingerprint
            || marker.sourceRuntimeFileCount !== authority.repairedBaseline.fileCount || !(0, transfer_recovery_1.verifyAccountsTransferRecovery)(installedRuntime))
            fail("Accounts recovery reader or marker changed");
        const resourceRoot = (0, node_path_1.join)(target, "Contents", "Resources");
        for (const [name, expected] of [["codex", authority.unchanged.backendSha256], ["codex-code-mode-host", authority.unchanged.helperSha256]]) {
            if (sha(bytes((0, node_path_1.dirname)(target), (0, node_path_1.join)(resourceRoot, name), false, 512 * 1024 * 1024)) !== expected)
                fail("matching executable changed");
        }
        for (const resource of authority.unchanged.resources) {
            if (sha(bytes((0, node_path_1.dirname)(target), (0, node_path_1.join)(resourceRoot, resource.relativePath), false, 512 * 1024 * 1024)) !== resource.sha256)
                fail("backend resource changed");
        }
    }
    verifySourceDelta(managerRoot, childRoot, intent, originalWorker, authorizedWorker, sourceCustody, custody.originalCandidateReceipt, deps);
    for (const ref of [authority.originals.recoveryBinding, authority.originals.preparedCasIntent, authority.completedCas.prior, authority.completedCas.completed])
        fileRef(managerRoot, ref);
    if (intent.consumedApproval.path !== (0, node_path_1.join)(childRoot, "consumed-doctor-approval.json"))
        fail("consumed approval escaped child custody");
    const approval = parsed(fileRef(managerRoot, intent.consumedApproval));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairConsumedApprovalContract)(approval);
    if (approval.operationId !== operationId || approval.repairId !== head.repairId || approval.jobId !== authority.review.jobId
        || approval.workerGenerationId !== authority.authorizedWorker.generationId || approval.reportFingerprint !== authority.review.reportFingerprint
        || approval.authoritySha256 !== intent.authorityReceipt.jsonSha256
        || approval.promotionFingerprint !== authority.review.promotionFingerprint
        || Date.parse(intent.createdAt) < Date.parse(approval.approvedAt) || Date.parse(intent.createdAt) > Date.parse(approval.expiresAt))
        fail("consumed approval crossed signed review or consumption time");
    for (const ref of authority.sourceDelta.changedGeneratedFiles)
        fileRef(managerRoot, ref, false);
    const completedPlan = fileRef(managerRoot, authority.completedCas.completed);
    if (`sha256:${sha(completedPlan)}` !== authority.completedCas.planFingerprint)
        fail("completed CAS plan digest changed");
    if (authority.completedCas.resolverSha256 !== authority.unchanged.backendSha256)
        fail("completed resolver differs from the retained accepted pair");
    if (!historical) {
        const registration = object(parsed(fileRef(managerRoot, authority.completedCas.currentRegistration)));
        if (registration.resolverBinarySha256 !== authority.completedCas.resolverSha256)
            fail("completed resolver routes a different executable");
    }
    if (intent.effectiveJournal.path !== (0, node_path_1.join)(childRoot, "effective-journal.json") || intent.effectiveActiveReceipt.path !== (0, node_path_1.join)(childRoot, "effective-active-receipt.json"))
        fail("effective paths escaped the fixed child");
    const effectiveJournal = parsed(fileRef(managerRoot, intent.effectiveJournal));
    const effectiveActiveReceipt = parsed(fileRef(managerRoot, intent.effectiveActiveReceipt));
    const activeGeneration = deps.fingerprint(intent.effectiveActiveReceipt.path);
    const expectedActive = { ...originalJournal.activeReceipt.expected, version: 4,
        runtimeRepair: { repairId: head.repairId, authorityReceiptSha256: intent.authorityReceipt.jsonSha256 },
        entries: originalJournal.activeReceipt.expected.entries.map((entry) => entry.name === "runtime"
            ? { ...entry, fingerprint: authority.repairedRuntime.generation } : entry) };
    equal(effectiveActiveReceipt, expectedActive, "effective active receipt changed its original projection");
    equal(effectiveJournal, { ...originalJournal, phase: "committed",
        entries: originalJournal.entries.map((entry) => entry.name === "runtime" ? { ...entry, desired: authority.repairedRuntime.generation } : entry),
        activeReceipt: { ...originalJournal.activeReceipt, source: intent.effectiveActiveReceipt.path,
            archive: (0, node_path_1.join)(childRoot, "prior-active-receipt.json"), failed: (0, node_path_1.join)(childRoot, "failed-active-receipt.json"),
            desired: activeGeneration, expected: expectedActive } }, "effective journal changed its original projection");
    if (originalJournal.activeReceipt.hadDestination !== true || !originalJournal.activeReceipt.previous)
        fail("original repair has no retained prior active receipt");
    const runtimeRepair = { repairId: head.repairId, headSha256: sha(headBytes), intentSha256: head.intentSha256, authorityReceiptSha256: intent.authorityReceipt.jsonSha256 };
    const originalExpectation = object(parsed(fileRef(managerRoot, authority.originals.expectation.snapshot)));
    for (const [key, expected] of [["appRoot", target], ["appUserDataRoot", originalIdentity.appUserDataRoot],
        ["codexHomeRoot", originalIdentity.codexHomeRoot], ["accountsBrokerRoot", originalIdentity.accountsBrokerRoot]]) {
        if (originalExpectation[key] !== expected)
            fail("original challenge crosses signed desktop identity");
    }
    const expectationBinding = { intent, runtimeRepair,
        activePromotionReceiptSha256: activeGeneration.sha256 };
    let provisionalExpectation = null;
    if (publication.phase === "committed") {
        generation(managerRoot, (0, node_path_1.join)(childRoot, "prior-active-receipt.json"), authority.unchanged.priorActiveReceipt, deps);
        const acceptedExpectation = verifyCommittedAcceptance(managerRoot, childRoot, operationId, promotionId, runtimeRepair);
        assertAcceptedRuntimeRepairExpectationProjection(originalExpectation, acceptedExpectation, expectationBinding);
    }
    else {
        if (retained) {
            if (retained.predecessor.challenge.sourcePath !== (0, node_path_1.join)(userRoot, "runtime-ready-expectation.json")
                || retained.predecessor.challenge.snapshot.path !== (0, node_path_1.join)((0, node_path_1.dirname)(retained.installedRuntimePath), "predecessor-challenge.json")
                || retained.predecessor.challenge.sourceSha256AtCapture !== retained.predecessor.challenge.snapshot.sha256)
                fail("predecessor challenge escaped captured custody");
            provisionalExpectation = parsed(fileRef(managerRoot, retained.predecessor.challenge.snapshot));
            assertNoPredecessorAcceptance(managerRoot, childRoot, operationId, head.repairId);
        }
        else
            provisionalExpectation = json(managerRoot, (0, node_path_1.join)(userRoot, "runtime-ready-expectation.json"));
        assertAcceptedRuntimeRepairExpectationProjection(originalExpectation, provisionalExpectation, expectationBinding);
    }
    // Re-read the authoritative mutable head and publication after expensive custody verification.
    if (sha(bytes(managerRoot, (0, node_path_1.join)(childRoot, "intent.json"))) !== head.intentSha256
        || sha(bytes(managerRoot, (0, node_path_1.join)(receiptBundle, "Contents", "Resources", "runtime-repair.json"), false)) !== intent.authorityReceipt.jsonSha256)
        fail("immutable repair authority changed during initialization");
    const latestOperation = object(json(managerRoot, authority.originals.operation.sourcePath));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairOriginalOperationProjection)(originalOperation, latestOperation);
    if (publication.phase === "challenge:published" && latestOperation.phase !== "recovery-required"
        && !(retained && retained.currentPhase === "committed" && latestOperation.phase === "completed"))
        fail("operation settled during provisional initialization");
    if (historical && latestOperation.phase !== "completed")
        fail("historical original settlement changed");
    equal(bytes(managerRoot, headPath), headBytes, "head changed during initialization");
    equal(json(managerRoot, (0, node_path_1.join)(childRoot, "publication.json")), publication, "publication changed during initialization");
    if (retained)
        assertNoPredecessorAcceptance(managerRoot, childRoot, operationId, head.repairId);
    return { head, intent, phase: publication.phase, runtimeRepair, originalJournal, effectiveJournal, effectiveActiveReceipt, childRoot, managerRoot,
        originalOperationCompleted: latestOperation.phase === "completed", provisionalExpectation };
}
/** Recheck mutable admission bindings after the full initialization gate, without repeating sealed tree walks. */
function assertAcceptedRuntimeRepairChallengeCurrent(projection) {
    const { managerRoot: root, head, intent, childRoot, runtimeRepair } = projection;
    if (projection.phase !== "challenge:published")
        fail("committed repair cannot produce a provisional readiness receipt");
    const headBytes = bytes(root, (0, node_path_1.join)(root, "transactions", "manager-recovery-bindings", `${head.operationId}.runtime-repair-head.json`));
    if (sha(headBytes) !== runtimeRepair.headSha256)
        fail("readiness head changed");
    equal(parsed(headBytes), head, "readiness head identity changed");
    if (sha(bytes(root, (0, node_path_1.join)(childRoot, "intent.json"))) !== runtimeRepair.intentSha256)
        fail("readiness intent changed");
    if (sha(bytes(root, (0, node_path_1.join)(childRoot, "receipt", "TweakersRuntimeRepairReceipt.bundle", "Contents", "Resources", "runtime-repair.json"), false))
        !== runtimeRepair.authorityReceiptSha256)
        fail("readiness signed authority bytes changed");
    const publication = json(root, (0, node_path_1.join)(childRoot, "publication.json"));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairPublicationContract)(publication);
    if (publication.phase !== "challenge:published" || publication.operationId !== head.operationId || publication.promotionId !== head.promotionId
        || publication.repairId !== head.repairId || publication.intentSha256 !== head.intentSha256)
        fail("readiness publication changed");
    const originalOperation = parsed(fileRef(root, intent.authority.originals.operation.snapshot));
    const currentOperation = object(json(root, intent.authority.originals.operation.sourcePath));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairOriginalOperationProjection)(originalOperation, currentOperation);
    if (currentOperation.phase !== "recovery-required")
        fail("readiness cannot reopen a completed original operation");
    if (projection.provisionalExpectation === null)
        fail("readiness has no authenticated initial challenge");
    equal(json(root, (0, node_path_1.join)(root, "variants", "tweakers", "runtime-ready-expectation.json")), projection.provisionalExpectation, "readiness challenge changed since initialization");
    fileRef(root, intent.effectiveJournal);
    fileRef(root, intent.effectiveActiveReceipt);
    if (intent.authority.version === 2) {
        const predecessor = intent.authority.predecessor;
        const priorRoot = (0, node_path_1.join)(root, "variants", "tweakers", "builds", head.promotionId, "runtime-repair", "accepted", "operations", predecessor.binding.repairId);
        if (sha(bytes(root, (0, node_path_1.join)(priorRoot, "head.json"))) !== predecessor.binding.headSha256
            || sha(bytes(root, (0, node_path_1.join)(priorRoot, "intent.json"))) !== predecessor.binding.intentSha256
            || sha(bytes(root, (0, node_path_1.join)(priorRoot, "receipt", "TweakersRuntimeRepairReceipt.bundle", "Contents", "Resources", "runtime-repair.json"), false)) !== predecessor.binding.authorityReceiptSha256)
            fail("readiness predecessor custody changed");
        fileRef(root, predecessor.publication);
        fileRef(root, predecessor.challenge.snapshot);
        assertNoPredecessorAcceptance(root, priorRoot, head.operationId, predecessor.binding.repairId);
    }
}
function canonicalJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const item = object(value);
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
}
/** Only maintained operation attempts are inspected; a successor proof never accepts its predecessor. */
function assertNoPredecessorAcceptance(root, childRoot, operationId, repairId) {
    for (const name of ["acceptance.json", "acceptance-source.json"]) {
        try {
            (0, node_fs_1.lstatSync)((0, node_path_1.join)(childRoot, name));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        fail("predecessor already has immutable acceptance");
    }
    const directory = (0, node_path_1.join)(root, "transactions", "manager-recovery-bindings");
    safePath(root, directory, true);
    const pattern = new RegExp(`^${operationId}\\.acceptance(?:\\.[a-f0-9]{64})?\\.json$`);
    for (const name of (0, node_fs_1.readdirSync)(directory)) {
        if (!pattern.test(name))
            continue;
        const proof = exact(json(root, (0, node_path_1.join)(directory, name)), ["schemaVersion", "kind", "expectation", "receipt", "pid", "processStartToken"]);
        const expectation = object(proof.expectation), receipt = object(proof.receipt);
        (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(expectation);
        (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(receipt);
        exact(expectation, ["schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
            "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt", ...(expectation.schemaVersion === 6 ? ["runtimeRepair"] : [])]);
        exact(receipt, ["schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
            "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearance", "mainInitialized", "preloadInitialized", "settingsMounted", "sharedHistoryBrokerState", "initializedTweakIds", "observedAt", ...(receipt.schemaVersion === 6 ? ["runtimeRepair"] : [])]);
        if (proof.schemaVersion !== 1 || proof.kind !== "tweakers-manager-runtime-acceptance"
            || expectation.operationId !== operationId || receipt.operationId !== operationId || expectation.promotionId !== receipt.promotionId
            || expectation.kind !== "tweakers-independent-runtime-ready-expectation" || receipt.kind !== "tweakers-independent-runtime-ready"
            || expectation.schemaVersion !== receipt.schemaVersion || !Number.isSafeInteger(proof.pid) || proof.pid < 1
            || proof.pid !== receipt.pid || typeof proof.processStartToken !== "string" || proof.processStartToken.length < 1
            || proof.processStartToken.length > 256 || proof.processStartToken !== receipt.processStartToken
            || typeof expectation.createdAt !== "string" || !Number.isFinite(Date.parse(expectation.createdAt))
            || typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt))
            || Date.parse(receipt.observedAt) < Date.parse(expectation.createdAt)
            || receipt.mainInitialized !== true || receipt.preloadInitialized !== true || receipt.settingsMounted !== true
            || receipt.sharedHistoryBrokerState !== "connected")
            fail("malformed original operation acceptance attempt");
        const broker = exact(receipt.brokerAuthorityExpectation, ["globalRootState", "configSha256"]);
        if (broker.globalRootState !== "valid-v3" || typeof broker.configSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(broker.configSha256)
            || receipt.bundleId !== "com.therealityreport.tweakers" || typeof receipt.promotionId !== "string"
            || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt.promotionId))
            fail("malformed acceptance attempt desktop identity");
        equal(exact(receipt.appearance, ["status", "normalized"]), { status: "normal", normalized: true }, "acceptance attempt appearance changed");
        equal(expectation.appearanceExpectation, receipt.appearance, "acceptance attempt appearance requirement changed");
        if (!Array.isArray(receipt.initializedTweakIds) || receipt.initializedTweakIds.length < 1 || receipt.initializedTweakIds.length > 128
            || receipt.initializedTweakIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id))
            || new Set(receipt.initializedTweakIds).size !== receipt.initializedTweakIds.length || !Array.isArray(expectation.expectedTweakIds))
            fail("malformed acceptance attempt tweak evidence");
        equal([...receipt.initializedTweakIds].sort(), [...expectation.expectedTweakIds].sort(), "acceptance attempt tweak set changed");
        if (name !== `${operationId}.acceptance.json` && name !== `${operationId}.acceptance.${sha(canonicalJson(receipt))}.json`)
            fail("acceptance attempt filename changed its receipt digest");
        for (const key of ["activePromotionReceiptSha256", "appAsarHeaderHash", "runtimeFingerprint"]) {
            if (typeof receipt[key] !== "string" || !/^[a-f0-9]{64}$/i.test(receipt[key]))
                fail("malformed acceptance attempt digest");
        }
        for (const key of ["appRoot", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot"]) {
            if (typeof receipt[key] !== "string" || !canonical(receipt[key]))
                fail("malformed acceptance attempt path");
        }
        for (const key of ["promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation"]) {
            equal(receipt[key], expectation[key], "acceptance attempt identity differs");
        }
        if (expectation.schemaVersion === 6 && receipt.schemaVersion === 6) {
            equal(expectation.runtimeRepair, receipt.runtimeRepair, "acceptance attempt repair differs");
            if (receipt.runtimeRepair.repairId === repairId)
                fail("predecessor has a verified runtime acceptance attempt");
        }
    }
}
/** Repair preserves the original identity/policy challenge while replacing only its runtime authority. */
function assertAcceptedRuntimeRepairExpectationProjection(original, current, binding) {
    const keys = ["schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
        "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt"];
    const before = exact(original, [...keys]), after = exact(current, [...keys, "runtimeRepair"]);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(before);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(after);
    if (before.schemaVersion !== 5 || after.schemaVersion !== 6 || before.kind !== "tweakers-independent-runtime-ready-expectation"
        || before.operationId !== binding.intent.operationId || before.promotionId !== binding.intent.promotionId
        || before.bundleId !== "com.therealityreport.tweakers" || typeof after.createdAt !== "string"
        || !Number.isFinite(Date.parse(after.createdAt)) || !Number.isFinite(Date.parse(before.createdAt))
        || Date.parse(after.createdAt) < Math.max(Date.parse(before.createdAt), Date.parse(binding.intent.createdAt)))
        fail("repair challenge origin or time changed");
    equal(after, { ...before, schemaVersion: 6, runtimeRepair: binding.runtimeRepair,
        runtimeFingerprint: binding.intent.authority.repairedRuntime.evidence.fingerprint,
        activePromotionReceiptSha256: binding.activePromotionReceiptSha256, createdAt: after.createdAt }, "repair challenge changed original identity or policy");
}
function verifyCommittedAcceptance(root, childRoot, operationId, promotionId, runtimeRepair) {
    const acceptancePath = (0, node_path_1.join)(childRoot, "acceptance.json"), proofBytes = bytes(root, acceptancePath);
    const proof = exact(parsed(proofBytes), ["schemaVersion", "kind", "expectation", "receipt", "pid", "processStartToken"]);
    const source = json(root, (0, node_path_1.join)(childRoot, "acceptance-source.json"));
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairAcceptanceSourceContract)(source, contractDeps);
    if (source.snapshot.path !== acceptancePath || source.snapshot.sha256 !== sha(proofBytes)
        || source.sourceSha256AtCapture !== source.snapshot.sha256)
        fail("immutable acceptance snapshot changed");
    const receipt = exact(proof.receipt, ["schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "pid", "processStartToken", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
        "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearance", "mainInitialized", "preloadInitialized", "settingsMounted", "sharedHistoryBrokerState", "initializedTweakIds", "observedAt", "runtimeRepair"]);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(receipt);
    if (receipt.schemaVersion !== 6 || receipt.kind !== "tweakers-independent-runtime-ready" || receipt.operationId !== operationId
        || receipt.promotionId !== promotionId || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || typeof receipt.processStartToken !== "string")
        fail("committed runtime acceptance receipt changed");
    equal(receipt.runtimeRepair, runtimeRepair, "committed acceptance crosses repair");
    const path = (0, node_path_1.join)(root, "transactions", "manager-recovery-bindings", `${operationId}.acceptance.${sha(canonicalJson(receipt))}.json`);
    if (source.sourcePath !== path)
        fail("immutable acceptance source escaped original attempt");
    equal(fileRef(root, { path, sha256: source.sourceSha256AtCapture }), proofBytes, "immutable acceptance source changed");
    if (proof.schemaVersion !== 1 || proof.kind !== "tweakers-manager-runtime-acceptance" || proof.pid !== receipt.pid
        || proof.processStartToken !== receipt.processStartToken)
        fail("committed acceptance proof changed");
    equal(proof.receipt, receipt, "committed acceptance proof receipt changed");
    const expectation = exact(proof.expectation, ["schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint",
        "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt", "runtimeRepair"]);
    (0, tweakers_sdk_1.assertAcceptedRuntimeRepairReadinessVersionContract)(expectation);
    if (expectation.schemaVersion !== 6 || expectation.operationId !== operationId || expectation.promotionId !== promotionId)
        fail("committed acceptance proof challenge changed");
    equal(expectation.runtimeRepair, runtimeRepair, "committed acceptance proof crosses repair");
    for (const key of ["activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash", "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation"])
        equal(receipt[key], expectation[key], "committed acceptance identity changed");
    for (const key of ["activePromotionReceiptSha256", "appAsarHeaderHash", "runtimeFingerprint"])
        if (typeof receipt[key] !== "string" || !/^[a-f0-9]{64}$/i.test(receipt[key]))
            fail("malformed acceptance digest");
    for (const key of ["appRoot", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot"])
        if (typeof receipt[key] !== "string" || !canonical(receipt[key]))
            fail("malformed acceptance path");
    const broker = exact(receipt.brokerAuthorityExpectation, ["globalRootState", "configSha256"]);
    if (broker.globalRootState !== "valid-v3" || typeof broker.configSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(broker.configSha256)
        || receipt.sharedHistoryBrokerState !== "connected" || receipt.bundleId !== "com.therealityreport.tweakers"
        || receipt.mainInitialized !== true || receipt.preloadInitialized !== true || receipt.settingsMounted !== true
        || typeof receipt.processStartToken !== "string" || receipt.processStartToken.length < 1 || receipt.processStartToken.length > 256
        || !Number.isFinite(Date.parse(receipt.observedAt)) || !Number.isFinite(Date.parse(expectation.createdAt))
        || Date.parse(receipt.observedAt) < Date.parse(expectation.createdAt))
        fail("committed acceptance initialization evidence changed");
    equal(exact(receipt.appearance, ["status", "normalized"]), { status: "normal", normalized: true }, "committed appearance changed");
    equal(expectation.appearanceExpectation, receipt.appearance, "committed appearance requirement changed");
    if (!Array.isArray(receipt.initializedTweakIds) || receipt.initializedTweakIds.length < 1 || receipt.initializedTweakIds.length > 128
        || receipt.initializedTweakIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id))
        || new Set(receipt.initializedTweakIds).size !== receipt.initializedTweakIds.length || !Array.isArray(expectation.expectedTweakIds))
        fail("committed tweak evidence changed");
    equal([...receipt.initializedTweakIds].sort(), [...expectation.expectedTweakIds].sort(), "committed tweak set changed");
    return expectation;
}
//# sourceMappingURL=accepted-runtime-repair-bootstrap.js.map