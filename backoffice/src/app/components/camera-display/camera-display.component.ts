import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, take, timeout } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ReceivedBadgeComponent } from '../received-badge/received-badge.component';

@Component({
  selector: 'app-camera-fullscreen-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL, ReceivedBadgeComponent],
  template: `
    <div class="cam-fs-wrap" #wrap>
      <div class="cam-fs-actions">
        @if (fullscreenSupported) {
          <button
            mat-icon-button
            class="cam-fs-btn"
            (click)="toggleFullscreen()"
            [matTooltip]="isFullscreen() ? 'Exit full screen' : 'Full screen'"
          >
            <mat-icon>{{ isFullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
          </button>
        }
        <button mat-icon-button class="cam-fs-btn" (click)="dialogRef.close()" matTooltip="Close">
          <mat-icon>close</mat-icon>
        </button>
      </div>
      @if (data.action.state) {
        <div class="cam-fs-frame">
          <img [src]="'data:image/jpeg;base64,' + data.action.state" alt="Camera" class="cam-fs-img" />
          <div class="cam-fs-received-badge">
            <app-received-badge [receivedAt]="data.action.receivedAt" variant="overlay"></app-received-badge>
          </div>
        </div>
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
      width: fit-content;
      height: fit-content;
      max-width: 88vw;
      max-height: 88vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* The frame hugs the rendered image so the badge sits on the picture, not in
       the (viewport-sized) letterbox around it on mobile. */
    .cam-fs-frame {
      position: relative;
      display: flex;
      max-width: 100%;
      max-height: 100%;
      min-width: 0;
      min-height: 0;
    }
    .cam-fs-actions {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      display: flex;
      gap: 4px;
    }
    .cam-fs-btn {
      color: #fff;
      background: rgba(0,0,0,0.4);
    }
    .cam-fs-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }
    /* Top-left: clear of the close button and of any timestamp the camera burns
       into the bottom of the frame. */
    .cam-fs-received-badge {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 10;
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

    /* Mobile: the global <600px rule makes every dialog surface 100vw/100dvh, so the
       wrap must fill it and centre the frame instead of hugging the top-left corner.
       Close button clears the notch/status bar. */
    @media (max-width: 599px) {
      .cam-fs-wrap {
        width: 100%;
        height: 100%;
        max-width: 100%;
        max-height: 100%;
      }
      /* Fill the width — tapping "expand" on a phone should show the frame as large
         as it fits, not the sensor's native pixel size adrift in black. */
      .cam-fs-frame { width: 100%; }
      .cam-fs-img { width: 100%; height: auto; }
      .cam-fs-actions {
        top: max(8px, env(safe-area-inset-top));
        right: max(8px, env(safe-area-inset-right));
      }
    }

    /* Real fullscreen (Fullscreen API): the wrap itself becomes the fullscreen element,
       so it has to stop hugging the image and take over the whole screen. */
    .cam-fs-wrap:fullscreen {
      width: 100vw;
      height: 100vh;
      max-width: none;
      max-height: none;
    }
    .cam-fs-wrap:fullscreen .cam-fs-frame,
    .cam-fs-wrap:fullscreen .cam-fs-img {
      width: 100%;
      height: 100%;
    }
  `],
})
export class CameraFullscreenDialog implements OnDestroy {
  dialogRef = inject(MatDialogRef<CameraFullscreenDialog>);
  data: { action: DeviceActionView } = inject(MAT_DIALOG_DATA);

  private wrap = viewChild.required<ElementRef<HTMLDivElement>>('wrap');

  // iOS Safari only grants fullscreen to <video>, so hide the control there rather than
  // offering a button that silently does nothing.
  readonly fullscreenSupported = document.fullscreenEnabled;
  readonly isFullscreen = signal(false);

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    const active = document.fullscreenElement === this.wrap().nativeElement;
    this.isFullscreen.set(active);
    // While fullscreen, Escape belongs to the browser (it exits fullscreen); letting the
    // dialog also close on it would tear the whole viewer down on the first press.
    this.dialogRef.disableClose = active;
  }

  ngOnDestroy(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
  }

  protected async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await this.wrap().nativeElement.requestFullscreen();
  }
}

@Component({
  selector: 'app-camera-display',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './camera-display.component.html',
  styleUrl: './camera-display.component.css',
})
export class CameraDisplayComponent implements OnInit {
  action = input.required<DeviceActionView>();

  private dialog = inject(MatDialog);
  private userActionsService = inject(UserActionsService);
  private socketService = inject(DeviceSocketService);
  private snackBar = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  // A capture is in flight: the request was accepted and we are waiting for the frame.
  protected readonly capturing = signal(false);

  ngOnInit(): void {
    // Backfill the last stored frame so the card isn't blank on load (F6.7). Skip if a live
    // frame already populated state; guard again in the callback so a frame arriving over the
    // socket while the request is in flight isn't clobbered by a staler stored frame.
    const action = this.action();
    if (action.state) return;
    this.userActionsService.getLastFrame(action.id).subscribe((res) => {
      if (res && !action.state) action.state = res.frame;
    });
  }

  openFullscreen() {
    this.dialog.open(CameraFullscreenDialog, {
      data: { action: this.action() },
      maxWidth: '95vw',
      maxHeight: '95vh',
      panelClass: 'camera-dialog-panel',
    });
  }

  // Ask the device for a frame now, rather than waiting for its next scheduled one.
  protected captureNow(event: Event): void {
    event.stopPropagation(); // the whole card is a button that opens fullscreen
    if (this.capturing()) return;

    this.capturing.set(true);
    this.userActionsService.captureNow(this.action().id).subscribe({
      next: ({ timeoutMs }) => this.awaitFrame(timeoutMs),
      error: (err: { error?: { error?: string } }) => {
        this.capturing.set(false);
        // The api's own words where it has them — "Device is offline" beats a generic failure.
        this.snackBar.open(err.error?.error ?? 'Could not request a capture', 'Dismiss', {
          duration: 4000,
        });
      },
    });
  }

  // The frame arrives as an ordinary state update, so that is what we wait on. The grace period
  // past the server's own timeout keeps the spinner from giving up on a frame that is still
  // being written and relayed — the platform is the one that decides the capture failed.
  private awaitFrame(timeoutMs: number): void {
    const actionId = this.action().id;
    this.socketService.actionStateUpdate$
      .pipe(
        filter((update) => update.actionId === actionId),
        take(1),
        timeout({ first: timeoutMs + 2000 }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.capturing.set(false),
        error: () => {
          this.capturing.set(false);
          this.snackBar.open('The camera did not send a frame', 'Dismiss', { duration: 4000 });
        },
      });
  }
}
