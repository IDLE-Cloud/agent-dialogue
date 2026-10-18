import { basename, resolve } from 'node:path';
import { createViewer } from './server.mjs';
import { readViewerConfig, registerSources } from './config.mjs';

export async function viewerOptions(args, defaultState) {
  const inputs = [];
  let port = 0, seenPort = false, seenConfig = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--source') {
      const separator = value.indexOf('=');
      if (separator < 1 || separator === value.length - 1) throw new Error('--source requires LABEL=PATH.');
      const label = value.slice(0, separator), path = resolve(value.slice(separator + 1));
      if (label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Source label must be 1–64 printable characters.');
      inputs.push({ label, path });
    } else if (flag === '--config') {
      if (seenConfig) throw new Error('--config must occur once.');
      seenConfig = true;
      inputs.push(...await readViewerConfig(value));
    } else if (flag === '--port') {
      if (seenPort || !/^\d{1,5}$/.test(value) || +value > 65535) throw new Error('--port must occur once, with an integer from 0 to 65535.');
      seenPort = true; port = +value;
    } else throw new Error(`Unknown viewer option: ${flag}`);
  }
  if (!inputs.length) inputs.push({ label: basename(defaultState) || 'Current space', path: defaultState });
  const sources = await registerSources(inputs);
  return { sources, port };
}

export async function runViewer(args, context) {
  const options = await viewerOptions(args, context.stateDir);
  const viewer = await createViewer(options);
  console.log(`Read-only agent dialogue viewer\n${viewer.url}\nSources: ${options.sources.map(source => source.label).join(', ')}\nPress Ctrl+C to close the viewer. Agent communication continues independently.`);
  for (const source of viewer.model.snapshot().sources) if (!source.available) console.error(`${source.label}: ${source.error}`);
  return await new Promise(resolveExit => {
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      await viewer.close();
      resolveExit(0);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });
}
