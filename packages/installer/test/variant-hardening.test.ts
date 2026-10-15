import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPlist, writePlist } from "../src/plist";
import { captureOfficialBundledBackendClosure, NATIVE_CODEX_BACKEND, NATIVE_CODE_MODE_HOST, NATIVE_CODEX_CLI_ROOT } from "../src/native-bundled-backend.js";
import {
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID,
  TWEAKERS_VARIANT_COMPUTER_USE_NAME,
  applyMacAppIdentity,
  assertNoResidualOpenAIRuntimeIdentities,
  defaultTweakersVariantIdentity,
} from "../src/macos-variant";

function writeInfo(path: string, value: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writePlist(path, value);
}

test("variant identity preserves the verified supplied native CLI closure while isolating sibling desktop helpers",()=>{
  const root=mkdtempSync(join(tmpdir(),"tweakers-native-identity-"));
  try {
    const app=join(root,"Tweakers.app"),main=join(app,"Contents/Info.plist"),nativeInfo=join(app,NATIVE_CODEX_CLI_ROOT,"CodexCLI.app/Contents/Info.plist");
    const sibling=join(app,"Contents/Resources/codex-cli-shadow/Helper.app/Contents/Info.plist");
    writeInfo(main,{CFBundleIdentifier:"com.openai.codex",CFBundleName:"Codex"});
    writeInfo(nativeInfo,{CFBundleIdentifier:"com.openai.codex.CodexCLI",CFBundleExecutable:"codex",CFBundleName:"CodexCLI"});
    writeInfo(sibling,{CFBundleIdentifier:"com.openai.codex.helper",CFBundleName:"Codex Helper"});
    for(const name of [NATIVE_CODEX_BACKEND,NATIVE_CODE_MODE_HOST]) {
      const file=join(app,name);mkdirSync(join(file,".."),{recursive:true});writeFileSync(file,Buffer.from([0xcf,0xfa,0xed,0xfe,1,2,3,4]),{mode:0o755});
    }
    const port={certificate:()=>"A".repeat(40),verify:()=>({ok:true,output:"fixture signature"})};
    const closure=captureOfficialBundledBackendClosure(app,port)!,before=readFileSync(nativeInfo);
    applyMacAppIdentity(app,defaultTweakersVariantIdentity(join(root,"app-data"),root),closure,port);
    assert.deepEqual(readFileSync(nativeInfo),before);
    assert.deepEqual(captureOfficialBundledBackendClosure(app,port)!.resourceTree,closure.resourceTree);
    assert.equal(readPlist(main).CFBundleIdentifier,TWEAKERS_VARIANT_BUNDLE_ID);
    assert.equal(readPlist(sibling).CFBundleIdentifier,`${TWEAKERS_VARIANT_BUNDLE_ID}.helper`);
    assert.doesNotThrow(()=>assertNoResidualOpenAIRuntimeIdentities(app,closure,port));
    writeInfo(nativeInfo,{...readPlist(nativeInfo),CFBundleName:"tampered native resource"});
    assert.throws(()=>applyMacAppIdentity(app,defaultTweakersVariantIdentity(join(root,"app-data"),root),closure,port),/resource closure changed/);
    assert.throws(()=>assertNoResidualOpenAIRuntimeIdentities(app,closure,port),/resource closure changed/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("variant identity rewrite covers all nested desktop and Computer Use names while retaining only dSYM metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-hardening-"));
  try {
    const app = join(root, "Tweakers.app");
    const main = join(app, "Contents", "Info.plist");
    const helper = join(app, "Contents", "Frameworks", "Codex Helper.app", "Contents", "Info.plist");
    const cua = join(app, "Contents", "Resources", "CUA.app", "Contents", "Info.plist");
    const dsym = join(app, "Contents", "Resources", "Codex.dSYM", "Contents", "Info.plist");
    writeInfo(main, {
      CFBundleIdentifier: "com.openai.codex",
      CFBundleName: "ChatGPT",
      CFBundleDisplayName: "ChatGPT",
    });
    writeInfo(helper, {
      CFBundleIdentifier: "com.openai.codex.helper.renderer",
      CFBundleName: "Codex Helper",
      CFBundleDisplayName: "OpenAI Renderer",
      BundleSigningBaseName: "Codex Helper",
    });
    writeInfo(cua, {
      CFBundleIdentifier: "com.openai.sky.CUAService.helper",
      CFBundleName: "Codex Computer Use Helper",
      CFBundleDisplayName: "OpenAI CUA Helper",
    });
    // dSYM Contents/Info.plist is symbol metadata, not a launchable runtime
    // bundle; its original ID is intentionally the only permitted residue.
    writeInfo(dsym, {
      CFBundleIdentifier: "com.openai.codex.dsym",
      CFBundleName: "Codex Symbols",
    });

    const changed = applyMacAppIdentity(app, defaultTweakersVariantIdentity(join(root, "app-data"), root));
    assert.equal(changed.length, 3);
    assert.equal(readPlist(helper).CFBundleIdentifier, `${TWEAKERS_VARIANT_BUNDLE_ID}.helper.renderer`);
    assert.equal(readPlist(helper).CFBundleName, "Tweakers Helper");
    assert.equal(readPlist(helper).CFBundleDisplayName, "Tweakers Renderer");
    assert.equal(readPlist(helper).BundleSigningBaseName, "Tweakers Helper");
    assert.equal(readPlist(cua).CFBundleIdentifier, `${TWEAKERS_VARIANT_COMPUTER_USE_BUNDLE_ID}.helper`);
    assert.equal(readPlist(cua).CFBundleName, "Tweakers Computer Use Helper");
    assert.equal(readPlist(cua).CFBundleDisplayName, "Tweakers CUA Helper");
    assert.equal(readPlist(dsym).CFBundleIdentifier, "com.openai.codex.dsym");
    assert.equal(readPlist(dsym).CFBundleName, "Codex Symbols");
    assert.doesNotThrow(() => assertNoResidualOpenAIRuntimeIdentities(app));
    assert.ok(readFileSync(join(app, "Contents", "Resources", "tweakers.icns")).length > 0);
    assert.equal(TWEAKERS_VARIANT_COMPUTER_USE_NAME, "Tweakers Computer Use");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("variant identity rewrite fails before mutation on an unknown OpenAI runtime identity", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-hardening-"));
  try {
    const app = join(root, "Tweakers.app");
    const main = join(app, "Contents", "Info.plist");
    const unknown = join(app, "Contents", "Resources", "Unknown.app", "Contents", "Info.plist");
    writeInfo(main, { CFBundleIdentifier: "com.openai.codex", CFBundleName: "ChatGPT" });
    writeInfo(unknown, { CFBundleIdentifier: "com.openai.unknown.runtime", CFBundleName: "OpenAI Unknown" });

    assert.throws(
      () => applyMacAppIdentity(app, defaultTweakersVariantIdentity(join(root, "app-data"), root)),
      /unrecognized OpenAI runtime bundle identity/,
    );
    assert.equal(readPlist(main).CFBundleIdentifier, "com.openai.codex");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("variant identity rewrite rejects OpenAI lookalike bundle IDs instead of prefix-colliding", () => {
  for (const bundleId of ["com.openai.codextra", "com.openai.sky.CUAServiceExtra"]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-variant-hardening-"));
    try {
      const app = join(root, "Tweakers.app");
      const main = join(app, "Contents", "Info.plist");
      const lookalike = join(app, "Contents", "Resources", "Lookalike.app", "Contents", "Info.plist");
      writeInfo(main, { CFBundleIdentifier: "com.openai.codex", CFBundleName: "ChatGPT" });
      writeInfo(lookalike, { CFBundleIdentifier: bundleId, CFBundleName: "OpenAI Lookalike" });

      assert.throws(
        () => applyMacAppIdentity(app, defaultTweakersVariantIdentity(join(root, "app-data"), root)),
        /unrecognized OpenAI runtime bundle identity/,
        bundleId,
      );
      assert.equal(readPlist(main).CFBundleIdentifier, "com.openai.codex", bundleId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("residual OpenAI runtime identity audit rejects post-rewrite tampering", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-variant-hardening-"));
  try {
    const app = join(root, "Tweakers.app");
    const main = join(app, "Contents", "Info.plist");
    writeInfo(main, { CFBundleIdentifier: "com.openai.codex", CFBundleName: "ChatGPT" });
    applyMacAppIdentity(app, defaultTweakersVariantIdentity(join(root, "app-data"), root));
    writePlist(main, { ...readPlist(main), CFBundleIdentifier: "com.openai.codex.reintroduced" });

    assert.throws(
      () => assertNoResidualOpenAIRuntimeIdentities(app),
      /retained an OpenAI runtime bundle identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
