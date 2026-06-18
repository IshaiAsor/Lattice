import { Router } from 'express';
import { requireDeviceToken } from '../middlewares/device.auth.middleware';
import { requireAppToken } from '../middlewares/app.auth.middleware';
import { JwtPurpose, jwtService } from '../services/jwt.service';
import { provisioningService } from '../services/provisioning.service';
import { env } from '../config/env.config';

export const provisioningRouter = Router();

// App-facing: the UI mints a provisioning token to hand to the device over BLE.
// Moved here from backend so all device lifecycle UI endpoints live in device-gateway.
provisioningRouter.get('/provision-token', requireAppToken, (req, res) => {
  const userId = req.appUser!.id;
  const token = jwtService.generateToken(
    { userId, clientid: String(userId) },
    JwtPurpose.device_provisioning,
  );
  res.json({
    provisioningToken: token,
    userId: String(userId),
    server: env.mqtt.serverName,
    mqttPort: env.mqtt.port,
    provisioningCallbackUrl: `${env.DeviceGatewaybaseUrl}/api/provisioning/provision`,
    validateCACert: env.mqtt.validateCert,
  });
});

// Device's single provisioning call.
provisioningRouter.post(
  '/provision',
  requireDeviceToken(JwtPurpose.device_provisioning),
  async (req, res, next) => {
    try {
      const userId = Number((req.device as { userId?: string | number }).userId);
      const { macAddress, deviceType, version, capabilities } = req.body ?? {};
      if (!macAddress || !deviceType || !version || !Array.isArray(capabilities)) {
        res.status(400).json({ error: 'Missing required fields: macAddress, deviceType, version, capabilities' });
        return;
      }
      const result = await provisioningService.provisionDevice(userId, macAddress, deviceType, version, capabilities);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// Device exchanges its refresh token (in the body) for a fresh device_usage JWT.
provisioningRouter.post('/refresh-token', async (req, res, next) => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }
    const result = provisioningService.refreshMqttToken(refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
