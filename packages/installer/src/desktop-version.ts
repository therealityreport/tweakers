export interface DesktopVersionIdentity {
  marketingVersion: string | null;
  build: string | null;
}

/**
 * Build numbers are the authoritative ordering when both sides expose one;
 * marketing versions only decide when a build is unreadable. An unreadable or
 * non-numeric pair is never treated as advancement.
 */
export function desktopVersionAdvanced(
  baseline: DesktopVersionIdentity,
  observed: DesktopVersionIdentity,
): boolean {
  const buildComparison = compareNumericVersion(baseline.build, observed.build);
  if (buildComparison !== null) return buildComparison < 0;
  const marketingComparison = compareNumericVersion(baseline.marketingVersion, observed.marketingVersion);
  return marketingComparison !== null && marketingComparison < 0;
}

export function compareNumericVersion(baseline: string | null, observed: string | null): number | null {
  if (!baseline || !observed) return null;
  const left = baseline.trim().split(".");
  const right = observed.trim().split(".");
  if (!left.length || !right.length || !left.every(isDecimalSegment) || !right.every(isDecimalSegment)) return null;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = BigInt(left[index] ?? "0");
    const b = BigInt(right[index] ?? "0");
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function isDecimalSegment(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}
