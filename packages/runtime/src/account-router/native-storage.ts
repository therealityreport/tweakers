import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAccountsBrokerSecret } from "./broker-socket";
import { readRouterLaunchSelection } from "./config";
import { NATIVE_HISTORY_SOURCE_FILE_V1, readAndPreflightNativeHistorySourceStaticV1 } from "./native-history";

/** Main-process read scope only; never changes execution or authentication homes. */
export function readNativeStorageHomeV1(stateRoot: string): string | null {
  if (!existsSync(join(stateRoot, NATIVE_HISTORY_SOURCE_FILE_V1))) return null;
  const config = readRouterLaunchSelection(join(stateRoot, "account-router-config.json")).config;
  if (config?.schemaVersion !== 3) throw new Error("Native storage source is unavailable.");
  const secret = readAccountsBrokerSecret(stateRoot);
  if (!secret) throw new Error("Native storage source is unavailable.");
  try {
    const result = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
    if (result.state !== "ready") throw new Error("Native storage source is unavailable.");
    const source = result.binding.source;
    const account = source.accounts.find((entry) => entry.opaqueAccountId === source.metadataAccountId);
    if (!account) throw new Error("Native storage source is unavailable.");
    return account.codexHome;
  } finally { secret.fill(0); }
}
