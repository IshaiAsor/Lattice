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
import http from 'http';
import socketService from './services/socket.service';
import { redisService } from './services/redis.service';

const app = express();
const server = http.createServer(app);
socketService.init(server);

// Debug logging middleware - MOVED TO TOP
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] DEBUG: ${req.method} ${req.url}`);
  next();
});

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: '*/*' })); // Catch everything else as text

// Post-parser debug logging
app.use((req, res, next) => {
  if (req.method === 'POST') {
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

// 404 Logger - Catch anything that didn't match the routes above
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    console.log(`[${new Date().toISOString()}] ⚠️ 404 - API Route Not Found: ${req.method} ${req.url}`);
    return res.status(404).json({ error: `API route ${req.method} ${req.url} not found` });
  }
  next();
});

const rootDir = process.cwd();
const publicPath = path.join(rootDir, 'dist', 'public');

if (fs.existsSync(publicPath)) {
  console.log(`✅ Serving static files from: ${publicPath}`);
  app.use(express.static(publicPath));

  app.use((req: express.Request, res: express.Response) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
} else {
  console.log('ℹ️ Static "public" folder not found. Running in API-only mode.');

  app.get('/', (req, res) => {
    res.send('Smart Home API is running. (Angular UI not found in dist/public)');
  });
}

async function startServer() {
  redisService.connect();
  server.listen(config.port, () => {
    console.log(`🚀 Smart Home Server running on port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
