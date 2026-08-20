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
  log.info('consumers started (rules-evaluate, telemetry-trigger, phase-advance)');

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
