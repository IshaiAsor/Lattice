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
  config?: { prompt_template?: string };
}

export interface CommandExecStageDto {
  kind: 'command_exec';
  ordinal: number;
  config?: { notify?: string; execute_condition?: string };
}

export type PipelineStageDto = EnrichStageDto | InferStageDto | CommandExecStageDto;

export interface PipelineTriggerDto {
  trigger_type: 'sensor_threshold' | 'schedule' | 'manual';
  user_device_action_id?: number | null;
  operator?: string | null;
  threshold_value?: string | null;
  schedule_cron?: string | null;
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
