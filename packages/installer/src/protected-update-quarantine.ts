import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installer bridge to the one protected-bootstrap quarantine authority.
 * It deliberately does not duplicate marker parsing or policy: generated
 * runtime packaging supplies the same reviewed bootstrap module the protected
 * loader uses. No marker means an ordinary, unprotected installation.
 */
export function assertInstallerUpdateQuarantineClear(userRoot: string, route: string): void {
  const protectedRoot = join(userRoot, "transactions", "protected");
  if (!existsSync(protectedRoot)) return;
  const status = lstatSync(protectedRoot);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Protected update quarantine authority directory is unsafe");
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const bootstrapPath = join(here, "..", "assets", "runtime", "protected-bootstrap.js");
  const bootstrap = createRequire(import.meta.url)(bootstrapPath) as {
    assertProtectedUpdateQuarantine?: (input: { authorityRoot: string; route: string }) => void;
  };
  if (typeof bootstrap.assertProtectedUpdateQuarantine !== "function") {
    throw new Error("Protected update quarantine authority is unavailable");
  }
  bootstrap.assertProtectedUpdateQuarantine({ authorityRoot: userRoot, route });
}
