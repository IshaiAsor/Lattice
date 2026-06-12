import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { emergencyRepository, CreateEmergencyRuleInput } from '../dal/emergency.repository';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(exceptionHandler);

router.get('/rules', async (req, res) => {
  res.json(await emergencyRepository.getByUserId(req.user.id));
});

router.post('/rules', async (req, res) => {
  const data: CreateEmergencyRuleInput = { ...req.body, user_id: req.user.id };
  res.status(201).json(await emergencyRepository.create(data));
});

router.patch('/rules/:id/toggle', async (req, res) => {
  await emergencyRepository.toggle(parseInt(req.params.id), req.user.id, req.body.enabled);
  res.status(204).send();
});

router.delete('/rules/:id', async (req, res) => {
  await emergencyRepository.delete(parseInt(req.params.id), req.user.id);
  res.status(204).send();
});

router.post('/rules/import', async (req, res) => {
  const rules: any[] = req.body.emergency_rules ?? [];
  let imported = 0;
  for (const r of rules) {
    await emergencyRepository.create({ ...r, user_id: req.user.id });
    imported++;
  }
  res.json({ imported });
});

router.get('/events', async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
  res.json(await emergencyRepository.getRecentEvents(req.user.id, limit));
});

export default router;
