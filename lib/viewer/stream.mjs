import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readSource } from './readers/local.mjs';
import { projectSources } from './projection.mjs';

const fingerprint = sources => createHash('sha256').update(JSON.stringify(sources.map(source => {
  const { observedAt, attemptedAt, ...content } = source;
  return content;
}))).digest('hex');

/** A disposable observation cache. It never owns a communication cursor or writes a source. */
export class ViewerModel extends EventEmitter {
  constructor(sources, { reader = readSource, projector = projectSources, pollMs = 750, ringSize = 128 } = {}) {
    super();
    this.specs = sources;
    this.reader = reader;
    this.projector = projector;
    this.pollMs = pollMs;
    this.ringSize = ringSize;
    this.instance = randomUUID();
    this.sequence = 0;
    this.epoch = 0;
    this.ring = [];
    this.sources = [];
    this.projection = { sources: [], rooms: [], messages: [], diagnostics: [] };
    this.closed = false;
  }
  get revision() { return `${this.instance}:${this.sequence}`; }
  async refresh() {
    if (this.pending) return this.pending;
    if (this.closed) return;
    this.pending = this.#refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  async #refresh() {
    const old = new Map(this.sources.map(source => [source.id, source]));
    const sources = await Promise.all(this.specs.map(async spec => {
      let source;
      try { source = await this.reader(spec); }
      catch { source = { id: spec.id, label: spec.label, available: false, error: 'Source read failed.', observedAt: null, events: [], store: {}, workers: [], diagnostics: [] }; }
      const previous = old.get(spec.id);
      // Retain the last successful observation when a source disappears. Missing is not failed delivery.
      if (!source.available && previous && (previous.generation || previous.available || previous.events?.length)) {
        return { ...previous, available: false, error: source.error, attemptedAt: source.observedAt, diagnostics: source.diagnostics };
      }
      return source;
    }));
    const hash = fingerprint(sources);
    const replaced = sources.some(source => old.get(source.id)?.generation && source.generation && old.get(source.id).generation !== source.generation);
    this.sources = sources;
    if (hash === this.hash) return;
    this.projection = this.projector(sources);
    this.hash = hash;
    if (replaced) this.epoch++;
    this.sequence++;
    const event = { id: this.revision, type: replaced ? 'reset' : 'change', data: { revision: this.revision, reason: replaced ? 'source-replaced' : sources.some(s => !s.available) ? 'source-unavailable' : 'observation-updated' } };
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emit('update', event);
  }
  snapshot() {
    return {
      revision: this.revision,
      sources: this.sources.map(({ id, label, available, observedAt, error, generation, diagnostics }) => {
        const projected = this.projection.sources?.find(source => source.id === id) || {};
        return { id, label, available, observedAt, error: error || null, generation, diagnostics: diagnostics || [], node: projected.node || null, eventCount: projected.eventCount || 0, workers: projected.workers || [] };
      }),
      rooms: this.projection.rooms,
      diagnostics: this.projection.diagnostics,
    };
  }
  replay(lastId) {
    if (lastId === this.revision) return [];
    const index = this.ring.findIndex(event => event.id === lastId);
    if (index >= 0) return this.ring.slice(index + 1);
    return [{ id: this.revision, type: 'reset', data: { revision: this.revision, reason: lastId ? 'history-expired-or-server-restarted' : 'initial-snapshot' } }];
  }
  start() {
    this.timer = setInterval(() => this.refresh().catch(() => this.emit('observationError')), this.pollMs);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
