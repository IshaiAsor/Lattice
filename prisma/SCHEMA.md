# Lattice v2.2 — Database Schema Review

Single source of truth is `prisma/schema.prisma`. **Keep this file in sync with every schema
change** (mermaid ERD + per-table examples). 54 tables, ordered by dependency tier 0 → 7.

| Tier | Theme                                                                                | Tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | External catalog                                                                     | `google_action_types`, `google_device_traits`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1    | Device & ML catalog                                                                  | `devices`, `device_capabilities`, `device_capability_traits`, `device_capability_pins`, `capability_configurations`, `ml_models`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2    | Identity                                                                             | `users`, `mqtt_user`, `user_login_audit`, `push_subscriptions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3    | User devices & actions                                                               | `user_devices`, `user_action_groups`, `areas`, `user_device_actions`, `user_device_action_pins`, `user_action_configurations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4    | Automation (rules; emergencies = rules with `is_emergency`; scenes = manual fan-out) | `user_rules`, `user_rule_conditions`, `user_rule_actions`, `user_rule_events`, `scenes`, `scene_members`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5    | Pipelines (ML execution)                                                             | `pipelines`, `pipeline_sensors`, `pipeline_stages`, `pipeline_triggers`, `pipeline_runs`, `pipeline_run_stages`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6    | Telemetry                                                                            | `sensor_history`, `device_commands`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
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
    int rssi "heartbeat WiFi dBm; nullable"
    datetime last_heartbeat_at "nullable"
    int pending_device_type_id FK "nullable"
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

| id  | device_type_id | user_id | mac_id            | name        | online | rssi | current_firmware_version | pending_device_type_id |
| --- | -------------- | ------- | ----------------- | ----------- | ------ | ---- | ------------------------ | ---------------------- |
| 7   | 1              | 2       | AA:BB:CC:00:11:22 | Garage Node | true   | -58  | v2.0.0                   | NULL                   |

#### `user_action_groups` (`UserActionGroup`) — dashboard grouping. Unique `(user_id, name)`. `sort_order` = card position.

| id  | user_id | name   | sort_order |
| --- | ------- | ------ | ---------- |
| 1   | 2       | Garage | 0          |

#### `areas` (`Area`) — user-createable "these devices belong together" grouping (F10.0). Unique `(user_id, name)`, index `(user_id, sort_order)`. Independent of blueprints (a derive creates one and fills it). `user_devices`/`user_rules`/`scenes`/`pipelines` carry a nullable `area_id` (SET NULL on delete — removing an area only un-groups, never deletes). Powers dashboard sectioning + area-scoped notifications.

| id  | user_id | name         | sort_order |
| --- | ------- | ------------ | ---------- |
| 1   | 2       | Greenhouse A | 0          |

#### `user_device_actions` (`UserDeviceAction`) — an activated capability instance. Index `(user_device_id, mqtt_action_name)`. `sort_order` = position within group. `default_trait_id` (nullable FK → `google_device_traits`) = the user's chosen display trait; overrides the capability-level `is_default` when set. Resolution order: `default_trait_id` → catalog `is_default` trait → first trait. `camera_resolution`/`camera_transport` are only meaningful for a `CameraAction` instance (nullable, unused by every other implementation_type).

| id  | user_device_id | capability_id | group_id | default_trait_id | action_name | mqtt_action_name | current_state | status | sort_order | camera_resolution | camera_transport |
| --- | -------------- | ------------- | -------- | ---------------- | ----------- | ---------------- | ------------- | ------ | ---------- | ----------------- | ---------------- |
| 100 | 7              | 10            | 1        | NULL             | Garage Temp | temperature      | "23.4"        | active | 0          | NULL              | NULL             |
| 101 | 7              | 11            | 1        | 1                | Door Relay  | relay1           | "OFF"         | active | 1          | NULL              | NULL             |
| 102 | 7              | 12            | 1        | NULL             | Door Camera | camera           | NULL          | active | 2          | SVGA              | http             |
| 102 | 7              | 12            | 1        | NULL             | Garage Cam  | cam              | NULL          | active | 2          |

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
