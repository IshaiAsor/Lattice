import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

// Dial geometry constants
const CX = 60, CY = 52, R = 36;
const START_ANGLE = 225; // math degrees (CCW from +x), value=0
const TOTAL_SWEEP = 270; // degrees clockwise

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

@Component({
  selector: 'app-user-dashboard',
  imports: [SHARED_MATERIAL],
  templateUrl: './user-dashboard.html',
  styleUrl: './user-dashboard.css',
})
export class UserDashboard implements OnInit {
  userActionsService = inject(UserActionsService);
  socketService = inject(DeviceSocketService);
  destroyRef = inject(DestroyRef);
  dialog = inject(MatDialog);
  snackBar = inject(MatSnackBar);

  actions: DeviceActionView[] = [];
  private draggingActionId: number | null = null;

  @HostListener('document:pointerup')
  onDocumentPointerUp() { this.draggingActionId = null; }

  ngOnInit(): void {
    this.userActionsService
      .getUserActions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => { this.actions = result; });

    this.socketService
      .onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.actions.find((e) => e.id == data.actionId);
        if (action) action.state = data.state;
      });

    this.socketService
      .onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res: any) => {
        const data = res as { deviceId: number; state: boolean };
        const affected = this.actions.filter((e) => e.deviceId === data.deviceId);
        for (const a of affected) a.online = data.state;
      });
  }

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  drop(event: CdkDragDrop<DeviceActionView[]>) {
    moveItemInArray(this.actions, event.previousIndex, event.currentIndex);
    this.userActionsService.reorderActions(this.actions.map((a) => a.id)).subscribe();
  }

  renameAction(action: DeviceActionView) {
    const dialogRef = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      data: { action },
    });
    dialogRef.afterClosed().subscribe((newName: string | undefined) => {
      if (!newName) return;
      this.userActionsService.updateUserAction({ ...action, name: newName }).subscribe(() => {
        action.name = newName;
        this.snackBar.open('Action renamed', 'Close', { duration: 2000 });
      });
    });
  }

  // ── Arc dial ────────────────────────────────────────────────────

  dialTrackPath(): string {
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - TOTAL_SWEEP); // -45°
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialActivePath(value: unknown): string {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (v <= 0) return '';
    if (v >= 100) return this.dialTrackPath();
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
    const largeArc = (v / 100) * TOTAL_SWEEP > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialThumbPt(value: unknown) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    return toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
  }

  onDialPointerDown(event: PointerEvent, action: DeviceActionView) {
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.draggingActionId = action.id;
    this.applyDialEvent(event, action);
  }

  onDialPointerMove(event: PointerEvent, action: DeviceActionView) {
    if (this.draggingActionId !== action.id) return;
    this.applyDialEvent(event, action);
  }

  private applyDialEvent(event: PointerEvent, action: DeviceActionView) {
    const svg = event.currentTarget as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM()!.inverse());

    const dx = sp.x - CX; // CX/CY reference the module constants
    const dy = -(sp.y - CY);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;

    let sweep = START_ANGLE - angle;
    if (sweep < 0) sweep += 360;
    if (sweep > TOTAL_SWEEP) sweep = sweep > TOTAL_SWEEP + (360 - TOTAL_SWEEP) / 2 ? 0 : TOTAL_SWEEP;

    const v = Math.round((sweep / TOTAL_SWEEP) * 100);
    action.state = v;
    this.changeActionState(action, String(v));
  }
}
