import { initOTel } from '@lattice/otel';
import { createLogger, createHttpLogger } from '@lattice/logger';
import { connect, consume, QUEUES } from '@lattice/queue';
import express from 'express';
import cron from 'node-cron';
import { env } from './config/env.config';
import { db } from './db/client';
import { rulesEvaluateConsumer } from './consumers/rules-evaluate.consumer';
import { telemetryTriggerConsumer } from './consumers/telemetry-trigger.consumer';
import { phaseAdvanceConsumer } from './consumers/phase-advance.consumer';
import { rulesEngine } from './services/rules.engine';
import { advanceDuePhases } from './services/phases.service';
import { fireDueScheduleTriggers } from './services/pipeline-triggers';
import {
  sweepUnconfirmedActions,
  sweepUnsettledCommands,
  reapSilentDevices,
} from './services/reconcile.service';
import { runCadenceTick, reapStale } from './services/retention-run';
import { retentionSweepConsumer } from './consumers/retention-sweep.consumer';
import { healthRouter } from './routes/health.routes';

const { metricsHandler } = initOTel('automation-worker');
const log = createLogger('automation-worker');

async function main() {
  await db.$connect();
  log.info('PostgreSQL connected');

  const ch = await connect(env.rabbitmqUrl);
  log.info('RabbitMQ connected');

  await consume(ch, QUEUES.RULES_EVALUATE, rulesEvaluateConsumer(ch));
  await consume(ch, QUEUES.TELEMETRY_ARRIVED_AUTOMATION, telemetryTriggerConsumer(ch));
  await consume(ch, QUEUES.BLUEPRINT_PHASE_ADVANCE, phaseAdvanceConsumer(ch));
  await consume(ch, QUEUES.RETENTION_SWEEP, retentionSweepConsumer());
  log.info('consumers started (rules-evaluate, telemetry-trigger, phase-advance, retention-sweep)');

  // Release any run a previous process died holding. Until this runs, a crash mid-sweep leaves
  // `lock_key` held and nothing — not the cron, not the interval rollup, not an Apply — can ever
  // claim again. The SHORT fuse here on purpose: this process is starting, so it is not executing
  // anything, and a run still `running` is one the previous process was killed in the middle of.
  await reapStale(new Date(), env.retention.startupGraceMs).catch((err) =>
    log.error({ err }, 'error reaping stale retention runs'),
  );

  cron.schedule('*/10 * * * * *', () => rulesEngine.evaluateScheduledRules(ch));
  log.info('scheduled rules cron started (every 10 seconds)');

  // The pipeline half of the same question. Shares the 10s tick because both match a MINUTE, and a
  // slower scan would miss one entirely; `min_interval_sec` on the trigger is what keeps a matching
  // minute from firing six times.
  cron.schedule('*/10 * * * * *', () => {
    fireDueScheduleTriggers(ch).catch((err) =>
      log.error({ err }, 'error firing scheduled pipeline triggers'),
    );
  });
  log.info('scheduled pipeline triggers cron started (every 10 seconds)');

  // Phase durations are hours at the shortest, so a minute of granularity is ample — and it
  // keeps the 10s rules pass free of a second query it would almost never act on.
  cron.schedule('0 * * * * *', () => advanceDuePhases(ch));
  log.info('blueprint phase auto-advance cron started (every minute)');

  // State reconciliation (F23). Slower than everything above by design: it exists to catch state
  // the platform has quietly been wrong about, and being wrong for five more minutes costs
  // nothing next to the message volume of asking constantly.
  if (env.reconcile.enabled) {
    cron.schedule(env.reconcile.cron, () => {
      sweepUnconfirmedActions(ch).catch((err) =>
        log.error({ err }, 'error sweeping unconfirmed actions'),
      );
      sweepUnsettledCommands(ch).catch((err) =>
        log.error({ err }, 'error settling stranded commands'),
      );
    });
    log.info({ cron: env.reconcile.cron }, 'state reconciliation cron started');
  } else {
    log.warn('state reconciliation disabled by RECONCILE_ENABLED=false');
  }

  // Liveness reaper. The Last-Will covers a disconnect the broker witnesses; this covers the one
  // it does not — a device losing power, which otherwise reads online forever.
  cron.schedule(env.liveness.cron, () => {
    reapSilentDevices(ch).catch((err) => log.error({ err }, 'error reaping silent devices'));
  });
  log.info({ cron: env.liveness.cron }, 'device liveness reaper cron started');

  // History retention (F18.1/F18.9/F18.17/F18.18), on ONE heartbeat that is the whole scheduler.
  //
  // There is deliberately no `cron.schedule` here any more. The four jobs — build, data sweep,
  // summary cleanup, orphan cleanup — each have their own row in `retention_schedule` that an admin
  // edits in the UI, and the tick below compares each one's last completion against its own previous
  // scheduled occurrence. Registering four node-cron tasks and re-registering them when a row
  // changed would have meant four things that can silently drift from the four rows that configured
  // them; this cannot drift, because there is nothing holding a copy.
  //
  // It is also the only reason a missed slot is survivable: node-cron is a wall-clock ticker with no
  // catch-up, so a worker restarting at 03:00 used to skip the night with nothing written anywhere
  // to say so.
  //
  // Every job claims through the same lock an Apply does, so no two ever overlap. One that loses the
  // claim skips rather than queuing — every window is computed from `now`, so the next tick does
  // whatever this one would have.
  if (env.retention.enabled) {
    cron.schedule(env.retention.tickCron, () => {
      runCadenceTick().catch((err: unknown) =>
        log.error({ err }, 'error on retention cadence tick'),
      );
    });
    // Once at startup too, so coming back up is enough to catch up — no waiting for the next tick
    // and no being lucky about restart timing.
    runCadenceTick().catch((err: unknown) =>
      log.error({ err }, 'error on startup retention cadence tick'),
    );
    log.info({ cron: env.retention.tickCron }, 'retention scheduler started');
  } else {
    log.warn('history retention disabled by RETENTION_ENABLED=false');
  }

  const app = express();
  app.use(createHttpLogger(log));
  app.use(healthRouter);
  app.get('/metrics', (req, res) => metricsHandler(req, res));
  app.listen(env.port, () => log.info({ port: env.port }, 'automation-worker listening'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
