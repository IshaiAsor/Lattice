import type { Channel } from 'amqplib';
import { publish, RK, type PipelineStagePayload, type PipelineStageDonePayload } from '@lattice/queue';

export async function advancePipeline(
  ch: Channel,
  stage: PipelineStagePayload,
  output?: Record<string, unknown> | null,
  error?: string,
): Promise<void> {
  const payload: PipelineStageDonePayload = {
    pipelineRunId: stage.pipelineRunId,
    stageId:       stage.stageId,
    status:        error ? 'failed' : 'completed',
    output:        output ?? undefined,
    error,
  };
  publish(ch, RK.PIPELINE_STAGE_DONE, payload);
}
