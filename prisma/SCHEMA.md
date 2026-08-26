# Lattice v2.2 — Database Schema Review

Single source of truth is `prisma/schema.prisma`. **Keep this file in sync with every schema
change** (mermaid ERD + per-table examples). 63 tables, ordered by dependency tier 0 → 7.

| Tier | Theme                                                                                | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | External catalog                                                                     | `google_action_types`, `google_device_traits`, `retention_buckets`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 1    | Device & ML catalog                                                                  | `devices`, `device_capabilities`, `device_capability_traits`, `device_capability_pins`, `capability_configurations`, `ml_models`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2    | Identity                                                                             | `users`, `mqtt_user`, `user_login_audit`, `push_subscriptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3    | User devices & actions                                                               | `user_devices`, `user_action_groups`, `areas`, `user_device_actions`, `user_device_action_pins`, `user_action_configurations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4    | Automation (rules; emergencies = rules with `is_emergency`; scenes = manual fan-out) | `user_rules`, `user_rule_conditions`, `user_rule_actions`, `user_rule_events`, `scenes`, `scene_members`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5    | Pipelines (ML execution)                                                             | `pipelines`, `pipeline_sensors`, `pipeline_stages`, `pipeline_triggers`, `pipeline_runs`, `pipeline_run_stages`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6    | Telemetry                                                                            | `sensor_history`, `device_commands`, `sensor_rollup`, `camera_frame_history`, `command_rollup_daily`, `device_events`, `device_availability_daily`, `retention_policy`, `user_retention_preferences`, `retention_policy_tiers`, `user_retention_tiers`, `device_retention_tiers`, `action_retention_tiers`, `blueprint_retention_tiers`, `retention_runs`, `retention_run_kinds`, `retention_activity`                                                                                                                                                                                                                                     |
| 7    | Blueprints (F10 — admin definition + user instance)                                  | `blueprints`, `blueprint_slots`, `blueprint_params`, `blueprint_profiles`, `blueprint_phases`, `blueprint_phase_targets`, `blueprint_scene_templates`, `blueprint_scene_template_members`, `blueprint_rule_templates`, `blueprint_rule_template_conditions`, `blueprint_rule_template_actions`, `blueprint_pipeline_templates`, `blueprint_pipeline_template_sensors`, `blueprint_pipeline_template_stages`, `blueprint_pipeline_template_triggers`, `blueprint_instances`, `blueprint_slot_bindings`, `blueprint_param_overrides`, `blueprint_instance_phase_state`, `blueprint_binding_phase_state`, `blueprint_binding_param_overrides` |

---

## ER Diagram

```mermaid
erDiagram
  %% ── Tier 0: external catalog ──
  GoogleActionType {
    int id PK
    string value UK "action.devices.types.*"
  }
  GoogleDeviceTrait {
    int id PK
    string value UK "action.devices.traits.*"
    json valid_parameters "external Google contract"
  }
  RetentionBucket {
    string code PK "raw|5m|15m|1h|1d|1w|… user-added"
    int seconds "0 = the raw sentinel, which is not a duration"
    string label
    int anchor_offset_seconds "1w carries 345600 — the epoch is a Thursday"
    bool is_builtin "seeded; undeletable"
    int created_by_user_id FK "nullable; any user may add a size"
    datetime created_at
  }

  %% ── Tier 1: device & ML catalog ──
  Device {
    int id PK
    string type
    string version
    string default_name UK
    bool is_sealed "factory-soldered; admin-composed template"
  }
  DeviceCapability {
    int id PK
    int device_id FK
    string capability_key "stable per-device key"
    string label
    string implementation_type
    string mqtt_action_type
    string mqtt_action_name
    int min_telemetry_interval_ms
    int google_type_id FK "nullable"
  }
  DeviceCapabilityTrait {
    int id PK
    int capability_id FK
    int google_trait_id FK
  }
  DeviceCapabilityPin {
    int id PK
    int capability_id FK
    string key
    string label
    string mode "INPUT/OUTPUT"
  }
  CapabilityConfiguration {
    int id PK
    int capability_id FK
    string behavior "command/interval/on_demand"
    int min_interval_ms "interval floor; nullable"
  }
  SealedTemplate {
    int id PK
    string name UK
    string status "draft/released"
  }
  SealedTemplateTarget {
    int id PK
    int template_id FK
    string device_type
    string version_min
    string version_max
  }
  SealedTemplateEntry {
    int id PK
    int template_id FK
    string capability_key "resolved per version"
    string mqtt_action_name "per-instance routing verb; unique per template"
    string action_label
    string default_trait_value "nullable"
    int sort_order
  }
  SealedTemplateEntryPin {
    int id PK
    int entry_id FK
    string pin_slot_key
    int pin_number "fixed GPIO"
  }
  SealedTemplateEntryBehavior {
    int id PK
    int entry_id FK
    string behavior "command/interval/on_demand"
    int interval_ms "nullable"
    string camera_resolution "nullable"
    string camera_transport "nullable"
  }
  MlModel {
    int id PK
    string kind "vlm/llm"
    string name
    string version
    string backend "onnx/ollama"
    json classes "model metadata"
    json config "model metadata"
  }

  %% ── Tier 2: identity ──
  User {
    int id PK
    string email UK
    string user_role
    string google_id UK "nullable"
    bool email_verified
    string email_verification_token UK "nullable"
  }
  NotificationPreference {
    int id PK
    int user_id FK
    string channel "in_app/email/push/sms"
    string event_type
    bool enabled
  }
  NotificationHistory {
    int id PK
    int user_id FK
    string event_type
    string title
    string body
    json data "nullable"
    string_array channels
    datetime read_at "nullable"
    datetime deleted_at "nullable"
  }
  PushSubscription {
    int id PK
    int user_id FK
    string endpoint UK "browser push service URL"
    string p256dh "encryption key"
    string auth "encryption key"
    string user_agent "nullable"
  }
  MqttUser {
    int id PK
    string username UK
    string password_hash
    bool is_superuser
  }
  UserLoginAudit {
    int id PK
    int user_id FK
    datetime login_at
    string ip_address
  }

  %% ── Tier 3: user devices & actions ──
  UserDevice {
    int id PK
    int device_type_id FK "current Device"
    int user_id FK
    string mac_id UK
    string name
    bool online
    string status "provisioning | active"
    int rssi "heartbeat WiFi dBm; nullable"
    datetime last_heartbeat_at "nullable"
    int pending_device_type_id FK "nullable"
    datetime pending_since "OTA dispatched at; nullable"
    int area_id FK "nullable"
  }
  UserActionGroup {
    int id PK
    int user_id FK
    string name
    int sort_order "dashboard card position"
  }
  Area {
    int id PK
    int user_id FK
    string name
    int sort_order "dashboard section position"
  }
  UserDeviceAction {
    int id PK
    int user_device_id FK
    int capability_id FK
    int group_id FK "nullable"
    string action_name
    string mqtt_action_name
    string current_state
    datetime last_confirmed_at "nullable; last positive confirmation of current_state"
    string state_source "nullable; command-ack/telemetry/reconcile/boot-restore"
    string status "active/staged_*/deprecated"
    int sort_order "position within group"
    int telemetry_interval_ms
    string camera_resolution "nullable; CameraAction only, e.g. VGA/SVGA/XGA"
    string camera_transport "nullable; CameraAction only, ws/http, default http"
  }
  UserDeviceActionPin {
    int id PK
    int user_device_action_id FK
    int capability_pin_id FK "→ device_capability_pins.id"
    int pin_number "assigned GPIO"
  }
  UserActionConfiguration {
    int id PK
    int user_device_action_id FK
    int capability_configuration_id FK "→ capability_configurations.id"
    string behavior "enabled behavior"
    int interval_ms "chosen cadence; nullable"
    string camera_resolution "on_demand camera; nullable"
    string camera_transport "on_demand camera; nullable"
  }

  %% ── Tier 4: automation (rules) ──
  UserRule {
    int id PK
    int user_id FK
    string name
    bool enabled
    bool is_emergency "fast-path safety rule"
    string condition_operator "AND/OR"
    int cooldown_seconds
    int area_id FK "nullable"
    int blueprint_instance_id FK "nullable; derived from a blueprint"
    string blueprint_key "nullable; reconcile identity"
    string_array phase_scope "phase keys active in; empty = all phases"
    bool user_modified "user edited it ⇒ reconcile skips, shows as drift"
  }
  UserRuleCondition {
    int id PK
    int rule_id FK
    string condition_type "threshold/device_status/schedule/vlm"
    int user_device_action_id FK "threshold, nullable"
    string operator "threshold"
    string threshold_value "threshold"
    int user_device_id FK "device_status, nullable"
    string status_value "online/offline"
    string schedule_time "HH:MM or a reference"
    int_array schedule_days "0=Sun..6=Sat"
  }
  UserRuleAction {
    int id PK
    int rule_id FK
    int user_device_action_id FK
    string target_state
    string delay_seconds "literal or reference"
    string duration_seconds "device holds it this long; literal or reference"
  }
  UserRuleEvent {
    int id PK
    int rule_id FK
    string triggered_value
    datetime fired_at
  }
  Scene {
    int id PK
    int user_id FK
    string name "unique per user"
    int sort_order
    int area_id FK "nullable"
    int blueprint_instance_id FK "nullable; derived from a blueprint"
    string blueprint_key "nullable; reconcile identity"
    string_array phase_scope "phase keys offered in; empty = all phases"
    bool user_modified "user edited it ⇒ reconcile skips, shows as drift"
  }
  SceneMember {
    int id PK
    int scene_id FK
    int user_device_action_id FK
    string target_state
    int sort_order
    string delay_seconds "stagger; literal or reference"
    string duration_seconds "device holds it this long; literal or reference"
  }

  %% ── Tier 5: pipelines ──
  Pipeline {
    int id PK
    int user_id FK
    string name
    bool enabled
    int area_id FK "nullable"
    int blueprint_instance_id FK "nullable; derived from a blueprint"
    string blueprint_key "nullable; reconcile identity"
    string_array phase_scope "phase keys triggers are live in; empty = all phases"
    bool user_modified "user edited it ⇒ reconcile skips, shows as drift"
  }
  PipelineSensor {
    int id PK
    int pipeline_id FK
    int user_device_action_id FK
    string group_name
    string description "required LLM context note"
    bool inject_as_sensor "default true; include in historic digest + current state"
    bool inject_as_action "default false; include in LLM available_actions"
    string min_value
    string max_value
    string compression "average/last_n/min_max/min_max_avg/time_series"
    int window_minutes "default 60"
    int n "nullable; required for last_n"
  }
  PipelineStage {
    int id PK
    int pipeline_id FK
    int ordinal
    string kind "enrich/infer/command_exec"
    int ml_model_id FK "nullable"
    string prompt_template "infer; may embed refs"
    string notify "command_exec"
    string execute_condition "command_exec"
  }
  PipelineTrigger {
    int id PK
    int pipeline_id FK
    string trigger_type "telemetry/schedule/manual"
    int user_device_action_id FK "nullable"
    string operator
    string threshold_value
    string schedule_cron
    int min_interval_sec
    datetime last_fired_at "nullable; cooldown clock"
  }
  PipelineRun {
    int id PK
    int pipeline_id FK
    string status "queued/running/completed/failed"
    string trigger_type "manual/sensor_threshold/schedule"
    json trigger_payload "ML audit blob"
    bool is_dry_run "default false"
    json sensor_overrides "nullable; dry-run override map"
    datetime started_at
    datetime completed_at
  }
  PipelineRunStage {
    int id PK
    int run_id FK
    int stage_id FK
    string status
    json input "ML audit blob"
    json output "ML audit blob"
  }

  %% ── Tier 6: telemetry ──
  %% Raw tiers (SensorHistory, DeviceCommand) + the derived rollups and the retention policy.
  SensorRollup {
    int id PK
    int user_device_action_id FK
    string bucket FK "retention_buckets.code — was hour|day in Phase 1"
    datetime bucket_start "UTC, truncated to the bucket"
    int sample_count "every reading"
    int numeric_count "those that parsed as a number"
    int error_count
    float min_value "null when nothing numeric"
    float max_value
    float avg_value
    string last_value "the only summary a non-numeric series has"
  }

  DeviceEvent {
    int id PK
    int user_id FK
    int user_device_id FK
    string kind "online|offline|firmware|fault|config"
    string from_value "nullable"
    string to_value "nullable"
    json detail "nullable"
    datetime recorded_at
  }

  DeviceAvailabilityDaily {
    int id PK
    int user_device_id FK
    date day
    int online_seconds
    int offline_seconds
    int transitions
  }

  CameraFrameHistory {
    int id PK
    int user_device_action_id FK
    string value "base64 jpeg"
    int byte_size "decoded size, for the storage panel"
    datetime recorded_at
  }

  CommandRollupDaily {
    int id PK
    int user_device_action_id FK
    date day
    string source
    string status
    int count
  }

  RetentionPolicy {
    int id PK
    string data_kind UK "scalar|frame|command|device_event"
    int default_raw_days "0 = forever"
    int default_hourly_days "nullable"
    int default_daily_days "nullable"
    int max_raw_days "ceiling; NULL = uncapped"
    int max_hourly_days
    int max_daily_days
    boolean enabled
    string min_bucket FK "finest SUMMARY allowed; never binds raw"
    int updated_by_user_id FK "nullable"
    datetime updated_at
  }

  UserRetentionPreference {
    int id PK
    int user_id FK
    string data_kind
    int raw_days "0 = forever"
    int hourly_days "nullable"
    int daily_days "nullable"
    datetime updated_at
  }

  %% ── Tier 6: retention tiers (F18.9). The tier list IS the configuration for one
  %% (scope, data_kind); raw is position 0 of it, not a separate window. Resolution runs
  %% action → device → blueprint → user → platform and THE WHOLE LIST WINS.
  RetentionPolicyTier {
    int id PK
    string data_kind FK
    string bucket FK
    int keep_days "0 = forever"
    int max_keep_days "the ceiling; NULL = uncapped. Platform only"
    int position
    int updated_by_user_id FK "nullable"
    datetime updated_at
  }

  UserRetentionTier {
    int id PK
    int user_id FK
    string data_kind
    string bucket FK
    int keep_days "0 = forever"
    int position
    datetime updated_at
  }

  DeviceRetentionTier {
    int id PK
    int user_device_id FK
    string data_kind
    string bucket FK
    int keep_days
    int position
    datetime updated_at
  }

  ActionRetentionTier {
    int id PK
    int user_device_action_id FK
    string data_kind
    string bucket FK
    int keep_days
    int position
    datetime updated_at
  }

  BlueprintRetentionTier {
    int id PK
    int blueprint_id FK
    string slot_key "plain string; survives a v2 publish"
    string action_name "mqtt_action_name"
    string data_kind
    string bucket FK
    int keep_days
    int position
    datetime updated_at
  }

  RetentionRun {
    int id PK
    string trigger "cron|admin|user"
    string status "queued|running|ok|failed"
    string phase "rollup:scalar | prune:frame — live progress"
    int requested_by_user_id FK "nullable"
    int scope_user_id "non-null = a user-scoped sweep; read from HERE, not the queue payload"
    string lock_key UK "global | user:<id>; NULL once terminal"
    datetime queued_at
    datetime started_at "nullable"
    datetime finished_at "nullable"
    int duration_ms "nullable"
    string error "nullable"
  }

  RetentionRunKind {
    int id PK
    int run_id FK
    string data_kind
    int buckets_written
    int rows_deleted
    bigint bytes_reclaimed
    bool bytes_estimated "false only for frames, which sum byte_size"
  }

  RetentionActivity {
    int id PK
    datetime at
    string action "tiers_changed|policy_changed|bucket_created|sweep_finished|data_trimmed|..."
    string scope "platform|user|device|action|blueprint|catalog"
    string actor_kind "user|admin|cron|system"
    int actor_user_id FK "nullable — SetNull, so closing an account cannot erase who acted"
    string actor_name "denormalized: the id goes, the name stays"
    int subject_user_id FK "nullable — whose data it concerned"
    int subject_ref_id "nullable — device / action / blueprint id"
    string subject_label "its name AT THE TIME, so a rename does not rewrite history"
    string data_kind "nullable"
    string summary "the human line: raw 30d → 7d, added 15m kept 90d"
    json before "nullable"
    json after "nullable"
    int run_id FK "nullable — the sweep this entry belongs to"
  }

  SensorHistory {
    int id PK
    int user_device_action_id FK
    string value "nullable; scalar or base64 image, NULL on fault"
    boolean is_error "fault reading flag"
    string error_code "fault envelope code, e.g. read_failed"
    datetime recorded_at
  }

  DeviceCommand {
    int id PK
    int user_id FK
    int user_device_id FK "nullable"
    int user_device_action_id FK "nullable"
    string action_name
    string target_state
    int duration_seconds "device-held hold, null = indefinite"
    string source "manual|rule|scene|pipeline|phase|device|system"
    int source_ref_id "the rule/scene/pipeline row"
    string source_label "its name at dispatch time"
    string status "sent|ok|error|timeout"
    string command_id "unique; echoed by the device on its ack"
    string result_value "what the device reported back"
    datetime dispatched_at
    datetime settled_at "when the ack (or timeout) landed"
  }

  %% ── Tier 7: blueprints (F10) ──
  Blueprint {
    int id PK
    string key UK "stable identifier"
    string name
    string description "nullable"
    int version "bumped on publish, not on edit"
    string status "draft | published"
    string context_notes "nullable; setup context for the LLM"
    datetime created_at
    datetime updated_at
  }
  BlueprintSlot {
    int id PK
    int blueprint_id FK
    string key "referenced by templates + bindings"
    string label
    boolean required
    int min_count
    int max_count
    int sealed_template_id FK "the only match path"
    int sort_order
  }
  BlueprintParam {
    int id PK
    int blueprint_id FK
    string key "what @param./@phase. resolves against"
    string label
    string default_value
    string unit "nullable"
    boolean user_tunable "false = phase-driven only"
    int sort_order
  }
  BlueprintField {
    int id PK
    int blueprint_id FK
    string key "what @field.key resolves against"
    string label "the question"
    string input_type "text|number|select|date|boolean"
    string scope "setup | binding"
    string slot_key "nullable; scope=binding: whose devices"
    boolean required
    string default_value "nullable"
  }
  BlueprintFieldOption {
    int id PK
    int field_id FK
    string value "what @field.key resolves to"
    string label
    string profile_key "nullable; picking this sets the lifecycle"
  }
  BlueprintInstanceFieldValue {
    int id PK
    int instance_id FK
    string field_key
    string value "the user's answer for the setup"
  }
  BlueprintBindingFieldValue {
    int id PK
    int binding_id FK
    string field_key
    string value "the user's answer for ONE device"
  }
  BlueprintProfile {
    int id PK
    int blueprint_id FK
    string key "lifecycle a binding follows"
    string label
    int sort_order
  }
  BlueprintPhase {
    int id PK
    int profile_id FK "phases belong to a PROFILE, not the blueprint"
    string key
    string name
    int ordinal
    string duration_value "literal or @param. reference (F11.13); nullable"
    string duration_unit "seconds | minutes | hours | days | weeks | months"
    string advance_mode "manual | schedule | rule | pipeline"
    string advance_ref_key "nullable; rule/pipeline template key for rule|pipeline"
    string advance_to_key "nullable; target phase key in this profile; null = next"
    string context_notes "nullable; @phase.context_notes"
  }
  BlueprintPhaseTarget {
    int id PK
    int phase_id FK
    string param_key
    string value "what this phase sets the param to"
  }
  BlueprintSceneTemplate {
    int id PK
    int blueprint_id FK
    string key "reconcile identity"
    string name
    int sort_order
    string_array phase_scope "phase keys offered in; empty = all"
  }
  BlueprintSceneTemplateMember {
    int id PK
    int template_id FK
    string slot_key "with action_name, replaces user_device_action_id"
    string action_name "sealed template entry mqtt_action_name"
    string target_state "literal OR @param./@phase. ref"
    int sort_order
    string delay_seconds "literal OR ref"
    string duration_seconds "device holds it this long; literal OR ref"
  }
  BlueprintRuleTemplate {
    int id PK
    int blueprint_id FK
    string key "reconcile identity"
    string name
    boolean is_emergency
    string condition_operator "AND | OR"
    int cooldown_seconds
    string_array phase_scope "phase keys active in; empty = all"
  }
  BlueprintRuleTemplateCondition {
    int id PK
    int template_id FK
    string condition_type "threshold | device_status | schedule"
    string slot_key "nullable"
    string action_name "nullable"
    string operator "nullable"
    string threshold_value "literal OR @phase. ref"
    string status_value "nullable"
    string schedule_time "nullable; HH:MM OR @phase. ref"
    int_array schedule_days
  }
  BlueprintRuleTemplateAction {
    int id PK
    int template_id FK
    string slot_key
    string action_name
    string target_state "literal OR @param. ref"
    string delay_seconds "literal OR ref"
    string duration_seconds "device holds it this long; literal OR ref"
  }
  BlueprintPipelineTemplate {
    int id PK
    int blueprint_id FK
    string key "reconcile identity"
    string name
    boolean enabled
    string_array phase_scope "phase keys triggers live in; empty = all"
  }
  BlueprintPipelineTemplateSensor {
    int id PK
    int template_id FK
    string group_name
    string description
    string slot_key
    string action_name
    boolean inject_as_sensor
    boolean inject_as_action
    string min_value "literal OR @phase. ref"
    string max_value "literal OR @phase. ref"
    string compression
    int window_minutes
    int n "nullable"
  }
  BlueprintPipelineTemplateStage {
    int id PK
    int template_id FK
    int ordinal
    string kind
    int ml_model_id FK "nullable"
    string prompt_template "may embed refs"
    string notify "command_exec"
    string execute_condition "command_exec"
  }
  BlueprintPipelineTemplateTrigger {
    int id PK
    int template_id FK
    string trigger_type
    string slot_key "nullable"
    string action_name "nullable"
    string operator "nullable"
    string threshold_value "literal OR a ref"
    string schedule_cron "nullable"
    int min_interval_sec "nullable"
  }
  BlueprintInstance {
    int id PK
    int user_id FK
    int blueprint_id FK
    int blueprint_version "derived from / reconciled to"
    int area_id FK
    string name
    string lifecycle_state "not_started | running | stopped — nothing acts unless running"
    int current_phase_id FK "nullable; a phase change writes ONLY this + phase_started_at"
    datetime phase_started_at "nullable; start of the CURRENT visit, null whenever parked"
    datetime created_at
    datetime updated_at
  }
  BlueprintSlotBinding {
    int id PK
    int instance_id FK
    string slot_key "plain string, survives template edits"
    int user_device_id FK
    boolean auto_bound "bound with no user input"
    string label "nullable; what the user calls this one"
    string profile_key "nullable; null = shared device, no lifecycle"
    string lifecycle_state "per-binding; live only if the setup is too"
    int current_phase_id FK "nullable"
    datetime phase_started_at "nullable; start of THIS binding's run"
  }
  BlueprintBindingPhaseState {
    int id PK
    int binding_id FK
    string phase_key
    int accrued_seconds "banked per binding, per phase"
    datetime last_exited_at "nullable"
  }
  BlueprintBindingParamOverride {
    int id PK
    int binding_id FK
    string param_key
    string phase_key "empty = every phase"
    string value "beats the setup-wide override"
  }
  BlueprintParamOverride {
    int id PK
    int instance_id FK
    string param_key
    string phase_key "empty = every phase; else that phase only"
    string value "beats phase target and default"
  }
  BlueprintInstancePhaseState {
    int id PK
    int instance_id FK
    string phase_key "banked per phase, survives a v2"
    int accrued_seconds "time from PREVIOUS visits; current run is live"
    datetime last_exited_at "nullable"
    datetime updated_at
  }

  %% ── Relationships ──
  Device                ||--o{ DeviceCapability       : "declares"
  GoogleActionType      |o--o{ DeviceCapability       : "google type"
  DeviceCapability      ||--o{ DeviceCapabilityTrait  : "has"
  GoogleDeviceTrait     ||--o{ DeviceCapabilityTrait  : "google trait"
  DeviceCapability      ||--o{ DeviceCapabilityPin    : "pin slots"
  DeviceCapability      ||--o{ CapabilityConfiguration : "supported behaviors"
  DeviceCapability      ||--o{ UserDeviceAction       : "instantiated as"

  SealedTemplate        ||--o{ SealedTemplateTarget   : "covers (type, version range)"
  SealedTemplate        ||--o{ SealedTemplateEntry    : "activates capabilities"
  SealedTemplateEntry   ||--o{ SealedTemplateEntryPin : "fixed pins"
  SealedTemplateEntry   ||--o{ SealedTemplateEntryBehavior : "enabled behaviors"

  Device                ||--o{ UserDevice             : "current model"
  Device                |o--o{ UserDevice             : "pending model"
  User                  ||--o{ UserDevice             : "owns"
  User                  ||--o{ UserActionGroup        : "owns"
  User                  ||--o{ Area                   : "owns"
  User                  ||--o{ UserRule               : "owns"
  User                  ||--o{ Pipeline               : "owns"
  User                  ||--o{ UserLoginAudit         : "logins"
  User                  ||--o{ NotificationPreference : "notification prefs"
  User                  ||--o{ NotificationHistory    : "notifications"
  User                  ||--o{ PushSubscription       : "push subscriptions"

  UserDevice            ||--o{ UserDeviceAction       : "has"
  UserDevice            |o--o{ UserRuleCondition      : "status checked by"
  UserActionGroup       |o--o{ UserDeviceAction       : "groups"
  Area                  |o--o{ UserDevice             : "sections"
  Area                  |o--o{ UserRule               : "scopes"
  Area                  |o--o{ Scene                  : "scopes"
  Area                  |o--o{ Pipeline               : "scopes"
  UserDeviceAction      ||--o{ UserDeviceActionPin    : "pin assignment"
  UserDeviceAction      ||--o{ UserActionConfiguration : "enabled behaviors"
  CapabilityConfiguration ||--o{ UserActionConfiguration : "selected from"

  UserRule              ||--o{ UserRuleCondition      : "when"
  UserRule              ||--o{ UserRuleAction         : "then"
  UserRule              ||--o{ UserRuleEvent          : "fired"
  UserDeviceAction      |o--o{ UserRuleCondition      : "reads"
  UserDeviceAction      ||--o{ UserRuleAction         : "commands"
  User                  ||--o{ Scene                  : "owns"
  Scene                 ||--o{ SceneMember            : "runs"
  UserDeviceAction      ||--o{ SceneMember            : "commands"

  MlModel               |o--o{ PipelineStage          : "runs"
  Pipeline              ||--o{ PipelineSensor         : "inputs"
  Pipeline              ||--o{ PipelineStage          : "steps"
  Pipeline              ||--o{ PipelineTrigger        : "fires on"
  Pipeline              ||--o{ PipelineRun            : "executions"
  PipelineRun           ||--o{ PipelineRunStage       : "per-stage record"
  PipelineStage         ||--o{ PipelineRunStage       : "definition of"
  UserDeviceAction      ||--o{ PipelineSensor         : "read by"
  UserDeviceAction      |o--o{ PipelineTrigger        : "triggers"

  UserDeviceAction      ||--o{ SensorHistory          : "readings"
  UserDeviceAction      |o--o{ DeviceCommand          : "commanded by"
  UserDevice            |o--o{ DeviceCommand          : "commands sent to"
  User                  ||--o{ DeviceCommand          : "issued"

  RetentionBucket       ||--o{ SensorRollup           : "granularity of"
  RetentionBucket       ||--o{ RetentionPolicy        : "finest summary allowed"
  RetentionBucket       ||--o{ RetentionPolicyTier    : "sized by"
  RetentionBucket       ||--o{ UserRetentionTier      : "sized by"
  RetentionBucket       ||--o{ DeviceRetentionTier    : "sized by"
  RetentionBucket       ||--o{ ActionRetentionTier    : "sized by"
  RetentionBucket       ||--o{ BlueprintRetentionTier : "sized by"
  User                  |o--o{ RetentionBucket        : "added custom size"
  RetentionPolicy       ||--o{ RetentionPolicyTier    : "platform tier list"
  User                  ||--o{ UserRetentionTier      : "my tier list"
  UserDevice            ||--o{ DeviceRetentionTier    : "this device's tier list"
  UserDeviceAction      ||--o{ ActionRetentionTier    : "this sensor's tier list"
  Blueprint             ||--o{ BlueprintRetentionTier : "ships tiers for its slots"
  User                  |o--o{ RetentionRun           : "requested sweep"
  RetentionRun          ||--o{ RetentionRunKind       : "per-kind counters"
  RetentionRun          |o--o{ RetentionActivity      : "entries about this sweep"
  User                  |o--o{ RetentionActivity      : "acted / was subject"

  Blueprint             ||--o{ BlueprintSlot          : "requires devices"
  Blueprint             ||--o{ BlueprintParam         : "declares tuning surface"
  Blueprint             ||--o{ BlueprintProfile       : "lifecycles offered"
  BlueprintProfile      ||--o{ BlueprintPhase         : "lifecycle"
  Blueprint             ||--o{ BlueprintSceneTemplate : "scene templates"
  Blueprint             ||--o{ BlueprintRuleTemplate  : "rule templates"
  Blueprint             ||--o{ BlueprintPipelineTemplate : "pipeline templates"
  SealedTemplate        ||--o{ BlueprintSlot          : "qualifies devices for"
  BlueprintPhase        ||--o{ BlueprintPhaseTarget   : "sets params"
  BlueprintSceneTemplate ||--o{ BlueprintSceneTemplateMember : "members"
  BlueprintRuleTemplate ||--o{ BlueprintRuleTemplateCondition : "when"
  BlueprintRuleTemplate ||--o{ BlueprintRuleTemplateAction : "then"
  BlueprintPipelineTemplate ||--o{ BlueprintPipelineTemplateSensor : "inputs"
  BlueprintPipelineTemplate ||--o{ BlueprintPipelineTemplateStage : "steps"
  BlueprintPipelineTemplate ||--o{ BlueprintPipelineTemplateTrigger : "fires on"
  MlModel               |o--o{ BlueprintPipelineTemplateStage : "runs"

  User                  ||--o{ BlueprintInstance      : "owns"
  Blueprint             ||--o{ BlueprintInstance      : "derived as"
  Area                  ||--o{ BlueprintInstance      : "contains"
  BlueprintPhase        |o--o{ BlueprintInstance      : "current phase of"
  BlueprintInstance     ||--o{ BlueprintSlotBinding   : "binds slots"
  BlueprintInstance     ||--o{ BlueprintParamOverride : "user tuning"
  BlueprintInstance     ||--o{ BlueprintInstancePhaseState : "banked phase time"
  UserDevice            ||--o{ BlueprintSlotBinding   : "bound to slot"
  Blueprint             ||--o{ BlueprintField        : "asks"
  BlueprintField        ||--o{ BlueprintFieldOption   : "offers"
  BlueprintInstance     ||--o{ BlueprintInstanceFieldValue : "answered"
  BlueprintSlotBinding  ||--o{ BlueprintBindingFieldValue  : "answered per device"
  BlueprintSlotBinding  |o--o{ Scene                  : "per_device scene"
  BlueprintSlotBinding  |o--o{ UserRule               : "per_device rule"
  BlueprintSlotBinding  |o--o{ Pipeline               : "per_device pipeline"
  BlueprintPhase        |o--o{ BlueprintSlotBinding   : "current phase of binding"
  BlueprintSlotBinding  ||--o{ BlueprintBindingPhaseState : "banked binding time"
  BlueprintSlotBinding  ||--o{ BlueprintBindingParamOverride : "per-binding tuning"
  BlueprintInstance     |o--o{ Scene                  : "derived"
  BlueprintInstance     |o--o{ UserRule               : "derived"
  BlueprintInstance     |o--o{ Pipeline               : "derived"
```

---

## Table reference + examples

### Tier 0 — External catalog

#### `google_action_types`

| id  | name   | value                         |
| --- | ------ | ----------------------------- |
| 1   | Switch | `action.devices.types.SWITCH` |
| 2   | Sensor | `action.devices.types.SENSOR` |

#### `google_device_traits`

`valid_parameters` is JSON — a seed-authored, canonical accepted-value constraint per Google trait (one of `{"type":"enum","values":[...]}`, `{"type":"range","min","max","step"}`, or `{"type":"pattern","regex":"..."}`). This is the single source of truth for "what values can this trait take" — it lives on the trait, not the capability, because it's a property of Google's protocol contract (OnOff is always on/off, Brightness is always 0–100), not of any specific device's hardware. A capability's actual accepted values are _derived_ at read/validation time by unioning the `valid_parameters` of all traits it declares via `device_capability_traits` (see `@lattice/capability-validation`'s `deriveValidParameters()`) — e.g. the `dimmer` capability (OnOff + Brightness traits) derives to `{"type":"range","min":0,"max":100,"step":1,"aliases":["on","off"]}`. Consumed by dispatch validation (digest-service, google-home EXECUTE) and ml-router prompt enrichment.

| id  | name       | value                              | valid_parameters                              |
| --- | ---------- | ---------------------------------- | --------------------------------------------- |
| 1   | On / Off   | `action.devices.traits.OnOff`      | `{"type":"enum","values":["on","off"]}`       |
| 2   | Brightness | `action.devices.traits.Brightness` | `{"type":"range","min":0,"max":100,"step":1}` |

#### `retention_buckets` (`RetentionBucket`) — the bucket vocabulary, and **the only Tier 0 table users write to**. Seeded with nine codes (`raw`, `5m`, `15m`, `30m`, `1h`, `6h`, `12h`, `1d`, `1w`); **any user may add a size** — `90m`, `45m`, `4h` — with no release. It sits in Tier 0 rather than Tier 6 because it is what everything else FKs into: `sensor_rollup.bucket`, `retention_policy.min_bucket`, and the `bucket` column of all five tier tables, every one of them `ON DELETE RESTRICT` so removing a size can never cascade into deleting the history stored under it.

**One shared catalog, not one per user.** A bucket size is a unit, not personal data: two users who both want 90 minutes want the same 5400 seconds, so they share a row and adding an existing code reuses it. A per-user catalog would need either a second table (and then `sensor_rollup.bucket` could not FK to both) or a nullable owner in the unique key, which Postgres's NULL-distinct rule makes unsafe. What stays private is the part that actually is private: **which** buckets you keep and for how long, in your own tier list.

Flooring is generic — `floor((epoch − anchor) / seconds) * seconds + anchor` — so a size the catalog has never seen floors correctly the first time it is used. `anchor_offset_seconds` exists for the one seeded row where the epoch grid is wrong: `1w` floored on multiples of 604 800 lands on a **Thursday** (1 Jan 1970 was one), so it carries 345 600 to move the grid to Monday. What code keeps is only what a row cannot express — the admission rules (≥ 60 s, and either divides a day evenly or is whole days), the chain-divisibility rule, and the per-kind limits. All of it lives in `@lattice/retention`. **`seconds` is frozen once any `sensor_rollup` row uses the code** (existing rows were aggregated at the old width, and changing it would silently reinterpret them), so the API offers no `PATCH` of it at all. Calendar buckets (`1mo`) are **not expressible** — a month is not a fixed number of seconds.

| code | seconds | label        | anchor_offset_seconds | is_builtin | created_by_user_id |
| ---- | ------- | ------------ | --------------------- | ---------- | ------------------ |
| raw  | 0       | Raw readings | 0                     | true       | NULL               |
| 15m  | 900     | 15 minutes   | 0                     | true       | NULL               |
| 1d   | 86400   | 1 day        | 0                     | true       | NULL               |
| 1w   | 604800  | 1 week       | 345600                | true       | NULL               |
| 90m  | 5400    | 90 minutes   | 0                     | false      | 1                  |

### Tier 1 — Device & ML catalog

#### `devices` — device models (type + firmware version). Unique `(type, version)`. `is_sealed=true` (seeded from the firmware `SEALED` marker) marks factory-soldered types whose config is admin-composed via a sealed template rather than user-configured.

| id  | type       | version | default_name          | is_sealed |
| --- | ---------- | ------- | --------------------- | --------- |
| 1   | env-node   | v2.0.0  | Environment Node      | false     |
| 2   | env-node   | v2.1.0  | Environment Node v2.1 | false     |
| 3   | outlet-4ch | v2.0.0  | 4-Channel Outlet      | true      |

#### `device_capabilities` (`DeviceCapability`) — single per-version capability catalog. Unique `(device_id, capability_key)`.

| id  | device_id | capability_key | label       | implementation_type     | mqtt_action_type | mqtt_action_name | min_telemetry_interval_ms | google_type_id |
| --- | --------- | -------------- | ----------- | ----------------------- | ---------------- | ---------------- | ------------------------- | -------------- |
| 10  | 1         | temperature    | Temperature | TemperatureSensorAction | telemetry        | temperature      | 5000                      | 2              |
| 11  | 1         | relay1         | Relay 1     | DigitalOutputAction     | command          | relay1           | NULL                      | 1              |
| 12  | 1         | cam            | Camera      | TakePictureHttpAction   | telemetry        | cam              | NULL                      | NULL           |

#### `device_capability_traits` (`DeviceCapabilityTrait`) — capability ↔ google trait. Unique `(capability_id, google_trait_id)`. `is_default=true` marks the catalog-level default display trait for a capability (at most one per `capability_id`, enforced by the repository — not a DB constraint). Set via `PATCH /api/device-config/capabilities/:id/traits/:traitId/default`.

| id  | capability_id | google_trait_id | is_default |
| --- | ------------- | --------------- | ---------- |
| 1   | 11            | 1 (OnOff)       | false      |
| 2   | 11            | 5 (FanSpeed)    | true       |

#### `device_capability_pins` (`DeviceCapabilityPin`) — declared pin slots. Unique `(capability_id, key)`.

| id  | capability_id | key | label      | mode   |
| --- | ------------- | --- | ---------- | ------ |
| 1   | 11            | out | Output pin | OUTPUT |

#### `capability_configurations` (`CapabilityConfiguration`) — behaviors a capability supports, firmware-generated into the catalog. Unique `(capability_id, behavior)`. `behavior ∈ {command, interval, on_demand}`. Per-behavior limits are typed columns (nullable, set only where meaningful — same pattern as `user_rule_conditions`): `min_interval_ms` is the hardware floor for `interval`; `command` validation comes from the capability's traits; `on_demand` needs no catalog limits.

| id  | capability_id | behavior  | min_interval_ms |
| --- | ------------- | --------- | --------------- |
| 1   | 11 (outlet)   | command   | NULL            |
| 2   | 12 (temp)     | interval  | 2000            |
| 3   | 12 (temp)     | on_demand | NULL            |
| 4   | 15 (camera)   | on_demand | NULL            |

#### `sealed_templates` (`SealedTemplate`) — admin authoring layer for sealed devices. Unique `name`. `status ∈ {draft, released}`; only `released` templates materialize. Composing/releasing/editing a template re-applies its actions to every already-provisioned matching device (via the "apply migration" staging flow). The catalog itself stays append-only — only these tables + user instances mutate.

| id  | name              | status   |
| --- | ----------------- | -------- |
| 1   | 4-Ch Outlet (2.x) | released |

#### `sealed_template_targets` (`SealedTemplateTarget`) — which `(device_type, firmware version range)` a template covers. A device matches when `type == device_type AND version_min <= version <= version_max` (inclusive, `vX.Y.Z` compare). One template may have several targets.

| id  | template_id | device_type | version_min | version_max |
| --- | ----------- | ----------- | ----------- | ----------- |
| 1   | 1           | outlet-4ch  | v2.0.0      | v2.9.9      |

#### `sealed_template_entries` (`SealedTemplateEntry`) — one activated capability **instance**, resolved per version by `capability_key`. A capability may appear more than once per template (e.g. 8 `i2c_socket_8` channels), so `mqtt_action_name` (base capability name, then `<base>_2`/`_3`/… for repeats — mirrors `user_device_actions`) is the unique key: unique `(template_id, mqtt_action_name)`. `default_trait_value` is a `GoogleDeviceTrait.value` (resolved per version), nullable.

| id  | template_id | capability_key | mqtt_action_name | action_label | default_trait_value           | sort_order |
| --- | ----------- | -------------- | ---------------- | ------------ | ----------------------------- | ---------- |
| 1   | 1           | i2c_socket_8   | socket           | Socket 1     | `action.devices.traits.OnOff` | 0          |
| 2   | 1           | i2c_socket_8   | socket_2         | Socket 2     | `action.devices.traits.OnOff` | 1          |

#### `sealed_template_entry_pins` (`SealedTemplateEntryPin`) — fixed GPIO the admin assigned to a capability's pin slot (`DeviceCapabilityPin.key`). Unique `(entry_id, pin_slot_key)`.

| id  | entry_id | pin_slot_key | pin_number |
| --- | -------- | ------------ | ---------- |
| 1   | 1        | out          | 4          |

#### `sealed_template_entry_behaviors` (`SealedTemplateEntryBehavior`) — enabled behavior + chosen values (mirrors `user_action_configurations`). Unique `(entry_id, behavior)`.

| id  | entry_id | behavior | interval_ms | camera_resolution | camera_transport |
| --- | -------- | -------- | ----------- | ----------------- | ---------------- |
| 1   | 1        | command  | NULL        | NULL              | NULL             |

#### `ml_models` (`MlModel`) — system ML registry. Unique `(kind, name, version)`. `classes`/`config` JSON = per-model metadata.

| id  | kind | name       | version | backend | model_file | ollama_model | classes |
| --- | ---- | ---------- | ------- | ------- | ---------- | ------------ | ------- |
| 1   | llm  | groq       | v1      | openai  | NULL       | NULL         | NULL    |
| 2   | llm  | gemini     | v1      | openai  | NULL       | NULL         | NULL    |
| 3   | llm  | cerebras   | v1      | openai  | NULL       | NULL         | NULL    |
| 4   | llm  | openrouter | v1      | openai  | NULL       | NULL         | NULL    |

> `openai`-backend rows carry no `ollama_model`; the executor resolves their remote endpoint
> (`baseUrl`/`apiModel`/`apiKeyEnv`) from `services/ml-executor/models.json`, the seed source.
>
> The `vlm` kind (local ONNX/YOLO detector) is still fully supported by the executor and the
> pipeline coordinator but is **parked** — no `vlm` row is seeded, so no vision stage is offered
> in the editor. A camera item's frame now flows from the enrich stage straight to a multimodal
> LLM. Re-enable by adding a `vlm` entry back to `models.json` and un-hiding the editor control.

### Tier 2 — Identity

#### `users` (`User`) — `email_verified` gates credential login (F15.8); Google accounts are created verified. `email_verification_token` holds the pending single-use verify token (NULL once used). `timezone` is the IANA zone every schedule this user writes is read against (F11.11) — NULL means the evaluating process's own zone, which is UTC in a container; the client sets it from the browser on first sign-in.

| id  | email             | user_role | google_id | email_verified | email_verification_token | timezone       |
| --- | ----------------- | --------- | --------- | -------------- | ------------------------ | -------------- |
| 1   | owner@example.com | admin     | NULL      | true           | NULL                     | Asia/Jerusalem |
| 2   | alice@example.com | user      | 11522…    | true           | NULL                     | Europe/London  |
| 3   | bob@example.com   | user      | NULL      | false          | 7c3f…                    | NULL           |

#### `notification_preferences` (`NotificationPreference`) — per-user opt-in matrix. Unique `(user_id, channel, event_type)`. A missing row = service default; `enabled=false` is an explicit opt-out.

| id  | user_id | channel | event_type     | enabled |
| --- | ------- | ------- | -------------- | ------- |
| 1   | 2       | email   | device_offline | false   |
| 2   | 2       | push    | emergency      | true    |

#### `notification_history` (`NotificationHistory`) — delivered/attempted notifications backing the in-app inbox + unread badge. `read_at` NULL = unread; `deleted_at` non-NULL = soft-deleted (hidden from the inbox, kept on the DB); `channels` = the channels it fanned out to. Index `(user_id, created_at)`.

| id  | user_id | event_type    | title              | channels       | read_at |
| --- | ------- | ------------- | ------------------ | -------------- | ------- |
| 1   | 2       | ota_available | Firmware update    | {in_app,email} | NULL    |
| 2   | 2       | rule_fired    | Rule "Night" fired | {in_app}       | 2026-…  |

#### `push_subscriptions` (`PushSubscription`) — one row per subscribed browser/device (web-push). `endpoint` is the push service URL (unique — re-subscribing the same browser upserts, not duplicates); `p256dh`/`auth` are the subscription's encryption keys.

| id  | user_id | endpoint                           | p256dh | auth  | user_agent    |
| --- | ------- | ---------------------------------- | ------ | ----- | ------------- |
| 1   | 2       | https://fcm.googleapis.com/fcm/... | BNc4R… | k8J2… | Mozilla/5.0 … |

#### `mqtt_user` (`MqttUser`) — broker app auth (standalone, no FK)

| id  | username       | is_superuser |
| --- | -------------- | ------------ |
| 1   | ts_backend_app | true         |

#### `user_login_audit` (`UserLoginAudit`)

| id  | user_id | login_at             | ip_address  |
| --- | ------- | -------------------- | ----------- |
| 1   | 2       | 2026-06-26T08:00:00Z | 203.0.113.7 |

### Tier 3 — User devices & actions

#### `user_devices` (`UserDevice`) — a physical device a user owns. `rssi`/`last_heartbeat_at` hold the latest MQTT-heartbeat diagnostics (WiFi dBm); live-only, surfaced by the devices page while online.

`status` tracks setup: `provisioning` (registered, no actions yet — the devices list offers
"Finish setup") or `active`. Provisioning writes it on INSERT only, so re-provisioning an
already-configured device leaves it `active` and skips the wizard; sealed types go straight to
`active` because their actions are materialized from the admin template at provision time.

`pending_device_type_id`/`pending_firmware_version`/`pending_since` are the in-flight OTA: set
together when the user applies an update, cleared together when the device confirms the new
version or the update fails. While they are set the platform refuses a second dispatch for the
device — each one re-stages the migration and re-announces the firmware — until `pending_since`
falls outside the OTA window, after which the update is declared dead and can be retried.

| id  | device_type_id | user_id | mac_id            | name        | online | status | rssi | current_firmware_version | pending_device_type_id | pending_since |
| --- | -------------- | ------- | ----------------- | ----------- | ------ | ------ | ---- | ------------------------ | ---------------------- | ------------- |
| 7   | 1              | 2       | AA:BB:CC:00:11:22 | Garage Node | true   | active | -58  | v2.0.0                   | NULL                   | NULL          |

#### `user_action_groups` (`UserActionGroup`) — dashboard grouping. Unique `(user_id, name)`. `sort_order` = card position.

| id  | user_id | name   | sort_order |
| --- | ------- | ------ | ---------- |
| 1   | 2       | Garage | 0          |

#### `areas` (`Area`) — user-createable "these devices belong together" grouping (F10.0). Unique `(user_id, name)`, index `(user_id, sort_order)`. Independent of blueprints (a derive creates one and fills it). `user_devices`/`user_rules`/`scenes`/`pipelines` carry a nullable `area_id` (SET NULL on delete — removing an area only un-groups, never deletes). Powers dashboard sectioning + area-scoped notifications.

| id  | user_id | name         | sort_order |
| --- | ------- | ------------ | ---------- |
| 1   | 2       | Greenhouse A | 0          |

#### `user_device_actions` (`UserDeviceAction`) — an activated capability instance. Index `(user_device_id, mqtt_action_name)`. `sort_order` = position within group. `default_trait_id` (nullable FK → `google_device_traits`) = the user's chosen display trait; overrides the capability-level `is_default` when set. Resolution order: `default_trait_id` → catalog `is_default` trait → first trait. `camera_resolution`/`camera_transport` are only meaningful for a `CameraAction` instance (nullable, unused by every other implementation_type). `last_confirmed_at`/`state_source` record when the platform last had positive confirmation that `current_state` is what the device holds, and from which path — NULL/NULL means never confirmed. A command action only ever gets confirmed by an ack or a reconcile read-back; a telemetry action self-confirms on every cyclic reading.

| id  | user_device_id | capability_id | group_id | default_trait_id | action_name | mqtt_action_name | current_state | last_confirmed_at    | state_source | status | sort_order | camera_resolution | camera_transport |
| --- | -------------- | ------------- | -------- | ---------------- | ----------- | ---------------- | ------------- | -------------------- | ------------ | ------ | ---------- | ----------------- | ---------------- |
| 100 | 7              | 10            | 1        | NULL             | Garage Temp | temperature      | "23.4"        | 2026-08-19T10:42:03Z | telemetry    | active | 0          | NULL              | NULL             |
| 101 | 7              | 11            | 1        | 1                | Door Relay  | relay1           | "OFF"         | 2026-08-19T10:15:00Z | reconcile    | active | 1          | NULL              | NULL             |
| 102 | 7              | 12            | 1        | NULL             | Door Camera | camera           | NULL          | NULL                 | NULL         | active | 2          | SVGA              | http             |
| 103 | 7              | 13            | 1        | NULL             | Garage Cam  | cam              | NULL          | NULL                 | NULL         | active | 3          | NULL              | NULL             |

#### `user_device_action_pins` (`UserDeviceActionPin`) — per-instance GPIO assignment. `capability_pin_id` FK to the catalog slot (mode is read from there). Unique `(user_device_action_id, capability_pin_id)`.

| id  | user_device_action_id | key | pin_number |
| --- | --------------------- | --- | ---------- |
| 1   | 101                   | out | 5          |

#### `user_action_configurations` (`UserActionConfiguration`) — behaviors the user enabled on an action, with chosen values (typed columns, nullable per behavior). Unique `(user_device_action_id, behavior)`. `capability_configuration_id` FK to the catalog behavior it selects; validated against it on save (device-gateway). The device config endpoint resolves each behavior as user selection → catalog default → legacy column. `camera_resolution`/`camera_transport` fold here off `user_device_actions` (an `on_demand` camera row).

| id  | user_device_action_id | capability_configuration_id | behavior  | interval_ms | camera_resolution | camera_transport |
| --- | --------------------- | --------------------------- | --------- | ----------- | ----------------- | ---------------- |
| 1   | 100 (temp)            | 2                           | interval  | 15000       | NULL              | NULL             |
| 2   | 100 (temp)            | 3                           | on_demand | NULL        | NULL              | NULL             |
| 3   | 101 (relay)           | 1                           | command   | NULL        | NULL              | NULL             |
| 4   | 102 (camera)          | 4                           | on_demand | NULL        | SVGA              | http             |

### Tier 4 — Automation (rules; emergencies = `is_emergency` rules)

#### `user_rules` (`UserRule`) — `is_emergency=true` marks fast-path safety rules.

| id  | user_id | name                   | enabled | is_emergency | condition_operator | cooldown_seconds |
| --- | ------- | ---------------------- | ------- | ------------ | ------------------ | ---------------- |
| 50  | 2       | Hot garage → open vent | true    | false        | AND                | 60               |
| 51  | 2       | Overheat cutoff        | true    | true         | AND                | 30               |

Blueprint-derived rules also carry `phase_scope` (a `text[]` of phase keys). Empty — the default,
and always so for hand-written rules — means the rule is active in every phase; a non-empty set
makes the engine skip it unless the instance's current phase key is in it (`isPhaseInScope`,
`@lattice/params`). `scenes.phase_scope` and `pipelines.phase_scope` work the same way (a scene
gates on-demand execution/visibility; a pipeline gates its triggers).

#### `user_rule_conditions` (`UserRuleCondition`) — typed columns per `condition_type` (no JSON)

| id  | rule_id | condition_type | user_device_action_id | operator | threshold_value | user_device_id | status_value | schedule_time       | schedule_days |
| --- | ------- | -------------- | --------------------- | -------- | --------------- | -------------- | ------------ | ------------------- | ------------- |
| 80  | 50      | threshold      | 100                   | >        | 30              | NULL           | NULL         | NULL                | `{}`          |
| 81  | 50      | schedule       | NULL                  | NULL     | NULL            | NULL           | NULL         | 08:00               | `{1,2,3,4,5}` |
| 82  | 51      | threshold      | 100                   | >        | 45              | NULL           | NULL         | NULL                | `{}`          |
| 83  | 50      | device_status  | NULL                  | NULL     | NULL            | 7              | online       | NULL                | `{}`          |
| 84  | 52      | schedule       | NULL                  | NULL     | NULL            | NULL           | NULL         | `@phase.water.time` | `{}`          |

#### `user_rule_actions` (`UserRuleAction`) — the "then"

`delay_seconds` and `duration_seconds` are **text**, not integers (F11.14): each holds a literal or a
reference, resolved per entity at dispatch time by `resolveSeconds`. `schedule_time` /
`schedule_until` on the condition above are the same. That is what lets one rule serve several
lifecycles — row 92 is the garden's single watering rule, whose period and hour both come from
whichever phase the pot it fans out to is in. Unresolvable ⇒ hold indefinitely (duration) or send
now (delay), never a guessed number.

| id  | rule_id | user_device_action_id | target_state         | delay_seconds                  | duration_seconds       |
| --- | ------- | --------------------- | -------------------- | ------------------------------ | ---------------------- |
| 90  | 50      | 101                   | ON                   | NULL                           | NULL                   |
| 91  | 51      | 101                   | OFF                  | NULL                           | 120                    |
| 92  | 52      | 101                   | `@phase.water.state` | `@param.water.stagger_seconds` | `@phase.water.seconds` |

#### `user_rule_events` (`UserRuleEvent`) — fire audit (replaces the old `emergency_events`; works for any rule). Index `(rule_id, fired_at)`.

| id  | rule_id | triggered_value | fired_at             |
| --- | ------- | --------------- | -------------------- |
| 1   | 51      | "46.2"          | 2026-06-26T14:40:00Z |

#### `scenes` (`Scene`) — manual one-tap fan-out ("Good Night"). Unique `(user_id, name)`, index `(user_id, sort_order)`.

A scene is a `user_rules` row without conditions: it fires on `POST /api/scenes/:id/execute`,
not on a trigger. Distinct from `user_action_groups`, which is an organizational folder
(exclusive `group_id` on the action, no target value) — a scene stores the **desired value**
per action, and `scene_members` being a join table means one action can sit in many scenes.

| id  | user_id | name       | sort_order |
| --- | ------- | ---------- | ---------- |
| 10  | 2       | Good Night | 0          |
| 11  | 2       | Away       | 1          |

#### `scene_members` (`SceneMember`) — the action list. Unique `(scene_id, user_device_action_id)`.

A delay staggers a member (published after it); null or `0` fires immediately.

`duration_seconds` is different in kind: it is passed **to the device**, whose firmware arms its own
timer and returns the pin to rest when it elapses (`BaseCommandAction`'s duration auto-off). Null =
hold until something else changes it. Saying "on for two minutes" this way rather than as a second
delayed OFF row matters because the delayed row's timer lives in a service's memory — a restart
inside the window loses the close and leaves the actuator on.

Both are text and may hold a reference (F11.14), resolved once when the scene is pressed so a
delayed member cannot silently act on a phase that advanced while it waited. Row 33 is the garden's
"Soak this pot", which holds the valve for as long as the pot's current stage says.

| id  | scene_id | user_device_action_id | target_state | sort_order | delay_seconds                  | duration_seconds       |
| --- | -------- | --------------------- | ------------ | ---------- | ------------------------------ | ---------------------- |
| 30  | 10       | 101                   | OFF          | 0          | NULL                           | NULL                   |
| 31  | 10       | 104                   | ON           | 1          | NULL                           | NULL                   |
| 32  | 11       | 101                   | OFF          | 0          | 30                             | NULL                   |
| 33  | 12       | 101                   | ON           | 1          | `@param.water.stagger_seconds` | `@phase.water.seconds` |

### Tier 5 — Pipelines (ML execution: trigger → sensors → stages → decision)

#### `pipelines` (`Pipeline`)

| id  | user_id | name            | enabled |
| --- | ------- | --------------- | ------- |
| 40  | 2       | Garage AI watch | true    |

#### `pipeline_sensors` (`PipelineSensor`) — unified per-item list: every device action the pipeline cares about (sensor reading and/or LLM-invocable action), one row each. `inject_as_sensor` includes the item in the current-state + historic-digest blobs the enrich stage builds; `inject_as_action` includes it in the LLM's derived `available_actions` list. Telemetry and image/camera capability types force `inject_as_sensor=true` (can't be turned off) and `inject_as_action=false` (can't be commanded) — enforced both in the UI and server-side in `pipelines.service.ts`. Unique `(pipeline_id, user_device_action_id)`.

| id  | pipeline_id | group_name | description        | user_device_action_id | inject_as_sensor | inject_as_action | min_value | max_value | compression | window_minutes | n    |
| --- | ----------- | ---------- | ------------------ | --------------------- | ---------------- | ---------------- | --------- | --------- | ----------- | -------------- | ---- |
| 1   | 40          | climate    | Enclosure air temp | 100                   | true             | false            | 18        | 27        | average     | 60             | NULL |
| 2   | 40          | vision     | Door camera frame  | 102                   | true             | false            | NULL      | NULL      | last_n      | 5              | 5    |
| 3   | 40          | access     | Door relay         | 101                   | true             | true             | NULL      | NULL      | average     | 60             | NULL |

#### `pipeline_stages` (`PipelineStage`) — ordered steps. Kinds: `enrich` (builds current-state/historic-digest/available-actions from `pipeline_sensors`, no config needed); `infer` (ML model via `ml_model_id`); `command_exec` (executes LLM-recommended action). The editor now constructs `enrich → infer/llm → [command_exec]`; a camera item's frame is captured in enrich and attached to the multimodal LLM directly. The `[infer/vlm]` step (a preceding local YOLO/VLM stage) is still supported by the engine but is parked — the editor no longer builds one. The engine stays generic over ordinal/kind. Unique `(pipeline_id, ordinal)`.

| id  | pipeline_id | ordinal | kind         | ml_model_id    | prompt_template                  | notify | execute_condition |
| --- | ----------- | ------- | ------------ | -------------- | -------------------------------- | ------ | ----------------- |
| 70  | 40          | 1       | enrich       | NULL           | NULL                             | NULL   | NULL              |
| 72  | 40          | 2       | infer        | 2 (gemini/llm) | Prioritize security over comfort | NULL   | NULL              |
| 73  | 40          | 3       | command_exec | NULL           | NULL                             |

#### `pipeline_triggers` (`PipelineTrigger`) — many per pipeline (telemetry / schedule / manual)

`last_fired_at` is automation-worker's per-trigger cooldown clock: a match is skipped while `now - last_fired_at < min_interval_sec`, and stamped on every fire.

| id  | pipeline_id | trigger_type | user_device_action_id | operator | threshold_value | schedule_cron | min_interval_sec | last_fired_at       |
| --- | ----------- | ------------ | --------------------- | -------- | --------------- | ------------- | ---------------- | ------------------- |
| 60  | 40          | telemetry    | 102                   | NULL     | NULL            | NULL          | 30               | NULL                |
| 61  | 40          | telemetry    | 100                   | >        | 30              | NULL          | 30               | 2026-07-28 10:15:00 |

#### `pipeline_runs` (`PipelineRun`) — one execution. `trigger_payload` JSON = ML audit blob. `sensor_overrides` JSON = dry-run override map keyed by `user_device_action_id`.

| id  | pipeline_id | status    | trigger_type     | is_dry_run | started_at           | completed_at         |
| --- | ----------- | --------- | ---------------- | ---------- | -------------------- | -------------------- |
| 500 | 40          | completed | sensor_threshold | false      | 2026-06-26T14:32:00Z | 2026-06-26T14:32:09Z |
| 501 | 40          | completed | manual           | true       | 2026-06-26T15:00:00Z | 2026-06-26T15:00:08Z |

#### `pipeline_run_stages` (`PipelineRunStage`) — per-stage audit trail (`input`/`output` JSON = ML blobs). Unique `(run_id, stage_id)`. Replaced the old `vlm_analysis_logs`.

| id  | run_id | stage_id | status    | input                | output                                            |
| --- | ------ | -------- | --------- | -------------------- | ------------------------------------------------- |
| 1   | 500    | 70       | completed | `{"frame":"<hash>"}` | `{"detections":[{"class":"person","conf":0.94}]}` |
| 3   | 500    | 72       | completed | `{"prompt":"…"}`     | `{"value":"ON","reason":"person + high temp"}`    |

### Tier 6 — Telemetry

#### `sensor_history` (`SensorHistory`) — time series. `value` TEXT nullable (scalars + base64 frames; NULL on a fault reading). Fault rows carry `is_error=true` + `error_code`; readers filter `is_error=false`. Index `(user_device_action_id, recorded_at)`.

| id   | user_device_action_id | value                | is_error | error_code    | recorded_at          |
| ---- | --------------------- | -------------------- | -------- | ------------- | -------------------- |
| 9001 | 100                   | "23.4"               | false    | NULL          | 2026-06-26T14:31:55Z |
| 9002 | 102                   | "/9j/4AAQSk…" (jpeg) | false    | NULL          | 2026-06-26T14:32:00Z |
| 9003 | 100                   | NULL                 | true     | "read_failed" | 2026-06-26T14:33:00Z |

#### `device_commands` (`DeviceCommand`) — the write side's twin of `sensor_history` (F11.12): one row per command sent to a device, settled in place by the device's ack. Written by digest-service from `action.dispatch`, which every command passes through whoever raised it. `status` starts at `sent` — a row still `sent` means no ack was ever seen, which only the paths with a timeout (those routed through digest's pending tracking) convert to `timeout`. `source='device'` rows are acks with no command behind them: a duration auto-off releasing, or a boot restore. Indexes `(user_id, dispatched_at)` and `(user_device_action_id, dispatched_at)`.

| id  | user_device_action_id | action_name | target_state | duration_seconds | source   | source_label    | status  | result_value | dispatched_at        | settled_at           |
| --- | --------------------- | ----------- | ------------ | ---------------- | -------- | --------------- | ------- | ------------ | -------------------- | -------------------- |
| 501 | 100                   | socket      | "on"         | 30               | rule     | "Midday sip"    | ok      | "on"         | 2026-08-06T09:10:00Z | 2026-08-06T09:10:01Z |
| 502 | 100                   | socket      | "off"        | NULL             | device   | NULL            | ok      | "off"        | 2026-08-06T09:10:30Z | 2026-08-06T09:10:30Z |
| 503 | 104                   | valve       | "on"         | NULL             | manual   | NULL            | timeout | NULL         | 2026-08-06T09:12:00Z | 2026-08-06T09:12:10Z |
| 504 | 108                   | light       | "on"         | NULL             | pipeline | "Light decider" | error   | NULL         | 2026-08-06T09:15:00Z | 2026-08-06T09:15:01Z |

#### `sensor_rollup` (`SensorRollup`) — downsampled scalar readings, one row per (action, granularity, bucket). Written nightly by automation-worker's retention pass, which rolls up **before** it prunes so a bucket is never built from already-deleted rows. `sample_count` counts every reading; `numeric_count` only those that parsed as a number — they differ because `sensor_history.value` is TEXT and a switch's history is `"on"`/`"off"`. For a non-numeric series min/max/avg stay NULL and `last_value` is the only meaningful summary. The unique key `(user_device_action_id, bucket, bucket_start)` makes the upsert idempotent, so a re-run or a missed night self-heals.

`bucket` is a **`retention_buckets.code`**, FK'd `ON DELETE RESTRICT` (F18.9). Phase 1 wrote the literals `"hour"`/`"day"` from code and typed them there; the vocabulary is now data, and the `retention_tiers` migration rewrote every existing row to `1h`/`1d`. That FK is what makes the rewrite _checked_: Postgres validates the whole table as it adds the constraint, so a partial rewrite aborts the migration naming the offending value instead of silently orphaning every bucket ever written. Only the **finest** rollup tier is built from `sensor_history`; every coarser tier is folded from its predecessor, or a weekly rollup would re-read a week of 10-second readings per action per night.

| id   | user_device_action_id | bucket | bucket_start         | sample_count | numeric_count | error_count | min_value | max_value | avg_value | last_value |
| ---- | --------------------- | ------ | -------------------- | ------------ | ------------- | ----------- | --------- | --------- | --------- | ---------- |
| 7001 | 100                   | 1h     | 2026-08-20T14:00:00Z | 60           | 59            | 1           | 21.1      | 23.8      | 22.4      | "23.1"     |
| 7002 | 100                   | 1d     | 2026-08-20T00:00:00Z | 1440         | 1436          | 4           | 18.2      | 26.9      | 22.1      | "21.7"     |
| 7003 | 106                   | 1d     | 2026-08-20T00:00:00Z | 96           | 0             | 0           | NULL      | NULL      | NULL      | "on"       |
| 7004 | 100                   | 90m    | 2026-08-20T13:30:00Z | 90           | 90            | 0           | 21.4      | 22.9      | 22.2      | "22.5"     |

#### `device_events` (`DeviceEvent`) — everything that happened **to** a device, as opposed to what it was told to do. Written by digest-service on a **real transition only**: the previous `online` value is read first, or a chatty device writes a row per status message rather than per change. Every online/offline transition funnels through `RK.DEVICE_STATE_CHANGED` (the broker's Last-Will _and_ automation-worker's liveness reaper both publish it), so there is exactly one hook. `kind='firmware'` exists because `device_commands` deliberately excludes the `ota` action — this is that audit trail. Indexes `(user_device_id, recorded_at)` and `(user_id, recorded_at)`.

| id  | user_id | user_device_id | kind     | from_value | to_value   | detail                                  | recorded_at          |
| --- | ------- | -------------- | -------- | ---------- | ---------- | --------------------------------------- | -------------------- |
| 301 | 1       | 12             | offline  | "true"     | "false"    | {"reason":"reaper"}                     | 2026-08-19T03:12:00Z |
| 302 | 1       | 12             | online   | "false"    | "true"     | NULL                                    | 2026-08-19T04:31:00Z |
| 303 | 1       | 12             | firmware | "v2.0.438" | "v2.0.459" | NULL                                    | 2026-08-20T09:47:00Z |
| 304 | 1       | 12             | fault    | NULL       | NULL       | {"action":"level","code":"read_failed"} | 2026-08-20T11:02:00Z |

#### `device_availability_daily` (`DeviceAvailabilityDaily`) — daily uptime per device, folded from consecutive `device_events` plus the day boundary. Derived rather than counted live because the question ("what % of yesterday was this up") needs the span _between_ events, which would otherwise be recomputed on every render. Unique `(user_device_id, day)`.

| id  | user_device_id | day        | online_seconds | offline_seconds | transitions |
| --- | -------------- | ---------- | -------------- | --------------- | ----------- |
| 210 | 12             | 2026-08-19 | 81660          | 4740            | 2           |
| 211 | 12             | 2026-08-20 | 86400          | 0               | 0           |

#### `camera_frame_history` (`CameraFrameHistory`) — camera frames, split out of `sensor_history`. A **read-performance** change, not a retention one: full frame history is kept on purpose (`retention_policy.frame` ships `default_raw_days = 0` = forever), and this split is what makes keeping it affordable — every scalar series query was otherwise walking a table whose image rows are ~40 KB of base64 each. `byte_size` is the decoded size, stored so the storage panel can total it without measuring the TEXT. Fault rows for a camera action stay in `sensor_history` (they carry `value = NULL` and belong to the error timeline). Index `(user_device_action_id, recorded_at)`.

| id    | user_device_action_id | value                | byte_size | recorded_at          |
| ----- | --------------------- | -------------------- | --------- | -------------------- |
| 44001 | 102                   | "/9j/4AAQSk…" (jpeg) | 41216     | 2026-08-20T18:04:12Z |
| 44002 | 102                   | "/9j/4AAQSk…" (jpeg) | 39880     | 2026-08-20T18:04:42Z |

#### `command_rollup_daily` (`CommandRollupDaily`) — daily command counts per (action, source, outcome): "how often does this actually run, and how often does it fail". Lets the raw `device_commands` rows age out without losing the shape. Unique `(user_device_action_id, day, source, status)`.

| id  | user_device_action_id | day        | source | status  | count |
| --- | --------------------- | ---------- | ------ | ------- | ----- |
| 880 | 100                   | 2026-08-20 | rule   | ok      | 14    |
| 881 | 100                   | 2026-08-20 | rule   | timeout | 1     |
| 882 | 100                   | 2026-08-20 | device | ok      | 14    |

#### `retention_policy` (`RetentionPolicy`) — the platform default each user starts on, plus the ceiling they may not exceed. Admin-owned, one row per `data_kind`. Deliberately a table and not env vars: retention is a product decision an owner changes, and an env var means a redeploy plus no record of what the policy was. Env vars seed these rows on first migrate; afterwards this table is authoritative and the nightly job re-reads it every pass, so a change takes effect the same night without a restart. **On `*_days` columns `0` means KEEP FOREVER** (the safe reading for a column driving deletes); **on `max_*` ceilings NULL means UNCAPPED** — a different spelling on purpose, since a ceiling of `0` would otherwise read as "cap everyone at forever". All ceilings ship NULL.

**F18.9 added one knob and began retiring six columns.** `min_bucket` is the finest _summary_ anyone may configure for this kind; it never binds `raw`, because the floor is about how fine a rollup may be and raw is not a rollup — a `min_bucket` of `15m` still keeps the readings themselves for as long as the raw tier says. It ships as `raw` (no floor), so it changes nobody's options; it exists so a volume with no headroom can be defended later without a schema change, exactly as `max_raw_days` already does.

F18.9 also shipped a `max_tiers` column — a per-kind cap on how many tiers a list could hold — which was **dropped again on 2026-08-26**. The count was the wrong axis to limit: a tier list costs what its _finest_ bucket costs, so a `30m` tier writes 48 rollup rows per sensor per day while every coarser tier above it together writes about one. The cap therefore blocked the nearly-free additions and permitted the expensive one. `min_bucket` bounds the axis that actually costs, and the chain rule (each tier a whole multiple of the one below) bounds length on its own. Per-kind bucket _eligibility_ is unchanged and still lives in code, because it is a property of where the rows go rather than a policy an admin could raise: `command_rollup_daily` and `device_availability_daily` are `DATE`-keyed, so those kinds take whole-day buckets only, and a camera frame is an image that does not average.

⚠️ The six `default_*_days` / `max_*_days` columns are **superseded by `retention_policy_tiers`** and have been copied across. They are still present only so the API and worker keep compiling while their call sites move; they are dropped, with `user_retention_preferences`, once the last reader is gone. **Do not add a reader.**

| id  | data_kind    | default_raw_days | default_hourly_days | default_daily_days | max_raw_days | min_bucket | enabled |
| --- | ------------ | ---------------- | ------------------- | ------------------ | ------------ | ---------- | ------- |
| 1   | scalar       | 14               | 90                  | 0                  | NULL         | raw        | true    |
| 2   | command      | 365              | NULL                | 0                  | NULL         | raw        | true    |
| 3   | device_event | 0                | NULL                | 0                  | NULL         | raw        | true    |
| 4   | frame        | 0                | NULL                | NULL               | NULL         | raw        | 1       | true |

#### `user_retention_preferences` (`UserRetentionPreference`) — one user's override of a platform default. Same shape as `notification_preferences`: **a row exists only once the user has actually chosen something**, so a new account needs no seeding, the absence of a row is a meaningful "use the default", and changing a default moves every user who never customised. "Reset to default" deletes the row rather than writing the default into it. The effective window is `min(user_choice, ceiling)` with `0` read as infinity — that arithmetic lives in exactly one place, `clampKeepDays` in `@lattice/retention`. Two tables rather than one with a nullable `user_id` because Postgres treats NULLs as **distinct** in a unique index, so `UNIQUE(user_id, data_kind)` would happily allow two platform rows for the same kind. Unique `(user_id, data_kind)`.

⚠️ **SUPERSEDED by `user_retention_tiers`** (F18.9). Every row here was copied across by the `retention_tiers` migration, and the two are **not kept in sync** — this is read-only legacy, present only so the API and worker keep compiling while their call sites move one at a time. It is dropped, with the six `retention_policy` day columns, once the last reader is gone. **Do not add a reader.**

| id  | user_id | data_kind | raw_days | hourly_days | daily_days | updated_at           |
| --- | ------- | --------- | -------- | ----------- | ---------- | -------------------- |
| 31  | 1       | scalar    | 0        | 90          | 0          | 2026-08-21T10:00:00Z |

#### The five tier tables — `retention_policy_tiers`, `user_retention_tiers`, `device_retention_tiers`, `action_retention_tiers`, `blueprint_retention_tiers`

A **tier list** is the complete retention configuration for one `(scope, data_kind)`: an ordered set of buckets, each with a keep window. **`raw` is position 0 of that list**, not a separate kind-level window — which is what makes a per-sensor raw window fall out for free, and is why the six `retention_policy` day columns above are on their way out.

**Five tables, not one with a nullable owner.** Postgres treats NULLs as _distinct_ in a unique index, so a nullable-owner key would admit two platform rows for the same `(data_kind, bucket)`; a partial unique index would fix that but cannot be expressed in `schema.prisma`, so the schema would stop describing the database — the same reasoning already recorded on `blueprint_binding_phase_state` and on `user_retention_preferences` itself. One table per scope also buys real FKs and real cascades: deleting an action takes its tiers with it.

Resolution runs **action → device → blueprint → user → platform**, and **the whole list wins**: the most specific scope with _any_ rows for a kind supplies every tier, and the scopes below it are not consulted. Merging tier-by-tier would leave "removing the action's tier falls back to the device's" without a single answer, and a half-inherited list composes differently depending on which half you remove. Clamping is per bucket against the platform row for the _same_ bucket; a scope that keeps a bucket the platform does not configure is uncapped for it, because the platform expresses a ceiling by carrying the bucket rather than by omitting it.

Only `retention_policy_tiers` carries `max_keep_days` — the ceiling, mirroring the `default_* / max_*` pairing Phase 1 used. `blueprint_retention_tiers` addresses `(blueprint_id, slot_key, action_name)` so a blueprint can single out a known-noisy sensor without changing the switches beside it; `slot_key` and `action_name` are plain strings for the same reason `blueprint_slot_bindings.slot_key` is one — they survive a v2 publish recreating the slot rows. Blueprint tiers are **admin-only**: a user cannot edit the definition their instance inherits, they override it at their own device or action scope, which sits above it in the order.

Two invariants live in `@lattice/retention`, not in the schema, because no column can express them:

- **Chain divisibility.** Each rollup tier's `seconds` must be a whole multiple of its predecessor's, since a coarse bucket is folded from the next finer one. This constrains the **list**, not the size — `90m` is legal, it simply cannot sit directly above `1h` (5400 / 3600 = 1.5).
- **The raw floor.** `raw.keep_days` must be at least `max(RETENTION_LOOKBACK_DAYS, 2)` while any rollup tier exists, unless it is `0`. Rollups are built by reading raw rows, so a shorter window deletes readings before they were ever summarised — and the loss is invisible, because the rollup rows that would have shown it were never written.

`retention_policy_tiers` — unique `(data_kind, bucket)`:

| id  | data_kind | bucket | keep_days | max_keep_days | position |
| --- | --------- | ------ | --------- | ------------- | -------- |
| 1   | scalar    | raw    | 14        | 30            | 0        |
| 2   | scalar    | 1h     | 90        | NULL          | 1        |
| 3   | scalar    | 1d     | 0         | NULL          | 2        |
| 4   | frame     | raw    | 0         | NULL          | 0        |

`action_retention_tiers` — the finest scope, and the reason F18.12 exists: a tank-level sensor worth 5-minute buckets no longer forces every switch in the house to the same shape. Unique `(user_device_action_id, data_kind, bucket)`:

| id  | user_device_action_id | data_kind | bucket | keep_days | position |
| --- | --------------------- | --------- | ------ | --------- | -------- |
| 12  | 100                   | scalar    | raw    | 3         | 0        |
| 13  | 100                   | scalar    | 90m    | 60        | 1        |
| 14  | 100                   | scalar    | 1d     | 0         | 2        |

`user_retention_tiers`, `device_retention_tiers` and `blueprint_retention_tiers` have the same shape minus `max_keep_days`, keyed on `(user_id, …)`, `(user_device_id, …)` and `(blueprint_id, slot_key, action_name, …)` respectively. As with the table it replaces, a `user_retention_tiers` row exists only once the user has chosen something, so the **absence** of rows means "follow the platform" — which is what makes changing a platform default move everyone who never customised.

#### `retention_runs` (`RetentionRun`) — one execution of the retention pass: the nightly cron, an admin's "Apply now", or a user's (F18.13–F18.15). `phase` is written as each stage completes (`rollup:scalar`, `prune:frame`), so the page shows real progress rather than a spinner.

`lock_key` is the single-flight mechanism: `'global'` for a platform sweep, `'user:<id>'` for a user sweep, `UNIQUE` and nullable, held from `queued` until terminal and then set NULL. Postgres's NULL-distinct rule is documented as a trap everywhere else in this file; **here it is the feature** — any number of finished rows carry NULL, and exactly one live run can hold each key.

The key alone is not enough, because a user sweep and a platform sweep would still overlap on the same rows while holding _different_ keys. So every claim runs inside a transaction guarded by `pg_advisory_xact_lock`: a global claim is refused while **any** run is active; `user:N` is refused while global or `user:N` is, but **not** while `user:M` is — those touch disjoint, ownership-scoped rows, and serialising them would make one user's Apply wait on a stranger's. A global claim that loses inserts as `queued` anyway, which blocks new user claims, and waits for in-flight user runs before going `running` — writer preference, so the nightly pass cannot be starved by a stream of Applies.

`scope_user_id` is **read from this row by the worker, never from the queue payload**: the message is a wake-up, not an authority.

| id  | trigger | status  | phase        | requested_by_user_id | scope_user_id | lock_key | queued_at            | duration_ms | error |
| --- | ------- | ------- | ------------ | -------------------- | ------------- | -------- | -------------------- | ----------- | ----- |
| 40  | cron    | ok      | NULL         | NULL                 | NULL          | NULL     | 2026-08-24T03:00:00Z | 41200       | NULL  |
| 41  | user    | running | prune:scalar | 1                    | 1             | user:1   | 2026-08-24T09:14:02Z | NULL        | NULL  |

#### `retention_run_kinds` (`RetentionRunKind`) — what one run did to one data kind. Relational children rather than a JSON counters blob, for the same reason the tiers are five tables: the job-history page sorts and totals by kind, and a blob can be neither indexed nor summed. `bytes_estimated` is `false` **only for frames**, where `byte_size` is summed off the rows before they are deleted; everywhere else the figure comes from the same per-row constants the storage panel uses and is labelled an estimate in the UI rather than presented as a measurement. Unique `(run_id, data_kind)`.

| id  | run_id | data_kind | buckets_written | rows_deleted | bytes_reclaimed | bytes_estimated |
| --- | ------ | --------- | --------------- | ------------ | --------------- | --------------- |
| 91  | 40     | scalar    | 274             | 18420        | 884160          | true            |
| 92  | 40     | frame     | 0               | 96           | 3842560         | false           |

#### `retention_activity` (`RetentionActivity`) — every retention event, append-only: **when, who, what changed, and how** (F18.19). `retention_runs` records what a _sweep_ did; this records everything else, and in particular the entire configuration half, which nothing recorded before. A tier row's `updated_at` is current state, not history — it can say a list changed this morning, but never who changed it, from what, or in which direction. For a feature whose whole purpose is deleting data irreversibly, that was the wrong side of the line.

**Append-only.** Nothing updates a row here and nothing deletes one — that is what keeps it separate from `retention_runs`, whose `phase` and `lock_key` are mutated throughout a run. The two are linked by `run_id` rather than merged, so the log never has to carry live state.

**`actor_name` and `subject_label` are denormalized on purpose.** Both user FKs are `ON DELETE SET NULL`, because deleting a user must neither be blocked by an audit row nor cascade one away — so the ids go and the names stay. A log that forgets who did something the moment their account closes is not an audit trail. `subject_label` captures the device / action / blueprint name **at the time**, so a later rename does not silently rewrite what the entry says happened.

`summary` is the line the page shows; `before`/`after` keep the machine-readable pair so a question the summary did not anticipate is still answerable years later. Writes go through `retentionActivityService.record`, which takes the **transaction handle** — a config change and its log entry commit together or not at all. The worker's own writer is the one exception and never throws: a sweep that successfully deleted rows must not be reported as failed because its log line did not write.

| id  | at                   | action         | scope    | actor_kind | actor_name | subject_user_id | data_kind | summary                                                 | run_id |
| --- | -------------------- | -------------- | -------- | ---------- | ---------- | --------------- | --------- | ------------------------------------------------------- | ------ |
| 118 | 2026-08-26T10:27:27Z | tiers_changed  | user     | user       | admin      | 1               | scalar    | removed 90m, raw 14d → 7d, added 6h kept 90d            | NULL   |
| 119 | 2026-08-26T10:31:02Z | sweep_finished | user     | user       | admin      | 1               | NULL      | 36,031 rows deleted, 659 buckets built                  | 7      |
| 120 | 2026-08-26T11:04:55Z | policy_changed | platform | admin      | admin      | NULL            | frame     | 1d ceiling uncapped → 30d; 2 users over the new ceiling | NULL   |

### Tier 7 — Blueprints (F10)

Admin-authored setups and the user instances derived from them. The worked example below is one
blueprint with two slots, three params, two phases and one rule template — the shape a derive
consumes. Domain-flavored strings (`Reservoir Setup`, `Seedling`) are **admin-typed runtime
content**, never code or seed constants.

#### `blueprints` (`Blueprint`) — unique `key`. `version` bumps on **publish**, not on edit; only `published` blueprints can be derived. `context_notes` is free text handed to the LLM.

| id  | key             | name            | version | status    | is_static | context_notes                         |
| --- | --------------- | --------------- | ------- | --------- | --------- | ------------------------------------- |
| 3   | reservoir_setup | Reservoir Setup | 1       | published | false     | "Closed-loop tank with a top-up pump" |

`is_static = true` (F11.8) means **no slot in this setup has phases** — nothing in it is scheduled
at all. Declared rather than inferred: a draft part-way through being written also has no phases
yet, and the two must not look alike. Publish enforces the agreement in **both** directions (static
with phases, and non-static without), so the flag can never disagree with the content.

It is _not_ the same as a setup whose devices own the schedules — that is a **profiled slot**, where
the phases exist and belong to the bound devices. A static setup still starts and stops (pausing
holds its automations); it simply has no phase track and no timers.

#### `blueprint_slots` (`BlueprintSlot`) — one device requirement each, qualified by a **released** `sealed_template` (RESTRICT: a template with live slots cannot be deleted). Unique `(blueprint_id, key)`.

| id  | blueprint_id | key   | label        | required | min_count | max_count | profiled | sealed_template_id |
| --- | ------------ | ----- | ------------ | -------- | --------- | --------- | -------- | ------------------ |
| 10  | 3            | tank  | Tank monitor | true     | 1         | 1         | false    | 2                  |
| 11  | 3            | pump  | Top-up pump  | true     | 1         | 1         | false    | 5                  |
| 12  | 3            | loops | Loops        | false    | 1         | 6         | true     | 5                  |

`profiled=true` (F11) means every device bound here runs a lifecycle of its own — the user picks a
`blueprint_profile` per binding. The unprofiled slots are shared by the whole setup.

#### `blueprint_params` (`BlueprintParam`) — the declared tuning surface. Every `@param.x` / `@phase.x` reference must name a key here. `user_tunable=false` ⇒ phase-driven only, no override UI. Unique `(blueprint_id, key)`.

| id  | blueprint_id | key            | label             | default_value | unit | user_tunable |
| --- | ------------ | -------------- | ----------------- | ------------- | ---- | ------------ |
| 20  | 3            | humidity.min   | Humidity floor    | 40            | %    | true         |
| 21  | 3            | humidity.max   | Humidity ceiling  | 70            | %    | true         |
| 22  | 3            | tank.min_level | Tank refill level | 20            | %    | true         |

#### `blueprint_fields` (`BlueprintField`) — a question the blueprint asks the user at setup time (F11.6). Params are values the _system_ tunes across phases; a field is a fact the **user states**, so it is a separate declaration with its own reference kind. `@field.x` resolves **device answer → setup answer → default → null** and does _not_ walk the param precedence — no phase retunes a fact. `scope='binding'` asks once per bound device of `slot_key`. Unique `(blueprint_id, key)`.

| id  | blueprint_id | key     | label                  | input_type | scope   | slot_key | required |
| --- | ------------ | ------- | ---------------------- | ---------- | ------- | -------- | -------- |
| 60  | 3            | site    | Where is this?         | text       | setup   | NULL     | false    |
| 61  | 3            | variant | What is this handling? | select     | binding | loops    | true     |

#### `blueprint_field_options` (`BlueprintFieldOption`) — one choice of a `select` field. **`profile_key` is the load-bearing column**: picking an option stores the descriptive answer _and_ puts that binding on the named lifecycle, so one question sets both facts — and two devices can share a profile while still carrying different answers. Unique `(field_id, value)`.

| id  | field_id | value     | label     | profile_key |
| --- | -------- | --------- | --------- | ----------- |
| 70  | 61       | quick_run | Quick run | fast_cycle  |
| 71  | 61       | long_soak | Long soak | slow_cycle  |

Publish validation refuses an option whose `profile_key` names no declared profile, and refuses
profile-selecting options on a field that is not asked per device of a **profiled** slot — the two
cases where the column would silently do nothing.

#### `blueprint_instance_field_values` (`BlueprintInstanceFieldValue`) / `blueprint_binding_field_values` (`BlueprintBindingFieldValue`) — the answers. Keyed by field **key**, like every other user-owned blueprint table, so a v2 publish that recreates the field rows keeps them. A required field added in a v2 leaves live instances unanswered: the reference fails closed (null) rather than breaking automations. Unique `(instance_id, field_key)` / `(binding_id, field_key)`.

#### `blueprint_profiles` (`BlueprintProfile`) — a named lifecycle a bound device can follow (F11). What a device is handling decides its schedule, so a blueprint declares one profile per schedule and each binding of a profiled slot picks one. Runtime content like a phase name: the engine never knows what a profile _means_, only that it has these phases in this order. **Every blueprint with a lifecycle has at least one** — the single-lifecycle (F10) shape is simply the one-profile case, which is why phases hang off a profile rather than the blueprint. Unique `(blueprint_id, key)`.

| id  | blueprint_id | key        | label      | sort_order |
| --- | ------------ | ---------- | ---------- | ---------- |
| 5   | 3            | fast_cycle | Fast cycle | 0          |
| 6   | 3            | slow_cycle | Slow cycle | 1          |

#### `blueprint_phases` (`BlueprintPhase`) — ordered lifecycle **within a profile**. `duration_value` is TEXT: a literal (`"7"`) **or** an `@param.` reference resolved against the owner's context at evaluation time (F11.13), which is how two devices on ONE lifecycle run the same phase for different lengths — each pins that param for itself. Publish refuses `@phase.` there, a reference to an undeclared param, and a param this same phase's targets set (the loop). `advance_mode` decides what ends the phase — `schedule` uses the duration + `automation-worker` cron; `rule`/`pipeline` name a template in `advance_ref_key` whose derived automation decides; `manual` waits for a person. `advance_to_key` is the target phase **in this profile** (null = next by ordinal). `context_notes` resolves via `@phase.context_notes`. Unique `(profile_id, key)` — keys and ordinals are unique per profile, **not** per blueprint: two profiles legitimately declare the same key at the same ordinal, and a `phase_scope` naming it matches whichever profile the binding follows.

| id  | profile_id     | key   | name  | ordinal | duration_value     | duration_unit | advance_mode | advance_ref_key | advance_to_key |
| --- | -------------- | ----- | ----- | ------- | ------------------ | ------------- | ------------ | --------------- | -------------- |
| 30  | 5 (fast_cycle) | fill  | Fill  | 1       | "1"                | days          | schedule     | NULL            | NULL           |
| 31  | 5 (fast_cycle) | hold  | Hold  | 2       | NULL               | NULL          | manual       | NULL            | NULL           |
| 32  | 6 (slow_cycle) | fill  | Fill  | 1       | "@param.fill_days" | days          | schedule     | NULL            | NULL           |
| 33  | 6 (slow_cycle) | flush | Flush | 2       | "1"                | weeks         | schedule     | NULL            | NULL           |

Row 32 is the F11.13 case: every device on `slow_cycle` reads its own `fill_days`, so a
`blueprint_binding_param_overrides` row pinning `fill_days = 1` for one device gives that device a
one-day fill while its siblings keep the blueprint's default — one lifecycle, different lengths.

#### `blueprint_phase_targets` (`BlueprintPhaseTarget`) — what a phase sets a param to. **No row ⇒ the param's own default applies in that phase.** Unique `(phase_id, param_key)`.

| id  | phase_id | param_key    | value |
| --- | -------- | ------------ | ----- |
| 40  | 30       | humidity.min | 60    |
| 41  | 30       | humidity.max | 80    |

#### Template fan-out (`fan_out`, `fan_out_slot_key`, `fan_out_profiles` on all three `*_templates`) — how ONE template becomes one automation or several, and over which devices (F11.2, F11.9).

Two independent questions. **How many** entities:

| `fan_out`              | meaning                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `combined` _(default)_ | One entity naming every bound device — "if **any** of them reports X". Every pre-F11 template, unchanged.                              |
| `per_device`           | One entity **per bound device** of `fan_out_slot_key`, each carrying `blueprint_binding_id` and resolving that slot to its own device. |

…and **which** devices take part — `fan_out_profiles`, a list of lifecycle keys, empty for all of
them. The two combine into the three shapes an author actually reaches for:

| shape              | `fan_out`    | `fan_out_profiles`                                  | reads as                                      |
| ------------------ | ------------ | --------------------------------------------------- | --------------------------------------------- |
| **all**, together  | `combined`   | `[]`                                                | "if any device reports X"                     |
| **all**, one each  | `per_device` | `[]`                                                | "each device watches itself"                  |
| **some**, together | `combined`   | `[a, b]`                                            | "if any device on lifecycle a or b reports X" |
| **some**, one each | `per_device` | `[a, b]`                                            | "each device on a or b watches itself"        |
| **one**            | `per_device` | a single-device lifecycle, or a `max_count: 1` slot |

Selection is by **lifecycle, not device id**: the author writes the template long before the user
owns anything, and a device moved onto another lifecycle then joins and leaves the right automations
by itself, where a stored device list would quietly go stale. Publish rejects a selector that can
never select anybody — no slot to select from, a slot whose devices have no lifecycle, an undeclared
lifecycle, or a slot the template never addresses.

`per_device` is not a preference — it is required the moment an automation over a **profiled** slot
holds a `@phase.` reference. Those devices are each in their own phase, and one entity has one
resolution context, so a single reference cannot mean two numbers at once. Publish rejects that
combination (and a `phase_scope` on a combined template over a profiled slot) rather than letting it
resolve to whichever device happened to be first. Narrowing to one lifecycle does **not** lift that:
two devices on the same lifecycle still walk it on their own clocks.

`blueprint_binding_id` on `scenes` / `user_rules` / `pipelines` records which device an entity
belongs to; it is NULL for everything a combined template produces — including a combined template
restricted to some devices, which covers several and so belongs to none. **Reconcile identity is the
pair `(blueprint_key, blueprint_binding_id)`** — which is what makes adding a device create its
automations and removing one disable exactly its own, with the others untouched.

#### `blueprint_rule_templates` (`BlueprintRuleTemplate`) + `_conditions` / `_actions` — mirror `user_rules`, addressing devices as `(slot_key, action_name)` instead of `user_device_action_id`. `key` is the **reconcile identity**. Value columns hold a literal **or** a reference resolved at evaluation time.

| id  | blueprint_id | key          | name                  | cooldown_seconds |
| --- | ------------ | ------------ | --------------------- | ---------------- |
| 50  | 3            | refill_tank  | Refill tank           | 300              |
| 51  | 3            | humidity_low | Humidity below target | 60               |

| id  | template_id | condition_type | slot_key | action_name | operator | threshold_value         |
| --- | ----------- | -------------- | -------- | ----------- | -------- | ----------------------- |
| 60  | 50          | threshold      | tank     | water_level | <        | `@param.tank.min_level` |
| 61  | 51          | threshold      | env      | humidity    | <        | `@phase.humidity.min`   |

| id  | template_id | slot_key | action_name | target_state | delay_seconds |
| --- | ----------- | -------- | ----------- | ------------ | ------------- |
| 70  | 50          | pump     | outlet      | ON           | 0             |

`blueprint_scene_templates(+_members)` and `blueprint_pipeline_templates(+_sensors/_stages/_triggers)`
follow the identical pattern against `scenes`/`scene_members` and `pipelines`/`pipeline_*`. A
pipeline template's sensor bounds (`min_value`/`max_value`) and its stage `prompt_template`
accept references too — that is how a phase reaches the LLM.

#### `blueprint_instances` (`BlueprintInstance`) — a user's live copy. **Changing phase writes `current_phase_id` + `phase_started_at` and a `blueprint_instance_phase_state` row, and nothing else**; no rule, scene or pipeline row is rewritten. Unique `(user_id, name)`.

| id  | user_id | blueprint_id | blueprint_version | area_id | name           | lifecycle_state | current_phase_id | phase_started_at     |
| --- | ------- | ------------ | ----------------- | ------- | -------------- | --------------- | ---------------- | -------------------- |
| 12  | 7       | 3            | 1                 | 9       | Main reservoir | running         | 30 (Seedling)    | 2026-07-21T09:00:00Z |

**`lifecycle_state` — deriving builds a setup, it does not start it.** Binding a board says nothing
about when the process that board watches actually began, so the start instant is a decision the
user makes (which phase, and how far into it), not a side effect of finishing the wizard.

| State         | `current_phase_id` | `phase_started_at` | What runs                            |
| ------------- | ------------------ | ------------------ | ------------------------------------ |
| `not_started` | null               | null               | nothing this setup derived           |
| `running`     | set                | set                | everything, subject to `phase_scope` |
| `stopped`     | **remembered**     | null               | nothing this setup derived           |

A null `phase_started_at` is the single mechanism behind "parked": the auto-advance cron's
due-check reads it, and so does every elapsed number, so one column stops the clock everywhere.
The gate on _acting_ is `isAutomationLive` in `@lattice/params`, applied by the rule engine,
pipeline triggers and scene execution alike — **including emergency rules**, because stopping a
setup is meant to mean the setup is off, not off except the parts that matter.

#### `blueprint_slot_bindings` (`BlueprintSlotBinding`) — slot → real device, **with a lifecycle of its own** when its slot is profiled (F11). `slot_key` is a plain string, not an FK, so the binding survives the slot row being edited in a later version. `auto_bound=true` means exactly one candidate matched and the user confirmed nothing. Unique `(instance_id, slot_key, user_device_id)`.

A binding of a **profiled** slot carries the same lifecycle columns the instance does — profile, state, current phase, clock — one level down. That is what lets ONE setup hold devices on independent schedules: a shared controller (unprofiled, no lifecycle of its own) alongside a binding per device, each walking its own profile's phases.

| id  | instance_id | slot_key | user_device_id | label  | profile_key | lifecycle_state | current_phase_id | phase_started_at     |
| --- | ----------- | -------- | -------------- | ------ | ----------- | --------------- | ---------------- | -------------------- |
| 80  | 12          | tank     | 44             | NULL   | NULL        | not_started     | NULL             | NULL                 |
| 81  | 12          | loops    | 45             | Loop A | fast_cycle  | running         | 31 (Hold)        | 2026-08-02T09:00:00Z |
| 82  | 12          | loops    | 46             | Loop B | slow_cycle  | running         | 33 (Flush)       | 2026-07-28T09:00:00Z |

**A binding acts only while it _and_ its setup are running.** The two states collapse into one
`effective_state` (`effectiveLifecycle` in `@lattice/params`, beside `isAutomationLive`), so stopping
the setup holds every binding regardless of what the bindings themselves say.

#### `blueprint_binding_phase_state` (`BlueprintBindingPhaseState`) — the per-binding twin of `blueprint_instance_phase_state`: seconds banked per phase for one binding, written when it leaves. Unique `(binding_id, phase_key)`.

#### `blueprint_binding_param_overrides` (`BlueprintBindingParamOverride`) — the user's tuning for one binding ("this device wants a different number"). Beats the setup-wide override, which beats the profile's phase target, which beats the blueprint default. Unique `(binding_id, param_key, phase_key)`.

The **four** per-binding tables (phase state, param overrides, field values, and the automations
themselves) are siblings rather than a nullable `binding_id` on the instance-level ones: Postgres
treats NULLs as distinct in a unique index, so a NULL component would admit duplicate rows, and
Prisma's `upsert` needs a compound unique it can name — the same reasoning that gave
`blueprint_param_overrides.phase_key` its empty-string sentinel.

#### `blueprint_param_overrides` (`BlueprintParamOverride`) — the user's own tuning, always **per instance**, so two instances of one blueprint tune independently and neither can write the shared template. `phase_key` scopes the row: `''` = every phase, a phase key = that phase alone. Reconcile never touches this table, which is what makes a v2 release non-destructive to user intent. Unique `(instance_id, param_key, phase_key)`.

| id  | instance_id | param_key    | phase_key | value |
| --- | ----------- | ------------ | --------- | ----- |
| 90  | 12          | humidity.min | `''`      | 50    |
| 91  | 12          | humidity.min | mature    | 45    |

**Resolution worked through** — rule 51's condition holds `@phase.humidity.min`, instance 12 is in
Seedling:

| Source                                       | Value | Wins? |
| -------------------------------------------- | ----- | ----- |
| `blueprint_param_overrides` phase=`seedling` | —     |       |
| `blueprint_param_overrides` all-phases (90)  | 50    | ✅    |
| `blueprint_phase_targets` (40)               | 60    |       |
| `blueprint_params.default` (20)              | 40    |       |

Advance to Mature and row 91 wins with 45 — the more specific row beats the all-phases one. Remove
both overrides and Seedling resolves to 60 (its target), Mature falls through to the default 40 —
with zero writes to the rule in every case.

#### `blueprint_instance_phase_state` (`BlueprintInstancePhaseState`) — time already banked in each phase, written when the instance **leaves** it. The phase it is in right now is not in here: its live run is `now - blueprint_instances.phase_started_at`, added at read time, so a running timer costs no writes. Keyed by phase key (like the overrides table) so a bank survives a v2 that recreates the phase rows. Unique `(instance_id, phase_key)`.

| id  | instance_id | phase_key  | accrued_seconds | last_exited_at       |
| --- | ----------- | ---------- | --------------- | -------------------- |
| 60  | 12          | seedling   | 604800          | 2026-07-28T09:00:00Z |
| 61  | 12          | vegetative | 273600          | 2026-07-30T14:00:00Z |

This is what makes rolling a phase back an undo rather than a restart. Instance 12 spent 3d 4h in
Vegetative, rolled back to Seedling, and comes back later:

| Re-entering Vegetative with… | `accrued_seconds` becomes | Elapsed shown       |
| ---------------------------- | ------------------------- | ------------------- |
| `timer: "resume"`            | 273600 (kept)             | 3d 4h, and counting |
| `timer: "reset"`             | 0                         | from zero           |
| `timer: "at"` (2 days)       | 172800                    | 2d, and counting    |
| auto-advance cron            | 0 — always resets         | from zero           |

Only a person ever spends a bank; the clock alone cannot resurrect time from an earlier visit.

---

## Notes / invariants

- **JSON is used only for genuinely freeform data**: ML audit blobs (`pipeline_runs.trigger_payload`,
  `pipeline_run_stages.input`/`output`) and per-model metadata (`ml_models.classes`/`config`).
  All stable-shape domain data is normalized: instance pins → `user_device_action_pins`; rule
  condition params → typed columns; pipeline stage options → typed columns (`prompt_template` for
  `infer`, `notify`/`execute_condition` for `command_exec`, replacing the old `config` JSON blob).
  Exception: `google_device_traits.valid_parameters` is JSON despite having a small fixed schema
  (`{type: enum|range|pattern, ...}`) because it's a discriminated union — the shape varies by
  `type`, so no single flat set of typed columns fits.
- **Catalog vs instance:** `DeviceCapability` (catalog, per device model) is abstract; a user
  activates it as a `UserDeviceAction` (instance, with assigned pins + live state).
- **Rules vs pipelines:** rules are deterministic + synchronous (no ML); pipelines are the single
  ML path (async). **Emergencies are rules** with `is_emergency=true` (fast-path safety + alert),
  fired events logged in `user_rule_events` — no separate emergency tables.
- **`PipelineRun` + `PipelineRunStage` are the ML audit trail** (replaced `device_vlm_configs` +
  `vlm_analysis_logs`); a single-model analysis is a 1-stage pipeline.
- **Blueprints store references, not values.** A derived rule's `threshold_value` may be
  `@phase.humidity.min` rather than a number, resolved at evaluation time by `@lattice/params`
  (precedence: override → current phase → default). This is deliberate: it makes reconcile,
  phase advance and user tuning write to **disjoint** places — a phase change touches the phase
  columns on `blueprint_instances` plus its own `blueprint_instance_phase_state` row, an override
  is its own row, and reconcile only ever changes entity structure — so none of the three can
  clobber another. An unresolvable reference resolves to null and the caller must fail closed.
- **Blueprint slots bind through `sealed_templates`, never through `devices` directly.** That tier
  already owns "which firmware versions does this config apply to" and materializes per-device
  config idempotently; a blueprint only adds the multi-device layer above it. Non-sealed,
  hand-configured devices are intentionally out of scope.
- **Blueprint template rows address actions as `(slot_key, action_name)`, where `action_name` is
  the slot's `sealed_template_entries.mqtt_action_name` — not a `capability_key`.** A sealed
  template may activate the same capability several times (8 `i2c_socket_8` channels →
  `i2c_socket_8`, `i2c_socket_8_2`, …), so `capability_key` does not identify one action, while
  `mqtt_action_name` is unique per template and is exactly what materialization upserts
  `user_device_actions` on. Publish validation rejects an `action_name` the slot's sealed template
  does not provide, because at derive time it would resolve to nothing.
- **Camera/image** is not a special table: a `UserDeviceAction` whose capability has an image
  `implementation_type`; frames flow through `sensor_history` and pipeline `infer(vlm)`.

```

```
