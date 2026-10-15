import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationDependencyIdentity } from './operation-dependency-identity.mjs';

test('owned work inventories dependencies once and checks drift once before publication', () => {
  let reads = 0;
  const memo = createOperationDependencyIdentity(() => { reads++; return 'verified'; });
  for (let index=0; index<12; index++) assert.equal(memo.get(),'verified');
  assert.equal(reads,1);
  memo.assertUnchanged();
  assert.equal(reads,2);
});
test('changed dependency identity prevents reuse and unused operations do not scan', () => {
  let value = 'before', reads = 0;
  const memo = createOperationDependencyIdentity(() => { reads++; return value; });
  memo.assertUnchanged();
  assert.equal(reads,0);
  memo.get();
  value = 'after';
  assert.throws(()=>memo.assertUnchanged(),/Dependencies changed/);
});
