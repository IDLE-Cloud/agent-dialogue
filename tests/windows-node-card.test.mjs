import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, readStore, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode, signObject } from '../lib/node-identity.mjs';
import { exportNode, pairPeer } from '../lib/nodes.mjs';

test('signed peer directories are canonical on their owning OS, independent of the importing OS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ad-card-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { stateDir: join(root, 'source') }, target = { stateDir: join(root, 'target') };
  const node = await loadOrCreateNode(source);
  await withStore(source, store => createBinding(store, { alias: 'windows', harness: 'opencode-v1', sessionId: 'ses_windows', projectId: 'global', directory: 'D:\\Tools\\project', serviceId: 'native-windows', origin: 'http://127.0.0.1:1234' }));
  const card = await exportNode(source);
  const route = { kind: 'ssh', destination: 'windows-test', shell: 'powershell', executable: 'D:/node.exe', args: ['D:/app/cli.mjs'], stateDir: 'D:/state' };
  await pairPeer(target, card, route);
  assert.equal((await readStore(target)).bindings.windows.directory, 'D:\\Tools\\project');
  for (const directory of ['D:relative', 'D:\\Tools\\..\\project', '/work/../project', 'relative', 'D:\\Tools\nproject']) {
    const invalid = signObject(node, { ...card.payload, bindings: [{ ...card.payload.bindings[0], directory }] });
    await assert.rejects(pairPeer(target, invalid, route), /directory must be absolute/);
  }
  const unix = signObject(node, { ...card.payload, bindings: [{ ...card.payload.bindings[0], alias: 'unix', id: 'b_12345678-1234-1234-1234-123456789abc', directory: '/work/project' }] });
  await pairPeer(target, unix, route);
  assert.equal((await readStore(target)).bindings.unix.directory, '/work/project');
});
