import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeSavedProfileV1 } from "../../src/account-router/native-auth-binding";
import { nativeHistoryAuthIdentityHmacV1 } from "../../src/account-router/native-history";
import { AccountsBrokerV1, createBrokerHandshakeProof } from "../../src/account-router/broker";
import type { OpaqueAccountId, OpaqueAppToolsRef, OpaqueRendererRef } from "../../src/account-router/types";

test("saved profile facts stay account-bound, masked, read-only and separate from authentication", async () => {
  const home = mkdtempSync(join(tmpdir(), "saved-profile-")), secret = Buffer.alloc(32, 8), raw = "fixture-provider-account";
  const opaqueAccountId = `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}` as OpaqueAccountId;
  const entry = { opaqueAccountId, authIdentityHmac: nativeHistoryAuthIdentityHmacV1(raw, secret) };
  const token = (account: string, email = "codex@example.invalid") => ["header", Buffer.from(JSON.stringify({ email, exp: 0, "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" } })).toString("base64url"), "signature"].join(".");
  const file = join(home, "auth.json"), write = (account: string, email?: string) => writeFileSync(file, JSON.stringify({ tokens: { account_id: raw, id_token: token(account, email) } }), { mode: 0o600 });
  const fingerprint = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    write(raw); const before = fingerprint();
    const profile = readNativeSavedProfileV1(home, entry, secret);
    assert.deepEqual(profile, { identifierMasked: "cod***@example.invalid", plan: "pro", avatarUrl: null });
    assert.equal(fingerprint(), before);
    assert.equal(JSON.stringify(profile).includes("signature"), false);
    const broker = new AccountsBrokerV1({ accounts: [{ opaqueAccountId, enabled: true }], secret,
      onDeviceAction: async action => action.kind === "profile.read" ? { outcome: "accepted", value: profile } : { outcome: "rejected" } });
    const unsigned = { version: 1 as const, clientKind: "tweakers" as const, rendererRef: `br_${"r".repeat(43)}` as OpaqueRendererRef,
      appToolsRef: `bat_${"t".repeat(43)}` as OpaqueAppToolsRef, nonce: "s".repeat(32) };
    broker.handshake({ ...unsigned, proof: createBrokerHandshakeProof(secret, unsigned) });
    broker.markAccountFailure(opaqueAccountId, "authentication");
    await broker.invoke(unsigned.rendererRef, { version: 1, requestId: "saved-facts", command: "profile.read" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(broker.pool().accounts[0]!.state, "reauth_required", "saved facts cannot recover authentication");
    assert.deepEqual(broker.pool().accounts[0]!.safeProfile, profile);
    assert.notEqual(broker.quota()[0]?.freshness, "fresh", "saved plan is never fresh usage capacity");
    broker.close();
    write("another-account"); assert.equal(readNativeSavedProfileV1(home, entry, secret), null);
    write(raw, "bad email@example.invalid"); assert.equal(readNativeSavedProfileV1(home, entry, secret), null);
    write(raw); assert.throws(() => readNativeSavedProfileV1(home, { ...entry, opaqueAccountId: `ar_${"x".repeat(43)}` as OpaqueAccountId }, secret));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
