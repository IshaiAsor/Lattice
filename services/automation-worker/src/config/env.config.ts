export const env = {
  port: parseInt(process.env['PORT'] ?? '3008', 10),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  otelEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
  rabbitmqUrl: process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
  // State reconciliation (F23): periodically ask devices what state they are actually in, because
  // a command action's stored state is only ever as true as the last ack the platform happened
  // to see.
  reconcile: {
    enabled: process.env['RECONCILE_ENABLED'] !== 'false',
    cron: process.env['RECONCILE_CRON'] ?? '0 */5 * * * *',
    // How stale a confirmation may get before the action is worth re-reading.
    windowMs: parseInt(process.env['RECONCILE_WINDOW_MS'] ?? '1800000', 10),
    // How recently a device must have been heard from to be worth asking at all. `online` alone
    // is not enough: nothing marks a device offline if it dies without delivering its LWT.
    livenessMs: parseInt(process.env['RECONCILE_LIVENESS_MS'] ?? '300000', 10),
    // Ceiling on reads per pass, and the gap between them. Together they keep a 20-action device
    // from being read 20× at once and bound the pass well inside its own interval.
    batchSize: parseInt(process.env['RECONCILE_BATCH_SIZE'] ?? '50', 10),
    spacingMs: parseInt(process.env['RECONCILE_SPACING_MS'] ?? '200', 10),
    // A command sitting unsettled longer than this is presumed lost: it is marked timed out and
    // its action re-read. Comfortably past digest's own ack budget so the two never race.
    settleWindowMs: parseInt(process.env['RECONCILE_SETTLE_WINDOW_MS'] ?? '120000', 10),
  },
  // Nightly history pass (F18.1): fold raw readings into every configured rollup tier, then prune
  // whatever is past each tier's own window. The windows, the tier sizes and the tier COUNT are NOT
  // here — they live in retention_policy_tiers and the four scope tables (F18.9), so an owner
  // changes them in the UI and the next pass picks it up without a redeploy. What stays here is the
  // shape of the job, not the policy it enforces.
  retention: {
    enabled: process.env['RETENTION_ENABLED'] !== 'false',
    // 03:00, the quietest hour — but since F18.18 this is only the FALLBACK.
    //
    // The real schedules live in `retention_schedule`, four rows an admin edits in the UI, because
    // when the pass runs is as much a product decision as how long rows are kept and an env var
    // means a redeploy plus no record of what the policy was. This value seeds those rows in the
    // migration and is used at runtime only when a row is missing or its expression will not parse:
    // a schedule nobody can read must not silently mean no cleanup at all.
    cron: process.env['RETENTION_CRON'] ?? '0 0 3 * * *',
    // How late a job may start and still be recorded as its scheduled run rather than a `catchup`.
    //
    // The tick fires once a minute, so a pass is routinely a few seconds past its slot; calling that
    // a catch-up would make the label meaningless. Five minutes is comfortably more than the tick
    // plus the longest sweep ever observed here (19s), and comfortably less than any real outage.
    onTimeGraceMs: parseInt(process.env['RETENTION_ON_TIME_GRACE_MS'] ?? '300000', 10),
    // The heartbeat. Since F18.18 it is not a helper beside a cron — it IS the retention scheduler:
    // every minute it asks each of the four jobs whether it is past its own last due slot. Cheap by
    // construction — a handful of small reads and pure arithmetic — and it does nothing at all
    // unless something is overdue.
    tickCron: process.env['RETENTION_TICK_CRON'] ?? '0 * * * * *',
    // Floor under the derived rollup interval. A 60-second custom bucket is admissible, and
    // someone will make one; without this it would turn the sweep into permanent background load.
    rollupMinIntervalMs: parseInt(process.env['RETENTION_ROLLUP_MIN_INTERVAL_MS'] ?? '300000', 10),
    // A backstop, and since F18.18 nothing more.
    //
    // F18.17 used this fixed 25h fuse to decide the nightly pass had been missed, which was correct
    // only while the schedule was a constant. The moment an admin can choose it, a constant fuse
    // silently overrides them: a weekly schedule would be upgraded to daily, and switching a job off
    // would hold for 25 hours and then run anyway. "Late" is now measured against each job's OWN
    // previous occurrence, which is exact for any expression. This survives for the case where no
    // job has a usable schedule at all.
    maxPassAgeMs: parseInt(process.env['RETENTION_MAX_PASS_AGE_MS'] ?? '90000000', 10),
    // How far back a single pass will look for buckets to build. Bounds a first run against years
    // of accumulated history; because the upserts are idempotent, successive nights walk backward
    // on their own rather than needing one heroic pass.
    lookbackDays: parseInt(process.env['RETENTION_LOOKBACK_DAYS'] ?? '3', 10),
    // Ceiling on raw rows read per action per pass, so one chatty sensor cannot make the rollup
    // unbounded.
    rowsPerAction: parseInt(process.env['RETENTION_ROWS_PER_ACTION'] ?? '20000', 10),
    // Ceiling on rows deleted per kind per pass. The remainder goes tomorrow — being a night late
    // costs nothing next to holding a lock over a million rows while rules are evaluating.
    deleteBatch: parseInt(process.env['RETENTION_DELETE_BATCH'] ?? '50000', 10),
    // Rows per DELETE statement (F18.10). `deleteBatch` alone only decided whether a delete
    // STARTED, not how big it was — Prisma's deleteMany has no LIMIT, so one user with millions of
    // expired rows still deleted them in a single statement holding one long lock. This is the size
    // of each bounded chunk; the loop repeats until the batch cap is spent or nothing is left.
    deleteChunk: parseInt(process.env['RETENTION_DELETE_CHUNK'] ?? '5000', 10),
    // A run still queued/running after this is presumed abandoned by a killed worker and released.
    // Without it, one crash mid-sweep holds `lock_key` forever and nothing can ever claim again.
    runStaleMs: parseInt(process.env['RETENTION_RUN_STALE_MS'] ?? '21600000', 10),
    // The same reaper, run once AT STARTUP with a far shorter fuse.
    //
    // A process that is starting cannot be executing a run, so a run left `running` is almost
    // certainly one this pod was killed in the middle of. Six hours was a defensible fuse when the
    // only casualty was one missed night; since F18.17 that same held lock also stops every
    // interval rollup, so a crash would freeze every chart's right-hand edge until the fuse burned
    // down. Observed exactly that on 2026-08-27 when the Docker daemon restarted mid-pass.
    //
    // Ten minutes and not zero because `replicas: 1` with the default RollingUpdate strategy still
    // means two pods exist briefly, and reaping a sweep the OUTGOING pod is genuinely running would
    // release the lock for a second, concurrent prune — the one thing the lock exists to prevent.
    // The overlap is bounded by readiness plus the termination grace (seconds); the longest sweep
    // ever observed here is 19s. If a deployment ever runs sweeps longer than this, raise it.
    startupGraceMs: parseInt(process.env['RETENTION_STARTUP_GRACE_MS'] ?? '600000', 10),
    // One user-triggered sweep per user per this window. Without it, "Apply now" is a free
    // denial-of-service on a worker every other user shares.
    userSweepCooldownMs: parseInt(process.env['RETENTION_USER_COOLDOWN_MS'] ?? '900000', 10),
  },
  // Liveness reaper: mark a device offline once it has missed enough heartbeats. The LWT covers a
  // clean disconnect; this covers power loss, where no will is ever delivered.
  liveness: {
    cron: process.env['LIVENESS_REAP_CRON'] ?? '0 * * * * *',
    // Firmware heartbeats every 60s, so this is three missed beats before we call it.
    timeoutMs: parseInt(process.env['LIVENESS_TIMEOUT_MS'] ?? '195000', 10),
  },
};
