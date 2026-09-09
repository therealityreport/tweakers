export declare const ACCOUNTS_TRANSFER_RECOVERY_FILE = "accounts-transfer-recovery.v1.json";
/** A prepared recovery runtime can read both formats but need not enable new transfers. */
export interface AccountsTransferRecoveryReceiptV1 {
    version: 1;
    readerVersion: 2;
    supportedTransferVersions: [1, 2];
    sourceRetirementReaderVersion: 2;
    supportedSourceRetirementVersions: [2];
    runtimeTransferSha256: string;
    runtimeSourceRetirementSha256: string;
    recoveryRuntimeRoot: string;
    recoveryFingerprint: string;
    validationSha256: string;
    sourceRuntimeFingerprint: string;
    sourceRuntimeFileCount: number;
    verifiedAt: string;
}
/**
 * This is checked before the first v2 publication and every later preparation.
 * Missing, replaced or incompatible recovery artifacts keep transfer held.
 * It never edits a user home or imports code from a caller-selected directory.
 */
export declare function verifyAccountsTransferRecovery(runtimeRoot: string): boolean;
