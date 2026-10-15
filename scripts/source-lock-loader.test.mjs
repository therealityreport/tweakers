import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from './source-lock-loader.mjs';

test('source bootstrap resolves the shared lock without requiring compiled SDK output', () => {
  const parentURL = new URL('../packages/installer/src/process-lock.ts',import.meta.url).href;
  const resolution = resolve('@therealityreport/tweakers-sdk/dist/process-lock.js',{parentURL},()=>assert.fail('SDK dist must not be consulted'));
  assert.equal(resolution.url,new URL('../packages/sdk/src/process-lock.ts',import.meta.url).href);
  assert.equal(resolution.shortCircuit,true);
});
test('published and unrelated imports retain ordinary resolution', () => {
  let calls=0;
  const next=()=>{calls++;return {url:'normal'};};
  assert.equal(resolve('@therealityreport/tweakers-sdk/dist/process-lock.js',{parentURL:'file:///published/dist/process-lock.js'},next).url,'normal');
  assert.equal(calls,1);
});
