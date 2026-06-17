import { Router } from 'express';
import { requireDeviceToken } from '../middlewares/device.auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { deviceConfigurationService } from '../services/device-configuration.service';

export const deviceConfigurationRouter = Router();

// GET /api/device/configuration/{version}
// Device-only: the device pulls its own firmware config (clientid = userDevice.id).
// App clients do NOT use this — the UI reads device config via the api management
// endpoints, so app_usage is intentionally not accepted here.
deviceConfigurationRouter.get(
  '/configuration',
  requireDeviceToken(JwtPurpose.device_usage),
  async (req, res) => {
    const version = String(req.query.version);
    const deviceId = String(req.query.deviceId);
    if (!version || version === 'undefined' ||!deviceId || deviceId === 'undefined') {
      res.status(400).json({ error: 'Missing version or deviceId in URL' });
      return;
    }
    const config = await deviceConfigurationService.getConfigurationForDevice(Number(deviceId), version);
    res.json(config);
  },
);
