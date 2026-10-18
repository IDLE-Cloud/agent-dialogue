import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/vps-remote-helper.mjs', import.meta.url));
const runId = 'vps-integration-20990101-v1';
const sessionId = 'ses_syntheticOwnedHelper';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'tool', 'bin', 'agent-dialogue.mjs');
  const modulePath = join(dirname(dirname(cli)), 'lib', 'opencode.mjs');
  const logPath = join(root, 'synthetic-api.jsonl');
  const config = { executable: process.execPath, cli, stateDir: join(root, 'state'),
    cacheDir: join(root, 'cache'), serviceFile: join(root, 'synthetic-service.json'),
    workspace: join(root, 'owned-project'), path: '/usr/bin:/bin', peerSshDestination: 'synthetic-peer' };
  await mkdir(dirname(modulePath), { recursive: true });
  await mkdir(config.stateDir);
  await writeFile(join(config.stateDir, 'vps-acceptance-scope.json'), JSON.stringify({ runId, workspace: config.workspace, sessionId }));
  await writeFile(modulePath, `
    import { appendFile } from 'node:fs/promises';
    export class OpenCodeClient {
      static async discover() { return new OpenCodeClient(); }
      async messages(id, options) {
        await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ operation: 'messages', id, limit: options.limit }) + '\\n');
        if (id !== ${JSON.stringify(sessionId)} || options.limit !== 100) throw new Error('Synthetic API requires owned session and page limit 100.');
        return [{ id: 'msg_synthetic', sessionID: id, type: 'user' }];
      }
      async request(method, path, body) {
        await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ method, path, body }) + '\\n');
        if (method !== 'POST' || path !== ${JSON.stringify(`/api/session/${sessionId}/interrupt?resume=false`)} || body !== undefined) throw new Error('Synthetic API requires interrupt without resuming queued input.');
        return { interrupted: true };
      }
    }
  `);
  async function run(operation) {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [helper], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic helper timeout.')); }, 5000);
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); done({ code, response: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
      child.stdin.end(JSON.stringify({ version: 1, runId, config, operation }) + '\n');
    });
    const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    return { ...result, calls };
  }
  return { run };
}

test('VPS helper reads only its owned session with a V2-compatible bounded message limit', async t => {
  const f = await fixture(t); const result = await f.run('messages');
  assert.equal(result.code, 0); assert.equal(result.response.ok, true);
  assert.deepEqual(result.calls, [{ operation: 'messages', id: sessionId, limit: 100 }]);
  assert.equal(result.response.result[0].sessionID, sessionId);
});

test('VPS helper abort operation interrupts only its owned session without resuming queued work', async t => {
  const f = await fixture(t); const result = await f.run('abort');
  assert.equal(result.code, 0); assert.equal(result.response.ok, true);
  assert.deepEqual(result.calls, [{ method: 'POST', path: `/api/session/${sessionId}/interrupt?resume=false` }]);
});
