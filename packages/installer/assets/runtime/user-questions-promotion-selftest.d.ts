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
export interface UserQuestionsLifecycleModule {
    start?: unknown;
    stop?: unknown;
}
export interface UserQuestionsBrokerModule {
    createEnhancementClaimResponse(claim: unknown): Record<string, unknown>;
}
export interface UserQuestionsSchemaModule {
    validateAskInput(value: unknown): {
        ok: boolean;
    };
}
export declare function userQuestionsMainLifecycleSelfTest(lifecycle: UserQuestionsLifecycleModule): boolean;
/**
 * The session-model claim response echoes both fingerprints and mints a fresh
 * session id; it deliberately does not echo the claim id, and a malformed
 * claim must throw.
 */
export declare function userQuestionsBrokerSelfTest(broker: UserQuestionsBrokerModule): boolean;
export declare function userQuestionsSchemaSelfTest(schema: UserQuestionsSchemaModule): boolean;
