import { Component, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, switchMap, of } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { UserRulesService, UserRuleView } from 'src/app/services/user.rules.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceActionView, DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { RuleEditorDialogComponent } from '../rule-editor-dialog/rule-editor-dialog.component';

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
  userActions: DeviceActionView[] = [];
  userDevices: DeviceView[] = [];
  actionsLoaded = false;

  ngOnInit(): void {
    this.loadRules();
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
    this.rulesService.getRules().subscribe((rules) => {
      this.rules = rules;
    });
  }

  openEditor(rule?: UserRuleView): void {
    const data$ = (this.userActions.length && this.userDevices.length)
      ? of({ actions: this.userActions, devices: this.userDevices })
      : forkJoin({ actions: this.actionsService.getUserActions(), devices: this.deviceMgmtService.getDevices() });

    data$.pipe(
      switchMap(({ actions, devices }) => {
        this.userActions = actions;
        this.userDevices = devices;
        this.actionsLoaded = true;
        const dialogRef = this.dialog.open(RuleEditorDialogComponent, {
          width: '640px',
          maxHeight: '90vh',
          data: { rule, actions, devices },
        });
        return dialogRef.afterClosed();
      })
    ).subscribe((result) => {
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
    });
  }

  delete(rule: UserRuleView): void {
    this.rulesService.deleteRule(rule.id).subscribe(() => {
      this.rules = this.rules.filter((r) => r.id !== rule.id);
      this.snackBar.open('Rule deleted', 'Close', { duration: 2000 });
    });
  }

  conditionSummary(rule: UserRuleView): string {
    return rule.conditions.map((c) => {
      const p = c.parameters as any;
      if (c.condition_type === 'schedule') return `At ${p.time}`;
      if (c.condition_type === 'device_state' || c.condition_type === 'device_status') {
        const device = this.userDevices.find((d) => d.id === p.user_device_id);
        const name = device?.deviceName ?? `Device #${p.user_device_id}`;
        return `${name} is ${p.value ?? p.status}`;
      }
      const action = this.userActions.find((a) => a.id === p.user_device_action_id);
      const name = action ? `${action.deviceName} · ${action.name}` : `Action #${p.user_device_action_id}`;
      return `${name} ${p.operator} ${p.value}`;
    }).join(` ${rule.condition_operator} `);
  }

  actionSummary(rule: UserRuleView): string {
    return rule.actions.map((a) => {
      const action = this.userActions.find((ua) => ua.id === a.user_device_action_id);
      const name = action?.name ?? `Action #${a.user_device_action_id}`;
      return `Set ${name} → ${a.target_state}`;
    }).join(', ');
  }
}
