import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DeviceMgmtService, UpdatePreview, DeviceView } from 'src/app/services/device.mgmt.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

export interface DeviceUpdateDialogData {
  device: DeviceView;
}

@Component({
  selector: 'app-device-update-dialog',
  imports: [SHARED_MATERIAL],
  template: `
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

      @if (!loading && preview) {
        <p class="version-line">
          <span class="label">Current:</span> <code>{{ preview.current_version }}</code>
          <mat-icon class="arrow">arrow_forward</mat-icon>
          <span class="label">New:</span> <code>{{ preview.new_version }}</code>
        </p>

        <p class="section-label">Action compatibility</p>
        <div class="action-list">
          @for (action of preview.actions; track action.id) {
            <div class="action-row" [class.deprecated]="action.status === 'deprecated'">
              <mat-icon class="status-icon">
                {{ action.status === 'ok' ? 'check_circle' : 'warning' }}
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
      @if (preview && !upToDate) {
        <button mat-flat-button color="primary" (click)="confirm()" [disabled]="applying">
          @if (applying) { Updating… } @else { Update }
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    .loading { padding: 8px 0; }
    .hint { color: #757575; font-size: 13px; margin: 8px 0; }
    .version-line { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 12px 0 4px; }
    .version-line .label { color: #9e9e9e; font-size: 11px; text-transform: uppercase; }
    .version-line code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .version-line .arrow { font-size: 16px; width: 16px; height: 16px; color: #9e9e9e; }
    .section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #9e9e9e; margin: 16px 0 6px; }
    .action-list { display: flex; flex-direction: column; gap: 6px; }
    .action-row { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 6px 8px; border-radius: 6px; background: #f9fbe7; }
    .action-row .status-icon { font-size: 16px; width: 16px; height: 16px; color: #43a047; }
    .action-row.deprecated { background: #fff3e0; }
    .action-row.deprecated .status-icon { color: #ef6c00; }
    .action-name { font-weight: 500; }
    .reason { color: #757575; font-size: 12px; margin-left: auto; }
    .warn-note { font-size: 12px; color: #ef6c00; margin-top: 12px; }
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
      error: () => {
        this.loading = false;
        this.snack.open('Failed to load update preview', 'Close', { duration: 3000 });
        this.dialogRef.close();
      },
    });
  }

  confirm() {
    this.applying = true;
    this.deviceMgmtService.applyUpdate(this.data.device.id).subscribe({
      next: () => {
        this.snack.open('Update applied — OTA sent to device', 'Close', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: () => {
        this.applying = false;
        this.snack.open('Update failed', 'Close', { duration: 3000 });
      },
    });
  }
}
