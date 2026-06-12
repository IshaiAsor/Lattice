// OTel must be initialised before any other import
import { startOtel } from '@lattice/otel';
startOtel('lattice-api');

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import http from 'http';

import config from './config/env.config';
import socketService from './services/socket.service';
import { createLogger } from '@lattice/logger';
import { errorHandler } from './middlewares/exception.middleware';

// Routes
import authRoutes          from './routes/auth.routes';
import deviceMgmtRoutes    from './routes/device.mgmt.routes';
import actionsMgmtRoutes   from './routes/actions.mgmt.routes';
import rulesRoutes         from './routes/rules.routes';
import emergencyRoutes     from './routes/emergency.routes';
import pipelineRoutes      from './routes/pipeline.routes';
import adminCatalogRoutes  from './routes/admin.catalog.routes';
import blueprintRoutes     from './routes/blueprints.routes';
import aiRulesRoutes      from './routes/ai.rules.routes';
import provisioningRoutes  from './routes/provisioning.routes';

// Google vocab read-only routes (for admin UI — trait/type lookup)
import googleActionsTypesRoutes  from './routes/google.actions.types.routes';
import googleActionsTraitsRoutes from './routes/google.actions.traits.routes';

const log = createLogger('lattice-api');
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

socketService.init(server);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'lattice-api', version: process.env.npm_package_version, uptime: process.uptime() });
});

// User/admin API
app.use('/api/auth',             authRoutes);
app.use('/api/mgmt/devices',     deviceMgmtRoutes);
app.use('/api/mgmt/actions',     actionsMgmtRoutes);
app.use('/api/rules',            rulesRoutes);
app.use('/api/emergency',        emergencyRoutes);
app.use('/api/pipelines',        pipelineRoutes);
app.use('/api/admin/catalog',    adminCatalogRoutes);
app.use('/api',                  blueprintRoutes);
app.use('/api/ai',               aiRulesRoutes);
app.use('/api/provisioning',     provisioningRoutes);

// Google vocab (read-only admin UI helpers) — TODO Phase 6: move to google-home-service
app.use('/api/google/actions/types',  googleActionsTypesRoutes);
app.use('/api/google/actions/traits', googleActionsTraitsRoutes);

// Global error handler — must be last middleware
app.use(errorHandler);

server.listen(config.port, () => {
  log.info({ port: config.port }, 'Lattice API started');
});

server.on('error', (err) => {
  log.error(err, 'Server error');
  process.exit(1);
});
