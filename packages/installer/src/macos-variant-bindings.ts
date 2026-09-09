// Signed wrapper bindings are data only. Keep them independent of installer
// asset discovery so compatibility checks can run in the sealed manager.
const DIRECTORY = "tweakers";
export const TWEAKERS_VARIANT_USER_DATA_CONFIG = `${DIRECTORY}/variant-user-data-path`;
export const TWEAKERS_VARIANT_CODEX_HOME_CONFIG = `${DIRECTORY}/variant-codex-home-path`;
export const TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG = `${DIRECTORY}/variant-accounts-broker-root`;
