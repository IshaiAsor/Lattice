import express from 'express';
import { verifyToken } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/admin.middleware';
import { JwtPurpose } from '../services/jwt.service';
import { blueprintsRepository } from '../dal/blueprints.repository';
import { blueprintDeriveService } from '../services/blueprint.derive.service';
import { blueprintImportService } from '../services/blueprint.import.service';

const router = express.Router();

// ─── Admin ────────────────────────────────────────────────────────────────────

const adminRouter = express.Router();
adminRouter.use(verifyToken(JwtPurpose.app_usage));
adminRouter.use(requireAdmin);

// Blueprint CRUD
adminRouter.get('/', async (_req, res) => {
  res.json(await blueprintsRepository.listAll());
});

adminRouter.post('/', async (req, res) => {
  const { name, description, category } = req.body;
  res.status(201).json(await blueprintsRepository.create({ name, description, category, created_by: req.user.id }));
});

adminRouter.get('/:id', async (req, res) => {
  res.json(await blueprintsRepository.findFullById(+req.params.id));
});

adminRouter.patch('/:id', async (req, res) => {
  const { name, description, category } = req.body;
  res.json(await blueprintsRepository.update(+req.params.id, { name, description, category }));
});

adminRouter.patch('/:id/publish', async (req, res) => {
  res.json(await blueprintsRepository.publish(+req.params.id));
});

adminRouter.delete('/:id', async (req, res) => {
  await blueprintsRepository.delete(+req.params.id);
  res.status(204).send();
});

// Slots
adminRouter.post('/:id/slots', async (req, res) => {
  const { device_model_id, role, min_count, max_count, sort_order } = req.body;
  res.status(201).json(await blueprintsRepository.addSlot(+req.params.id, { device_model_id, role, min_count, max_count, sort_order }));
});

adminRouter.delete('/:id/slots/:slotId', async (req, res) => {
  await blueprintsRepository.deleteSlot(+req.params.slotId);
  res.status(204).send();
});

// Action groups
adminRouter.post('/:id/action-groups', async (req, res) => {
  const { blueprint_device_slot_id, name, description, icon, color, sort_order } = req.body;
  res.status(201).json(await blueprintsRepository.addActionGroup({
    blueprint_id: +req.params.id, blueprint_device_slot_id, name, description, icon, color, sort_order,
  }));
});

adminRouter.delete('/:id/action-groups/:gid', async (req, res) => {
  await blueprintsRepository.deleteActionGroup(+req.params.gid);
  res.status(204).send();
});

// Pipelines
adminRouter.post('/:id/pipelines', async (req, res) => {
  const { name, enabled, trigger_kind, trigger_capability, trigger_config } = req.body;
  res.status(201).json(await blueprintsRepository.addPipeline(+req.params.id, { name, enabled, trigger_kind, trigger_capability, trigger_config }));
});

adminRouter.delete('/:id/pipelines/:pid', async (req, res) => {
  await blueprintsRepository.deletePipeline(+req.params.pid);
  res.status(204).send();
});

adminRouter.post('/:id/pipelines/:pid/stages', async (req, res) => {
  const { position, stage_kind, ml_model_id, component_version, config } = req.body;
  res.status(201).json(await blueprintsRepository.addPipelineStage(+req.params.pid, { position, stage_kind, ml_model_id, component_version, config }));
});

adminRouter.delete('/:id/pipelines/:pid/stages/:sid', async (req, res) => {
  await blueprintsRepository.deletePipelineStage(+req.params.sid);
  res.status(204).send();
});

// Rules
adminRouter.post('/:id/rules', async (req, res) => {
  const { name, match, cooldown_sec, enabled } = req.body;
  res.status(201).json(await blueprintsRepository.addRule(+req.params.id, { name, match, cooldown_sec, enabled }));
});

adminRouter.delete('/:id/rules/:rid', async (req, res) => {
  await blueprintsRepository.deleteRule(+req.params.rid);
  res.status(204).send();
});

adminRouter.post('/:id/rules/:rid/conditions', async (req, res) => {
  const { kind, params } = req.body;
  res.status(201).json(await blueprintsRepository.addRuleCondition(+req.params.rid, { kind, params }));
});

adminRouter.delete('/:id/rules/:rid/conditions/:cid', async (req, res) => {
  await blueprintsRepository.deleteRuleCondition(+req.params.cid);
  res.status(204).send();
});

adminRouter.post('/:id/rules/:rid/actions', async (req, res) => {
  const { kind, capability, target_state, blueprint_pipeline_id, delay_sec } = req.body;
  res.status(201).json(await blueprintsRepository.addRuleAction(+req.params.rid, { kind, capability, target_state, blueprint_pipeline_id, delay_sec }));
});

adminRouter.delete('/:id/rules/:rid/actions/:aid', async (req, res) => {
  await blueprintsRepository.deleteRuleAction(+req.params.aid);
  res.status(204).send();
});

// Emergency rules
adminRouter.post('/:id/emergency-rules', async (req, res) => {
  const { name, source_capability, operator, threshold, target_capability, target_state, enabled } = req.body;
  res.status(201).json(await blueprintsRepository.addEmergencyRule(+req.params.id, {
    name, source_capability, operator, threshold, target_capability, target_state, enabled,
  }));
});

adminRouter.patch('/:id/emergency-rules/:eid', async (req, res) => {
  const { name, source_capability, operator, threshold, target_capability, target_state, enabled } = req.body;
  res.json(await blueprintsRepository.updateEmergencyRule(+req.params.eid, {
    name, source_capability, operator, threshold, target_capability, target_state, enabled,
  }));
});

adminRouter.delete('/:id/emergency-rules/:eid', async (req, res) => {
  await blueprintsRepository.deleteEmergencyRule(+req.params.eid);
  res.status(204).send();
});

// ─── Import ───────────────────────────────────────────────────────────────────

adminRouter.post('/import', async (req, res) => {
  const result = await blueprintImportService.importBlueprints(req.body, req.user.id);
  res.json(result);
});

// ─── User ─────────────────────────────────────────────────────────────────────

const userRouter = express.Router();
userRouter.use(verifyToken(JwtPurpose.app_usage));

userRouter.get('/', async (_req, res) => {
  res.json(await blueprintsRepository.listPublished());
});

userRouter.get('/:id', async (req, res) => {
  res.json(await blueprintsRepository.findFullById(+req.params.id));
});

userRouter.post('/:id/derive', async (req, res) => {
  const result = await blueprintDeriveService.derive(req.user.id, +req.params.id);
  res.status(201).json(result);
});

// ─── Mount ────────────────────────────────────────────────────────────────────

router.use('/admin/blueprints', adminRouter);
router.use('/blueprints', userRouter);

export default router;
