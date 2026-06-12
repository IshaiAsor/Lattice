import express from 'express';
import { verifyDeviceToken } from '../middlewares/device.auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { deviceGatewayRepository } from '../dal/device.gateway.repository';

const router = express.Router();
router.use(verifyDeviceToken(JwtPurpose.device_usage));

// GET /api/config  — device pulls its action definitions on boot + periodically
router.get('/', async (req, res) => {
  const { deviceId: userDeviceId } = req.device!;
  const defs = await deviceGatewayRepository.getActionDefsForDevice(userDeviceId);

  res.json({
    actions: defs.map((d) => ({
      action_key:           d.action_key,
      capability:           d.capability,
      mqtt_type:            d.mqtt_type,
      mqtt_name:            d.mqtt_name,
      pins:                 d.pins,
      telemetry_interval_ms: d.telemetry_interval_ms,
    })),
  });
});

export default router;
