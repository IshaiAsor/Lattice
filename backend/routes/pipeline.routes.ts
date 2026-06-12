import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { pipelinesRepository, CreatePipelineInput, CreateStageInput } from '../dal/pipelines.repository';
import { pipelineImportService } from '../services/pipeline.import.service';
import { publish, RK } from '@lattice/queue';
import { injectTraceHeaders } from '@lattice/otel';

const router = express.Router();
router.use(verifyToken(JwtPurpose.app_usage));

// ─── Pipelines ────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  res.json(await pipelinesRepository.getByUserId(req.user.id));
});

router.get('/:id', async (req, res) => {
  res.json(await pipelinesRepository.getById(parseInt(req.params.id), req.user.id));
});

router.post('/', async (req, res) => {
  const { stages, ...rest } = req.body as CreatePipelineInput & { stages?: CreateStageInput[] };
  const pipeline = await pipelinesRepository.create({ ...rest, user_id: req.user.id }, stages);
  res.status(201).json(pipeline);
});

router.patch('/:id', async (req, res) => {
  const pipeline = await pipelinesRepository.update(parseInt(req.params.id), req.user.id, req.body);
  res.json(pipeline);
});

router.patch('/:id/toggle', async (req, res) => {
  await pipelinesRepository.toggle(parseInt(req.params.id), req.user.id, req.body.enabled);
  res.status(204).send();
});

router.delete('/:id', async (req, res) => {
  await pipelinesRepository.delete(parseInt(req.params.id), req.user.id);
  res.status(204).send();
});

// ─── Stage management ─────────────────────────────────────────────────────────

router.put('/:id/stages', async (req, res) => {
  const stages: CreateStageInput[] = req.body;
  const pipeline = await pipelinesRepository.replaceStages(parseInt(req.params.id), req.user.id, stages);
  res.json(pipeline);
});

router.post('/:id/stages', async (req, res) => {
  const stage = await pipelinesRepository.addStage(parseInt(req.params.id), req.user.id, req.body);
  res.status(201).json(stage);
});

router.patch('/:id/stages/:stageId', async (req, res) => {
  const stage = await pipelinesRepository.updateStage(
    parseInt(req.params.stageId), parseInt(req.params.id), req.user.id, req.body,
  );
  res.json(stage);
});

router.delete('/:id/stages/:stageId', async (req, res) => {
  await pipelinesRepository.deleteStage(
    parseInt(req.params.stageId), parseInt(req.params.id), req.user.id,
  );
  res.status(204).send();
});

// ─── Import ───────────────────────────────────────────────────────────────────

router.post('/import', async (req, res) => {
  const result = await pipelineImportService.importPipelines(req.body, req.user.id);
  res.json(result);
});

// ─── Manual trigger ───────────────────────────────────────────────────────────

router.post('/:id/trigger', async (req, res) => {
  const pipelineId = parseInt(req.params.id);
  await pipelinesRepository.getById(pipelineId, req.user.id); // ownership check
  await publish(
    RK.pipelineTrigger(req.user.id),
    { userId: req.user.id, pipelineId, triggerUserActionId: req.body.triggerUserActionId ?? null },
    injectTraceHeaders(),
  );
  res.json({ message: 'Pipeline trigger queued' });
});

// ─── Run history ──────────────────────────────────────────────────────────────

router.get('/:id/runs', async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
  res.json(await pipelinesRepository.getRecentRuns(parseInt(req.params.id), req.user.id, limit));
});

export default router;
