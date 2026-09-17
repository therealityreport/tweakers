export interface DoctorAuthInspection {
    state: "ready" | "reconnect_required" | "blocked";
    fingerprint: string;
    accounts: {
        accountId: string;
        label: string;
    }[];
}
export declare function inspectNativeAuthenticationAtRoot(root: string): DoctorAuthInspection;
/** The login callback must finish and reap its child before returning. */
export declare function reconnectNativeAuthenticationAtRoot(input: {
    root: string;
    accountId: string;
    expectedFingerprint: string;
    login: (stagedHome: string) => Promise<void>;
    prepareDesktop?: () => Promise<void>;
}): Promise<DoctorAuthInspection>;
