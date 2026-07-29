export interface DesktopVersionIdentity {
  marketingVersion: string | null;
  build: string | null;
}

export type DesktopVersionComparison = "newer" | "not-newer" | "unknown";

/**
 * Sparkle build numbers are authoritative whenever either side reports one.
 * Marketing versions are a fallback only for older snapshots where both build
 * numbers are absent. Incomplete or malformed identities are never guessed.
 */
export function compareDesktopVersionIdentity(
  baseline: DesktopVersionIdentity,
  observed: DesktopVersionIdentity,
): DesktopVersionComparison {
  if (baseline.build !== null || observed.build !== null) {
    const buildComparison = compareNumericDotted(baseline.build, observed.build);
    if (buildComparison === null) return "unknown";
    return buildComparison < 0 ? "newer" : "not-newer";
  }

  const marketingComparison = compareNumericDotted(
    baseline.marketingVersion,
    observed.marketingVersion,
  );
  if (marketingComparison === null) return "unknown";
  return marketingComparison < 0 ? "newer" : "not-newer";
}

/**
 * Fast-path payload reuse requires both the marketing version and build to be
 * present, numeric, and equal. A missing field is unknown rather than equal.
 */
export function desktopVersionIdentityEqual(
  left: DesktopVersionIdentity,
  right: DesktopVersionIdentity,
): boolean | null {
  const marketingComparison = compareNumericDotted(
    left.marketingVersion,
    right.marketingVersion,
  );
  const buildComparison = compareNumericDotted(left.build, right.build);
  if (marketingComparison === null || buildComparison === null) return null;
  return marketingComparison === 0 && buildComparison === 0;
}

/** Backward-compatible boolean form used by transaction gates. */
export function desktopVersionAdvanced(
  baseline: DesktopVersionIdentity,
  observed: DesktopVersionIdentity,
): boolean {
  return compareDesktopVersionIdentity(baseline, observed) === "newer";
}

function compareNumericDotted(leftValue: string | null, rightValue: string | null): number | null {
  if (!leftValue || !rightValue) return null;
  const left = leftValue.trim().split(".");
  const right = rightValue.trim().split(".");
  if (!left.length
    || !right.length
    || !left.every(isDecimalSegment)
    || !right.every(isDecimalSegment)) {
    return null;
  }
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
