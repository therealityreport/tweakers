type TextDirection = "forward" | "backward" | "none";
export interface TweakReloadFocusSnapshot {
    document: Document;
    element: HTMLElement;
    selection: {
        kind: "control";
        start: number;
        end: number;
        direction: TextDirection;
    } | {
        kind: "contenteditable";
        anchor: number;
        focus: number;
    } | null;
}
export declare function captureTweakReloadFocus(document: Document): TweakReloadFocusSnapshot | null;
export declare function restoreTweakReloadFocus(snapshot: TweakReloadFocusSnapshot | null): boolean;
export {};
