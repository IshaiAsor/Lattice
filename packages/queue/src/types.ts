export interface TelemetryArrivedPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
}

export interface RulesEvaluatePayload {
  userId: string;
  deviceId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
}

export interface PipelineTriggerPayload {
  userId: string;
  deviceId: string;
  pipelineId: string;
  actionName: string;
  value: unknown;
  timestamp: string;
}

export interface PipelineResultPayload {
  userId: string;
  pipelineId: string;
  pipelineRunId: string;
  status: 'completed' | 'failed';
  error?: string;
}

export interface DeviceStateChangedPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  state: unknown;
  timestamp: string;
}

export interface ActionDispatchPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  command: unknown;
}

export interface PipelineStagePayload {
  userId: string;
  deviceId: string;
  pipelineId: string;
  pipelineRunId: string;
  stageId: string;
  stageName: string;
  stageKind: string;
  context: Record<string, unknown>;
}

export interface PipelineStageDonePayload {
  pipelineRunId: string;
  stageId: string;
  status: 'completed' | 'failed';
  output?: Record<string, unknown>;
  error?: string;
}
