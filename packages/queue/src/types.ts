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

// A UI client's request to change an action's state, addressed by UserDeviceAction id
// (the only handle the UI has). digest resolves it to a device/action/version and a
// concrete ActionDispatchPayload.
export interface ActionRequestedPayload {
  userId: string;
  actionId: number;
  value: unknown;      // desired state value (e.g. "on", "23.5")
  duration?: string;   // command duration hint passed through to the device
}

export interface ActionDispatchPayload {
  userId: string;
  deviceId: string;
  actionName: string;
  command: unknown;
  firmwareVersion?: string;
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

export interface OtaDispatchPayload {
  deviceType: string;
  version: string;
  url: string;
  releaseNotes?: string;
  timestamp: string;
}

// Incoming OTA release trigger — published by ota-manager/CI, consumed by
// digest-service which validates + audit-logs, then forwards to OtaDispatchPayload.
// Shape mirrors OtaDispatchPayload for now but kept separate as it may diverge
// (e.g. carry CI metadata or an auth token).
export interface OtaIncomingPayload {
  deviceType: string;
  version: string;
  url: string;
  releaseNotes?: string;
  timestamp: string;
}
