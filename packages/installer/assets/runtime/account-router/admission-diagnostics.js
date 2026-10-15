"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROKER_ADMISSION_STAGES_V1 = void 0;
exports.brokerAdmissionStageV1 = brokerAdmissionStageV1;
/** Fixed owner-private reason codes. Never accept provider errors or account values. */
exports.BROKER_ADMISSION_STAGES_V1 = [
    "pool-lease", "pool-closed", "pool-account", "pool-factory", "pool-capacity", "pool-child-identity", "pool-factory-exception",
    "factory-handoff", "factory-native-binding", "factory-execution-home", "factory-service", "factory-history", "factory-continuity",
    "factory-arguments", "factory-mode", "factory-plan", "factory-resolver", "factory-child",
    "ledger-unavailable", "ledger-source", "ledger-hydration", "account-plan", "account-session", "service-create", "service-final-authority",
];
function brokerAdmissionStageV1(value) {
    return typeof value === "string" && exports.BROKER_ADMISSION_STAGES_V1.includes(value) ? value : undefined;
}
//# sourceMappingURL=admission-diagnostics.js.map