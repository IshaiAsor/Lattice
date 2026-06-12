// ── Auth ──────────────────────────────────────────────────────────────────────
export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  user_type: number;
  profileImage?: string;
}

// ── Catalog ───────────────────────────────────────────────────────────────────
export interface GoogleActionType {
  id: number;
  key: string;
  name: string;
}

export interface GoogleTrait {
  id: number;
  key: string;
  name: string;
  params?: Record<string, unknown>;
}

export interface DeviceModel {
  id: number;
  model_key: string | null;
  version: string | null;
  display_name: string;
  created_at?: string;
  updated_at?: string;
  actions?: ModelAction[];
}

export interface ModelAction {
  id: number;
  device_model_id: number;
  action_key: string;
  capability: string;
  google_action_type_id: number;
  mqtt_type: string | null;
  mqtt_name: string | null;
  params?: Record<string, unknown>;
  pins?: Record<string, unknown>;
  telemetry_interval_ms: number | null;
  traits?: ModelActionTrait[];
}

export interface ModelActionTrait {
  id: number;
  model_action_id: number;
  google_trait_id: number;
}

export interface MlModel {
  id: number;
  kind: string;
  name: string;
  version: string;
  description: string | null;
  config?: Record<string, unknown>;
  created_at?: string;
}

// ── User devices + actions ────────────────────────────────────────────────────
export interface UserDeviceModel {
  id: number;
  display_name: string;
  model_key: string | null;
  version: string | null;
  source_blueprint_id: number | null;
}

export interface UserActionDef {
  id: number;
  action_key: string;
  capability: string;
  google_action_type_id: number;
  mqtt_type: string | null;
  mqtt_name: string | null;
  params?: Record<string, unknown>;
  pins?: Record<string, unknown>;
  telemetry_interval_ms: number | null;
}

export interface UserDevice {
  id: number;
  name: string;
  online: boolean;
  last_seen_at: string | null;
  mac_id: string | null;
  user_device_model_id: number;
  source_blueprint_id: number | null;
  device_model?: UserDeviceModel;
  actions?: UserAction[];
}

export interface UserAction {
  id: number;
  user_device_id: number;
  user_action_def_id: number;
  user_action_group_id: number | null;
  name: string;
  state: string | null;
  sort_order: number;
  // Included by GET /api/mgmt/actions
  action_def?: UserActionDef;
  user_device?: Pick<UserDevice, 'id' | 'name' | 'online' | 'last_seen_at'>;
}

export interface UserActionGroup {
  id: number;
  user_device_id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  source_blueprint_id: number | null;
  actions?: UserAction[];
}

// ── Rules ─────────────────────────────────────────────────────────────────────
export type RuleActionScope = 'instance' | 'capability' | 'group';
export type RuleActionKind  = 'set_state' | 'run_pipeline';
export type RuleConditionKind = 'schedule' | 'device_status' | 'threshold' | 'vlm_result' | 'vlm_decision' | 'pipeline_result';

export interface RuleCondition {
  id?: number;
  kind: RuleConditionKind;
  params: Record<string, unknown>;
}

export interface RuleAction {
  id?: number;
  kind: RuleActionKind;
  scope: RuleActionScope;
  user_action_id?: number | null;
  capability?: string | null;
  group_id?: number | null;
  target_state?: string | null;
  pipeline_id?: number | null;
  delay_sec: number;
}

export interface Rule {
  id: number;
  name: string;
  match: 'AND' | 'OR';
  cooldown_sec: number;
  enabled: boolean;
  last_fired_at: string | null;
  source_blueprint_id: number | null;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

// ── Emergency rules ───────────────────────────────────────────────────────────
export interface EmergencyRule {
  id: number;
  name: string;
  source_scope: RuleActionScope;
  source_user_action_id: number | null;
  source_capability: string | null;
  source_group_id: number | null;
  operator: string;
  threshold: string;
  target_scope: RuleActionScope;
  target_user_action_id: number | null;
  target_capability: string | null;
  target_group_id: number | null;
  target_state: string | null;
  enabled: boolean;
  source_blueprint_id: number | null;
}

export interface EmergencyEvent {
  id: number;
  emergency_rule_id: number;
  value: string;
  trace_id: string | null;
  fired_at: string;
  rule?: Pick<EmergencyRule, 'id' | 'name'>;
}

// ── Pipelines ─────────────────────────────────────────────────────────────────
export type StageKind    = 'vlm' | 'sensor_digest' | 'llm' | 'command_exec';
export type TriggerKind  = 'telemetry' | 'schedule' | 'rule';

export interface PipelineStage {
  id?: number;
  position: number;
  stage_kind: StageKind;
  ml_model_id: number | null;
  component_version: string | null;
  config?: Record<string, unknown>;
  ml_model?: Pick<MlModel, 'id' | 'kind' | 'name' | 'version'>;
}

export interface Pipeline {
  id: number;
  name: string;
  enabled: boolean;
  trigger_kind: TriggerKind;
  trigger_capability: string | null;
  trigger_config?: Record<string, unknown>;
  source_blueprint_id: number | null;
  stages: PipelineStage[];
}

export interface PipelineRunStage {
  id: number;
  position: number;
  stage_kind: StageKind;
  component: string | null;
  version: string | null;
  input?: unknown;
  output?: unknown;
  duration_ms: number | null;
  created_at: string;
}

export interface PipelineRun {
  id: number;
  pipeline_id: number;
  trace_id: string | null;
  status: string;
  input?: unknown;
  output?: unknown;
  started_at: string;
  finished_at: string | null;
  stage_runs?: PipelineRunStage[];
}

// ── Blueprints ────────────────────────────────────────────────────────────────
export type BlueprintStatus = 'draft' | 'published';

export interface BlueprintDeviceSlot {
  id: number;
  blueprint_id: number;
  device_model_id: number;
  role: string;
  min_count: number;
  max_count: number | null;
  sort_order: number;
  device_model?: Pick<DeviceModel, 'id' | 'display_name' | 'model_key' | 'version'>;
  action_groups?: BlueprintActionGroup[];
}

export interface BlueprintActionGroup {
  id: number;
  blueprint_id: number;
  blueprint_device_slot_id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
}

export interface BlueprintRuleCondition {
  id?: number;
  kind: string;
  params: Record<string, unknown>;
}

export interface BlueprintRuleAction {
  id?: number;
  kind: RuleActionKind;
  capability: string | null;
  target_state: string | null;
  blueprint_pipeline_id: number | null;
  delay_sec: number;
}

export interface BlueprintRule {
  id: number;
  name: string;
  match: string;
  cooldown_sec: number;
  enabled: boolean;
  conditions: BlueprintRuleCondition[];
  actions: BlueprintRuleAction[];
}

export interface BlueprintEmergencyRule {
  id: number;
  name: string;
  source_capability: string;
  operator: string;
  threshold: string;
  target_capability: string | null;
  target_state: string | null;
  enabled: boolean;
}

export interface BlueprintPipelineStage {
  id?: number;
  position: number;
  stage_kind: StageKind;
  ml_model_id: number | null;
  component_version: string | null;
  config?: Record<string, unknown>;
}

export interface BlueprintPipeline {
  id: number;
  name: string;
  enabled: boolean;
  trigger_kind: TriggerKind;
  trigger_capability: string | null;
  trigger_config?: Record<string, unknown>;
  stages: BlueprintPipelineStage[];
}

export interface Blueprint {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  status: BlueprintStatus;
  version: number;
  created_at?: string;
  updated_at?: string;
  slots?: BlueprintDeviceSlot[];
  action_groups?: BlueprintActionGroup[];
  pipelines?: BlueprintPipeline[];
  rules?: BlueprintRule[];
  emergency_rules?: BlueprintEmergencyRule[];
}

// ── Socket events ─────────────────────────────────────────────────────────────
export interface ActionStateUpdateEvent {
  actionId: number;
  state: string;
}

export interface DeviceStatusChangeEvent {
  deviceId: number;
  online: boolean;
}

export interface EmergencyAlertEvent {
  rule_id: number;
  rule_name: string;
  value: string;
  fired_at: string;
}

export interface PipelineResultEvent {
  pipeline_id: number;
  run_id: number;
  status: string;
  output?: unknown;
}
