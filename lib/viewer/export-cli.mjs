import { isAbsolute } from 'node:path';
import { readSource } from './readers/local.mjs';
import { validateObservationRequest, exportObservation } from './observation.mjs';

/** Fixed SSH entry point: one bounded request in, one scoped JSON snapshot out. */
export async function runObservationExport(args, input = process.stdin, output = process.stdout) {
  const invalid = () => { throw new Error('Invalid read-only observation request or unavailable pinned source.'); };
  try {
    if (args.length !== 2 || args[0] !== '--state-dir' || typeof args[1] !== 'string' || !isAbsolute(args[1]) || Buffer.byteLength(args[1]) > 4096 || /[\x00-\x1f\x7f]/.test(args[1])) invalid();
    let size = 0; const chunks = [];
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 16384) invalid();
      chunks.push(bytes);
    }
    const request = validateObservationRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    const source = await readSource({ id: 'remote', label: 'Remote observation', path: args[1] });
    const response = `${JSON.stringify(exportObservation(source, request))}\n`;
    if (Buffer.byteLength(response) > 16 * 1024 * 1024) invalid();
    await new Promise((done, reject) => output.write(response, error => error ? reject(error) : done()));
    return 0;
  } catch { invalid(); }
}
