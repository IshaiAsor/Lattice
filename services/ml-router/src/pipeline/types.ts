import type { PipelinePlan } from './registry';

export interface Run {
  userId: number;
  pipelineId: number;
  runId: number;
  plan: PipelinePlan;
  index: number;
  context: Record<string, unknown>;
  isDryRun: boolean;
  sensorOverrides?: Record<string, string>;
}
