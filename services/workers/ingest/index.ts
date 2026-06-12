// OTel first
import { startOtel } from '@lattice/otel';
startOtel('ingest-worker');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });
import { createLogger } from '@lattice/logger';
import { connectQueue, consume, publish, QUEUES, RK } from '@lattice/queue';
import type { TelemetryArrivedPayload } from '@lattice/queue';
import { db } from '@lattice/prisma-client';
import { emitActionStateUpdate } from '../shared/socket.emitter';

const log = createLogger('ingest-worker');

async function handleTelemetry(
  payload: TelemetryArrivedPayload,
  ack: () => void,
  nack: (requeue?: boolean) => void,
): Promise<void> {
  const { userId, userDeviceId, userActionId, capability, value, timestamp, traceId } = payload;

  try {
    // 1. Write current state to DB (authoritative — device-gateway wrote to Valkey optimistically)
    await db.userAction.update({
      where: { id: userActionId },
      data: { state: value, updated_at: new Date() },
    });

    // 2. Write sensor reading history
    await db.sensorReading.create({
      data: {
        user_action_id: userActionId,
        value,
        recorded_at: new Date(timestamp),
      },
    });

    // 3. Emit confirmed state update to Angular (post-DB-write — authoritative confirmation)
    emitActionStateUpdate(userId, userActionId, value);

    // 4. Fan-out to downstream workers (fire-and-forget, failures handled by DLQ)
    await Promise.all([
      publish(RK.rulesEvaluate(userId),       { userId, traceId }),
      publish(RK.deviceStateChanged(userId),  { userId, userDeviceId, userActionId, value, traceId }),
    ]);

    ack();
    log.debug({ userId, userActionId, capability, value }, 'telemetry ingested');
  } catch (err) {
    log.error(err, 'ingest failed');
    nack(false); // send to DLQ
  }
}

async function start(): Promise<void> {
  await connectQueue();

  await consume<TelemetryArrivedPayload>(
    QUEUES.telemetryArrived,
    (payload, _headers, ack, nack) => handleTelemetry(payload, ack, nack),
    /* prefetch */ 10,
  );

  log.info('ingest-worker started');
}

start().catch((err) => {
  log.error(err, 'ingest-worker failed to start');
  process.exit(1);
});
