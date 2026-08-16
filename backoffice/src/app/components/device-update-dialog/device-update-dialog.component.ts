import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  DeviceMgmtService,
  UpdatePreview,
  ActionPreview,
  DeviceView,
} from 'src/app/services/device.mgmt.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

export interface DeviceUpdateDialogData {
  device: DeviceView;
}

@Component({
  selector: 'app-device-update-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <div class="sheet-handle"></div>
    <h2 mat-dialog-title>Update Device</h2>

    <mat-dialog-content>
      @if (loading) {
        <div class="loading">
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
          <p class="hint">Checking for updates…</p>
        </div>
      }

      @if (!loading && upToDate) {
        <p class="hint">Device is already on the latest firmware version.</p>
      }

      @if (!loading && preview?.in_progress) {
        <p class="warn-note">
          An update to <code>{{ preview!.pending_version }}</code> is already running on this
          device. It downloads and reboots on its own — starting another would only restart it.
        </p>
      }

      @if (!loading && preview) {
        <p class="version-line">
          <span class="label">Current:</span> <code>{{ preview.current_version }}</code>
          <mat-icon class="arrow">arrow_forward</mat-icon>
          <span class="label">New:</span> <code>{{ preview.new_version }}</code>
        </p>

        <p class="section-label">Action compatibility</p>
        <div class="action-list">
          @for (action of preview.actions; track action.mqttName) {
            <div
              class="action-row"
              [class.deprecated]="action.status === 'deprecated'"
              [class.added]="action.status === 'new'"
            >
              <mat-icon class="status-icon">
                {{ statusIcon(action.status) }}
              </mat-icon>
              <span class="action-name">{{ action.name }}</span>
              @if (action.reason) {
                <span class="reason">{{ action.reason }}</span>
              }
            </div>
          }
        </div>

        @if (hasDeprecated) {
          <p class="warn-note">
            Deprecated actions will be hidden from the device config until removed or reconfigured.
          </p>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close [disabled]="applying">Cancel</button>
      @if (preview && !upToDate && !preview.in_progress) {
        <button mat-flat-button color="primary" (click)="confirm()" [disabled]="applying">
          @if (applying) { Updating… } @else { Update }
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    .sheet-handle {
      width: 36px; height: 4px;
      background: var(--border-strong, #ccc);
      border-radius: 2px;
      margin: 12px auto 0;
    }
    .loading { padding: 8px 0; }
    .hint { color: var(--text-muted); font-size: 13px; margin: 8px 0; }
    .version-line { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 12px 0 4px; }
    .version-line .label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
    .version-line code { background: var(--surface-alt); color: var(--text); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .version-line .arrow { font-size: 16px; width: 16px; height: 16px; color: var(--text-muted); }
    .section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); margin: 16px 0 6px; }
    .action-list { display: flex; flex-direction: column; gap: 6px; }
    .action-row {
      display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--online) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--online) 24%, transparent);
    }
    .action-row .status-icon { font-size: 16px; width: 16px; height: 16px; color: var(--online); }
    .action-row.deprecated {
      background: color-mix(in srgb, var(--warning) 12%, transparent);
      border-color: color-mix(in srgb, var(--warning) 28%, transparent);
    }
    .action-row.deprecated .status-icon { color: var(--warning); }
    /* An added action is good news, not a caution — tint it with the accent, not the warning. */
    .action-row.added {
      background: color-mix(in srgb, var(--primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--primary) 26%, transparent);
    }
    .action-row.added .status-icon { color: var(--primary); }
    .action-name { font-weight: 500; color: var(--text); }
    .reason { color: var(--text-muted); font-size: 12px; margin-left: auto; }
    .warn-note { font-size: 12px; color: var(--warning); margin-top: 12px; }
  `],
})
export class DeviceUpdateDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<DeviceUpdateDialogComponent>);
  private data: DeviceUpdateDialogData = inject(MAT_DIALOG_DATA);
  private deviceMgmtService = inject(DeviceMgmtService);
  private snack = inject(MatSnackBar);

  loading = true;
  applying = false;
  upToDate = false;
  preview: UpdatePreview | null = null;

  get hasDeprecated(): boolean {
    return this.preview?.actions.some(a => a.status === 'deprecated') ?? false;
  }

  statusIcon(status: ActionPreview['status']): string {
    if (status === 'deprecated') return 'warning';
    return status === 'new' ? 'add_circle' : 'check_circle';
  }

  ngOnInit() {
    this.deviceMgmtService.getUpdatePreview(this.data.device.id).subscribe({
      next: (result) => {
        this.loading = false;
        if ('up_to_date' in result) {
          this.upToDate = true;
        } else {
          this.preview = result;
        }
      },
      // 422 = a sealed device whose target version has no released template. That is an admin
      // gap, not a transient failure, so it gets its own message instead of "failed to load" —
      // the previous behaviour was to preview it as a clean diff and invite an Update that
      // would stage nothing.
      error: (err: { status?: number; error?: { error?: string } }) => {
        this.loading = false;
        const message =
          err?.status === 422
            ? (err.error?.error ?? 'No released template covers this firmware version yet')
            : 'Failed to load update preview';
        this.snack.open(message, 'Close', { duration: err?.status === 422 ? 6000 : 3000 });
        this.dialogRef.close();
      },
    });
  }

  confirm() {
    // Guards the double-click the disabled attribute cannot: the click that set `applying` and
    // the one that arrives before change detection has painted it are the same millisecond.
    if (this.applying) return;
    this.applying = true;
    this.deviceMgmtService.applyUpdate(this.data.device.id).subscribe({
      next: () => {
        // Sent, not done — the device downloads and reboots on its own, and the devices page
        // reports the outcome when it settles.
        this.snack.open('Update sent — the device is downloading', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: (err: { status?: number }) => {
        // 409 = this device is already updating; the platform refused a second dispatch.
        // Close as if we had dispatched, so the caller reloads and shows the in-flight state
        // this client had not seen yet.
        if (err?.status === 409) {
          this.snack.open('An update is already running on this device', 'Close', { duration: 4000 });
          this.dialogRef.close(true);
          return;
        }
        this.applying = false;
        this.snack.open('Update failed', 'Close', { duration: 3000 });
      },
    });
  }
}
