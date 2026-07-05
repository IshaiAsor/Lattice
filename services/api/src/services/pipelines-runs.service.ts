import { db, Prisma } from '@lattice/prisma-client';
import { publish, RK } from '@lattice/queue';
import { getChannel } from '../queue';
import { DryRunDto } from './pipelines.types';
import { err, validateSensorOverrides } from './pipelines.validation';

type PipelineRunWithStages = Prisma.PipelineRunGetPayload<{
  include: { stages: { include: { stage: true } } };
}>;

class PipelinesRunsService {
  async listRuns(userId: number, pipelineId: number, limit = 20, offset = 0) {
    await this.ensureOwned(userId, pipelineId);
    return db.pipelineRun.findMany({
      where: { pipeline_id: pipelineId },
      orderBy: { started_at: 'desc' },
      skip: offset,
      take: Math.min(limit, 100),
      select: {
        id: true,
        status: true,
        trigger_type: true,
        is_dry_run: true,
        started_at: true,
        completed_at: true,
      },
    });
  }

  async getRun(userId: number, pipelineId: number, runId: number): Promise<PipelineRunWithStages> {
    await this.ensureOwned(userId, pipelineId);
    const run = await db.pipelineRun.findUnique({
      where: { id: runId },
      include: { stages: { include: { stage: true }, orderBy: { id: 'asc' } } },
    });
    if (!run || run.pipeline_id !== pipelineId) throw err(404, 'Run not found');
    return run;
  }

  async cancelRun(userId: number, pipelineId: number, runId: number): Promise<void> {
    await this.ensureOwned(userId, pipelineId);
    const run = await db.pipelineRun.findUnique({ where: { id: runId } });
    if (!run || run.pipeline_id !== pipelineId) throw err(404, 'Run not found');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw err(400, `cannot cancel a run with status '${run.status}'`);
    }
    await db.pipelineRun.update({
      where: { id: runId },
      data: { status: 'cancelled', completed_at: new Date() },
    });
    const ch = await getChannel();
    publish(ch, RK.PIPELINE_CANCEL, {
      userId: String(userId),
      pipelineId: String(pipelineId),
      runId,
    });
  }

  async removeRun(userId: number, pipelineId: number, runId: number): Promise<void> {
    await this.ensureOwned(userId, pipelineId);
    const run = await db.pipelineRun.findUnique({ where: { id: runId } });
    if (!run || run.pipeline_id !== pipelineId) throw err(404, 'Run not found');
    if (run.status === 'queued' || run.status === 'running') {
      throw err(400, 'cannot delete a run that is still in progress — cancel it first');
    }
    await db.pipelineRun.delete({ where: { id: runId } });
  }

  async triggerRun(userId: number, pipelineId: number): Promise<{ runId: number }> {
    await this.ensureOwned(userId, pipelineId);
    const run = await db.pipelineRun.create({
      data: { pipeline_id: pipelineId, status: 'queued', trigger_type: 'manual' },
    });
    const ch = await getChannel();
    publish(ch, RK.PIPELINE_TRIGGER, {
      userId: String(userId),
      pipelineId: String(pipelineId),
      runId: run.id,
    });
    return { runId: run.id };
  }

  async dryRun(userId: number, pipelineId: number, dto: DryRunDto): Promise<{ runId: number }> {
    const pipeline = await this.ensureOwned(userId, pipelineId);

    const sensorActionIds = pipeline.sensors.map(
      (s: { user_device_action_id: number }) => s.user_device_action_id,
    );
    const overrideKeys = Object.keys(dto.sensor_overrides).map(Number);
    const unknown = overrideKeys.filter((k) => !sensorActionIds.includes(k));
    if (unknown.length > 0)
      throw err(400, `unknown sensor action ids in overrides: ${unknown.join(', ')}`);
    await validateSensorOverrides(sensorActionIds, dto.sensor_overrides);

    const run = await db.pipelineRun.create({
      data: {
        pipeline_id: pipelineId,
        status: 'queued',
        trigger_type: 'manual',
        is_dry_run: true,
        sensor_overrides: dto.sensor_overrides,
      },
    });
    const ch = await getChannel();
    publish(ch, RK.PIPELINE_TRIGGER, {
      userId: String(userId),
      pipelineId: String(pipelineId),
      runId: run.id,
      isDryRun: true,
      sensorOverrides: dto.sensor_overrides,
    });
    return { runId: run.id };
  }

  private async ensureOwned(userId: number, pipelineId: number) {
    const p = await db.pipeline.findUnique({
      where: { id: pipelineId },
      include: { sensors: { select: { user_device_action_id: true } } },
    });
    if (!p) throw err(404, 'Pipeline not found');
    if (p.user_id !== userId) throw err(403, 'Forbidden');
    return p;
  }
}

export const pipelinesRunsService = new PipelinesRunsService();
