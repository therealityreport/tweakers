/** Fixed owner-private reason codes. Never accept provider errors or account values. */
export const BROKER_ADMISSION_STAGES_V1 = [
  "pool-lease", "pool-closed", "pool-account", "pool-factory", "pool-capacity", "pool-child-identity", "pool-factory-exception",
  "factory-handoff", "factory-native-binding", "factory-execution-home", "factory-service", "factory-history", "factory-continuity",
  "factory-arguments", "factory-mode", "factory-plan", "factory-resolver", "factory-child",
  "ledger-unavailable", "ledger-source", "ledger-hydration", "account-plan", "account-session", "service-create", "service-final-authority",
] as const;
export type BrokerAdmissionStageV1 = typeof BROKER_ADMISSION_STAGES_V1[number];
export function brokerAdmissionStageV1(value: unknown): BrokerAdmissionStageV1 | undefined {
  return typeof value === "string" && (BROKER_ADMISSION_STAGES_V1 as readonly string[]).includes(value) ? value as BrokerAdmissionStageV1 : undefined;
}
