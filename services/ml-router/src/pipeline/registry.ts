import type { PlanStage } from '../plans/registry';

// A pipeline is the async/system counterpart of a chat plan: an ordered list of stages,
// where `infer` stages run on the executor (via RMQ stage queues) and `enrich` stages run
// locally in the coordinator between them. Reuses the same PlanStage shape as chat plans.
export interface PipelinePlan {
  pipelineId: string;
  stages: PlanStage[];
}

// SEAM: how a pipelineId maps to its stage sequence is not decided yet (config file vs DB /
// backend lookup — see project_sensor_data_service / project_ml_orchestrator memos). For now
// one hardcoded example so the coordinator works end-to-end; replace with a real source later.
const EXAMPLE: PipelinePlan = {
  pipelineId: 'example',
  stages: [
    { type: 'infer', model: { kind: 'vlm', name: 'yolo', version: 'v1' } },
    { type: 'enrich', enricher: 'sensors' },
    { type: 'infer', model: { kind: 'llm', name: 'qwen', version: 'v1' } },
  ],
};

export function loadPipeline(_pipelineId: string): PipelinePlan {
  // TODO: resolve the stage sequence by pipelineId from config or DB. Returns the example for now.
  return EXAMPLE;
}
