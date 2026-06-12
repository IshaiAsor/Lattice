import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { userDevicesRepository } from '../dal/user.devices.repository';
import { publish, RK } from '@lattice/queue';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req, res) => {
  const devices = await userDevicesRepository.getByUserId(req.user.id);
  res.json(devices.map(d => ({
    id: d.id,
    name: d.name,
    online: d.online ?? false,
    lastSeenAt: d.last_seen_at,
    modelKey: d.device_model.model_key,
    version: d.device_model.version,
    macId: d.mac_id,
    sourceBlueprintId: d.source_blueprint_id,
  })));
});

router.get('/:deviceId', async (req, res) => {
  const device = await userDevicesRepository.getById(parseInt(req.params.deviceId));
  res.json({
    id: device.id,
    name: device.name,
    online: device.online ?? false,
    lastSeenAt: device.last_seen_at,
    modelKey: device.device_model.model_key,
    version: device.device_model.version,
    macId: device.mac_id,
    sourceBlueprintId: device.source_blueprint_id,
  });
});

router.get('/:deviceId/pending-defs', async (req, res) => {
  const defs = await userDevicesRepository.getPendingDefs(parseInt(req.params.deviceId));
  res.json(defs);
});

router.post('/:deviceId/activate', async (req, res) => {
  const items: { user_action_def_id: number; name: string; user_action_group_id?: number | null }[] = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Body must be a non-empty array of capability activation items' });
  }
  const activated = await userDevicesRepository.activateCapabilities(parseInt(req.params.deviceId), items);
  res.json({ activated });
});

router.patch('/:deviceId', async (req, res) => {
  const device = await userDevicesRepository.update(req.user.id, parseInt(req.params.deviceId), req.body);
  res.json(device);
});

router.delete('/:deviceId', async (req, res) => {
  const deviceId = parseInt(req.params.deviceId);
  // Send hard-reset command via device-gateway before deleting
  await publish(RK.actionDispatch(req.user.id), {
    userId: req.user.id, userDeviceId: deviceId,
    mqttType: 'command', mqttName: 'hard-reset', value: '1',
  }).catch(() => {}); // best-effort
  await userDevicesRepository.delete(deviceId, req.user.id);
  res.status(204).send();
});

// Device management commands — dispatched via RabbitMQ → device-gateway → EMQX
const sendCommand = (command: string) => async (req: express.Request, res: express.Response) => {
  const deviceId = parseInt(req.params['deviceId'] as string);
   await publish(RK.actionDispatch(req.user.id), {
    userId: req.user.id, userDeviceId: deviceId,
    mqttType: 'command', mqttName: command, value: '1',
  });
  res.json({ message: `${command} command sent` });
};

router.post('/:deviceId/reprovision', sendCommand('reprovision'));
router.post('/:deviceId/soft-reset',  sendCommand('soft-reset'));
router.post('/:deviceId/hard-reset',  sendCommand('hard-reset'));
router.post('/:deviceId/restart',     sendCommand('restart'));

export default router;
