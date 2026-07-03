import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from './api.config';

export interface EnumConstraint {
  type: 'enum';
  values: string[];
}

export interface RangeConstraint {
  type: 'range';
  min: number;
  max: number;
  step?: number;
  aliases?: string[];
}

export interface PatternConstraint {
  type: 'pattern';
  regex: string;
}

export type ValidParameters = EnumConstraint | RangeConstraint | PatternConstraint;

export interface MlModelView {
  id: number;
  kind: 'vlm' | 'llm';
  name: string;
  version: string;
  backend: string;
}

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

export interface PipelineListItem {
  id: number;
  name: string;
  enabled: boolean;
  stage_count: number;
  trigger_types: string[];
  last_run: { status: string; started_at: string; is_dry_run: boolean } | null;
}

export interface PipelineDetail {
  id: number;
  name: string;
  enabled: boolean;
  stages: {
    id: number; ordinal: number; kind: string;
    ml_model_id?: number | null;
    ml_model?: { id: number; kind: string; name: string; version: string } | null;
    config?: Record<string, unknown> | null;
  }[];
  sensors: {
    id: number; group_name: string; description: string;
    user_device_action_id: number;
    inject_as_sensor: boolean; inject_as_action: boolean;
    compression: string; window_minutes: number; n: number | null;
    min_value: string | null; max_value: string | null;
    is_image: boolean;
    valid_parameters?: ValidParameters;
    user_device_action?: { action_name: string };
  }[];
  triggers: {
    id: number; trigger_type: string;
    user_device_action_id?: number | null;
    operator?: string | null; threshold_value?: string | null;
    schedule_cron?: string | null; min_interval_sec?: number | null;
  }[];
}

export interface PipelineRunSummary {
  id: number;
  status: string;
  trigger_type: string;
  is_dry_run: boolean;
  started_at: string;
  completed_at: string | null;
}

export interface PipelineRunDetail extends PipelineRunSummary {
  stages: {
    id: number;
    stage: { id: number; ordinal: number; kind: string };
    status: string;
    input?: unknown;
    output?: unknown;
    started_at?: string | null;
    completed_at?: string | null;
  }[];
}

export interface DryRunDto {
  sensor_overrides: Record<number, string>;
}

@Injectable({ providedIn: 'root' })
export class PipelinesService {
  private apiUrl = `${apiUrl()}/api/pipelines`;
  http = inject(HttpClient);

  getPipelines(): Observable<PipelineListItem[]> {
    return this.http.get<PipelineListItem[]>(this.apiUrl);
  }

  getPipeline(id: number): Observable<PipelineDetail> {
    return this.http.get<PipelineDetail>(`${this.apiUrl}/${id}`);
  }

  createPipeline(dto: CreatePipelineDto): Observable<PipelineDetail> {
    return this.http.post<PipelineDetail>(this.apiUrl, dto);
  }

  updatePipeline(id: number, dto: CreatePipelineDto): Observable<PipelineDetail> {
    return this.http.put<PipelineDetail>(`${this.apiUrl}/${id}`, dto);
  }

  deletePipeline(id: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  togglePipeline(id: number, enabled: boolean): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/${id}/toggle`, { enabled });
  }

  getRuns(pipelineId: number, limit = 20, offset = 0): Observable<PipelineRunSummary[]> {
    return this.http.get<PipelineRunSummary[]>(`${this.apiUrl}/${pipelineId}/runs`, {
      params: { limit, offset },
    });
  }

  getRun(pipelineId: number, runId: number): Observable<PipelineRunDetail> {
    return this.http.get<PipelineRunDetail>(`${this.apiUrl}/${pipelineId}/runs/${runId}`);
  }

  triggerRun(pipelineId: number): Observable<{ runId: number }> {
    return this.http.post<{ runId: number }>(`${this.apiUrl}/${pipelineId}/runs`, {});
  }

  cancelRun(pipelineId: number, runId: number): Observable<void> {
    return this.http.post<void>(`${this.apiUrl}/${pipelineId}/runs/${runId}/cancel`, {});
  }

  deleteRun(pipelineId: number, runId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${pipelineId}/runs/${runId}`);
  }

  dryRun(pipelineId: number, sensorOverrides: Record<number, string>): Observable<{ runId: number }> {
    return this.http.post<{ runId: number }>(`${this.apiUrl}/${pipelineId}/runs/dry-run`, {
      sensor_overrides: sensorOverrides,
    });
  }

  getModels(): Observable<MlModelView[]> {
    return this.http.get<MlModelView[]>(`${this.apiUrl}/ml-models`);
  }
}
