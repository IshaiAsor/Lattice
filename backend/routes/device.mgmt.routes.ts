import express from 'express';
import { deviceMgmtService } from '../services/device.mgmt.service';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const devices = await deviceMgmtService.getUserDevices(userId);
  res.json(devices);
});

router.patch('/:deviceId', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  const updates = req.body;
  const updatedDevice = await deviceMgmtService.updateDevice(userId, deviceId, updates);
  res.json(updatedDevice);
});

router.delete('/:deviceId', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await deviceMgmtService.deleteDevice(userId, deviceId);
  res.status(204).send();
});
export default router;
