import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceMgmtService, ActivateCapabilityInput } from 'src/app/services/device.mgmt.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { controlTypeFor, iconForCapability, ControlType } from 'src/app/utils/device-type.utils';
import type { UserAction, UserActionDef, UserActionGroup, UserDevice } from 'src/app/models';

export interface CapabilityDialogData {
  device: UserDevice;
}

interface PendingRow {
  def: UserActionDef;
  name: string;
  groupId: number | null;
}

@Component({
  selector: 'app-device-capability-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <h2 mat-dialog-title>Configure Capabilities — {{ data.device.name }}</h2>

    @if (loading) {
      <mat-progress-bar mode="indeterminate" />
    }

    <mat-dialog-content class="dialog-content">

      <!-- ── Section 1: Active ── -->
      @if (activeActions.length > 0) {
        <p class="section-label">Active Capabilities</p>
        <div cdkDropList (cdkDropListDropped)="drop($event)" class="active-list">
          @for (action of activeActions; track action.id) {
            <div class="cap-row" cdkDrag>
              <mat-icon cdkDragHandle class="drag-handle">drag_indicator</mat-icon>
              <span class="cap-chip" [ngStyle]="chipStyle(action.action_def?.capability)">
                <mat-icon class="cap-icon">{{ icon(action.action_def?.capability) }}</mat-icon>
                {{ action.action_def?.capability }}
              </span>
              <input class="name-input" [(ngModel)]="action.name"
                     (blur)="saveActionName(action)" placeholder="Name" />
              <mat-select [(ngModel)]="action.user_action_group_id"
                          (ngModelChange)="saveActionGroup(action)"
                          class="group-select" placeholder="No group">
                <mat-option [value]="null">No group</mat-option>
                @for (g of deviceGroups; track g.id) {
                  <mat-option [value]="g.id">{{ g.name }}</mat-option>
                }
              </mat-select>
            </div>
          }
        </div>
      }

      <!-- ── Section 2: Available ── -->
      @if (pendingRows.length > 0) {
        <div class="section-header">
          <p class="section-label">Available from Device</p>
          <button mat-stroked-button class="activate-all-btn" (click)="activateAll()">
            <mat-icon>check_circle</mat-icon> Activate All
          </button>
        </div>
        <div class="pending-list">
          @for (row of pendingRows; track row.def.id) {
            <div class="cap-row pending-row">
              <span class="cap-chip" [ngStyle]="chipStyle(row.def.capability)">
                <mat-icon class="cap-icon">{{ icon(row.def.capability) }}</mat-icon>
                {{ row.def.capability }}
              </span>
              <input class="name-input" [(ngModel)]="row.name" placeholder="Name" />
              <mat-select [(ngModel)]="row.groupId" class="group-select" placeholder="No group">
                <mat-option [value]="null">No group</mat-option>
                @for (g of deviceGroups; track g.id) {
                  <mat-option [value]="g.id">{{ g.name }}</mat-option>
                }
              </mat-select>
              @if (pendingPinTypes(row.def)) {
                <span class="pin-hint">{{ pendingPinTypes(row.def) }}</span>
              }
              <button mat-stroked-button class="activate-btn" (click)="activate([row])">Activate</button>
            </div>
          }
        </div>
      }

      @if (!loading && activeActions.length === 0 && pendingRows.length === 0) {
        <div class="empty-state">
          <mat-icon>sensors_off</mat-icon>
          <p>No capabilities reported yet. Re-provision the device to populate this list.</p>
        </div>
      }

    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-flat-button color="primary" (click)="close()">Done</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-content { min-width: 520px; max-width: 95vw; padding-top: 8px; }
    .section-label { margin: 12px 0 6px; font-weight: 600; font-size: 13px; color: var(--text-muted, #666); }
    .section-header { display: flex; align-items: center; justify-content: space-between; }
    .section-header .section-label { margin-bottom: 0; }
    .activate-all-btn { height: 28px; font-size: 12px; line-height: 28px; }
    .active-list, .pending-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .cap-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
               border-radius: 6px; background: var(--surface-alt, #f5f5f5); }
    .pending-row { border: 1px dashed var(--border, #ddd); background: transparent; }
    .drag-handle { cursor: grab; color: var(--text-muted, #aaa); font-size: 20px; flex-shrink: 0; }
    .cap-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
                border-radius: 12px; font-size: 11px; font-weight: 600;
                white-space: nowrap; flex-shrink: 0; }
    .cap-icon { font-size: 14px; height: 14px; width: 14px; }
    .name-input { flex: 1; min-width: 80px; padding: 4px 8px; border: 1px solid var(--border, #ddd);
                  border-radius: 4px; background: var(--surface, #fff); color: var(--text, #222);
                  font-size: 13px; }
    .name-input:focus { outline: none; border-color: var(--primary, #3d6ee0); }
    .group-select { width: 130px; font-size: 13px; }
    .pin-hint { font-size: 11px; color: var(--text-muted, #888); white-space: nowrap;
                padding: 2px 6px; background: var(--surface, #fff);
                border: 1px solid var(--border, #eee); border-radius: 10px; }
    .activate-btn { height: 28px; font-size: 12px; line-height: 28px; flex-shrink: 0; }
    .empty-state { text-align: center; padding: 32px 16px; color: var(--text-muted, #888); }
    .empty-state mat-icon { font-size: 48px; height: 48px; width: 48px; }
    .cdk-drag-preview { box-shadow: 0 4px 16px rgba(0,0,0,0.15); border-radius: 6px; }
    .cdk-drag-placeholder { opacity: 0.3; }
  `],
})
export class DeviceCapabilityDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<DeviceCapabilityDialogComponent>);
  data: CapabilityDialogData = inject(MAT_DIALOG_DATA);
  private mgmt    = inject(DeviceMgmtService);
  private actions = inject(UserActionsService);
  private snack   = inject(MatSnackBar);

  loading = true;
  activeActions: UserAction[]  = [];
  pendingRows:   PendingRow[]  = [];
  deviceGroups:  UserActionGroup[] = [];

  private activatedCount = 0;

  ngOnInit(): void {
    forkJoin({
      all:     this.actions.getUserActions(),
      pending: this.mgmt.getPendingDefs(this.data.device.id),
      groups:  this.actions.getGroups(),
    }).subscribe({
      next: ({ all, pending, groups }) => {
        this.activeActions = all.filter(a => a.user_device_id === this.data.device.id);
        this.deviceGroups  = groups.filter(g => g.user_device_id === this.data.device.id);
        this.pendingRows   = pending.map(def => ({
          def,
          name: def.action_key,
          groupId: null,
        }));
        this.loading = false;
      },
      error: () => { this.loading = false; },
    });
  }

  // ── Active section ─────────────────────────────────────────────────────────

  drop(event: CdkDragDrop<UserAction[]>): void {
    moveItemInArray(this.activeActions, event.previousIndex, event.currentIndex);
    this.actions.reorderActions(this.activeActions.map(a => a.id)).subscribe();
  }

  saveActionName(action: UserAction): void {
    this.actions.updateAction(action.id, { name: action.name }).subscribe();
  }

  saveActionGroup(action: UserAction): void {
    this.actions.updateAction(action.id, { user_action_group_id: action.user_action_group_id }).subscribe();
  }

  // ── Pending section ────────────────────────────────────────────────────────

  activate(rows: PendingRow[]): void {
    const items: ActivateCapabilityInput[] = rows.map(r => ({
      user_action_def_id: r.def.id,
      name: r.name || r.def.action_key,
      user_action_group_id: r.groupId,
    }));
    this.mgmt.activateCapabilities(this.data.device.id, items).subscribe({
      next: ({ activated }) => {
        activated.forEach(ua => {
          const row = rows.find(r => r.def.id === ua.user_action_def_id);
          if (row) ua.action_def = row.def;
          this.activeActions.push(ua);
        });
        this.pendingRows = this.pendingRows.filter(r => !rows.includes(r));
        this.activatedCount += activated.length;
      },
    });
  }

  activateAll(): void {
    if (this.pendingRows.length) this.activate([...this.pendingRows]);
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  close(): void {
    if (this.activatedCount > 0) {
      this.mgmt.softResetDevice(this.data.device.id).subscribe();
      this.snack.open('Device will restart to apply configuration.', 'OK', { duration: 4000 });
    }
    this.dialogRef.close();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  icon(capability?: string): string { return iconForCapability(capability); }

  chipStyle(capability?: string): Record<string, string> {
    const t: ControlType = controlTypeFor(capability);
    switch (t) {
      case 'onoff':    return { color: 'var(--online)',    background: 'rgba(46,204,113,0.12)' };
      case 'dimmer':   return { color: 'var(--primary)',   background: 'rgba(61,110,224,0.12)' };
      case 'camera':   return { color: 'var(--primary)',   background: 'rgba(61,110,224,0.15)' };
      case 'temp':
      case 'humidity':
      case 'level':
      case 'ph':
      case 'tds':
      case 'co2':      return { color: 'var(--warning)',   background: 'rgba(245,166,35,0.12)' };
      default:         return { color: 'var(--text-muted)', background: 'var(--surface-alt)' };
    }
  }

  pendingPinTypes(def: UserActionDef): string {
    const pins = def.pins as { type: string }[] | undefined;
    if (!pins?.length) return '';
    return pins.map(p => p.type).join(', ');
  }
}
