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
  let bodyData = req.body;
  if (typeof bodyData === 'string') {
    try {
      const parsed = JSON.parse(bodyData.trim());
      if (parsed && typeof parsed === 'object') bodyData = parsed;
    } catch (e) {}
  }

  let provisioningToken = '';
  if (typeof bodyData === 'string' && (bodyData.startsWith('ey') || bodyData.startsWith('"ey'))) {
    provisioningToken = bodyData.trim();
    if (provisioningToken.startsWith('"') && provisioningToken.endsWith('"')) {
        provisioningToken = provisioningToken.substring(1, provisioningToken.length - 1);
    }
  } else {
    provisioningToken = bodyData.provisioningToken;
    if (provisioningToken) provisioningToken = provisioningToken.trim();
  }

  const deviceType = bodyData.deviceType || req.query.deviceType;
  const deviceId = bodyData.deviceId || req.query.deviceId;
  const macAddress = bodyData.macAddress || req.query.macAddress;
  const version = bodyData.version || req.query.version;
  const userId = req.user.userId;

  let permanentToken = await provisioningService.registerDevice(userId, provisioningToken, deviceType as string, deviceId, macAddress as string, version as string);
  res.json(permanentToken);
});

router.post('/refresh-token', verifyToken(JwtPurpose.device_usage_refresh), async (req: Request, res: Response) => {
  const refreshToken = req.body.refreshToken;
  var result = await provisioningService.RefreshMqttToken(refreshToken);
  res.json(result);
});
export default router;
