// Out-of-band sweeps and their history (F18.13/F18.14/F18.15).
//
// Never inline in the request: a sweep deletes millions of rows, no HTTP timeout survives that,
// a client retry would try to start a second one, and `api` is the request-serving process whose
// connection pool every user shares.

import { publish, RK } from '@lattice/queue';
import { db } from '../db';
import { getChannel } from '../queue';
import { claim } from './retention-claim';
import { previewSweep } from './retention-preview';
import { retentionActivityService } from './retention-activity.service';

export const retentionSweepsService = {
  // ── Sweeps ────────────────────────────────────────────────────────────────

  /**
   * Ask the worker to sweep now (F18.13/F18.15).
   *
   * **`scopeUserId` is a parameter, never a body field.** The user route passes `req.user!.id`
   * positionally and the admin route passes `null`; there is nothing a request can send that
   * reaches it. The queue message carries only the run id — the worker re-reads the scope from the
   * row this insert created.
   *
   * Out of band rather than inline because it deletes millions of rows: no HTTP timeout survives
   * that, a client retry would try to start a second sweep, and `api` is the request-serving
   * process whose connection pool every user shares.
   */
  async requestSweep(
    trigger: 'admin' | 'user',
    requestedByUserId: number,
    scopeUserId: number | null,
  ) {
    const runId = await claim({ trigger, requestedByUserId, scopeUserId });
    await retentionActivityService.record({
      action: 'sweep_requested',
      scope: scopeUserId === null ? 'platform' : 'user',
      actorKind: trigger === 'admin' ? 'admin' : 'user',
      actorUserId: requestedByUserId,
      subjectUserId: scopeUserId,
      summary:
        scopeUserId === null
          ? 'requested a platform-wide sweep'
          : 'requested a sweep of their own data',
      runId,
    });
    publish(await getChannel(), RK.RETENTION_SWEEP_REQUESTED, { runId, trigger });
    return this.run(scopeUserId, runId);
  },

  /** What a sweep would delete, without deleting it — so the dialog names real numbers. */
  async preview(scopeUserId: number | null) {
    return previewSweep(scopeUserId);
  },

  /** Job history. A user only ever sees their own runs — a platform run's counters are everyone's. */
  async runs(scopeUserId: number | null, limit = 50) {
    const rows = await db.retentionRun.findMany({
      where: scopeUserId === null ? {} : { scope_user_id: scopeUserId },
      orderBy: { queued_at: 'desc' },
      take: Math.min(limit, 200),
      include: {
        kinds: true,
        requested_by: { select: { id: true, full_name: true, email: true } },
      },
    });
    return rows.map(runView);
  },

  async run(scopeUserId: number | null, runId: number) {
    const row = await db.retentionRun.findUnique({
      where: { id: runId },
      include: {
        kinds: true,
        requested_by: { select: { id: true, full_name: true, email: true } },
      },
    });
    if (!row) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
    // A user may not read a platform run: its counters are the whole platform's data volumes.
    if (scopeUserId !== null && row.scope_user_id !== scopeUserId)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    return runView(row);
  },
};

interface RunRow {
  id: number;
  trigger: string;
  status: string;
  phase: string | null;
  scope_user_id: number | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  requested_by: { id: number; full_name: string | null; email: string } | null;
  kinds: {
    data_kind: string;
    buckets_written: number;
    rows_deleted: number;
    bytes_reclaimed: bigint;
    bytes_estimated: boolean;
  }[];
}

function runView(r: RunRow) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    phase: r.phase,
    scoped: r.scope_user_id !== null,
    requestedBy: r.requested_by ? (r.requested_by.full_name ?? r.requested_by.email) : null,
    queuedAt: r.queued_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
    durationMs: r.duration_ms,
    error: r.error,
    kinds: r.kinds.map((k) => ({
      dataKind: k.data_kind,
      bucketsWritten: k.buckets_written,
      rowsDeleted: k.rows_deleted,
      // BigInt does not survive JSON.stringify; the figure is bytes, so a Number is exact well past
      // any volume this platform will hold.
      bytesReclaimed: Number(k.bytes_reclaimed),
      bytesEstimated: k.bytes_estimated,
    })),
    // Totals, so the page does not have to sum them and disagree with itself.
    rowsDeleted: r.kinds.reduce((n, k) => n + k.rows_deleted, 0),
    bytesReclaimed: r.kinds.reduce((n, k) => n + Number(k.bytes_reclaimed), 0),
  };
}
