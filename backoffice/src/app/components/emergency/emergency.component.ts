import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { EmergencyService } from 'src/app/services/emergency.service';
import { downloadJson, readJsonFile } from 'src/app/utils/import-export.utils';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { forkJoin } from 'rxjs';
import type { EmergencyRule, EmergencyEvent, UserAction, UserActionGroup } from 'src/app/models';

@Component({
  selector: 'app-emergency',
  imports: [SHARED_MATERIAL],
  templateUrl: './emergency.component.html',
  styleUrl: './emergency.component.css',
})
export class EmergencyComponent implements OnInit {
  private svc        = inject(EmergencyService);
  private actionsSvc = inject(UserActionsService);
  private socket     = inject(DeviceSocketService);
  private snack      = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  activeTab = signal<'rules' | 'events'>('rules');

  rules:       EmergencyRule[]   = [];
  events:      EmergencyEvent[]  = [];
  userActions: UserAction[]      = [];
  userGroups:  UserActionGroup[] = [];

  // ── New-rule form ──────────────────────────────────────────────────────────
  showForm    = signal(false);
  editRule    = signal<EmergencyRule | null>(null);
  formName         = '';
  formSourceScope  = 'capability';
  formSourceCap    = '';
  formSourceAction = '';
  formSourceGroup  = '';
  formOperator     = '>';
  formThreshold    = '';
  formTargetScope  = 'capability';
  formTargetCap    = '';
  formTargetAction = '';
  formTargetGroup  = '';
  formTargetState  = '';

  readonly operators = ['>', '>=', '<', '<=', '==', '!='];
  readonly scopes    = ['capability', 'instance', 'group'];

  ngOnInit(): void {
    this.load();
    forkJoin({
      actions: this.actionsSvc.getUserActions(),
      groups:  this.actionsSvc.getGroups(),
    }).subscribe(({ actions, groups }) => {
      this.userActions = actions;
      this.userGroups  = groups;
    });

    this.socket.onEmergencyAlert()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(alert => {
        this.snack.open(`🚨 Emergency: ${alert.rule_name} — value ${alert.value}`, 'Dismiss', { duration: 8000 });
        if (this.activeTab() === 'events') this.loadEvents();
      });
  }

  private load(): void {
    this.svc.getRules().subscribe(r => this.rules = r);
  }

  loadEvents(): void {
    this.svc.getEvents(50).subscribe(e => this.events = e);
  }

  switchTab(tab: 'rules' | 'events'): void {
    this.activeTab.set(tab);
    if (tab === 'events') this.loadEvents();
  }

  openCreate(): void {
    this.editRule.set(null);
    this.resetForm();
    this.showForm.set(true);
  }

  openEdit(rule: EmergencyRule): void {
    this.editRule.set(rule);
    this.formName        = rule.name;
    this.formSourceScope = rule.source_scope;
    this.formSourceCap   = rule.source_capability ?? '';
    this.formSourceAction= rule.source_user_action_id ? String(rule.source_user_action_id) : '';
    this.formSourceGroup = rule.source_group_id ? String(rule.source_group_id) : '';
    this.formOperator    = rule.operator;
    this.formThreshold   = rule.threshold;
    this.formTargetScope = rule.target_scope;
    this.formTargetCap   = rule.target_capability ?? '';
    this.formTargetAction= rule.target_user_action_id ? String(rule.target_user_action_id) : '';
    this.formTargetGroup = rule.target_group_id ? String(rule.target_group_id) : '';
    this.formTargetState = rule.target_state ?? '';
    this.showForm.set(true);
  }

  saveRule(): void {
    const payload: Partial<EmergencyRule> = {
      name:                  this.formName,
      source_scope:          this.formSourceScope as EmergencyRule['source_scope'],
      source_capability:     this.formSourceScope === 'capability' ? this.formSourceCap  : null,
      source_user_action_id: this.formSourceScope === 'instance'   ? +this.formSourceAction : null,
      source_group_id:       this.formSourceScope === 'group'      ? +this.formSourceGroup  : null,
      operator:              this.formOperator,
      threshold:             this.formThreshold,
      target_scope:          this.formTargetScope as EmergencyRule['target_scope'],
      target_capability:     this.formTargetScope === 'capability' ? this.formTargetCap  : null,
      target_user_action_id: this.formTargetScope === 'instance'   ? +this.formTargetAction : null,
      target_group_id:       this.formTargetScope === 'group'      ? +this.formTargetGroup  : null,
      target_state:          this.formTargetState,
    };

    const existing = this.editRule();
    if (existing) {
      this.svc.createRule(payload).subscribe(() => {
        this.snack.open('Rule updated', 'OK', { duration: 2000 });
        this.cancelForm();
        this.load();
      });
    } else {
      this.svc.createRule(payload).subscribe(() => {
        this.snack.open('Rule created', 'OK', { duration: 2000 });
        this.cancelForm();
        this.load();
      });
    }
  }

  cancelForm(): void {
    this.showForm.set(false);
    this.editRule.set(null);
    this.resetForm();
  }

  private resetForm(): void {
    this.formName = ''; this.formSourceScope = 'capability'; this.formSourceCap = '';
    this.formSourceAction = ''; this.formSourceGroup = ''; this.formOperator = '>';
    this.formThreshold = ''; this.formTargetScope = 'capability'; this.formTargetCap = '';
    this.formTargetAction = ''; this.formTargetGroup = ''; this.formTargetState = '';
  }

  toggle(rule: EmergencyRule): void {
    this.svc.toggle(rule.id, !rule.enabled).subscribe(() => rule.enabled = !rule.enabled);
  }

  delete(rule: EmergencyRule): void {
    this.svc.deleteRule(rule.id).subscribe(() => {
      this.rules = this.rules.filter(r => r.id !== rule.id);
      this.snack.open('Rule deleted', 'OK', { duration: 2000 });
    });
  }

  sourceSummary(rule: EmergencyRule): string {
    if (rule.source_scope === 'capability') return `capability: ${rule.source_capability ?? '?'}`;
    if (rule.source_scope === 'instance')   return `action #${rule.source_user_action_id}`;
    return `group #${rule.source_group_id}`;
  }

  targetSummary(rule: EmergencyRule): string {
    if (rule.target_scope === 'capability') return `capability: ${rule.target_capability ?? '?'} → ${rule.target_state ?? '?'}`;
    if (rule.target_scope === 'instance')   return `action #${rule.target_user_action_id} → ${rule.target_state ?? '?'}`;
    return `group #${rule.target_group_id} → ${rule.target_state ?? '?'}`;
  }

  firedAt(ev: EmergencyEvent): string {
    return new Date(ev.fired_at).toLocaleString();
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportConfig(): void {
    this.svc.getRules().subscribe(rules =>
      downloadJson('lattice-emergency.json', { version: '1', exported_at: new Date().toISOString(), emergency_rules: rules })
    );
  }

  importConfig(file: File): void {
    readJsonFile(file).then(data => {
      this.svc.importRules(data).subscribe({
        next: r => { this.snack.open(`Imported ${r.imported} rule(s)`, 'OK', { duration: 3000 }); this.load(); },
        error: () => this.snack.open('Import failed', 'OK', { duration: 3000 }),
      });
    }).catch(() => this.snack.open('Invalid JSON file', 'OK', { duration: 3000 }));
  }
}
