import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, existsSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readRouterLaunchSelection } from "./config";
import { AccountsBrokerManagerClientV1, readAccountsBrokerSecret, reserveAccountsBrokerSocket } from "./broker-socket";
import { readNativeHistoryRecoveryAuthorityV1 } from "./native-history";
import { readNativeAuthBindingAuthorityV1, readNativeAuthPrivateFileV1, readNativeExternalTokensV1 } from "./native-auth-binding";

export interface DoctorAuthInspection {
  state: "ready" | "reconnect_required" | "blocked";
  fingerprint: string;
  accounts: { accountId: string; label: string }[];
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function authority(root: string, secret: Buffer) {
  if (["native-storage-identities-repair.v2.json", "enrollment-materialization.v1.json", "shared-native-mode-transition.v1.json", "shared-native-resolver-transition.v1.json", "shared-account-config/shared-source-rebase-intent.v1.json"].some(name => existsSync(join(root, name)))) throw new Error("Resolve pending account recovery first");
  const config = readRouterLaunchSelection(join(root, "account-router-config.json")).config;
  if (!config || config.schemaVersion !== 3) throw new Error("Recovery authority unavailable");
  const source = readNativeHistoryRecoveryAuthorityV1(root, config, secret);
  const companion = readNativeAuthBindingAuthorityV1(root, source, secret);
  const accounts = source.accounts.map((entry, index) => {
    const home = companion?.document.accounts.find(a => a.opaqueAccountId === entry.opaqueAccountId)?.authHome ?? entry.codexHome;
    const bytes = readNativeAuthPrivateFileV1(join(home, "auth.json"));
    let valid = false;
    try { readNativeExternalTokensV1(home, entry, secret); valid = true; } catch { /* Only this credential is repairable. */ }
    const fingerprint = digest(bytes.toString("base64")); bytes.fill(0);
    return { entry, home, valid, fingerprint, label: `Account ${index + 1}` };
  });
  const metadata = ["account-router-config.json", "native-history-source.v1.json", "native-auth-binding.v1.json", "native-storage-identities.v2.json"]
    .map(name => [name, existsSync(join(root, name)) ? digest(readNativeAuthPrivateFileV1(join(root, name)).toString("base64")) : null]);
  return { config, accounts, fingerprint: digest({ metadata, accounts: accounts.map(a => [a.entry.opaqueAccountId, a.home, a.fingerprint]) }) };
}
export function inspectNativeAuthenticationAtRoot(root: string): DoctorAuthInspection {
  const secret = readAccountsBrokerSecret(root);
  try {
    if (!secret) throw new Error("unavailable");
    const value = authority(root, secret);
    const accounts = value.accounts.filter(a => !a.valid).map(a => ({ accountId: a.entry.opaqueAccountId, label: a.label }));
    return { state: accounts.length ? "reconnect_required" : "ready", fingerprint: value.fingerprint, accounts };
  } catch { return { state: "blocked", fingerprint: digest("unavailable"), accounts: [] }; }
  finally { secret?.fill(0); }
}

/** No foreign process may hold the selected authentication home during publication. */
function assertIdle(home: string): void {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-t", "+D", home], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || ![0, 1].includes(result.status ?? -1) || result.stderr.trim()
    || result.stdout.trim().split(/\s+/).filter(Boolean).some(pid => Number(pid) !== process.pid)) throw new Error("Close the session using this account before reconnecting.");
}

/** The login callback must finish and reap its child before returning. */
export async function reconnectNativeAuthenticationAtRoot(input: {
  root: string; accountId: string; expectedFingerprint: string;
  login: (stagedHome: string) => Promise<void>;
  prepareDesktop?: () => Promise<void>;
}): Promise<DoctorAuthInspection> {
  const secret = readAccountsBrokerSecret(input.root);
  if (!secret) throw new Error("Recovery authority unavailable");
  let reservation: Awaited<ReturnType<typeof reserveAccountsBrokerSocket>> | undefined;
  let stagedHome: string | undefined;
  let prior: Buffer | undefined;
  try {
    try { reservation = await reserveAccountsBrokerSocket({ root: input.root, secret }); }
    catch {
      const manager = new AccountsBrokerManagerClientV1({ root: input.root, secret });
      try { if (!await manager.prepareAuthenticationRecovery(randomUUID())) throw new Error("The broker is busy. Finish active account work before reconnecting."); }
      finally { await manager.close(); }
      const deadline = Date.now() + 5000;
      while (!reservation && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { reservation = await reserveAccountsBrokerSocket({ root: input.root, secret }); } catch { /* Wait only for the acknowledged retirement. */ }
      }
      if (!reservation) throw new Error("The broker did not finish preparing recovery.");
    }
    const before = authority(input.root, secret);
    if (before.fingerprint !== input.expectedFingerprint) throw new Error("Account recovery findings changed. Refresh Doctor.");
    const account = before.accounts.find(a => a.entry.opaqueAccountId === input.accountId && !a.valid);
    if (!account) throw new Error("This account does not need recovery.");
    await input.prepareDesktop?.();
    assertIdle(account.home);
    const target = join(account.home, "auth.json");
    const stat = lstatSync(target);
    prior = readNativeAuthPrivateFileV1(target);
    stagedHome = mkdtempSync(join(input.root, ".auth-recovery-"));
    writeFileSync(join(stagedHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
    await input.login(stagedHome);
    try { readNativeExternalTokensV1(stagedHome, account.entry, secret); }
    catch { throw new Error(`That login is not ${account.label}. Its credentials were not changed. Use Switch account to use your other account, or reconnect the original account.`); }
    if (authority(input.root, secret).fingerprint !== before.fingerprint) throw new Error("Account recovery findings changed during login.");
    assertIdle(account.home);
    const current = readNativeAuthPrivateFileV1(target);
    const currentStat = lstatSync(target);
    try { if (!current.equals(prior) || currentStat.ino !== stat.ino || currentStat.dev !== stat.dev) throw new Error("Credentials changed during login."); }
    finally { current.fill(0); }
    const fresh = readNativeAuthPrivateFileV1(join(stagedHome, "auth.json"));
    const suffix = randomBytes(16).toString("hex");
    const replacement = join(account.home, `.auth-recovery-${suffix}`);
    const backup = join(account.home, `.auth-before-recovery-${suffix}`);
    try {
      writeFileSync(backup, prior, { mode: 0o600, flag: "wx" });
      writeFileSync(replacement, fresh, { mode: 0o600, flag: "wx" });
      for (const path of [backup, replacement]) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
      // Revalidate immediately before the only credential mutation.
      if (authority(input.root, secret).fingerprint !== before.fingerprint || lstatSync(target).ino !== stat.ino) throw new Error("Credentials changed before publication.");
      renameSync(replacement, target);
      const fd = openSync(account.home, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
      try { readNativeExternalTokensV1(account.home, account.entry, secret); }
      catch { renameSync(backup, target); throw new Error("Reconnect verification failed; prior credentials restored."); }
    } finally { fresh.fill(0); }
    return inspectNativeAuthenticationAtRoot(input.root);
  } finally {
    prior?.fill(0);
    if (stagedHome) rmSync(stagedHome, { recursive: true, force: true });
    await reservation?.close(); secret.fill(0);
  }
}
