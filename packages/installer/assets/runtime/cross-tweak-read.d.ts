type Handler = (...args: unknown[]) => unknown;
export declare function sanitizeProfilesReadResponse(value: unknown): unknown;
export declare function dispatchCrossTweakRead(requester: unknown, target: unknown, action: unknown, message: unknown, lookup: (tweakId: string, channel: string) => Handler | undefined): Promise<unknown>;
export declare const crossTweakReadPolicy: {
    readonly profilesTweak: "co.tweakers.thread-summary-profiles";
    readonly followupTweak: "co.tweakers.followup";
    readonly projectsTweak: "co.tweakers.projects";
    readonly action: "profiles.read";
    readonly followupAction: "followup.policy.read";
};
export {};
