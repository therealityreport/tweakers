export function isUpdateRecoveryV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWEAKERS_UPDATE_RECOVERY_V2 !== "0";
}
