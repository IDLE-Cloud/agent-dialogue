import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameImmutable } from '../lib/atomic-rename.mjs';
const keys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-publication-'));t.after(() => rm(root, { recursive: true, force: true }));
  const source=join(root,'candidate'), destination=join(root,'current');
  await writeFile(source,'candidate');await writeFile(destination,'before');
  const info=await lstat(destination,{bigint:true});
  return {source,destination,expectedDestination:Object.fromEntries(keys.map(k=>[k,info[k]]))};
}
test('immutable publication rejects a destination changed after its caller captured the intended preimage', async t => {
  const f=await fixture(t);await writeFile(f.destination,'operator-third-image');
  await assert.rejects(renameImmutable(f.source,f.destination,{expectedDestination:f.expectedDestination}),{code:'ATOMIC_RENAME_DESTINATION_CHANGED'});
  assert.equal(await readFile(f.destination,'utf8'),'operator-third-image');assert.equal(await readFile(f.source,'utf8'),'candidate');
});
test('immutable publication with an absent preimage never adopts an already created destination', async t => {
  const f=await fixture(t);
  await assert.rejects(renameImmutable(f.source,f.destination,{expectedDestination:null}),{code:'ATOMIC_RENAME_DESTINATION_CHANGED'});
  assert.equal(await readFile(f.destination,'utf8'),'before');
});
test('explicit immutable destination evidence supports one accurate publication and rejects Number identities', async t => {
  const f=await fixture(t);await renameImmutable(f.source,f.destination,{expectedDestination:f.expectedDestination});assert.equal(await readFile(f.destination,'utf8'),'candidate');
  await writeFile(f.source,'another');
  await assert.rejects(renameImmutable(f.source,f.destination,{expectedDestination:Object.fromEntries(keys.map(k=>[k,Number(f.expectedDestination[k])]))}),{code:'ATOMIC_RENAME_OPTIONS_INVALID'});
});
test('immutable publication also fixes the verified candidate before an asynchronous publication gate', async t => {
  const f = await fixture(t), info = await lstat(f.source, { bigint: true });
  const expectedSource = Object.fromEntries(keys.map(key => [key, info[key]]));
  await writeFile(f.source, 'altered candidate after verification');
  await assert.rejects(renameImmutable(f.source, f.destination, { expectedSource, expectedDestination: f.expectedDestination }), { code: 'ATOMIC_RENAME_SOURCE_CHANGED' });
  assert.equal(await readFile(f.destination, 'utf8'), 'before');
  assert.equal(await readFile(f.source, 'utf8'), 'altered candidate after verification');
});
