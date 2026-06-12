import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { userActionsRepository } from '../dal/user.actions.repository';
import { userActionGroupsRepository } from '../dal/user.action.groups.repository';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));

// ─── User actions ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  res.json(await userActionsRepository.getAllByUserId(req.user.id));
});

router.put('/order', async (req, res) => {
  const { orderedIds } = req.body as { orderedIds: number[] };
  await userActionsRepository.reorder(orderedIds);
  res.status(204).send();
});

router.patch('/:actionId', async (req, res) => {
  const action = await userActionsRepository.patch(parseInt(req.params.actionId), req.body);
  res.json(action);
});

// ─── Action groups ────────────────────────────────────────────────────────────

router.get('/groups', async (req, res) => {
  res.json(await userActionGroupsRepository.getByUserId(req.user.id));
});

router.post('/groups', async (req, res) => {
  const group = await userActionGroupsRepository.create({ ...req.body, user_id: req.user.id });
  res.status(201).json(group);
});

router.put('/groups/order', async (req, res) => {
  const { orderedIds } = req.body as { orderedIds: number[] };
  await userActionGroupsRepository.reorder(req.user.id, orderedIds);
  res.status(204).send();
});

router.patch('/groups/:groupId', async (req, res) => {
  const group = await userActionGroupsRepository.update(parseInt(req.params.groupId), req.user.id, req.body);
  res.json(group);
});

router.delete('/groups/:groupId', async (req, res) => {
  await userActionGroupsRepository.delete(parseInt(req.params.groupId), req.user.id);
  res.status(204).send();
});

export default router;
