import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import inferRoutes from '../../routes/infer.routes';

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use('/api/infer', inferRoutes);
  return app;
}
