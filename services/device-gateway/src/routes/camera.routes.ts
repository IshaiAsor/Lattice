import { Router, raw } from 'express';
import { requireDeviceToken } from '../middlewares/device.auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { cameraService } from '../services/camera.service';

export const cameraRouter = Router();

// POST /api/camera/frame?action=<mqtt_action_name>  — device uploads a raw JPEG frame.
// The device names its own action (same convention as MQTT telemetry topics), so the
// gateway just forwards it.
cameraRouter.post(
  '/frame',
  raw({ type: 'image/jpeg', limit: '2mb' }),
  requireDeviceToken(JwtPurpose.device_usage),
  (req, res) => {
    const device = req.device as { userid?: number; clientid?: number };
    const action = String(req.query['action'] ?? '');
    if (!action) {
      res.status(400).json({ error: 'action query param required' });
      return;
    }
    const commandId = req.query['commandId'] ? String(req.query['commandId']) : undefined;
    cameraService.publishFrame(
      Number(device.userid),
      Number(device.clientid),
      action,
      req.body as Buffer,
      commandId,
    );
    res.status(200).end();
  },
);
