/** One dependency inventory per owned operation, plus one final drift check. */
export function createOperationDependencyIdentity(readIdentity) {
  let value;
  return {
    get() { return value ??= readIdentity(); },
    assertUnchanged() {
      if (value !== undefined && readIdentity() !== value) {
        throw new Error('Dependencies changed during owned work; reusable receipts were not published');
      }
    },
  };
}
