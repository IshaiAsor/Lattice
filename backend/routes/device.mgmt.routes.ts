import express from 'express';
import { deviceMgmtService } from '../services/device.mgmt.service';
import mqttService from '../services/mqtt.service';
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

router.post('/:deviceId/reprovision', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await mqttService.publish(userId, deviceId, 'command', 'reprovision');
  res.json({ message: 'Reprovision command sent' });
});

router.post('/:deviceId/soft-reset', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await mqttService.publish(userId, deviceId, 'command', 'soft-reset');
  res.json({ message: 'Soft reset command sent' });
});

router.post('/:deviceId/hard-reset', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await mqttService.publish(userId, deviceId, 'command', 'hard-reset');
  res.json({ message: 'Hard reset command sent' });
});

router.post('/:deviceId/restart', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await mqttService.publish(userId, deviceId, 'command', 'restart');
  res.json({ message: 'Restart command sent' });
});

export default router;
