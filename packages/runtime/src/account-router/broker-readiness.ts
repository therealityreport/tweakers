import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readRouterLaunchSelection } from "./config";
import { readAccountsBrokerSecret } from "./broker-socket";
import { assertPrivateRegularFile } from "./state-store";

/** Main-only diagnosis. Never return private paths or create missing state. */
export function readAccountsBrokerSetupState(root: string | null): "setup-required" | "registered" | "unavailable" {
  if (!root || !isAbsolute(root) || resolve(root) !== root) return "unavailable";
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) return "unavailable";
    for (const file of ["account-router-config.json", "control-secret.v1"]) {
      lstatSync(join(root, file));
    }
    assertPrivateRegularFile(join(root, "account-router-config.json"), 256 * 1024);
    if (readRouterLaunchSelection(join(root, "account-router-config.json")).config?.schemaVersion !== 3) return "unavailable";
    const secret = readAccountsBrokerSecret(root);
    if (!secret) return "unavailable";
    secret.fill(0);
    return "registered";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "setup-required" : "unavailable";
  }
}
