import type { RetentionSweepRequestedPayload } from '@lattice/queue';
import { createLogger } from '@lattice/logger';
import { execute } from '../services/retention-run';

const log = createLogger('automation-worker');

// An out-of-band retention sweep was asked for (F18.13/F18.15).
//
// The payload names a `retention_runs` row and nothing else. `execute` re-reads `scope_user_id`
// from that row, so whose data gets deleted is decided by the API when it claimed the run, not by
// anything that arrived over the wire — a forged or replayed message can at worst re-poke a run
// that already exists, and the compare-and-set inside `execute` makes even that a no-op.
//
// Errors are re-thrown so `consume()` nacks to the DLQ per repo convention. The run row already
// carries the readable error by then, so the failure is visible on the job-history page whether or
// not anyone ever looks in the dead-letter queue.
export function retentionSweepConsumer() {
  return async (payload: RetentionSweepRequestedPayload): Promise<void> => {
    log.info({ runId: payload.runId, trigger: payload.trigger }, 'retention sweep requested');
    await execute(payload.runId);
  };
}
