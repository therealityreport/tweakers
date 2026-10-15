import { createHash } from "node:crypto";

export const REVIEWED_STARTUP_POLICY_PATH = ".vite/build/startup-requirements-C6B1x9gL.js";
export const REVIEWED_STARTUP_POLICY_20398_PATH = ".vite/build/startup-requirements-CYrrMBwA.js";
const REVIEWED_HASHES: Readonly<Record<string,string>> = {
  [REVIEWED_STARTUP_POLICY_PATH]: "73f93b81152bff48cd27bcebcf27c430fb763e5c7418c67824950f4092ba933d",
  [REVIEWED_STARTUP_POLICY_20398_PATH]: "ec6518de6f43d8247ae39bae82a348e345674e979b8990c40b8dbf7b1e908cd4",
};
const legacyEdits = [
  ["Object.assign(process.env,l.userEnv)", "(Object.assign(process.env,l.userEnv),globalThis.__tweakersVerifiedBackendPathV1&&(process.env.CODEX_CLI_PATH=globalThis.__tweakersVerifiedBackendPathV1))"],
  ["await i.a(a,c.app.getVersion(),{signOut:e,timeoutMs:Math.max(1,Math.min(3e4,s-performance.now()))})", "await (globalThis.__tweakersStartupPolicyV1?globalThis.__tweakersStartupPolicyV1.run(()=>i.a(a,c.app.getVersion(),{signOut:e,timeoutMs:Math.max(1,Math.min(3e4,s-performance.now()))})):i.a(a,c.app.getVersion(),{signOut:e,timeoutMs:Math.max(1,Math.min(3e4,s-performance.now()))}))"],
  ["o.n().warning(`Desktop startup policy read failed`,{safe:{reason:n,phase:f,attempt:a,retrying:p}})", "(o.n().warning(`Desktop startup policy read failed`,{safe:{reason:n,phase:f,attempt:a,retrying:p}}),globalThis.__tweakersStartupPolicyV1?.diagnostic({reason:n,phase:f,attempt:a,retrying:p}))"],
] as const;
// Only the main-owned signed extension can enlarge the original combined 180s
// windows. A missing/throwing/invalid hint leaves every native timer intact.
const timeoutHint = "(()=>{try{let t=globalThis.__tweakersStartupPolicyV1?.preparationTimeoutMs?.();return Number.isSafeInteger(t)&&t>18e4&&t<=6e5?t:null}catch{return null}})()";
const policyCall = "i.a(a,c.app.getVersion(),{signOut:e,timeoutMs:Math.max(1,Math.min(__tweakersStartupBudgetV1??3e4,s-performance.now()))})";
const edits = [
  legacyEdits[0],
  [legacyEdits[1][0], `await (globalThis.__tweakersStartupPolicyV1?globalThis.__tweakersStartupPolicyV1.run(()=>${policyCall}):${policyCall})`],
  legacyEdits[2],
  ["let e=!1,t=!1,r=!1,a=0,s=null,l=null;", `let e=!1,t=!1,r=!1,a=0,s=null,l=null,__tweakersStartupBudgetV1=${timeoutHint},__tweakersStartupDeadlineV1=null;`],
  ["let a=await fa(l);", "let a=await fa(l,__tweakersStartupBudgetV1==null?void 0:(__tweakersStartupDeadlineV1??=performance.now()+__tweakersStartupBudgetV1));"],
  ["s??=performance.now()+6e4", "s??=__tweakersStartupDeadlineV1??performance.now()+6e4"],
  ["async function fa(e){let t=12e4,n=performance.now(),r;", "async function fa(e,__tweakersStartupDeadlineV1){if(__tweakersStartupDeadlineV1!==void 0&&performance.now()>=__tweakersStartupDeadlineV1)throw new i.n(`timeout`);let t=__tweakersStartupDeadlineV1===void 0?12e4:Math.max(1,__tweakersStartupDeadlineV1-performance.now()),n=performance.now(),r;"],
  ["e=!0,a=0,s=null;continue", "e=!0,a=0,s=null,__tweakersStartupDeadlineV1=null;continue"],
  ["e=h==null&&te===1,a=0,s=null,f!==`preparation`", "e=h==null&&te===1,a=0,s=null,__tweakersStartupDeadlineV1=null,f!==`preparation`"],
] as const;
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

/** Only the exact reviewed policy carriers may use the main-owned bridge. */
export function patchReviewedStartupPolicySource(source: string, carrierPath: string = REVIEWED_STARTUP_POLICY_PATH): { source: string; changed: boolean } {
  const pristineHash = REVIEWED_HASHES[carrierPath];
  if (!pristineHash) throw new Error("Native startup policy carrier is not reviewed");
  const recover = (pairs: readonly (readonly [string, string])[]) => {
    let original = source, patched = 0;
    for (const [before, after] of pairs) {
      if (!original.includes(after)) continue;
      if (original.split(after).length !== 2) throw new Error("Ambiguous startup policy repair");
      original = original.replace(after, () => before); patched++;
    }
    return { original, patched };
  };
  const current = recover(edits);
  if (current.patched === edits.length && hash(current.original) === pristineHash) return { source, changed: false };
  let original: string;
  if (current.patched === 0 && hash(source) === pristineHash) original = source;
  else {
    const legacy = recover(legacyEdits);
    if (legacy.patched !== legacyEdits.length || hash(legacy.original) !== pristineHash) throw new Error("Native startup policy carrier is not reviewed");
    original = legacy.original;
  }
  let result = original;
  for (const [before, after] of edits) {
    if (result.split(before).length !== 2) throw new Error("Native startup policy anchor changed");
    result = result.replace(before, () => after);
  }
  return { source: result, changed: true };
}
