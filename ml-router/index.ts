// OTel first
import { startOtel } from '@lattice/otel';
startOtel('ml-router');

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

import config from './config/env.config';
import { createLogger } from '@lattice/logger';
import { db } from '@lattice/prisma-client';
import { loadModel, loadedModelKeys } from './handlers/vlm.handler';
import inferRoutes from './routes/infer.routes';
import { client } from './metrics';

const log = createLogger('ml-router');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));  // base64 frames can be large

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/infer', inferRoutes);

app.get('/api/models', async (_req, res) => {
  const models = await db.mlModel.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
  res.json(models.map((m) => ({
    id:          m.id,
    kind:        m.kind,
    name:        m.name,
    version:     m.version,
    description: m.description,
    loaded:      loadedModelKeys().includes(`${m.name}:${m.version}`),
  })));
});

app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    service:      'ml-router',
    uptime:       process.uptime(),
    models_loaded: loadedModelKeys(),
  });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ─── Startup: pre-warm registered VLM models ─────────────────────────────────

async function warmVlmModels(): Promise<void> {
  const vlmModels = await db.mlModel.findMany({ where: { kind: 'vlm' } });
  for (const m of vlmModels) {
    const modelCfg = (m.config ?? {}) as Record<string, unknown>;
    const classes  = (modelCfg.classes as string[]) ?? ['Unknown'];
    try {
      await loadModel(m.name, m.version, classes);
    } catch (err) {
      // Log and continue — model file may not be present in this environment
      log.warn({ name: m.name, version: m.version, err }, 'VLM model warm-up skipped (file missing)');
    }
  }
}

async function start(): Promise<void> {
  await warmVlmModels();

  app.listen(config.port, () => {
    log.info({ port: config.port, models: loadedModelKeys() }, 'ml-router started');
  });
}

start().catch((err) => {
  log.error(err, 'ml-router failed to start');
  process.exit(1);
});
