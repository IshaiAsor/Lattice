// OTel must be first
import { startOtel } from '@lattice/otel';
startOtel('device-gateway');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import config from './config/env.config';
import { createLogger } from '@lattice/logger';
import { consume, QUEUES, connectQueue } from '@lattice/queue';
import type { ActionDispatchPayload } from '@lattice/queue';
import { errorHandler } from './middlewares/exception.middleware';
import { mqttService, MqttService } from './services/mqtt.service';
import { deviceCache } from './dal/device.cache';

import provisioningRoutes  from './routes/provisioning.routes';
import deviceConfigRoutes  from './routes/device.config.routes';
import cameraRoutes        from './routes/camera.routes';

const log = createLogger('device-gateway');
const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));  // camera frames can be large
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'device-gateway', uptime: process.uptime() });
});

app.use('/api/provision', provisioningRoutes);
app.use('/api/config',    deviceConfigRoutes);
app.use('/api/camera',    cameraRoutes);

app.use(errorHandler);

// ─── RabbitMQ action.dispatch consumer ───────────────────────────────────────

async function startActionDispatchConsumer(): Promise<void> {
  await consume<ActionDispatchPayload>(QUEUES.actionDispatch, async (payload, _headers, ack, nack) => {
    try {
      const { userId, userDeviceId, mqttType, mqttName, value } = payload;

      // Resolve mac_id + firmware version for this device
      const { db } = await import('@lattice/prisma-client');
      const row = await db.userDevice.findUnique({
        where: { id: userDeviceId },
        select: { mac_id: true, device_model: { select: { version: true } } },
      });
      const macId   = row?.mac_id ?? null;
      const version = row?.device_model?.version ?? null;

      if (!macId) {
        log.warn({ userDeviceId }, 'Cannot dispatch — device mac_id not found');
        ack();
        return;
      }

      // For capability-scoped dispatches, resolve to specific MQTT type/name
      if (mqttType === 'capability') {
        const action = await deviceCache.resolveAction(userDeviceId, mqttName).catch(() => null);
        if (action?.mqttType && action.mqttName) {
          mqttService.publish(MqttService.commandTopic(userId, macId, version, action.mqttType, action.mqttName), value);
        }
      } else {
        mqttService.publish(MqttService.commandTopic(userId, macId, version, mqttType, mqttName), value);
      }

      ack();
    } catch (err) {
      log.error(err, 'action.dispatch consumer error');
      nack(false); // send to DLQ
    }
  });

  log.info('action.dispatch consumer started');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await connectQueue();
  await startActionDispatchConsumer();

  mqttService.connect();

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'device-gateway started');
  });
}

start().catch((err) => {
  log.error(err, 'device-gateway failed to start');
  process.exit(1);
});
