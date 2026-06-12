import { Component, inject, OnInit, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, Observable } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { UserRulesService, CreateRulePayload } from 'src/app/services/user.rules.service';
import { downloadJson, readJsonFile } from 'src/app/utils/import-export.utils';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { RuleEditorDialogComponent } from '../rule-editor-dialog/rule-editor-dialog.component';
import type { Rule, UserAction, UserActionGroup } from 'src/app/models';

@Component({
  selector: 'app-rules',
  imports: [SHARED_MATERIAL],
  templateUrl: './rules.component.html',
  styleUrl: './rules.component.css',
})
export class RulesComponent implements OnInit {
  private rulesSvc   = inject(UserRulesService);
  private actionsSvc = inject(UserActionsService);
  private dialog     = inject(MatDialog);
  private snackBar   = inject(MatSnackBar);

  rules: Rule[] = [];
  userActions: UserAction[]       = [];
  userGroups:  UserActionGroup[]  = [];

  // ── AI assistant ───────────────────────────────────────────────────────
  aiGoal      = signal('');
  aiPreview   = signal<CreateRulePayload[] | null>(null);
  aiLoading   = signal(false);
  aiError     = signal('');

  ngOnInit(): void {
    this.load();
    forkJoin({
      actions: this.actionsSvc.getUserActions(),
      groups:  this.actionsSvc.getGroups(),
    }).subscribe(({ actions, groups }) => {
      this.userActions = actions;
      this.userGroups  = groups;
    });
  }

  private load(): void {
    this.rulesSvc.getRules().subscribe(rules => this.rules = rules);
  }

  openEditor(rule?: Rule): void {
    this.dialog.open(RuleEditorDialogComponent, {
      width: '680px', maxWidth: '95vw', maxHeight: '90vh',
      data: { rule, actions: this.userActions, groups: this.userGroups },
    }).afterClosed().subscribe((payload: CreateRulePayload | undefined) => {
      if (!payload) return;
      const call$: Observable<unknown> = rule
        ? this.rulesSvc.updateRule(rule.id, payload)
        : this.rulesSvc.createRule(payload);
      call$.subscribe(() => {
        this.snackBar.open(rule ? 'Rule updated' : 'Rule created', 'OK', { duration: 2000 });
        this.load();
      });
    });
  }

  toggle(rule: Rule): void {
    this.rulesSvc.toggleRule(rule.id, !rule.enabled).subscribe(() => rule.enabled = !rule.enabled);
  }

  delete(rule: Rule): void {
    this.rulesSvc.deleteRule(rule.id).subscribe(() => {
      this.rules = this.rules.filter(r => r.id !== rule.id);
      this.snackBar.open('Rule deleted', 'OK', { duration: 2000 });
    });
  }

  conditionSummary(rule: Rule): string {
    return rule.conditions.map(c => {
      const p = c.params as any;
      if (c.kind === 'schedule') return `At ${p.cron ?? p.time ?? '?'}`;
      if (c.kind === 'threshold') return `${p.capability ?? '?'} ${p.operator} ${p.value}`;
      if (c.kind === 'device_status') return `device ${p.status}`;
      return c.kind;
    }).join(` ${rule.match} `);
  }

  actionSummary(rule: Rule): string {
    return rule.actions.map(a => {
      if (a.kind === 'run_pipeline') return `Run pipeline`;
      const target = a.user_action_id ? `action #${a.user_action_id}`
                   : a.capability      ? a.capability
                   : a.group_id        ? `group #${a.group_id}`
                   : '?';
      return `${target} → ${a.target_state ?? '?'}`;
    }).join(', ');
  }

  isAiRule(rule: Rule): boolean { return rule.name.startsWith('[AI]'); }

  // ── AI assistant methods ───────────────────────────────────────────────
  generateAi(): void {
    if (!this.aiGoal().trim()) return;
    this.aiLoading.set(true); this.aiError.set(''); this.aiPreview.set(null);
    this.rulesSvc.aiGenerate(this.aiGoal()).subscribe({
      next:  r   => { this.aiPreview.set(r.rules); this.aiLoading.set(false); },
      error: err => { this.aiError.set(err.error?.error ?? 'Generation failed'); this.aiLoading.set(false); },
    });
  }

  applyAi(): void {
    const rules = this.aiPreview();
    if (!rules?.length) return;
    this.rulesSvc.aiApply(rules).subscribe(() => {
      this.snackBar.open('AI rules applied', 'OK', { duration: 2000 });
      this.aiPreview.set(null); this.aiGoal.set('');
      this.load();
    });
  }

  clearAi(): void {
    this.rulesSvc.aiClear().subscribe(r => {
      this.snackBar.open(`Cleared ${r.deleted} AI rules`, 'OK', { duration: 2000 });
      this.load();
    });
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportConfig(): void {
    this.rulesSvc.getRules().subscribe(rules =>
      downloadJson('lattice-rules.json', { version: '1', exported_at: new Date().toISOString(), rules })
    );
  }

  importConfig(file: File): void {
    readJsonFile(file).then(data => {
      this.rulesSvc.importRules(data).subscribe({
        next: r => { this.snackBar.open(`Imported ${r.imported} rule(s)`, 'OK', { duration: 3000 }); this.load(); },
        error: () => this.snackBar.open('Import failed', 'OK', { duration: 3000 }),
      });
    }).catch(() => this.snackBar.open('Invalid JSON file', 'OK', { duration: 3000 }));
  }
}
