export interface DesktopUpdateIndicatorState {
    status?: string;
    latest?: {
        marketingVersion?: string | null;
        build?: string | null;
    };
    nativeUpdateControlActive?: boolean;
}
export declare function shouldShowDesktopUpdateIndicator(state: DesktopUpdateIndicatorState | null): boolean;
export declare function desktopUpdateIndicatorIdentity(state: DesktopUpdateIndicatorState): string;
