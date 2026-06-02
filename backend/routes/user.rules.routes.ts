import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { userRulesRepository, CreateRuleInput } from '../dal/user.rules.repository';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req, res) => {
  const rules = await userRulesRepository.getAllByUserId(req.user.id);
  res.json(rules);
});

router.post('/', async (req, res) => {
  const data: CreateRuleInput = { ...req.body, user_id: req.user.id };
  const rule = await userRulesRepository.create(data);
  res.status(201).json(rule);
});

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await userRulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await userRulesRepository.update(id, { ...req.body, user_id: req.user.id });
  res.status(204).send();
});

router.patch('/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await userRulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await userRulesRepository.toggle(id, req.body.enabled);
  res.status(204).send();
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await userRulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await userRulesRepository.delete(id);
  res.status(204).send();
});

export default router;
