import express from 'express';
import { provisioningService, type CapabilityReport } from '../services/provisioning.service';
import { verifyDeviceToken } from '../middlewares/device.auth.middleware';
import { jwtService, JwtPurpose } from '../services/jwt.service';
import config from '../config/env.config';

const router = express.Router();

/**
 * POST /api/provision/register
 *
 * Single-step registration. Called by the device after a successful MQTT test.
 * Accepts both v1 field names (macAddress, deviceType) and v2 (mac_id, model_key).
 *
 * Required body fields:
 *   mac_id / macAddress         — device WiFi MAC address
 *   model_key / deviceType      — firmware model identifier (lowercased)
 *   version                     — firmware version string
 *   deviceId                    — hardware unique ID (eFuse MAC)
 *   provisioningClientId        — MQTT client ID used during testMqtt (must equal `${userId}_provisioning`)
 *
 * Auth: Bearer device_provisioning JWT in Authorization header (issued by the backend
 *       GET /api/provisioning/provision-token endpoint).
 *
 * Returns permanent device_usage tokens and device config URLs.
 */
router.post('/register', async (req, res) => {
  const mac_id:              string = req.body.mac_id     ?? req.body.macAddress  ?? '';
  const model_key:           string = (req.body.model_key ?? req.body.deviceType  ?? '').toLowerCase();
  const version:             string = req.body.version    ?? '';
  const deviceId:            string = req.body.deviceId   ?? '';
  const provisioningClientId: string = req.body.provisioningClientId ?? '';

  if (!mac_id || !model_key || !version || !deviceId || !provisioningClientId) {
    return res.status(400).json({
      error: 'mac_id (or macAddress), model_key (or deviceType), version, deviceId, and provisioningClientId are required',
    });
  }

  // Extract user_id from the provisioning Bearer token
  let user_id: number | undefined = typeof req.body.user_id === 'number' ? req.body.user_id : undefined;
  if (!user_id) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      const { valid, decoded } = jwtService.verify(bearer, JwtPurpose.device_provisioning);
      if (valid && decoded?.id) user_id = decoded.id;
    }
  }

  // Verify the provisioning client ID matches the user who started the provisioning flow
  if (provisioningClientId !== `${user_id}_provisioning`) {
    return res.status(400).json({ error: 'Invalid provisioningClientId' });
  }

  const capabilities: CapabilityReport[] | undefined = Array.isArray(req.body.capabilities)
    ? req.body.capabilities
    : undefined;

  const { token, refreshToken, deviceId: registeredDeviceId } = await provisioningService.register({
    mac_id,
    model_key,
    version,
    userId: user_id,
    capabilities,
  });

  res.json({
    clientId:                registeredDeviceId,
    permanentToken:          token,
    refreshToken:            refreshToken,
    refreshTokenCallbackUrl: `${config.baseUrl}/api/provision/token/refresh`,
    wsStreamUrl:             `${config.baseUrl}/api/stream`,
    cameraHttpUrl:           `${config.baseUrl}/api/camera/frame`,
    deviceConfigUrl:         `${config.baseUrl}/api/config`,
  });
});

/**
 * POST /api/provision/token/refresh
 *
 * Renews a device_usage JWT. Protected by a valid (non-expired) device_usage token.
 */
router.post('/token/refresh', verifyDeviceToken(JwtPurpose.device_usage), async (req, res) => {
  const { id: userId, deviceId: userDeviceId, mac_id } = req.device!;
  const token = provisioningService.refreshToken(userId, userDeviceId, mac_id);
  res.json({ token });
});

export default router;
