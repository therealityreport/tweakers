/** Exact recorded interim 0.6.0 generation: receipt said v3, producer emitted v2. */
export const KNOWN_SCHEMA2_PREDECESSOR = {
  schemaVersion: 2,
  packageVersion: "0.6.0",
  lifecycleSchemaVersion: 3,
  policyVersion: "strict-detached-v5",
  matcherRegistryVersion: "mcp-family-descriptors-v6",
  labels: ["com.thomashulihan.codex-mcp-idle-reaper", "com.thomashulihan.codex-mcp-guard"],
  compatibility: "current labels and paths preserved; rename deferred",
  assetDigests: {
    "lifecycle-module": "2fb31ecc76cb74ffb913eb2fe67a1ae18a039930636da6510c8070f659dc2a77",
    "idle-reaper": "a1f0c4abcb4d68037cbddbc78c4219c57cb78bb13faed6003f206029b0247eee",
    guard: "4dd0c66dd2c22d8fd4d5f32500fea124c2f07eaf4a061851fe35a9f0d47457ba",
    "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
    "guard-launch-agent": "bc31a9b5fc1975c34cb2963398b4bb4eea3c07894dd1389509d2d0f86ae8b887",
  },
} as const;

export function isKnownSchema2Predecessor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  for (const key of ["schemaVersion", "packageVersion", "lifecycleSchemaVersion", "policyVersion", "matcherRegistryVersion", "compatibility"] as const) {
    if (receipt[key] !== KNOWN_SCHEMA2_PREDECESSOR[key]) return false;
  }
  if (!Array.isArray(receipt.labels) || receipt.labels.length !== KNOWN_SCHEMA2_PREDECESSOR.labels.length
    || receipt.labels.some((label, index) => label !== KNOWN_SCHEMA2_PREDECESSOR.labels[index])) return false;
  const digests = receipt.assetDigests;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)) return false;
  const entries = Object.entries(digests);
  return entries.length === Object.keys(KNOWN_SCHEMA2_PREDECESSOR.assetDigests).length
    && entries.every(([id, digest]) => KNOWN_SCHEMA2_PREDECESSOR.assetDigests[id as keyof typeof KNOWN_SCHEMA2_PREDECESSOR.assetDigests] === digest);
}
