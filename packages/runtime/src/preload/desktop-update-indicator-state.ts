export interface DesktopUpdateIndicatorState {
  status?: string;
  latest?: { marketingVersion?: string | null; build?: string | null };
  nativeUpdateControlActive?: boolean;
}

export function shouldShowDesktopUpdateIndicator(state: DesktopUpdateIndicatorState | null): boolean {
  return state?.status === "update-available" && state.nativeUpdateControlActive !== true;
}

export function desktopUpdateIndicatorIdentity(state: DesktopUpdateIndicatorState): string {
  return [state.latest?.marketingVersion ?? "unknown", state.latest?.build ?? "unknown"].join(":");
}
