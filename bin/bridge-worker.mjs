#!/usr/bin/env node
import { runWorker } from '../lib/bridge.mjs';
const [id, flag, token] = process.argv.slice(2);
if (!/^b_[A-Za-z0-9_-]+$/.test(id || '') || flag !== '--token' || !token) throw new Error('Expected binding ID and worker token.');
await runWorker(id, token);
