import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/admin.middleware';
import { exceptionHandler } from '../middlewares/exception.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { catalogRepository } from '../dal/catalog.repository';
import { catalogImportService } from '../services/catalog.import.service';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));
router.use(requireAdmin);
router.use(exceptionHandler);

// ─── Device models ────────────────────────────────────────────────────────────

router.get('/models', async (_req, res) => {
  res.json(await catalogRepository.listModels());
});

router.post('/models', async (req, res) => {
  const { model_key, version, display_name } = req.body;
  res.status(201).json(await catalogRepository.createModel({ model_key, version, display_name }));
});

router.patch('/models/:id', async (req, res) => {
  res.json(await catalogRepository.updateModel(parseInt(req.params.id), req.body));
});

router.delete('/models/:id', async (req, res) => {
  await catalogRepository.deleteModel(parseInt(req.params.id));
  res.status(204).send();
});

// ─── Model actions ────────────────────────────────────────────────────────────

router.get('/models/:modelId/actions', async (req, res) => {
  res.json(await catalogRepository.listActions(parseInt(req.params.modelId)));
});

router.post('/models/:modelId/actions', async (req, res) => {
  const { trait_ids, ...actionData } = req.body;
  const action = await catalogRepository.createAction({ ...actionData, device_model_id: parseInt(req.params.modelId) });
  if (trait_ids?.length) await catalogRepository.upsertTraitsForAction(action.id, trait_ids);
  res.status(201).json(action);
});

router.patch('/actions/:actionId', async (req, res) => {
  const { trait_ids, ...actionData } = req.body;
  const action = await catalogRepository.updateAction(parseInt(req.params.actionId), actionData);
  if (trait_ids !== undefined) await catalogRepository.upsertTraitsForAction(action.id, trait_ids);
  res.json(action);
});

router.delete('/actions/:actionId', async (req, res) => {
  await catalogRepository.deleteAction(parseInt(req.params.actionId));
  res.status(204).send();
});

// ─── ML models ───────────────────────────────────────────────────────────────
// (Shared registry — admin manages, pipeline-worker reads)

import db from '../config/db';

router.get('/ml-models', async (_req, res) => {
  res.json(await db.mlModel.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] }));
});

router.post('/ml-models', async (req, res) => {
  const { kind, name, version, description, config } = req.body;
  res.status(201).json(await db.mlModel.create({ data: { kind, name, version, description, config } }));
});

router.patch('/ml-models/:id', async (req, res) => {
  res.json(await db.mlModel.update({ where: { id: parseInt(req.params.id) }, data: req.body }));
});

router.delete('/ml-models/:id', async (req, res) => {
  await db.mlModel.delete({ where: { id: parseInt(req.params.id) } });
  res.status(204).send();
});

// ─── Import ───────────────────────────────────────────────────────────────────

router.post('/import', async (req, res) => {
  const result = await catalogImportService.importCatalog(req.body);
  res.json(result);
});

// ─── Google vocab (read-only) ─────────────────────────────────────────────────

router.get('/google-action-types', async (_req, res) => {
  res.json(await catalogRepository.listGoogleActionTypes());
});

router.get('/google-traits', async (_req, res) => {
  res.json(await catalogRepository.listGoogleTraits());
});

export default router;
