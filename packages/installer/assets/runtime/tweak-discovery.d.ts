import { type TweakManifest } from "@therealityreport/tweakers-sdk";
export interface DiscoveredTweak {
    dir: string;
    entry: string;
    manifest: TweakManifest;
}
export interface TweakDiscoveryOptions {
    runtimeVersion?: string;
    onInvalid?: (directory: string, reason: string) => void;
}
export declare function discoverTweaks(tweaksDir: string, options?: TweakDiscoveryOptions): DiscoveredTweak[];
