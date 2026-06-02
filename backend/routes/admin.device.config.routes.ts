import express, { Request, Response } from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/admin.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { adminDeviceConfigService, ConflictError, ValidationError } from '../services/admin.device.config.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(requireAdmin);
router.use(exceptionHandler);

// Device types
router.get('/devices', async (req: Request, res: Response) => {
  res.json(await adminDeviceConfigService.listDeviceTypes());
});

router.post('/devices', async (req: Request, res: Response) => {
  const { type, version, default_name } = req.body;
  res.status(201).json(await adminDeviceConfigService.createDeviceType(type, version, default_name));
});

router.patch('/devices/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  res.json(await adminDeviceConfigService.updateDeviceType(id, req.body));
});

router.delete('/devices/:id', async (req: Request, res: Response) => {
  await adminDeviceConfigService.deleteDeviceType(parseInt(req.params.id as string));
  res.status(204).send();
});

// Actions for a device type
router.get('/devices/:id/actions', async (req: Request, res: Response) => {
  res.json(await adminDeviceConfigService.listActions(parseInt(req.params.id as string)));
});

router.post('/devices/:id/actions', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await adminDeviceConfigService.createAction(parseInt(req.params.id as string), req.body));
  } catch (err) {
    if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); }
    else if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); }
    else { throw err; }
  }
});

router.patch('/actions/:actionId', async (req: Request, res: Response) => {
  try {
    res.json(await adminDeviceConfigService.updateAction(parseInt(req.params.actionId as string), req.body));
  } catch (err) {
    if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); }
    else if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); }
    else { throw err; }
  }
});

router.delete('/actions/:actionId', async (req: Request, res: Response) => {
  await adminDeviceConfigService.deleteAction(parseInt(req.params.actionId as string));
  res.status(204).send();
});

export default router;
