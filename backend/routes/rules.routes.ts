import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { rulesRepository, CreateRuleInput } from '../dal/rules.repository';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/', async (req, res) => {
  res.json(await rulesRepository.getAllByUserId(req.user.id));
});

router.post('/', async (req, res) => {
  const data: CreateRuleInput = { ...req.body, user_id: req.user.id };
  res.status(201).json(await rulesRepository.create(data));
});

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await rulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await rulesRepository.update(id, { ...req.body, user_id: req.user.id });
  res.status(204).send();
});

router.patch('/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await rulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await rulesRepository.toggle(id, req.body.enabled);
  res.status(204).send();
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const rule = await rulesRepository.getById(id);
  if (rule.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return; }
  await rulesRepository.delete(id);
  res.status(204).send();
});

router.post('/import', async (req, res) => {
  const rules: any[] = req.body.rules ?? [];
  let imported = 0;
  for (const r of rules) {
    await rulesRepository.create({ ...r, user_id: req.user.id });
    imported++;
  }
  res.json({ imported });
});

export default router;
