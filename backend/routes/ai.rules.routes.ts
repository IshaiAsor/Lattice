import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { generateRules, applyRules, RuleSet } from '../services/ai.rules.service';
import { db } from '@lattice/prisma-client';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));

// POST /api/ai/rules/generate
// Describe your goal → qwen2.5vl generates a matching rule set using your actual capabilities.
router.post('/rules/generate', async (req, res) => {
  const { goal, context } = req.body as { goal: string; context?: string };
  if (!goal?.trim()) return res.status(400).json({ error: 'goal is required' });

  const ruleSet = await generateRules({ userId: req.user.id, goal, context });
  res.json(ruleSet);
});

// POST /api/ai/rules/apply
// Apply a rule set (from /generate or user-edited). Replaces previous AI rules.
router.post('/rules/apply', async (req, res) => {
  const { rules } = req.body as Partial<RuleSet>;
  if (!Array.isArray(rules) || !rules.length) {
    return res.status(400).json({ error: 'rules array is required' });
  }
  const result = await applyRules(req.user.id, { rules });
  res.status(201).json(result);
});

// GET /api/ai/rules
// List all active AI-generated rules for this user.
router.get('/rules', async (req, res) => {
  const rules = await db.rule.findMany({
    where: { user_id: req.user.id, name: { startsWith: '[AI]' } },
    include: { conditions: true, actions: true },
    orderBy: { created_at: 'desc' },
  });
  res.json(rules);
});

// DELETE /api/ai/rules
// Remove all AI-generated rules.
router.delete('/rules', async (req, res) => {
  const { count } = await db.rule.deleteMany({
    where: { user_id: req.user.id, name: { startsWith: '[AI]' } },
  });
  res.json({ deleted: count });
});

export default router;
