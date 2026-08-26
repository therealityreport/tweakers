/**
 * Pure User Questions promotion self-test predicates.
 *
 * The live candidate probe (main.ts) and the repository test that pins the
 * canonical tweak sources both run EXACTLY these functions. That lockstep is
 * the point: when the enhancement protocol migrates (as it did to the
 * session-model claim response), a contract change that only lands on one
 * side fails `npm test` immediately instead of surfacing days later as a
 * live "candidate health: promotion proof fail" refusal that blocks every
 * reload (candidate refusal 2026-08-25).
 */

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UserQuestionsLifecycleModule {
  start?: unknown;
  stop?: unknown;
}

export interface UserQuestionsBrokerModule {
  createEnhancementClaimResponse(claim: unknown): Record<string, unknown>;
}

export interface UserQuestionsSchemaModule {
  validateAskInput(value: unknown): { ok: boolean };
}

export function userQuestionsMainLifecycleSelfTest(lifecycle: UserQuestionsLifecycleModule): boolean {
  return typeof lifecycle.start === "function" && typeof lifecycle.stop === "function";
}

/**
 * The session-model claim response echoes both fingerprints and mints a fresh
 * session id; it deliberately does not echo the claim id, and a malformed
 * claim must throw.
 */
export function userQuestionsBrokerSelfTest(broker: UserQuestionsBrokerModule): boolean {
  const response = broker.createEnhancementClaimResponse({
    version: 1,
    type: "claim",
    id: "promotion-health",
    route_fingerprint: FINGERPRINT_A,
    input_fingerprint: FINGERPRINT_B,
  });
  let rejectedMalformed = false;
  try { broker.createEnhancementClaimResponse({}); } catch { rejectedMalformed = true; }
  return response.version === 1 && response.type === "claimed"
    && response.route_fingerprint === FINGERPRINT_A
    && response.input_fingerprint === FINGERPRINT_B
    && typeof response.session_id === "string"
    && UUID_PATTERN.test(response.session_id)
    && rejectedMalformed;
}

export function userQuestionsSchemaSelfTest(schema: UserQuestionsSchemaModule): boolean {
  const valid = schema.validateAskInput({
    round_id: "promotion-health",
    questions: [{
      id: "choice",
      header: "Promotion health",
      question: "Does the native decision schema accept this round?",
      selection_mode: "single",
      options: [
        { id: "yes", label: "Yes (Recommended)", description: "Accept the canonical schema.", recommended: true },
        { id: "no", label: "No", description: "Reject the canonical schema." },
      ],
      allow_other: true,
    }],
  });
  const invalid = schema.validateAskInput({ round_id: "promotion-health", questions: [] });
  return valid.ok === true && invalid.ok === false;
}
