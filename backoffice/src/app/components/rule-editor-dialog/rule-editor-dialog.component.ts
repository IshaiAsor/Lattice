import { Component, inject, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import type { Rule, UserAction, UserActionGroup, RuleConditionKind, RuleActionKind, RuleActionScope } from 'src/app/models';

export interface RuleEditorData {
  rule?:    Rule;
  actions:  UserAction[];
  groups:   UserActionGroup[];
}

const CONDITION_KINDS: { value: RuleConditionKind; label: string }[] = [
  { value: 'threshold',       label: 'Threshold' },
  { value: 'schedule',        label: 'Schedule' },
  { value: 'device_status',   label: 'Device status' },
  { value: 'vlm_result',      label: 'VLM result' },
  { value: 'vlm_decision',    label: 'VLM decision' },
  { value: 'pipeline_result', label: 'Pipeline result' },
];

@Component({
  selector: 'app-rule-editor-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL, MatButtonToggleModule],
  templateUrl: './rule-editor-dialog.component.html',
  styleUrl: './rule-editor-dialog.component.css',
})
export class RuleEditorDialogComponent implements OnInit {
  private fb      = inject(FormBuilder);
  dialogRef       = inject(MatDialogRef<RuleEditorDialogComponent>);
  data: RuleEditorData = inject(MAT_DIALOG_DATA);

  conditionKinds = CONDITION_KINDS;
  operators      = ['>', '<', '>=', '<=', '==', '!='];

  form!: FormGroup;

  get conditions(): FormArray { return this.form.get('conditions') as FormArray; }
  get actions():    FormArray { return this.form.get('actions')    as FormArray; }

  // Unique capabilities from user actions
  get capabilities(): string[] {
    return [...new Set(this.data.actions.map(a => a.action_def?.capability).filter(Boolean) as string[])];
  }

  ngOnInit(): void {
    const rule = this.data.rule;
    this.form = this.fb.group({
      name:        [rule?.name         ?? '',     Validators.required],
      match:       [rule?.match        ?? 'AND'],
      cooldown_sec:[rule?.cooldown_sec ?? 60,     [Validators.required, Validators.min(0)]],
      conditions:  this.fb.array(rule?.conditions.map(c => this.conditionGroup(c)) ?? [this.conditionGroup()]),
      actions:     this.fb.array(rule?.actions.map(a => this.actionGroup(a))       ?? [this.actionGroup()]),
    });
  }

  private conditionGroup(c?: Partial<Rule['conditions'][0]>): FormGroup {
    return this.fb.group({
      kind:        [c?.kind ?? 'threshold'],
      capability:  [(c?.params as any)?.capability   ?? ''],
      operator:    [(c?.params as any)?.operator     ?? '>'],
      value:       [(c?.params as any)?.value        ?? ''],
      cron:        [(c?.params as any)?.cron         ?? ''],
      status:      [(c?.params as any)?.status       ?? 'online'],
      pipeline_id: [(c?.params as any)?.pipeline_id  ?? null],
      expected:    [(c?.params as any)?.expected     ?? ''],
    });
  }

  private actionGroup(a?: Partial<Rule['actions'][0]>): FormGroup {
    return this.fb.group({
      kind:           [a?.kind         ?? 'set_state'],
      scope:          [a?.scope        ?? 'capability'],
      user_action_id: [a?.user_action_id ?? null],
      capability:     [a?.capability   ?? ''],
      group_id:       [a?.group_id     ?? null],
      target_state:   [a?.target_state ?? ''],
      pipeline_id:    [a?.pipeline_id  ?? null],
      delay_sec:      [a?.delay_sec    ?? 0,   [Validators.min(0)]],
    });
  }

  addCondition(): void { this.conditions.push(this.conditionGroup()); }
  removeCondition(i: number): void { this.conditions.removeAt(i); }
  addAction(): void { this.actions.push(this.actionGroup()); }
  removeAction(i: number): void { this.actions.removeAt(i); }

  save(): void {
    if (this.form.invalid) return;
    const v = this.form.value;
    this.dialogRef.close({
      name:        v.name,
      match:       v.match,
      cooldown_sec:+v.cooldown_sec,
      conditions:  v.conditions.map((c: any) => ({
        kind:   c.kind,
        params: this.buildConditionParams(c),
      })),
      actions: v.actions.map((a: any) => ({
        kind:           a.kind,
        scope:          a.scope,
        user_action_id: a.scope === 'instance'   ? (a.user_action_id ?? null) : null,
        capability:     a.scope === 'capability'  ? (a.capability || null) : null,
        group_id:       a.scope === 'group'       ? (a.group_id ?? null) : null,
        target_state:   a.kind === 'set_state'    ? (a.target_state || null) : null,
        pipeline_id:    a.kind === 'run_pipeline' ? (a.pipeline_id ?? null) : null,
        delay_sec:      +a.delay_sec,
      })),
    });
  }

  private buildConditionParams(c: any): Record<string, unknown> {
    switch (c.kind as RuleConditionKind) {
      case 'threshold':       return { capability: c.capability, operator: c.operator, value: c.value };
      case 'schedule':        return { cron: c.cron };
      case 'device_status':   return { status: c.status };
      case 'vlm_result':
      case 'vlm_decision':    return { pipeline_id: c.pipeline_id, expected: c.expected };
      case 'pipeline_result': return { pipeline_id: c.pipeline_id, expected: c.expected };
      default:                return {};
    }
  }

  cancel(): void { this.dialogRef.close(); }
}
