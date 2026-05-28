import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { deviceActionsService } from '../services/device.actions.service';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const actions = await deviceActionsService.getUserActions(userId);
  res.json(actions);
});

router.patch('/:actionId', async (req, res) => {
  const actionId = parseInt(req.params.actionId);
  await deviceActionsService.updateAction(actionId, req.body);
  res.status(204).send();
});

export default router;