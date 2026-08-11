export interface PipelineSensorDto {
  group_name: string;
  description: string;
  user_device_action_id: number;
  inject_as_sensor: boolean;
  inject_as_action: boolean;
  min_value?: string | null;
  max_value?: string | null;
  compression: 'average' | 'last_n' | 'min_max' | 'min_max_avg' | 'time_series';
  window_value: number;
  window_unit: 'minutes' | 'hours' | 'days';
  n?: number | null;
}

export interface EnrichStageDto {
  kind: 'enrich';
  ordinal: number;
}

export interface InferStageDto {
  kind: 'infer';
  ordinal: number;
  ml_model_id: number;
  prompt_template?: string | null;
}

export interface CommandExecStageDto {
  kind: 'command_exec';
  ordinal: number;
  notify?: string | null;
  execute_condition?: string | null;
}

export type PipelineStageDto = EnrichStageDto | InferStageDto | CommandExecStageDto;

export interface PipelineTriggerDto {
  trigger_type: 'sensor_threshold' | 'schedule' | 'manual';
  user_device_action_id?: number | null;
  operator?: string | null;
  threshold_value?: string | null;
  /** HH:MM — fires once a day, or opens a window when the two below are set. */
  schedule_time?: string | null;
  schedule_until?: string | null;
  schedule_every_minutes?: number | null;
  schedule_days?: number[];
  min_interval_sec?: number | null;
}

export interface CreatePipelineDto {
  name: string;
  stages: PipelineStageDto[];
  sensors: PipelineSensorDto[];
  triggers: PipelineTriggerDto[];
}

export interface DryRunDto {
  sensor_overrides: Record<string, string>;
}
