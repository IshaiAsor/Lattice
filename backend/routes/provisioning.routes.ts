import express, { Request, Response } from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { provisioningService } from '../services/provisioning.service';
import { JwtPurpose } from '../services/jwt.service';

const router = express.Router();

// App-facing: the UI mints a provisioning token to hand the device over BLE.
// The device-facing /provision and /refresh-token endpoints moved to services/device-gateway.
router.get('/provision-token', verifyToken(JwtPurpose.app_usage), async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  if (!userId) {
    return res.status(401).send('User not authenticated');
  }
  const token = await provisioningService.GenerateProvisioningToken(userId);
  res.send(token);
});

export default router;
