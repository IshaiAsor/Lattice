import express from 'express';
import { deviceMgmtService, BlueprintView } from '../services/device.mgmt.service';
import commandDispatch from '../services/command.dispatch.service';
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

router.get('/:deviceId/blueprints', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  const blueprints = await deviceMgmtService.getDeviceBlueprints(userId, deviceId);
  res.json(blueprints);
});

router.post('/:deviceId/actions/from-blueprint', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  const { blueprintId, telemetry_interval_ms, pins } = req.body;
  const action = await deviceMgmtService.activateBlueprintAction(userId, deviceId, blueprintId, telemetry_interval_ms ?? null, pins ?? undefined);
  res.status(201).json(action);
});

router.patch('/:deviceId/actions/:userActionId', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  const userActionId = parseInt(req.params.userActionId);
  const { name, telemetry_interval_ms, pins } = req.body;
  await deviceMgmtService.updateBlueprintAction(userId, deviceId, userActionId, {
    name,
    telemetryIntervalMs: telemetry_interval_ms,
    pins,
  });
  res.status(204).send();
});

router.post('/:deviceId/reprovision', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await commandDispatch.publishCommand(userId, deviceId, 'reprovision', '');
  res.json({ message: 'Reprovision command sent' });
});

router.post('/:deviceId/soft-reset', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await commandDispatch.publishCommand(userId, deviceId, 'soft-reset', '');
  res.json({ message: 'Soft reset command sent' });
});

router.post('/:deviceId/hard-reset', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await commandDispatch.publishCommand(userId, deviceId, 'hard-reset', '');
  res.json({ message: 'Hard reset command sent' });
});

router.post('/:deviceId/restart', async (req, res) => {
  const userId = req.user.id;
  const deviceId = parseInt(req.params.deviceId);
  await commandDispatch.publishCommand(userId, deviceId, 'restart', '');
  res.json({ message: 'Restart command sent' });
});

export default router;
