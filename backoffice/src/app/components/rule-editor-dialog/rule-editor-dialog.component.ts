import { Component, inject, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceActionView, DeviceView } from 'src/app/services/device.mgmt.service';
import { CreateRuleDto, UserRuleView } from 'src/app/services/user.rules.service';
import { actionControlType, ActionControlType } from 'src/app/utils/device-type.utils';

interface ConditionPrefill {
  days?: number[];
  time?: string;
  user_device_id?: number | null;
  value?: string;
  status?: string;
  user_device_action_id?: number | null;
  operator?: string;
}

interface ActionPrefill {
  user_device_action_id?: number | null;
  target_state?: string;
  delay_seconds?: number;
}

interface ConditionFormValue {
  condition_type: string;
  time?: string;
  days?: boolean[];
  device_id?: number;
  value?: unknown;
  user_device_action_id?: number;
  operator?: string;
}

interface ActionFormValue {
  user_device_action_id: number;
  target_state: unknown;
  delay_seconds: number;
}

export interface RuleEditorData {
  rule?: UserRuleView;
  actions: DeviceActionView[];
  devices: DeviceView[];
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Component({
  selector: 'app-rule-editor-dialog',
  standalone: true,
  imports: [...SHARED_MATERIAL, MatButtonToggleModule, MatCheckboxModule],
  templateUrl: './rule-editor-dialog.component.html',
  styleUrl: './rule-editor-dialog.component.css',
})
export class RuleEditorDialogComponent implements OnInit {
  dialogRef = inject(MatDialogRef<RuleEditorDialogComponent>);
  data: RuleEditorData = inject(MAT_DIALOG_DATA);
  fb = inject(FormBuilder);

  dayLabels = DAY_LABELS;
  dayNames = DAY_NAMES;

  form!: FormGroup;

  get conditionsArray(): FormArray { return this.form.get('conditions') as FormArray; }
  get actionsArray(): FormArray { return this.form.get('actions') as FormArray; }

  get uniqueDevices(): { id: number; name: string }[] {
    return this.data.devices.map(d => ({ id: d.id, name: d.deviceName }));
  }

  getActionsForDevice(deviceId: number | null | undefined): DeviceActionView[] {
    if (!deviceId) return [];
    return this.data.actions.filter(a => a.deviceId === deviceId);
  }

  private deviceIdForAction(actionId: number | null | undefined): number | null {
    if (!actionId) return null;
    return this.data.actions.find(a => a.id === Number(actionId))?.deviceId ?? null;
  }

  ngOnInit(): void {
    const rule = this.data.rule;
    this.form = this.fb.group({
      name: [rule?.name ?? '', Validators.required],
      condition_operator: [rule?.condition_operator ?? 'AND'],
      cooldown_seconds: [rule?.cooldown_seconds ?? 60, [Validators.required, Validators.min(0)]],
      is_emergency: [rule?.is_emergency ?? false],
      conditions: this.fb.array([]),
      actions: this.fb.array([]),
    });

    if (rule) {
      for (const c of rule.conditions) {
        this.addCondition(c.condition_type as 'device_state' | 'threshold' | 'schedule' | 'device_status', {
          days: c.schedule_days ?? [],
          time: c.schedule_time ?? undefined,
          user_device_id: c.user_device_id ?? undefined,
          value: c.threshold_value ?? c.status_value ?? undefined,
          status: c.status_value ?? undefined,
          user_device_action_id: c.user_device_action_id ?? undefined,
          operator: c.operator ?? undefined,
        });
      }
      for (const a of rule.actions) {
        this.addAction(a);
      }
    }
  }

  // ── Action info helpers ──────────────────────────────────────────

  getAction(id: number | null | undefined): DeviceActionView | undefined {
    return id != null ? this.data.actions.find(a => a.id === Number(id)) : undefined;
  }

  actionLabel(a: DeviceActionView): string {
    return a.deviceName ? `${a.deviceName} · ${a.name}` : a.name;
  }

  getActionControlType(id: number | null | undefined): ActionControlType {
    return actionControlType(this.getAction(id));
  }

  getConditionOperators(condIndex: number): { value: string; label: string }[] {
    const all = [
      { value: '=', label: '=' }, { value: '!=', label: '≠' },
      { value: '>', label: '>' }, { value: '<', label: '<' },
      { value: '>=', label: '≥' }, { value: '<=', label: '≤' },
    ];
    const actionId = this.conditionsArray.at(condIndex).get('user_device_action_id')?.value;
    const type = this.getActionControlType(actionId);
    return type === 'onoff' ? all.slice(0, 2) : all;
  }

  // ── Form array mutations ─────────────────────────────────────────

  addCondition(type: 'device_state' | 'threshold' | 'schedule' | 'device_status', prefill?: ConditionPrefill): void {
    let group: FormGroup;
    if (type === 'schedule') {
      const days = prefill?.days ?? [];
      group = this.fb.group({
        condition_type: [type],
        time: [prefill?.time ?? '08:00', Validators.required],
        days: this.fb.array(DAY_LABELS.map((_, i) => this.fb.control(days.includes(i)))),
      });
    } else if (type === 'device_state' || type === 'device_status') {
      group = this.fb.group({
        condition_type: ['device_state'],
        device_id: [prefill?.user_device_id ?? null, Validators.required],
        value: [prefill?.value ?? prefill?.status ?? 'online', Validators.required],
      });
    } else {
      // threshold
      group = this.fb.group({
        condition_type: [type],
        device_id: [this.deviceIdForAction(prefill?.user_device_action_id)],
        user_device_action_id: [prefill?.user_device_action_id ?? null, Validators.required],
        operator: [prefill?.operator ?? '=', Validators.required],
        value: [prefill?.value ?? '', Validators.required],
      });
    }
    this.conditionsArray.push(group);
  }

  removeCondition(i: number): void { this.conditionsArray.removeAt(i); }

  onConditionDeviceChange(i: number): void {
    this.conditionsArray.at(i).get('user_device_action_id')?.setValue(null);
    this.conditionsArray.at(i).get('value')?.setValue('');
    this.conditionsArray.at(i).get('operator')?.setValue('=');
  }

  onConditionActionChange(i: number): void {
    this.conditionsArray.at(i).get('value')?.setValue('');
    this.conditionsArray.at(i).get('operator')?.setValue('=');
  }

  getDaysArray(conditionIndex: number): FormArray {
    return this.conditionsArray.at(conditionIndex).get('days') as FormArray;
  }

  addAction(prefill?: ActionPrefill): void {
    this.actionsArray.push(this.fb.group({
      user_device_action_id: [prefill?.user_device_action_id ?? null, Validators.required],
      target_state: [prefill?.target_state ?? '', Validators.required],
      delay_seconds: [prefill?.delay_seconds ?? 0, [Validators.required, Validators.min(0)]],
    }));
  }

  removeAction(i: number): void { this.actionsArray.removeAt(i); }

  onTargetActionChange(i: number): void {
    this.actionsArray.at(i).get('target_state')?.setValue('');
  }

  hasNonScheduleCondition(): boolean {
    return this.conditionsArray.controls.some(
      c => c.get('condition_type')?.value !== 'schedule'
    );
  }

  // ── Save ─────────────────────────────────────────────────────────

  save(): void {
    if (this.form.invalid || this.conditionsArray.length === 0 || this.actionsArray.length === 0) return;

    const value = this.form.value;
    const dto: CreateRuleDto = {
      name: value.name,
      condition_operator: value.condition_operator,
      cooldown_seconds: value.cooldown_seconds,
      is_emergency: value.is_emergency,
      conditions: value.conditions.map((c: ConditionFormValue) => {
        if (c.condition_type === 'schedule') {
          const days = (c.days as boolean[]).map((checked, i) => checked ? i : -1).filter(i => i >= 0);
          return { condition_type: 'schedule', schedule_time: c.time, schedule_days: days };
        }
        if (c.condition_type === 'device_state') {
          return { condition_type: 'device_state', user_device_id: c.device_id, status_value: String(c.value) };
        }
        // threshold
        return {
          condition_type: 'threshold',
          user_device_action_id: c.user_device_action_id,
          operator: c.operator,
          threshold_value: String(c.value),
        };
      }),
      actions: value.actions.map((a: ActionFormValue) => ({
        user_device_action_id: a.user_device_action_id,
        target_state: String(a.target_state),
        delay_seconds: a.delay_seconds,
      })),
    };

    this.dialogRef.close(dto);
  }
}
