import { Component, inject, input } from '@angular/core';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'app-camera-fullscreen-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  template: `
    <div class="cam-fs-wrap">
      <button mat-icon-button class="cam-fs-close" (click)="dialogRef.close()">
        <mat-icon>close</mat-icon>
      </button>
      @if (data.action.state) {
        <img [src]="'data:image/jpeg;base64,' + data.action.state" class="cam-fs-img" />
      } @else {
        <div class="cam-fs-placeholder">
          <span class="material-symbols-outlined">photo_camera</span>
          <span>No image yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .cam-fs-wrap {
      position: relative;
      background: #000;
      width: 88vw;
      height: 88vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cam-fs-close {
      position: absolute;
      top: 8px;
      right: 8px;
      color: #fff;
      z-index: 10;
      background: rgba(0,0,0,0.4);
    }
    .cam-fs-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }
    .cam-fs-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: #555;
      font-size: 14px;
    }
    .cam-fs-placeholder .material-symbols-outlined { font-size: 56px; }
  `],
})
export class CameraFullscreenDialog {
  dialogRef = inject(MatDialogRef<CameraFullscreenDialog>);
  data: { action: DeviceActionView } = inject(MAT_DIALOG_DATA);
}

@Component({
  selector: 'app-camera-display',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './camera-display.component.html',
  styleUrl: './camera-display.component.css',
})
export class CameraDisplayComponent {
  action = input.required<DeviceActionView>();

  private dialog = inject(MatDialog);

  openFullscreen() {
    this.dialog.open(CameraFullscreenDialog, {
      data: { action: this.action() },
      maxWidth: '95vw',
      maxHeight: '95vh',
      panelClass: 'camera-dialog-panel',
    });
  }
}
