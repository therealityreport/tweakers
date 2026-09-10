/** Main-only diagnosis. Never return private paths or create missing state. */
export declare function readAccountsBrokerSetupState(root: string | null): "setup-required" | "registered" | "unavailable";
