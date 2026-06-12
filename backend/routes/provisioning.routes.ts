import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose, jwtService } from '../services/jwt.service';
import config from '../config/env.config';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

/**
 * GET /api/provisioning/provision-token
 *
 * Returns everything the Angular UI needs to send to an ESP32 via BLE:
 *  - MQTT broker connection details
 *  - A short-lived provisioning JWT (device uses it as Bearer token when
 *    calling provisioningCallbackUrl on the device-gateway)
 *  - The device-gateway base URL (device calls /api/provision/register then /api/provision/complete)
 */
router.get('/provision-token', async (req, res) => {
  const userId = req.user.id;

  const provisioningToken = jwtService.generateToken(
    { id: userId },
    JwtPurpose.device_provisioning,
  );



  res.json({
    userId:                 String(userId),
    clientId: userId +'_provisioning',  // For MQTT client ID — must be unique per device
    provisioningToken,
    mqttServer:                 config.mqtt.server,
    mqttPort:               config.mqtt.port,
   validateCACert:         config.mqtt.validateCert,
    // wsStreamUrl:            `${config.gatewayUrl}/api/stream`,
    // cameraHttpUrl:          `${config.gatewayUrl}/api/camera/frame`,
    // deviceConfigUrl:        `${config.gatewayUrl}/api/config`,
    finalizeCallbackUrl:    `${config.gatewayUrl}/api/provision/register`,
  });
});

export default router;
