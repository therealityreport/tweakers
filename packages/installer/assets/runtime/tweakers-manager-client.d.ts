import { type DoctorActionRequestV1, type DoctorReportV1, type TweakersManagerSection } from "@therealityreport/tweakers-sdk";
declare const PUBLIC_STATUS_ACTION_IDS: readonly ["refresh.injected", "refresh.independent"];
export type TweakersManagerPublicStatusActionId = typeof PUBLIC_STATUS_ACTION_IDS[number];
type TweakersManagerPublicStartActionId = "refresh.injected" | "refresh.independent";
export interface TweakersManagerClientDependencies {
    homeDirectory(): string;
    readText(path: string): string;
    execute(executable: string, args: readonly string[], input?: string): string;
    spawnDetached(executable: string, args: readonly string[]): void;
    createId(): string;
    now(): number;
}
export interface TweakersManagerStatus {
    stateToken: string;
    status: {
        environment?: {
            officialApp?: {
                state?: string;
                appPath?: string | null;
                bundleId?: string | null;
            };
        };
        chatgptAppUpdate?: unknown;
        tweakersPatch?: unknown;
        updater?: unknown;
    };
    actions: Array<{
        actionId: TweakersManagerPublicStatusActionId;
        available: boolean;
        reason: string;
    }>;
}
/**
 * This private manager capability is the only discovery path for the fixed
 * source-sealing prerequisite. It deliberately is not represented in the
 * generic public status action list.
 */
export interface TweakersManagerOfficialSourceRegistration {
    stateToken: string;
    officialSourceRegistration: {
        actionId: "official-source.register";
        available: boolean;
        reason: string;
    };
}
export declare function createTweakersManagerClient(overrides?: Partial<TweakersManagerClientDependencies>): {
    readStatus: () => TweakersManagerStatus;
    startAction: (actionId: TweakersManagerPublicStartActionId) => {
        started: true;
        operationId: string;
    };
    readOfficialSourceRegistration: () => TweakersManagerOfficialSourceRegistration;
    startOfficialSourceRegistration: () => {
        started: true;
        operationId: string;
    };
    readDoctor: () => DoctorReportV1;
    doctorAction: (input: DoctorActionRequestV1) => DoctorReportV1;
    openManager: (section?: TweakersManagerSection) => void;
    openDoctor: () => void;
};
export declare function readTweakersDoctor(): DoctorReportV1;
export declare function runTweakersDoctorAction(input: DoctorActionRequestV1): DoctorReportV1;
export declare function openTweakersManager(section?: TweakersManagerSection): void;
export declare function openTweakersDoctor(): void;
export declare function readTweakersManagerStatus(): TweakersManagerStatus;
export declare function startTweakersManagerAction(actionId: TweakersManagerPublicStartActionId): {
    started: true;
    operationId: string;
};
export declare function readTweakersManagerOfficialSourceRegistration(): TweakersManagerOfficialSourceRegistration;
export declare function startTweakersManagerOfficialSourceRegistration(): {
    started: true;
    operationId: string;
};
export {};
