import express, { Request, Response } from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { deviceConfigurationService } from '../services/device.configuration.service';

const router = express.Router();
router.use(exceptionHandler);

// GET /api/device/:version/configuration
// Auth: device_usage JWT — claims: { userid, clientid: UserDevice.id }
// :version identifies which firmware version's action config to return
router.get('/:version/configuration', verifyToken(JwtPurpose.device_usage), async (req: Request, res: Response) => {
  const userDeviceId: number = req.user?.clientid;
  const version: string = String(req.params.version);

  if (!userDeviceId) {
    return res.status(400).json({ error: 'Missing deviceId in token' });
  }
  if (!version) {
    return res.status(400).json({ error: 'Missing version in URL' });
  }

  const config = await deviceConfigurationService.getConfigurationForDevice(userDeviceId, version);
  return res.json(config);
});

export default router;
