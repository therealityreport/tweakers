import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertAcceptedRuntimeRepairBundledSourceDelta, assertAcceptedRuntimeRepairChallengeCurrent, assertAcceptedRuntimeRepairExpectationProjection, assertAcceptedRuntimeRepairFilesystemOwner, assertAcceptedRuntimeRepairReadSize, readAcceptedRuntimeRepairBootstrap, readAcceptedRuntimeRepairHistoricalBootstrap, readSupersededNativeReplacementHistoricalBootstrap, readAcceptedRuntimeRepairImmutableAttestation, readAcceptedRuntimeRepairSealedSourceCustody } from "../src/accepted-runtime-repair-bootstrap";
import type { AcceptedRuntimeRepairIntentV1 } from "@therealityreport/tweakers-sdk";
import { NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1, supersededNativeReplacementOperationProjection, acceptedOfficialBundledPayloadText } from "@therealityreport/tweakers-sdk";
import { canonicalManagerJson } from "../../installer/src/manager-contract";
import { assertTweakersVariantBootstrap, fingerprintTweakersVariantGeneration } from "../src/desktop-update-startup";
import { completeAcceptedRuntimeRepairFixture, completeAcceptedRuntimeRepairSuccessorFixture } from "./accepted-runtime-repair-fixture";
import { computeRuntimeFingerprint } from "../../installer/src/runtime-fingerprint";

const operationId = "00000000-0000-4000-8000-000000000001";
const promotionId = "00000000-0000-4000-8000-000000000002";
const repairId = "00000000-0000-4000-8000-000000000003";
test("native replacement boot validates legacy and same-native failed history through subsequent promotions",()=>{
  for(const native of [false,true]){
  const f=completeAcceptedRuntimeRepairFixture("challenge:published");
  try {
    const write=(path:string,value:unknown)=>{mkdirSync(join(path,".."),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value)+"\n",{mode:0o600});};
    const original:any=JSON.parse(readFileSync(f.authority.originals.journal.sourcePath,"utf8"));
    if(native){
      const h="a".repeat(64),source=join(f.managerRoot,"Native.app"),tree={sha256:h,entries:4,bytes:"300"};
      const bare:any={schemaVersion:2,kind:"official-bundled",transactionId:promotionId,installerPayloadHash:h,
        backend:{sourcePath:join(source,"Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),sha256:h,version:"0.162.0-alpha.17.2",architecture:"arm64",certificateSha1:"A".repeat(40)},
        closure:{kind:"official-bundled",sourceAppRoot:source,resourceRelativePath:"Contents/Resources/codex-cli",resourceTree:tree,
          backend:{relativePath:"Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",sha256:h,certificateSha1:"A".repeat(40)},codeModeHost:{relativePath:"Contents/Resources/codex-cli/bin/codex-code-mode-host",sha256:h,certificateSha1:"B".repeat(40)}},
        nativePackage:{relativePath:"Contents/Resources/codex-cli/codex-package.json",sha256:h,layoutVersion:1,version:"0.162.0-alpha.17.2",target:"aarch64-apple-darwin"},
        runtime:{sourceRoot:join(f.managerRoot,"native-runtime"),fingerprint:h,fileCount:10,documentSha256:h,adapterVersion:"official-bundled-adapter-v1"},
        sourceApp:{path:source,bundleId:"com.openai.codex",contentsFingerprint:h,treeSeal:tree}};
      original.acceptedBackendTransition.lane={version:2,resolverProtocol:"official-bundled-v1",identity:original.acceptedBackendTransition.lane.identity,
        authority:{...bare,payloadIdentity:createHash("sha256").update(acceptedOfficialBundledPayloadText(bare)).digest("hex")},priorRegistrationFingerprint:`sha256:${h}`,priorResolverBinarySha256:"b".repeat(64)};
      write(f.authority.originals.journal.sourcePath,original);
    }
    const nextId="00000000-0000-4000-8000-000000000005",nextOperation="00000000-0000-4000-8000-000000000006",replacementId="00000000-0000-4000-8000-000000000007";
    const current:any=JSON.parse(JSON.stringify(original).replaceAll(promotionId,nextId));delete current.acceptedBackendTransition;
    writeFileSync(join(f.userRoot,"runtime","main.js"),"new native-backed runtime\n");
    write(join(f.userRoot,"runtime","runtime-fingerprint.json"),{schemaVersion:1,...computeRuntimeFingerprint(join(f.userRoot,"runtime"))});
    for(const entry of current.entries)entry.desired=fingerprintTweakersVariantGeneration(entry.destination);
    current.activeReceipt.previous=fingerprintTweakersVariantGeneration(current.activeReceipt.destination);
    current.activeReceipt.expected={...current.activeReceipt.expected,entries:current.activeReceipt.expected.entries.map((entry:any)=>({...entry,fingerprint:current.entries.find((e:any)=>e.name===entry.name).desired}))};
    write(current.activeReceipt.source,current.activeReceipt.expected);current.activeReceipt.desired=fingerprintTweakersVariantGeneration(current.activeReceipt.source);
    const currentPath=join(f.userRoot,"transactions","variant-promotion",`${nextId}.json`);write(currentPath,current);
    const expectation:any={...f.child.expectation,schemaVersion:5,operationId:nextOperation,promotionId:nextId,activePromotionReceiptSha256:current.activeReceipt.desired.sha256,runtimeFingerprint:computeRuntimeFingerprint(join(f.userRoot,"runtime")).fingerprint};delete expectation.runtimeRepair;
    const expectationPath=join(f.userRoot,"runtime-ready-expectation.json");write(expectationPath,expectation);
    const at="2026-10-12T14:05:00Z",failed=supersededNativeReplacementOperationProjection(f.operation,at);write(f.originalOperation.path,failed);
    const root=join(f.managerRoot,"transactions","native-replacements",operationId);
    const intent={version:1,kind:"tweakers-native-replacement-intent",operationId,promotionId,repairId:native?null:repairId,replacementId,createdAt:at,trustedLeafSha1:NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1,
      worker:f.authority.authorizedWorker,originalOperation:f.operation,
      retained:[f.authority.originals.journal.sourcePath,f.authority.originals.recoveryBinding.path,f.child.root].map(path=>({path,generation:fingerprintTweakersVariantGeneration(path)})),
      unchanged:[current.activeReceipt.destination,...current.entries.filter((e:any)=>e.name!=="app").map((e:any)=>e.destination)].map(path=>({path,generation:fingerprintTweakersVariantGeneration(path)})),
      previousApp:{path:join(f.userRoot,"previous",promotionId,"app","Tweakers.app"),destination:join(f.managerRoot,"fixture-trash","Tweakers.app"),generation:f.authority.unchanged.app,identity:{dev:1,ino:1}},
      nativeRequest:native?null:{version:2,officialBundled:{transactionId:replacementId}}};
    const hash=(value:unknown)=>createHash("sha256").update(canonicalManagerJson(value)).digest("hex");
    const settlement={version:1,kind:"tweakers-native-replacement-settlement",operationId,promotionId,repairId:intent.repairId,intentSha256:hash(intent),originalOperation:failed,retiredApp:intent.previousApp,originalPromotionAccepted:false};
    const signedJson=(name:string)=>join(root,`${name}.bundle`,"Contents","Resources","receipt.json");
    write(join(root,"intent.json"),intent);write(signedJson("intent"),intent);write(signedJson("settlement"),settlement);
    const signatures:string[]=[];
    const options={environment:{TWEAKERS_DERIVED_VARIANT:"1",TWEAKERS_USER_ROOT:f.userRoot,TWEAKERS_RUNTIME:join(f.userRoot,"runtime")},resourcesPath:join(f.target,"Contents","Resources"),
      nativeReplacementHistoricalVerifier:(input:Parameters<typeof readSupersededNativeReplacementHistoricalBootstrap>[0],deps:Parameters<typeof readSupersededNativeReplacementHistoricalBootstrap>[1])=>readSupersededNativeReplacementHistoricalBootstrap(input,{...deps,verifySignature:(path,identifier,leaf)=>{assert.equal(leaf,NATIVE_REPLACEMENT_TRUSTED_LEAF_SHA1);signatures.push(identifier!);}})};
    assert.equal(assertTweakersVariantBootstrap(options),null);
    assert.deepEqual(signatures,["com.thomashulihan.tweakers.native-replacement.intent","com.thomashulihan.tweakers.native-replacement.settlement"]);
    write(signedJson("settlement"),{...settlement,originalPromotionAccepted:true});assert.throws(()=>assertTweakersVariantBootstrap(options),/settlement differs/);write(signedJson("settlement"),settlement);
    const runtimePath=join(f.userRoot,"runtime","main.js"),runtimeBytes=readFileSync(runtimePath);writeFileSync(runtimePath,"unapproved runtime");assert.throws(()=>assertTweakersVariantBootstrap(options),/pending generation fingerprint mismatch/);writeFileSync(runtimePath,runtimeBytes);
    const journalBytes=readFileSync(f.authority.originals.journal.sourcePath);write(f.authority.originals.journal.sourcePath,{...original,phase:"committed"});assert.throws(()=>assertTweakersVariantBootstrap(options));writeFileSync(f.authority.originals.journal.sourcePath,journalBytes);
    write(expectationPath,{...expectation,promotionId:operationId});assert.throws(()=>assertTweakersVariantBootstrap(options));write(expectationPath,expectation);
    current.phase="committed";write(currentPath,current);write(current.activeReceipt.destination,current.activeReceipt.expected);rmSync(expectationPath);
    assert.equal(assertTweakersVariantBootstrap(options),null);
    const futureId="00000000-0000-4000-8000-000000000008";
    const future:any=JSON.parse(JSON.stringify(current).replaceAll(nextId,futureId));future.phase="app:promoted";
    writeFileSync(runtimePath,"later verified update runtime\n");write(join(f.userRoot,"runtime","runtime-fingerprint.json"),{schemaVersion:1,...computeRuntimeFingerprint(join(f.userRoot,"runtime"))});
    for(const entry of future.entries)entry.desired=fingerprintTweakersVariantGeneration(entry.destination);
    future.activeReceipt.previous=fingerprintTweakersVariantGeneration(future.activeReceipt.destination);
    future.activeReceipt.expected={...future.activeReceipt.expected,entries:future.activeReceipt.expected.entries.map((entry:any)=>({...entry,fingerprint:future.entries.find((e:any)=>e.name===entry.name).desired}))};
    write(future.activeReceipt.source,future.activeReceipt.expected);future.activeReceipt.desired=fingerprintTweakersVariantGeneration(future.activeReceipt.source);
    write(join(f.userRoot,"transactions","variant-promotion",`${futureId}.json`),future);
    write(expectationPath,{...expectation,promotionId:futureId,activePromotionReceiptSha256:future.activeReceipt.desired.sha256,runtimeFingerprint:computeRuntimeFingerprint(join(f.userRoot,"runtime")).fingerprint});
    assert.equal(assertTweakersVariantBootstrap(options),null,"a later update keeps authenticated older supersession as history");
    assert.deepEqual(JSON.parse(readFileSync(f.originalOperation.path,"utf8")),failed);
    assert.deepEqual(readFileSync(f.authority.originals.journal.sourcePath),journalBytes);
  } finally {removeCompleteFixture(f.managerRoot);}
  }
});
test("accepted runtime repair raw payload size policy does not raise the JSON proof bound", () => {
  const aboveProof = 32 * 1024 * 1024 + 1;
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairReadSize(aboveProof, "generated-payload"));
  assert.throws(() => assertAcceptedRuntimeRepairReadSize(aboveProof, "json-proof"));
  for (const size of [-1, Infinity, 512 * 1024 * 1024 + 1]) {
    assert.throws(() => assertAcceptedRuntimeRepairReadSize(size, "generated-payload"));
    assert.throws(() => assertAcceptedRuntimeRepairReadSize(size, "json-proof"));
  }
});
function removeCompleteFixture(path: string): void {
  if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) removeCompleteFixture(join(path, name)); }
  else chmodSync(path, 0o600);
  rmSync(path, { recursive: true, force: true });
}
test("accepted runtime repair authenticates actual producer bytes and complete custody for provisional and committed initialization", () => {
  for (const phase of ["challenge:published", "committed"] as const) {
    const f = completeAcceptedRuntimeRepairFixture(phase);
    try {
      if (phase === "committed") {
        f.settle();
        rmSync(join(f.userRoot, "runtime-ready-expectation.json"));
        assert.equal(existsSync(join(f.userRoot, "runtime-ready.json")), false);
        writeFileSync(join(f.userRoot, "config.json"), JSON.stringify({ tweaks: { "com.example.tweak": { enabled: false } } }));
      }
      const signatures: Array<[string, string | null, string | null]> = [];
      const deps = { fingerprint: fingerprintTweakersVariantGeneration,
        verifySignature: (path: string, identifier: string | null, leaf: string | null) => { signatures.push([path, identifier, leaf]); } };
      const projection = readAcceptedRuntimeRepairBootstrap(f.input, deps);
      const startup = assertTweakersVariantBootstrap({ environment: { TWEAKERS_DERIVED_VARIANT: "1", TWEAKERS_USER_ROOT: f.userRoot, TWEAKERS_RUNTIME: join(f.userRoot, "runtime") },
        resourcesPath: join(f.target, "Contents", "Resources"), runtimeRepairVerifier: (input, supplied) => readAcceptedRuntimeRepairBootstrap(input, { ...supplied, verifySignature: deps.verifySignature }) });
      assert.equal(startup?.phase, phase);
      assert.equal(projection?.phase, phase);
      assert.equal(projection?.originalOperationCompleted, phase === "committed");
      assert.deepEqual(projection?.runtimeRepair, f.child.runtimeRepair);
      assert.deepEqual(signatures.slice(0, 5).map(item => item[1]), ["com.therealityreport.tweakers.manager-launcher", "com.therealityreport.tweakers.manager-launcher", "co.tweakers.accepted-runtime-repair", "co.tweakers.candidate-receipt", "com.therealityreport.tweakers"]);
      assert.equal(signatures.length, 10);
      assert.ok(signatures.every(item => item[2] === f.authority.originalTrustedLeafSha1));
      if (phase === "challenge:published") {
        assertAcceptedRuntimeRepairChallengeCurrent(projection!);
        const configPath = join(f.userRoot, "config.json"), config = readFileSync(configPath);
        writeFileSync(configPath, JSON.stringify({ tweaks: { "com.example.tweak": { enabled: false } } }));
        assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /generation fingerprint changed/);
        writeFileSync(configPath, config);
        const headPath = join(f.managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.runtime-repair-head.json`), head = readFileSync(headPath);
        writeFileSync(headPath, JSON.stringify({ ...f.child.head, intentSha256: "0".repeat(64) }));
        assert.throws(() => assertAcceptedRuntimeRepairChallengeCurrent(projection!), /readiness head changed/);
        writeFileSync(headPath, head);
        const expectationPath = join(f.userRoot, "runtime-ready-expectation.json"), expectation = readFileSync(expectationPath);
        writeFileSync(expectationPath, JSON.stringify({ ...f.child.expectation, expectedTweakIds: ["com.example.foreign"] }));
        assert.throws(() => assertAcceptedRuntimeRepairChallengeCurrent(projection!), /challenge changed since initialization/);
        writeFileSync(expectationPath, expectation);
      }
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, { ...deps, verifySignature: () => { throw new Error("strict signature rejected"); } }), /strict signature rejected/);
      const publicationPath = join(f.child.root, "publication.json"), publication = JSON.parse(readFileSync(publicationPath, "utf8"));
      writeFileSync(publicationPath, JSON.stringify({ ...publication, phase: "runtime:promoted" }));
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /publication gap/);
      writeFileSync(publicationPath, JSON.stringify(publication));
      writeFileSync(f.originalOperation.path, JSON.stringify({ ...f.operation, parameters: { forged: true } }));
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /contract is invalid/);
    } finally { removeCompleteFixture(f.managerRoot); }
  }
});
test("accepted runtime repair historical gate keeps immutable custody without requiring superseded live generations", () => {
  const f = completeAcceptedRuntimeRepairFixture("committed");
  try {
    const deps = { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: () => {} };
    assert.throws(() => readAcceptedRuntimeRepairHistoricalBootstrap(f.input, deps), /not fully settled/);
    f.settle();
    writeFileSync(join(f.userRoot, "runtime", "main.js"), "different normally promoted runtime");
    writeFileSync(join(f.target, "Contents", "Resources", "codex"), "different normally promoted backend");
    writeFileSync(f.authority.completedCas.currentRegistration.path, JSON.stringify({ resolverBinarySha256: "f".repeat(64) }));
    assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /generation fingerprint changed/);
    const history = readAcceptedRuntimeRepairHistoricalBootstrap(f.input, deps);
    assert.equal(history?.phase, "committed"); assert.equal(history?.originalOperationCompleted, true);
    // Immutable acceptance is required even when transient runtime-ready files disappear.
    rmSync(join(f.userRoot, "runtime-ready-expectation.json"));
    assert.doesNotThrow(() => readAcceptedRuntimeRepairHistoricalBootstrap(f.input, deps));
    writeFileSync(join(f.child.root, "acceptance.json"), "{}");
    assert.throws(() => readAcceptedRuntimeRepairHistoricalBootstrap(f.input, deps));
  } finally { removeCompleteFixture(f.managerRoot); }
});
test("accepted runtime repair authenticates a current schema6 child before comparing the prior committed runtime", () => {
  const f = completeAcceptedRuntimeRepairFixture("challenge:published");
  try {
    const options = { environment: { TWEAKERS_DERIVED_VARIANT: "1", TWEAKERS_USER_ROOT: f.userRoot, TWEAKERS_RUNTIME: join(f.userRoot, "runtime") },
      resourcesPath: join(f.target, "Contents", "Resources"),
      runtimeRepairVerifier: (input: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[0], supplied: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[1]) =>
        readAcceptedRuntimeRepairBootstrap(input, { ...supplied, verifySignature: () => {} }),
      runtimeRepairHistoricalVerifier: () => { throw new Error("current repair must not be classified as historical"); } };
    const activePath = join(f.userRoot, "transactions", "variant-promotion", "active.json");
    const prior = JSON.parse(readFileSync(activePath, "utf8"));
    assert.notEqual(prior.id, promotionId);
    assert.equal(JSON.parse(readFileSync(join(f.userRoot, "transactions", "variant-promotion", `${prior.id}.json`), "utf8")).phase, "committed");
    assert.notDeepEqual(prior.entries.find((entry: any) => entry.name === "runtime").fingerprint,
      fingerprintTweakersVariantGeneration(join(f.userRoot, "runtime")));
    assert.equal(assertTweakersVariantBootstrap(options)?.phase, "challenge:published");
    const challengePath = join(f.userRoot, "runtime-ready-expectation.json"), challengeBytes = readFileSync(challengePath);
    writeFileSync(challengePath, JSON.stringify({ ...f.child.expectation, operationId: "00000000-0000-4000-8000-000000000009" }));
    assert.throws(() => assertTweakersVariantBootstrap(options), /does not bind the sole pending promotion/);
    writeFileSync(challengePath, challengeBytes);
    const priorBytes = readFileSync(activePath);
    writeFileSync(activePath, JSON.stringify({ ...prior, entries: [] }));
    assert.throws(() => assertTweakersVariantBootstrap(options), /prior active receipt/);
    writeFileSync(activePath, priorBytes);
    const runtimePath = join(f.userRoot, "runtime", "main.js"), runtimeBytes = readFileSync(runtimePath);
    writeFileSync(runtimePath, "unreviewed repaired runtime");
    assert.throws(() => assertTweakersVariantBootstrap(options), /generation fingerprint changed/);
    writeFileSync(runtimePath, runtimeBytes);
    assert.equal(assertTweakersVariantBootstrap(options)?.phase, "challenge:published");
  } finally { removeCompleteFixture(f.managerRoot); }
});
test("accepted runtime repair authenticates both signed children and only the current V2 head provisionally and after settlement", () => {
  for (const phase of ["challenge:published", "committed"] as const) {
    const f = completeAcceptedRuntimeRepairSuccessorFixture(phase);
    try {
      if (phase === "committed") { f.settle(); rmSync(join(f.userRoot, "runtime-ready-expectation.json")); }
      const signatures: string[] = [];
      const deps = { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: (path: string, _identifier: string | null, leaf: string | null) => {
        assert.equal(leaf, f.authority.originalTrustedLeafSha1); signatures.push(path);
      } };
      const options = { environment: { TWEAKERS_DERIVED_VARIANT: "1", TWEAKERS_USER_ROOT: f.userRoot, TWEAKERS_RUNTIME: join(f.userRoot, "runtime") },
        resourcesPath: join(f.target, "Contents", "Resources"), runtimeRepairVerifier: (input: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[0], supplied: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[1]) =>
          readAcceptedRuntimeRepairBootstrap(input, { ...supplied, verifySignature: deps.verifySignature }) };
      const projection = readAcceptedRuntimeRepairBootstrap(f.input, deps)!;
      assert.equal(projection.head.version, 2); assert.equal(projection.head.repairId, f.child.head.repairId);
      assert.equal(assertTweakersVariantBootstrap(options)?.phase, phase);
      assert.ok(signatures.includes(f.predecessorAuthority.authorizedWorker.launcherPath));
      assert.ok(signatures.includes(f.authority.authorizedWorker.launcherPath));
      assert.ok(signatures.includes(join(f.predecessor.root, "receipt", "TweakersRuntimeRepairReceipt.bundle")));
      assert.notDeepEqual(f.authority.priorRuntime, f.authority.predecessor.installedRuntime);
      assert.deepEqual(fingerprintTweakersVariantGeneration(join(f.predecessor.root, "prior-runtime")), f.authority.priorRuntime);
      assert.deepEqual(fingerprintTweakersVariantGeneration(join(f.child.root, "prior-runtime")), f.authority.predecessor.installedRuntime);
      const headPath = join(f.managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.runtime-repair-head.json`), currentHead = readFileSync(headPath);
      writeFileSync(headPath, readFileSync(join(f.predecessor.root, "head.json")));
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps));
      writeFileSync(headPath, currentHead);
      const capturedChallenge = f.authority.predecessor.challenge.snapshot.path, challenge = readFileSync(capturedChallenge);
      writeFileSync(capturedChallenge, JSON.stringify({ ...f.predecessor.expectation, runtimeRepair: f.child.runtimeRepair }));
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /retained file digest changed/);
      writeFileSync(capturedChallenge, challenge);
      const archivePath = join(f.child.root, "prior-runtime", "main.js"), archiveBytes = readFileSync(archivePath);
      writeFileSync(archivePath, "foreign predecessor runtime");
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps), /generation fingerprint changed/);
      writeFileSync(archivePath, archiveBytes);
      if (phase === "challenge:published") assertAcceptedRuntimeRepairChallengeCurrent(readAcceptedRuntimeRepairBootstrap(f.input, deps)!);
      else {
        writeFileSync(join(f.userRoot, "runtime", "main.js"), "later normally promoted runtime");
        assert.equal(readAcceptedRuntimeRepairHistoricalBootstrap(f.input, deps)?.head.version, 2);
      }
    } finally { removeCompleteFixture(f.managerRoot); }
  }
});
test("accepted runtime repair refuses accepted predecessors malformed attempts and changed signed predecessor custody", () => {
  for (const mutation of ["immutable-acceptance", "verified-attempt", "attempt", "receipt", "publication", "head"] as const) {
    const f = completeAcceptedRuntimeRepairSuccessorFixture("challenge:published");
    try {
      const deps = { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: () => {} };
      assert.equal(readAcceptedRuntimeRepairBootstrap(f.input, deps)?.head.version, 2);
      if (mutation === "immutable-acceptance") f.recordAcceptance(f.predecessor);
      else if (mutation === "verified-attempt") {
        f.recordAcceptance(f.predecessor);
        rmSync(join(f.predecessor.root, "acceptance.json")); rmSync(join(f.predecessor.root, "acceptance-source.json"));
      }
      else if (mutation === "attempt") writeFileSync(join(f.managerRoot, "transactions", "manager-recovery-bindings", `${operationId}.acceptance.json`), "{}", { mode: 0o600 });
      else if (mutation === "receipt") writeFileSync(join(f.predecessor.root, "receipt", "TweakersRuntimeRepairReceipt.bundle", "Contents", "Resources", "runtime-repair.json"), "{}");
      else if (mutation === "publication") writeFileSync(join(f.predecessor.root, "publication.json"), JSON.stringify({ ...f.predecessor.head, phase: "committed" }));
      else writeFileSync(join(f.predecessor.root, "head.json"), JSON.stringify({ ...f.predecessor.head, version: 2, prior: f.child.runtimeRepair }));
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, deps));
    } finally { removeCompleteFixture(f.managerRoot); }
  }
});
test("accepted runtime repair permits a later normal provisional promotion only after full current and retained prior validation", () => {
  const f = completeAcceptedRuntimeRepairFixture("committed");
  try {
    f.settle();
    const nextId = "00000000-0000-4000-8000-000000000005", nextOperation = "00000000-0000-4000-8000-000000000006";
    const write = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 }); };
    const original: any = JSON.parse(readFileSync(f.authority.originals.journal.snapshot.path, "utf8"));
    delete original.acceptedBackendTransition;
    const current: any = JSON.parse(JSON.stringify(original).replaceAll(promotionId, nextId));
    writeFileSync(join(f.userRoot, "runtime", "main.js"), "later normal runtime\n");
    write(join(f.userRoot, "runtime", "runtime-fingerprint.json"), { schemaVersion: 1, ...computeRuntimeFingerprint(join(f.userRoot, "runtime")) });
    writeFileSync(join(f.target, "Contents", "Resources", "codex"), "later normal backend");
    write(join(f.userRoot, "config.json"), { tweaks: { "com.example.tweak": { enabled: false } } });
    for (const entry of current.entries) entry.desired = fingerprintTweakersVariantGeneration(entry.destination);
    current.activeReceipt.previous = fingerprintTweakersVariantGeneration(current.activeReceipt.destination);
    current.activeReceipt.expected = { ...current.activeReceipt.expected, entries: current.activeReceipt.expected.entries.map((entry: any) => ({ ...entry,
      fingerprint: current.entries.find((item: any) => item.name === entry.name).desired })) };
    write(current.activeReceipt.source, current.activeReceipt.expected);
    current.activeReceipt.desired = fingerprintTweakersVariantGeneration(current.activeReceipt.source);
    const currentPath = join(f.userRoot, "transactions", "variant-promotion", `${nextId}.json`); write(currentPath, current);
    const expectation: any = { ...f.child.expectation, schemaVersion: 5, operationId: nextOperation, promotionId: nextId,
      activePromotionReceiptSha256: current.activeReceipt.desired.sha256, runtimeFingerprint: computeRuntimeFingerprint(join(f.userRoot, "runtime")).fingerprint };
    delete expectation.runtimeRepair;
    const expectationPath = join(f.userRoot, "runtime-ready-expectation.json"); write(expectationPath, expectation);
    const options = { environment: { TWEAKERS_DERIVED_VARIANT: "1", TWEAKERS_USER_ROOT: f.userRoot, TWEAKERS_RUNTIME: join(f.userRoot, "runtime") }, resourcesPath: join(f.target, "Contents", "Resources"),
      runtimeRepairVerifier: (input: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[0], supplied: Parameters<typeof readAcceptedRuntimeRepairBootstrap>[1]) =>
        readAcceptedRuntimeRepairBootstrap(input, { ...supplied, verifySignature: () => {} }),
      runtimeRepairHistoricalVerifier: (input: Parameters<typeof readAcceptedRuntimeRepairHistoricalBootstrap>[0], supplied: Parameters<typeof readAcceptedRuntimeRepairHistoricalBootstrap>[1]) =>
        readAcceptedRuntimeRepairHistoricalBootstrap(input, { ...supplied, verifySignature: () => {} }) };
    assert.equal(assertTweakersVariantBootstrap(options), null);
    write(expectationPath, { ...expectation, promotionId: operationId });
    assert.throws(() => assertTweakersVariantBootstrap(options)); write(expectationPath, expectation);
    const priorBytes = readFileSync(current.activeReceipt.destination);
    write(current.activeReceipt.destination, { version: 4, wrong: true });
    assert.throws(() => assertTweakersVariantBootstrap(options), /prior receipt changed/); writeFileSync(current.activeReceipt.destination, priorBytes);
    const stagedBytes = readFileSync(current.activeReceipt.source);
    write(current.activeReceipt.source, { ...current.activeReceipt.expected, id: operationId });
    assert.throws(() => assertTweakersVariantBootstrap(options), /exact generation binding/); writeFileSync(current.activeReceipt.source, stagedBytes);
    const runtimeBytes = readFileSync(join(f.userRoot, "runtime", "main.js"));
    writeFileSync(join(f.userRoot, "runtime", "main.js"), "unapproved later runtime");
    assert.throws(() => assertTweakersVariantBootstrap(options), /pending generation fingerprint mismatch/); writeFileSync(join(f.userRoot, "runtime", "main.js"), runtimeBytes);
    current.phase = "committed"; write(currentPath, current); write(current.activeReceipt.destination, current.activeReceipt.expected); rmSync(expectationPath);
    assert.equal(assertTweakersVariantBootstrap(options), null);
  } finally { removeCompleteFixture(f.managerRoot); }
});
function fixture() {
  const managerRoot = realpathSync(mkdtempSync(join(tmpdir(), "accepted-runtime-repair-gate-")));
  chmodSync(managerRoot, 0o700);
  const bindings = join(managerRoot, "transactions", "manager-recovery-bindings");
  mkdirSync(bindings, { recursive: true, mode: 0o700 });
  const input = { managerRoot, userRoot: join(managerRoot, "variants", "tweakers"), target: join(managerRoot, "Tweakers.app"), operationId, promotionId };
  const path = join(bindings, `${operationId}.runtime-repair-head.json`);
  const head = { version: 1, kind: "tweakers-accepted-runtime-repair-head", operationId, promotionId, repairId, intentSha256: "a".repeat(64), prior: null };
  return { managerRoot, input, path, head };
}
test("accepted runtime repair absent fixed head preserves legacy startup without invoking a signature tool", () => {
  const f = fixture();
  try {
    let signatures = 0;
    assert.equal(readAcceptedRuntimeRepairBootstrap(f.input, { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: () => { signatures++; } }), null);
    assert.equal(signatures, 0);
  } finally { rmSync(f.managerRoot, { recursive: true, force: true }); }
});
test("accepted runtime repair absent head does not hide an aliased authority ancestor", () => {
  const f = fixture();
  try {
    const bindings = join(f.managerRoot, "transactions", "manager-recovery-bindings");
    rmSync(bindings, { recursive: true });
    symlinkSync(join(f.managerRoot, "missing-authority"), bindings);
    assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: () => {} }), /unsafe custody|noncanonical/);
  } finally { rmSync(f.managerRoot, { recursive: true, force: true }); }
});
test("accepted runtime repair rejects linked, public, duplicate-key and foreign-operation heads before using child code", () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => symlinkSync(join(f.managerRoot, "missing"), f.path),
    f => { writeFileSync(f.path, JSON.stringify(f.head), { mode: 0o600 }); linkSync(f.path, join(f.managerRoot, "head-alias")); },
    f => writeFileSync(f.path, JSON.stringify(f.head), { mode: 0o644 }),
    f => writeFileSync(f.path, JSON.stringify({ ...f.head, operationId: promotionId }), { mode: 0o600 }),
    f => writeFileSync(f.path, JSON.stringify({ ...f.head, prior: { repairId, headSha256: "a".repeat(64) } }), { mode: 0o600 }),
    f => writeFileSync(f.path, JSON.stringify(f.head).replace('"prior":null', '"prior":null,"prior":null'), { mode: 0o600 }),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      mutate(f); let signatures = 0;
      assert.throws(() => readAcceptedRuntimeRepairBootstrap(f.input, { fingerprint: fingerprintTweakersVariantGeneration, verifySignature: () => { signatures++; } }));
      assert.equal(signatures, 0);
    } finally { rmSync(f.managerRoot, { recursive: true, force: true }); }
  }
});
test("accepted runtime repair permits only the root-owned system Applications ancestor exception", () => {
  const root = { root: "/Applications", path: "/Applications", uid: 0, mode: 0o775, currentUid: 501, privateLeaf: false, symlink: false };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairFilesystemOwner(root));
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairFilesystemOwner({ ...root, root: "/private/manager", path: "/private/manager", uid: 501, mode: 0o700, privateLeaf: true }));
  for (const value of [{ ...root, mode: 0o777 }, { ...root, symlink: true },
    { ...root, root: "/other", path: "/other" }, { ...root, path: "/Applications/Tweakers.app" },
    { ...root, privateLeaf: true }, { ...root, uid: 502 }]) assert.throws(() => assertAcceptedRuntimeRepairFilesystemOwner(value));
});
test("accepted runtime repair binds only the exact durable attestation publisher links", () => {
  for (const name of ["accepted-build.json", "review-manifest.json"]) {
    for (const bad of [false, true]) {
      const f = fixture();
      try {
        const directory = join(f.managerRoot, "codex-source", "accepted", promotionId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, name), text = '{"retained":"original"}\n', hash = createHash("sha256").update(text).digest("hex");
        writeFileSync(path, text, { mode: 0o600 });
        linkSync(path, join(directory, bad ? "unrecognized-alias" : `.${name}.92916.1791789816698.tmp`));
        if (bad) assert.throws(() => readAcceptedRuntimeRepairImmutableAttestation(f.managerRoot, path, hash));
        else {
          assert.equal(readAcceptedRuntimeRepairImmutableAttestation(f.managerRoot, path, hash).toString(), text);
          assert.throws(() => readAcceptedRuntimeRepairImmutableAttestation(f.managerRoot, path, "0".repeat(64)));
          linkSync(path, join(directory, "third-link"));
          assert.throws(() => readAcceptedRuntimeRepairImmutableAttestation(f.managerRoot, path, hash));
        }
      } finally { rmSync(f.managerRoot, { recursive: true, force: true }); }
    }
  }
});
test("accepted runtime repair schema6 preserves original challenge policy and rejects identity drift", () => {
  const original = { schemaVersion: 5, kind: "tweakers-independent-runtime-ready-expectation", operationId, promotionId,
    activePromotionReceiptSha256: "a".repeat(64), appRoot: "/Applications/Tweakers.app", bundleId: "com.therealityreport.tweakers",
    appAsarHeaderHash: "b".repeat(64), runtimeFingerprint: "c".repeat(64), appUserDataRoot: "/private/app-data",
    codexHomeRoot: "/private/codex", accountsBrokerRoot: "/private/broker",
    brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: "d".repeat(64) },
    appearanceExpectation: { status: "normal", normalized: true }, expectedTweakIds: ["com.example.tweak"], createdAt: "2026-10-12T12:00:00Z" };
  // This helper takes the already authenticated intent projection; the complete
  // serialized intent shape is exercised separately in the SDK contract cases.
  const intent = { operationId, promotionId, createdAt: "2026-10-12T12:01:00Z",
    authority: { repairedRuntime: { evidence: { fingerprint: "e".repeat(64) } } } } as AcceptedRuntimeRepairIntentV1;
  const runtimeRepair = { repairId, headSha256: "f".repeat(64), intentSha256: "1".repeat(64), authorityReceiptSha256: "2".repeat(64) };
  const binding = { intent, runtimeRepair, activePromotionReceiptSha256: "3".repeat(64) };
  const current = { ...original, schemaVersion: 6, runtimeRepair, runtimeFingerprint: "e".repeat(64),
    activePromotionReceiptSha256: binding.activePromotionReceiptSha256, createdAt: "2026-10-12T12:02:00Z" };
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairExpectationProjection(original, current, binding));
  for (const delta of [{ createdAt: "2026-10-12T12:00:30Z" }, { schemaVersion: 5 }, { runtimeRepair: null },
    { runtimeFingerprint: original.runtimeFingerprint }, { activePromotionReceiptSha256: original.activePromotionReceiptSha256 },
    { accountsBrokerRoot: "/private/foreign-broker" }, { appUserDataRoot: "/private/foreign-app-data" },
    { expectedTweakIds: [] }, { appearanceExpectation: { status: "normal", normalized: false } },
    { brokerAuthorityExpectation: { globalRootState: "valid-v3", configSha256: "4".repeat(64) } }, { ignored: true }]) {
    assert.throws(() => assertAcceptedRuntimeRepairExpectationProjection(original, { ...current, ...delta }, binding));
  }
});

test("accepted runtime repair sealed custody requires the actual fixed check evidence and mapped output bytes", () => {
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const commands = [
    ...["installer", "runtime", "sdk"].map(name => ["node_modules/typescript/bin/tsc", "--noEmit", "-p", `packages/${name}/tsconfig.json`]),
    ["--import", "./scripts/test-root-preload.mjs", "--import", "tsx", "--test", "--test-concurrency=2", "--test-name-pattern=accepted runtime repair|schema6|schema5 is explicit",
      "packages/installer/test/accepted-runtime-repair.test.ts", "packages/installer/test/runtime-repair-source-custody.test.ts",
      "packages/installer/test/runtime-ready-receipt.test.ts", "packages/runtime/test/accepted-runtime-repair-contract.test.ts",
      "packages/installer/test/manager-historical-continuations.test.ts",
      "packages/installer/test/manager-action-adapter.test.ts", "packages/installer/test/manager-cli.test.ts",
      "packages/installer/test/generation-retention.test.ts",
      "packages/runtime/test/accepted-runtime-repair-bootstrap.test.ts", "packages/runtime/test/desktop-update-startup.test.ts"],
    ["--test", "scripts/verify-runtime-repair-source.test.mjs"],
  ];
  const mutations: Array<(f: { record: any; checks: any; writeChecks(): void; output: string; log: string }) => void> = [
    () => {},
    f => { f.checks.checks[0].argv.push("--skip-tests"); f.writeChecks(); },
    f => { f.checks.checks[0].exitCode = 1; f.writeChecks(); },
    f => writeFileSync(f.log, "changed log"),
    f => { chmodSync(f.output, 0o600); writeFileSync(f.output, "changed generated bytes"); },
    f => { f.record.generatedFiles[0].sourceInputs[0].sha256 = "9".repeat(64); },
    f => { f.record.generatedFiles[0].relativePath = "../foreign.js"; },
    f => { f.record.generatedFiles[0].sealedMode = 0o500; },
    f => { f.checks.inputSnapshots.after.sha256 = "8".repeat(64); f.writeChecks(); },
    f => { f.record.unrecognizedAuthority = true; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = fixture();
    try {
      const managedRoot = join(f.managerRoot, "managed"), moduleRoot = join(managedRoot, "packages", "installer", "dist");
      const evidence = join(moduleRoot, "runtime-repair-source-evidence"), run = join(evidence, "logs", repairId);
      mkdirSync(run, { recursive: true, mode: 0o700 });
      const sourceFiles = [{ relativePath: "packages/runtime/src/main.ts", mode: 0o644, sha256: hash("source") }];
      const node = { path: "/private/node", sha256: hash("node"), version: "v22.0.0" };
      const checks: any = { version: 1, kind: "tweakers-runtime-repair-source-checks", checkoutRoot: "/private/checkout", sourceFiles,
        inputIdentity: hash(JSON.stringify(sourceFiles)), node, dependencyIdentity: hash("dependencies"), environmentIdentity: hash("environment"),
        inputSnapshots: {}, checks: commands.map((argv, i) => ({ command: node.path, argv: [...argv], cwd: "/private/checkout", startedAt: "2026-10-12T12:00:00Z",
          completedAt: "2026-10-12T12:01:00Z", exitCode: 0,
          stdout: { relativePath: `logs/${repairId}/${i}.stdout.log`, sha256: hash(`passed ${i}`) },
          stderr: { relativePath: `logs/${repairId}/${i}.stderr.log`, sha256: hash("") } })) };
      for (const [i, check] of checks.checks.entries()) {
        writeFileSync(join(evidence, check.stdout.relativePath), `passed ${i}`, { mode: 0o600 });
        writeFileSync(join(evidence, check.stderr.relativePath), "", { mode: 0o600 });
      }
      const snapshot = JSON.stringify({ sourceFiles, inputIdentity: checks.inputIdentity, dependencyIdentity: checks.dependencyIdentity,
        environmentIdentity: checks.environmentIdentity, node });
      for (const side of ["before", "after"]) {
        checks.inputSnapshots[side] = { relativePath: `logs/${repairId}/inputs-${side}.json`, sha256: hash(snapshot) };
        writeFileSync(join(evidence, checks.inputSnapshots[side].relativePath), snapshot, { mode: 0o600 });
      }
      const baseline = { fingerprint: hash("runtime"), fileCount: 1, documentSha256: hash("document") };
      const output = join(moduleRoot, "main.js"); writeFileSync(output, "generated", { mode: 0o400 });
      const record: any = { version: 1, kind: "tweakers-runtime-repair-source-custody",
        checkReceipt: { relativePath: "runtime-repair-source-evidence/checks.json", sha256: "" }, sourceFiles, packagedRuntime: baseline,
        generatedFiles: [{ relativePath: "packages/installer/dist/main.js", mode: 0o644, sealedMode: 0o400,
          sha256: hash("generated"), mappingKind: "tsc-source-map", sourceInputs: [{ relativeSourcePath: sourceFiles[0]!.relativePath, sha256: sourceFiles[0]!.sha256 }] }] };
      const writeChecks = () => {
        const text = JSON.stringify(checks); writeFileSync(join(evidence, "checks.json"), text, { mode: 0o600 }); record.checkReceipt.sha256 = hash(text);
      };
      writeChecks(); mutate({ record, checks, writeChecks, output, log: join(run, "0.stdout.log") });
      writeFileSync(join(moduleRoot, "runtime-repair-source-custody.json"), JSON.stringify(record), { mode: 0o600 });
      if (index === 0) assert.deepEqual(readAcceptedRuntimeRepairSealedSourceCustody(f.managerRoot, moduleRoot, baseline), record);
      else assert.throws(() => readAcceptedRuntimeRepairSealedSourceCustody(f.managerRoot, moduleRoot, baseline));
    } finally { rmSync(f.managerRoot, { recursive: true, force: true }); }
  }
});
test("accepted runtime repair rejects an unreviewed embedded bundle change despite an approved bootstrap input", () => {
  const bundle = (main: string, broker: string, sources = ["../src/main.ts", "../src/account-router/broker-host.ts"]) => Buffer.from(
    `compiled\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources, sourcesContent: [main, broker], names: [], mappings: "" })).toString("base64")}\n`);
  const before = bundle("old bootstrap", "unchanged broker");
  assert.doesNotThrow(() => assertAcceptedRuntimeRepairBundledSourceDelta(before, bundle("new bootstrap", "unchanged broker"), "packages/installer/assets/runtime/main.js"));
  assert.throws(() => assertAcceptedRuntimeRepairBundledSourceDelta(before, bundle("new bootstrap", "changed broker"), "packages/installer/assets/runtime/main.js"));
  assert.throws(() => assertAcceptedRuntimeRepairBundledSourceDelta(before, bundle("new bootstrap", "unchanged broker", ["../src/main.ts", "../src/main.ts"]), "packages/installer/assets/runtime/main.js"));
  assert.throws(() => assertAcceptedRuntimeRepairBundledSourceDelta(before, Buffer.from("unmapped code"), "packages/installer/assets/runtime/main.js"));
  assert.throws(() => assertAcceptedRuntimeRepairBundledSourceDelta(before, bundle("new bootstrap", "unchanged broker"), "unowned/output.js"));
});
