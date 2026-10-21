import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/vps-remote-helper.mjs', import.meta.url));
const runId = 'vps-integration-20990101-v1';
const model = { providerID: 'opencode', id: 'synthetic-free-model' };

async function runHelper(request) {
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic helper timeout.')); }, 5000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); done({ code, response: JSON.parse(Buffer.concat(chunks).toString('utf8')), diagnostics }); });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'synthetic-tool', 'bin', 'agent-dialogue.mjs');
  const modulePath = join(dirname(dirname(cli)), 'lib', 'opencode.mjs');
  const logPath = join(root, 'synthetic-requests.jsonl');
  const workspace = join(root, 'owned project #one&two?plus+');
  const expected = `/api/model?${new URLSearchParams({ 'location[directory]': workspace })}`;
  await mkdir(dirname(modulePath), { recursive: true });
  // A local fake module records requests. It never contacts an OpenCode server.
  await writeFile(modulePath, `
    import { appendFile } from 'node:fs/promises';
    export class OpenCodeClient {
      static async discover() { return new OpenCodeClient(); }
      async request(method, path) {
        await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ method, path }) + '\\n');
        if (method !== 'GET' || path !== ${JSON.stringify(expected)}) throw new Error('Expected exact owned workspace model catalog.');
        return { data: [{ ...${JSON.stringify(model)}, enabled: true,
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] };
      }
      async createSession(options) {
        await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ operation: 'createSession', model: options.model, directory: options.location.directory }) + '\\n');
        return { id: 'ses_syntheticOwnedCatalog', location: options.location, model: options.model };
      }
    }
  `);
  return { root, logPath, expected, config: {
    executable: process.execPath, cli, stateDir: join(root, 'owned-state'), cacheDir: join(root, 'cache'),
    serviceFile: join(root, 'synthetic-service.json'), workspace, path: '/usr/bin:/bin', peerSshDestination: 'synthetic-peer',
  } };
}

test('VPS helper model listing scopes and encodes the exact owned workspace catalog', async t => {
  const f = await fixture(t);
  const result = await runHelper({ version: 1, runId, config: f.config, operation: 'models' });
  assert.equal(result.code, 0, 'Scoped synthetic catalog succeeds');
  assert.equal(result.response.ok, true);
  assert.equal(result.response.result[0].id, model.id);
  const calls = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [{ method: 'GET', path: f.expected }]);
  const url = new URL(calls[0].path, 'http://synthetic.invalid');
  assert.equal(url.pathname, '/api/model');
  assert.equal(url.searchParams.get('location[directory]'), f.config.workspace);
  assert.deepEqual([...url.searchParams.keys()], ['location[directory]']);
});

test('VPS helper repeats the same exact scoped catalog check before creating its owned chat', async t => {
  const f = await fixture(t);
  const result = await runHelper({ version: 1, runId, config: f.config, operation: 'create-session', model });
  assert.equal(result.code, 0, 'Scoped synthetic creation succeeds');
  assert.equal(result.response.ok, true);
  assert.equal(result.response.result.id, 'ses_syntheticOwnedCatalog');
  const calls = (await readFile(f.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    { method: 'GET', path: f.expected },
    { operation: 'createSession', model, directory: f.config.workspace },
  ]);
  const saved = JSON.parse(await readFile(join(f.config.stateDir, 'vps-acceptance-scope.json'), 'utf8'));
  assert.equal(saved.workspace, f.config.workspace); assert.equal(saved.sessionId, 'ses_syntheticOwnedCatalog');
});
