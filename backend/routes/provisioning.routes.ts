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
  console.log('Received device registration request with body:', req.body);

  const provisioningToken = req.body.provisioningToken;
  const deviceType = req.body.deviceType;
  const deviceId = req.body.deviceId;
  const macAddress = req.body.macAddress;
  const version = req.body.version;
  const userId = req.user.userId;

  let permanentToken = await provisioningService.registerDevice(userId,provisioningToken, deviceType, deviceId, macAddress, version);
  res.json(permanentToken);
});

router.post('/refresh-token', verifyToken(JwtPurpose.device_usage_refresh), async (req: Request, res: Response) => {
  const refreshToken = req.body.refreshToken;
  var result = await provisioningService.RefreshMqttToken(refreshToken);
  res.json(result);
});
export default router;
