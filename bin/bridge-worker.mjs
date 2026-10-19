#!/usr/bin/env node
import { openSync, writeSync, closeSync, lstatSync } from 'node:fs';
import { parseWorkerArguments, loadWindowsWorkerConfig, applyWindowsWorkerEnvironment, cleanupWindowsWorker } from '../lib/windows-worker.mjs';

const { bindingId, token, launchConfigPath } = parseWorkerArguments(process.argv.slice(2));
let fd;
try {
  if (launchConfigPath) {
    if (process.platform !== 'win32') throw new Error('Scheduled-task launch configurations require Windows.');
    const config = await loadWindowsWorkerConfig(launchConfigPath, { bindingId, token });
    applyWindowsWorkerEnvironment(config.env);
    try {
      const info = lstatSync(config.logPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Worker log must be a regular file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fd = openSync(config.logPath, 'a', 0o600);
    const redirect = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      callback?.(); return true;
    };
    process.stdout.write = redirect; process.stderr.write = redirect;
  }
  const { runWorker } = await import('../lib/bridge.mjs');
  await runWorker(bindingId, token);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
} finally {
  if (launchConfigPath && process.platform === 'win32') {
    try { await cleanupWindowsWorker(bindingId, token, { launchConfigPath }); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
  if (fd !== undefined) closeSync(fd);
}
