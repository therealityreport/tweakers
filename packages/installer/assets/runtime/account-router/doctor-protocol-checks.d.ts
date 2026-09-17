/** Exercises production routing and correlation without an account, filesystem writes, or backend calls. */
export declare function runDoctorProtocolAdapterChecks(contracts: ReadonlyArray<{
    method: string;
    direction: "client" | "server" | "notification";
}>): Array<{
    method: string;
    passed: boolean;
    summary: string;
}>;
