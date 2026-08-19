import { Component, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, switchMap, of } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  RuleConditionDto,
  RuleEventView,
  UserRulesService,
  UserRuleView,
} from 'src/app/services/user.rules.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import {
  DeviceActionView,
  DeviceMgmtService,
  DeviceView,
} from 'src/app/services/device.mgmt.service';
import { RuleEditorDialogComponent } from '../rule-editor-dialog/rule-editor-dialog.component';

/** Condition types collapse to three user-facing kinds — `device_status` is a legacy spelling
 *  of `device_state`, and both read as "State" on a card. */
const CONDITION_KIND: Record<string, { label: string; cls: string }> = {
  schedule: { label: 'Schedule', cls: 'pill-schedule' },
  threshold: { label: 'Threshold', cls: 'pill-threshold' },
  device_state: { label: 'State', cls: 'pill-state' },
  device_status: { label: 'State', cls: 'pill-state' },
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "12m ago" / "9h ago" / "2d ago" — the card only ever needs the coarse shape. */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

@Component({
  selector: 'app-rules',
  imports: [SHARED_MATERIAL],
  templateUrl: './rules.component.html',
  styleUrl: './rules.component.css',
})
export class RulesComponent implements OnInit {
  rulesService = inject(UserRulesService);
  actionsService = inject(UserActionsService);
  deviceMgmtService = inject(DeviceMgmtService);
  dialog = inject(MatDialog);
  snackBar = inject(MatSnackBar);

  rules: UserRuleView[] = [];
  events: RuleEventView[] = [];
  userActions: DeviceActionView[] = [];
  userDevices: DeviceView[] = [];
  actionsLoaded = false;
  loading = false;

  /** Which rule's fire history is expanded inline, if any. */
  expandedHistory: number | null = null;

  ngOnInit(): void {
    this.loadRules();
    this.loadEvents();
    forkJoin({
      actions: this.actionsService.getUserActions(),
      devices: this.deviceMgmtService.getDevices(),
    }).subscribe(({ actions, devices }) => {
      this.userActions = actions;
      this.userDevices = devices;
      this.actionsLoaded = true;
    });
  }

  loadRules(): void {
    this.loading = true;
    this.rulesService.getRules().subscribe({
      next: (rules) => {
        this.rules = rules;
        this.chipCache.clear();
        this.pillCache.clear();
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      },
    });
  }

  /** Fire events back the whole list: they feed the 24h stat and every card's history panel,
   *  so one call serves the page rather than one per rule. */
  loadEvents(): void {
    this.rulesService.getEvents().subscribe({
      next: (events) => (this.events = events),
      error: () => (this.events = []),
    });
  }

  // ── Stats row ──────────────────────────────────────────────────────────

  get totalEnabled(): number {
    return this.rules.filter((r) => r.enabled).length;
  }

  get firedToday(): number {
    const since = Date.now() - 86400_000;
    return this.events.filter((e) => new Date(e.fired_at).getTime() >= since).length;
  }

  get emergencyCount(): number {
    return this.rules.filter((r) => r.is_emergency).length;
  }

  // ── Card chrome ────────────────────────────────────────────────────────

  // Derived-per-card values are memoised by rule id, for two reasons. The status chip reads the
  // CLOCK: recomputing it during Angular's verification pass can return a different string than
  // the render pass produced ("fired 51s ago" → "fired 52s ago"), which is NG0100. The pills
  // return a fresh array, which would be rebuilt for all 44 cards on every change-detection tick.
  // Both are cleared on load and per rule on toggle — the only things that change their inputs.
  private chipCache = new Map<number, { cls: string; text: string }>();
  private pillCache = new Map<number, { label: string; cls: string }[]>();

  /** Distinct condition kinds, in the order they appear on the rule. */
  conditionPills(rule: UserRuleView): { label: string; cls: string }[] {
    const cached = this.pillCache.get(rule.id);
    if (cached) return cached;

    const seen = new Set<string>();
    const pills: { label: string; cls: string }[] = [];
    for (const c of rule.conditions) {
      const kind = CONDITION_KIND[c.condition_type];
      if (!kind || seen.has(kind.label)) continue;
      seen.add(kind.label);
      pills.push(kind);
    }
    this.pillCache.set(rule.id, pills);
    return pills;
  }

  matchLabel(rule: UserRuleView): string {
    // With one condition the operator decides nothing, so claiming "ALL match" is noise.
    if (rule.conditions.length < 2) return '1 condition';
    return rule.condition_operator === 'AND' ? 'ALL match' : 'ANY match';
  }

  cooldownLabel(rule: UserRuleView): string {
    const s = rule.cooldown_seconds;
    if (!s) return 'no cooldown';
    if (s % 3600 === 0) return `cooldown ${s / 3600} h`;
    if (s % 60 === 0) return `cooldown ${s / 60} min`;
    return `cooldown ${s} s`;
  }

  statusChip(rule: UserRuleView): { cls: string; text: string } {
    const cached = this.chipCache.get(rule.id);
    if (cached) return cached;

    const chip = !rule.enabled
      ? { cls: 'status-q', text: 'disabled' }
      : !rule.last_triggered
        ? { cls: 'status-q', text: 'never fired' }
        : { cls: 'status-ok', text: `fired ${ago(rule.last_triggered)}` };
    this.chipCache.set(rule.id, chip);
    return chip;
  }

  // ── Inline history ─────────────────────────────────────────────────────

  toggleHistory(ruleId: number): void {
    this.expandedHistory = this.expandedHistory === ruleId ? null : ruleId;
  }

  eventsFor(ruleId: number): { fired: string; value: string | null }[] {
    return this.events
      .filter((e) => e.rule_id === ruleId)
      .slice(0, 10)
      .map((e) => ({ fired: e.fired_at, value: e.triggered_value }));
  }

  // ── Rule CRUD ──────────────────────────────────────────────────────────

  openEditor(rule?: UserRuleView): void {
    const data$ =
      this.userActions.length && this.userDevices.length
        ? of({ actions: this.userActions, devices: this.userDevices })
        : forkJoin({
            actions: this.actionsService.getUserActions(),
            devices: this.deviceMgmtService.getDevices(),
          });

    data$
      .pipe(
        switchMap(({ actions, devices }) => {
          this.userActions = actions;
          this.userDevices = devices;
          this.actionsLoaded = true;
          const dialogRef = this.dialog.open(RuleEditorDialogComponent, {
            // Same shell as the pipeline editor: the board + rail + drawer needs the width,
            // and below 600px the global full-bleed rules turn the drawer into a bottom sheet.
            width: '1040px',
            maxWidth: '96vw',
            height: '760px',
            maxHeight: '92vh',
            panelClass: ['glass-dialog', 'rule-editor-dialog'],
            data: { rule, actions, devices },
          });
          return dialogRef.afterClosed();
        }),
      )
      .subscribe((result) => {
        if (!result) return;
        if (rule) {
          this.rulesService.updateRule(rule.id, result).subscribe(() => {
            this.snackBar.open('Rule updated', 'Close', { duration: 2000 });
            this.loadRules();
          });
        } else {
          this.rulesService.createRule(result).subscribe(() => {
            this.snackBar.open('Rule created', 'Close', { duration: 2000 });
            this.loadRules();
          });
        }
      });
  }

  toggle(rule: UserRuleView): void {
    this.rulesService.toggleRule(rule.id, !rule.enabled).subscribe(() => {
      rule.enabled = !rule.enabled;
      // enabled is an input to the chip ("disabled" vs "fired …"), so this one has to re-derive.
      this.chipCache.delete(rule.id);
    });
  }

  delete(rule: UserRuleView): void {
    this.rulesService.deleteRule(rule.id).subscribe(() => {
      this.rules = this.rules.filter((r) => r.id !== rule.id);
      this.snackBar.open('Rule deleted', 'Close', { duration: 2000 });
    });
  }

  // ── Flow strip ─────────────────────────────────────────────────────────

  /** One condition, in words. Kept per-condition (rather than one joined string) so the flow
   *  strip can put the AND/OR between them in its own voice. */
  conditionText(c: RuleConditionDto): string {
    if (c.condition_type === 'schedule') {
      // A window makes this a loop, and a list that still said "At 06:00" for one would be
      // describing something the rule does not do.
      const when =
        c.schedule_until && c.schedule_every_minutes
          ? `${c.schedule_time}–${c.schedule_until} every ${c.schedule_every_minutes} min`
          : `At ${c.schedule_time}`;
      const days = c.schedule_days ?? [];
      if (days.length === 0 || days.length === 7) return when;
      return `${when} · ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
    }
    if (c.condition_type === 'device_state' || c.condition_type === 'device_status') {
      const device = this.userDevices.find((d) => d.id === c.user_device_id);
      const name = device?.deviceName ?? `Device #${c.user_device_id}`;
      return `${name} is ${c.status_value}`;
    }
    // A blueprint template rule carries no action id until it is bound to real devices, so
    // "Action #null" is the shape this used to print for a perfectly normal unbound rule.
    const action = this.userActions.find((a) => a.id === c.user_device_action_id);
    const name = action
      ? `${action.deviceName} · ${action.name}`
      : c.user_device_action_id == null
        ? 'unbound action'
        : `Action #${c.user_device_action_id}`;
    return `${name} ${c.operator} ${c.threshold_value}`;
  }

  conditionSummary(rule: UserRuleView): string {
    return rule.conditions.map((c) => this.conditionText(c)).join(` ${rule.condition_operator} `);
  }

  actionSummary(rule: UserRuleView): string {
    // 17 of the dev stack's rules have none — an empty THEN read as a broken card.
    if (rule.actions.length === 0) return 'nothing yet';
    return rule.actions
      .map((a) => {
        const action = this.userActions.find((ua) => ua.id === a.user_device_action_id);
        const name = action?.name ?? `Action #${a.user_device_action_id}`;
        const delay = a.delay_seconds ? ` after ${a.delay_seconds}s` : '';
        return `${name} → ${a.target_state}${delay}`;
      })
      .join(', ');
  }
}
