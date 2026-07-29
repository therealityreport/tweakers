import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const name of ["promotion-policy.js", "main.js"]) {
  const built = fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
  const source = readFileSync(built, "utf8");
  if (source.includes("@therealityreport/tweakers-sdk")) {
    throw new Error(`Built standalone runtime must not require the SDK: ${name}`);
  }
  if (!source.includes("fingerprintPromotionPolicyPath")) {
    throw new Error(`Built runtime is missing its policy fingerprint entrypoint: ${name}`);
  }
}
