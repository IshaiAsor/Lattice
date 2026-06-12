import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import type { DashboardAction } from '../user-dashboard/user-dashboard';

@Component({
  selector: 'app-camera-fullscreen-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  template: `
    <div class="cam-fs-wrap">
      <button mat-icon-button class="cam-fs-close" (click)="dialogRef.close()">
        <mat-icon>close</mat-icon>
      </button>
      @if (frame()) {
        <img [src]="'data:image/jpeg;base64,' + frame()" class="cam-fs-img" />
      } @else {
        <div class="cam-fs-placeholder">
          <mat-icon style="font-size:56px;width:56px;height:56px;">photo_camera</mat-icon>
          <span>No image yet</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .cam-fs-wrap { position: relative; background: #000; width: 88vw; height: 88vh; display: flex; align-items: center; justify-content: center; }
    .cam-fs-close { position: absolute; top: 8px; right: 8px; color: #fff; z-index: 10; background: rgba(0,0,0,0.4); }
    .cam-fs-img   { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .cam-fs-placeholder { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #555; font-size: 14px; }
  `],
})
export class CameraFullscreenDialog {
  dialogRef = inject(MatDialogRef<CameraFullscreenDialog>);
  frame     = inject<() => string | null>(MAT_DIALOG_DATA);
}

@Component({
  selector: 'app-camera-display',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './camera-display.component.html',
  styleUrl: './camera-display.component.css',
})
export class CameraDisplayComponent implements OnInit {
  action = input.required<DashboardAction>();

  private dialog   = inject(MatDialog);
  private socket   = inject(DeviceSocketService);
  private destroyRef = inject(DestroyRef);

  frame = signal<string | null>(null);

  ngOnInit(): void {
    this.socket.onCameraFrame()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, frame }) => {
        if (deviceId === this.action().user_device_id) {
          this.frame.set(frame);
        }
      });
  }

  openFullscreen(): void {
    this.dialog.open(CameraFullscreenDialog, {
      data: this.frame,
      maxWidth: '95vw',
      maxHeight: '95vh',
      panelClass: 'camera-dialog-panel',
    });
  }
}
