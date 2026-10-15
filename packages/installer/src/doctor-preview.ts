/**
 * Independent preview packages violate the shared desktop/capacity boundary.
 * Keep the API as an explicit refusal for older Doctor clients; executable
 * acceptance belongs to the guarded update, with the installed fallback held.
 */
export async function openDoctorPreview(_root: string, _expectedReport: string, _side: "before" | "after"): Promise<void> {
  throw new Error("Separate executable previews are disabled by the one-desktop/two-copy policy. Review the retained comparison evidence; executable checks run only during the final guarded Tweakers update.");
}
