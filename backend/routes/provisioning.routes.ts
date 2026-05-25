import express, { Request, Response } from 'express';
import { verifyToken } from '../middlewares/auth.middleware'; // Assuming an auth middleware exists
import { provisioningService } from '../services/provisioning.service';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
const router = express.Router();
router.use(exceptionHandler);

router.get('/provision-token', verifyToken(JwtPurpose.app_usage), async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;

  if (!userId) {
    return res.status(401).send('User not authenticated');
  }
  let token = await provisioningService.GenerateProvisioningToken(userId);
  res.send(token);
});

router.post('/register-device', verifyToken(JwtPurpose.device_provisioning),async (req: Request, res: Response) => {
  console.log('Received device registration request with body type:', typeof req.body);

  let provisioningToken = '';
  if (typeof req.body === 'string' && req.body.startsWith('ey')) {
    provisioningToken = req.body;
  } else {
    provisioningToken = req.body.provisioningToken;
  }

  const deviceType = req.body.deviceType || req.query.deviceType;
  const deviceId = req.body.deviceId || req.query.deviceId;
  const macAddress = req.body.macAddress || req.query.macAddress;
  const version = req.body.version || req.query.version;
  const userId = req.user.userId;

  let permanentToken = await provisioningService.registerDevice(userId, provisioningToken, deviceType as string, Number(deviceId), macAddress as string, version as string);
  res.json(permanentToken);
});

router.post('/refresh-token', verifyToken(JwtPurpose.device_usage_refresh), async (req: Request, res: Response) => {
  const refreshToken = req.body.refreshToken;
  var result = await provisioningService.RefreshMqttToken(refreshToken);
  res.json(result);
});
export default router;
