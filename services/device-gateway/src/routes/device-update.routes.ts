import { Router } from 'express';
import { requireAppToken } from '../middlewares/app.auth.middleware';
import { actionMigrationService } from '../services/action-migration.service';

export const deviceUpdateRouter = Router();

deviceUpdateRouter.use(requireAppToken);

// Returns a preview of which actions will migrate cleanly and which will be deprecated.
deviceUpdateRouter.get('/:userDeviceId/update-preview', async (req, res, next) => {
  try {
    const userDeviceId = Number(req.params.userDeviceId);
    if (isNaN(userDeviceId)) {
      res.status(400).json({ error: 'Invalid userDeviceId' });
      return;
    }
    const result = await actionMigrationService.previewUpdate(userDeviceId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Migrates actions to the latest catalog version and dispatches OTA to the device.
deviceUpdateRouter.post('/:userDeviceId/apply-update', async (req, res, next) => {
  try {
    const userDeviceId = Number(req.params.userDeviceId);
    if (isNaN(userDeviceId)) {
      res.status(400).json({ error: 'Invalid userDeviceId' });
      return;
    }
    await actionMigrationService.applyUpdate(userDeviceId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
