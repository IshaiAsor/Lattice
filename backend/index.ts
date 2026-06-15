import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import config from './config/env.config';
import deviceMgmtRoutes from './routes/device.mgmt.routes';
import actionsMgmtRoutes from './routes/actions.mgmt.routes';
import googleRoutes from './routes/google.routes';
import authRoutes from './routes/auth.routes';
import provisioningRoutes from './routes/provisioning.routes';
import googleActionsTypesRoutes from './routes/google.actions.types.routes';
import googleActionsTraitsRoutes from './routes/google.actions.traits.routes';
import googleSmartHomeRoutes from './routes/google.smarthome.routes';
import deviceConfigurationRoutes from './routes/device.configuration.routes';
import userRulesRoutes from './routes/user.rules.routes';
import adminDeviceConfigRoutes from './routes/admin.device.config.routes';
import cameraRoutes from './routes/camera.routes';
import vlmRoutes from './routes/vlm.routes';
import emergencyRoutes from './routes/emergency.routes';
import { rulesEngineService } from './services/rules.engine.service';
import { sensorHistoryRepository } from './dal/sensor.history.repository';
import cron from 'node-cron';
import http from 'http';
import socketService from './services/socket.service';
import wsStreamService from './services/ws.stream.service';
import { redisService } from './services/redis.service';

const app = express();
app.set('trust proxy', 1); // trust Traefik ingress X-Forwarded-For header
const server = http.createServer(app);
wsStreamService.init(server);
socketService.init(server);

// Pre-parser debug logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] DEBUG: ${req.method} ${req.url}`);
  next();
});

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Post-parser debug logging
app.use((req, _res, next) => {
  if (req.method === 'POST' && !req.is('image/*')) {
    console.log(`[${new Date().toISOString()}] DEBUG: Parsed Body:`, JSON.stringify(req.body));
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/mgmt/devices',  deviceMgmtRoutes);
app.use('/api/mgmt/actions', actionsMgmtRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/provisioning', provisioningRoutes);
app.use('/api/google/actions/types', googleActionsTypesRoutes);
app.use('/api/google/actions/traits', googleActionsTraitsRoutes);
app.use('/api/google/smarthome', googleSmartHomeRoutes);
app.use('/api/device', deviceConfigurationRoutes);
app.use('/api/rules', userRulesRoutes);
app.use('/api/device-config', adminDeviceConfigRoutes);
app.use('/api/camera', cameraRoutes);
app.use('/api/vlm', vlmRoutes);
app.use('/api/emergency', emergencyRoutes);


const rootDir = process.cwd();
const publicPath = path.join(rootDir, 'dist', 'public');

if (fs.existsSync(publicPath)) {
  console.log(`✅ Serving static files from: ${publicPath}`);
  app.use(express.static(publicPath));

  app.use((_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
} else {
  console.log('ℹ️ Static "public" folder not found. Running in API-only mode.');

  app.get('/', (_req, res) => {
    res.send('Smart Home API is running. (Angular UI not found in dist/public)');
  });
}

async function startServer() {
  redisService.connect();
  cron.schedule('* * * * *', () => rulesEngineService.evaluateScheduledRules());


  // Prune sensor history older than 30 days (runs daily at midnight)
  cron.schedule('0 0 * * *', () =>
    sensorHistoryRepository.pruneOlderThan(30).catch(err =>
      console.error('[SensorHistory] Prune error:', err)
    )
  );

  server.listen(config.port, () => {
    console.log(`🚀 Smart Home Server running on port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
