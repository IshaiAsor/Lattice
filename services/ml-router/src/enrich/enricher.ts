import type { ChatIntentPayload, ChatMessage } from '@lattice/ml';

// Enrichment gathers context (sensor readings, device state, conversation history)
// and returns system messages to prepend before inference. The data SOURCE is not yet
// decided (dedicated sensor-data service vs ingest service) — see the project memos.
// Keep this interface as the seam: do NOT hardcode reads against any data source here.
export interface Enricher {
  enrich(intent: ChatIntentPayload): Promise<ChatMessage[]>;
}

// Stub until the sensor-data source lands. A no-op pass-through (returns no extra context),
// so chat orchestration works end-to-end today and enrichment can be wired in later.
export class NoopEnricher implements Enricher {
  async enrich(_intent: ChatIntentPayload): Promise<ChatMessage[]> {
    return [];
  }
}

const noop = new NoopEnricher();

// Named enrichers referenced by plans.json enrich stages. All stubbed for now.
const ENRICHERS: Record<string, Enricher> = {
  'device-context': noop,
  'build': noop,
};

export function getEnricher(name: string): Enricher {
  return ENRICHERS[name] ?? noop;
}
