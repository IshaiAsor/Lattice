// OTel first
import { startOtel } from '@lattice/otel';
startOtel('google-home');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import config from './config/env.config';
import { createLogger } from '@lattice/logger';
import { connectQueue, consume, QUEUES } from '@lattice/queue';
import type { DeviceStateChangedPayload } from '@lattice/queue';
import { errorHandler } from './middlewares/exception.middleware';
import { reportState } from './services/homegraph.service';

import oauthRoutes      from './routes/oauth.routes';
import smarthomeRoutes  from './routes/smarthome.routes';

const log = createLogger('google-home');
const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'google-home', uptime: process.uptime() });
});

// OAuth 2.0 account linking flow
app.use('/', oauthRoutes);

// Google Home webhook (SYNC/QUERY/EXECUTE)
app.use('/smarthome', smarthomeRoutes);

app.use(errorHandler);

// ─── device.state.changed consumer → HomeGraph reportState ───────────────────

async function startConsumer(): Promise<void> {
  await consume<DeviceStateChangedPayload>(
    QUEUES.deviceStateChanged,
    async (payload, _headers, ack, nack) => {
      try {
        const { userId, userDeviceId, userActionId, value } = payload;
        if (userActionId && value !== undefined) {
          await reportState(userId, userDeviceId, userActionId, value);
        }
        ack();
      } catch (err) {
        log.error(err, 'device.state.changed handler failed');
        nack(false);
      }
    },
    /* prefetch */ 5,
  );
  log.info('device.state.changed consumer started');
}

async function start(): Promise<void> {
  await connectQueue();
  await startConsumer();

  app.listen(config.port, () => {
    log.info({ port: config.port }, 'google-home service started');
  });
}

start().catch((err) => {
  log.error(err, 'google-home failed to start');
  process.exit(1);
});
