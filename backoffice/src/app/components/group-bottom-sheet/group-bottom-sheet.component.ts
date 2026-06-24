import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { iconForDeviceType, hasTrait, COLOR_OPTIONS } from 'src/app/utils/device-type.utils';
import { ActionGroupView } from 'src/app/services/user.actions.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { CdkDragEnd, CdkDragMove } from '@angular/cdk/drag-drop';

// Dial geometry constants (duplicated from user-dashboard for standalone use)
const CX = 60, CY = 52, R = 36;
const START_ANGLE = 225;
const TOTAL_SWEEP = 270;

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

@Component({
  selector: 'app-group-bottom-sheet',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './group-bottom-sheet.component.html',
  styleUrl: './group-bottom-sheet.component.css',
})
export class GroupBottomSheetComponent implements OnInit {
  private sheetRef = inject(MatBottomSheetRef<GroupBottomSheetComponent>);
  data: { group: ActionGroupView } = inject(MAT_BOTTOM_SHEET_DATA);
  private userActionsService = inject(UserActionsService);
  private socketService = inject(DeviceSocketService);
  private destroyRef = inject(DestroyRef);
  private snackBar = inject(MatSnackBar);
  dialog = inject(MatDialog);

  actions: DeviceActionView[] = [];
  dragUpActive = false;
  private draggingActionId: number | null = null;

  // Prior action.state for in-flight commands, so action_state_failed can revert the UI.
  private pendingPrevState = new Map<number, unknown>();
  private latestCommandId = new Map<number, string>();

  iconForType = iconForDeviceType;
  hasTrait = hasTrait;
  colorOptions = COLOR_OPTIONS;

  @HostListener('document:pointerup')
  onDocumentPointerUp() { this.draggingActionId = null; }

  ngOnInit() {
    this.actions = [...this.data.group.actions];

    this.socketService.onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.actions.find(a => a.id === data.actionId);
        if (action) {
          action.state = data.state;
          const isLatest = !data.commandId || this.latestCommandId.get(data.actionId) === data.commandId;
          if (isLatest) {
            action.pending = false;
            this.latestCommandId.delete(data.actionId);
            this.pendingPrevState.delete(data.actionId);
          }
        }
      });

    this.socketService.onActionStatePending()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.actions.find(a => a.id === data.actionId);
        if (action) {
          if (!action.pending) {
            this.pendingPrevState.set(data.actionId, action.state);
          }
          this.latestCommandId.set(data.actionId, data.commandId);
          action.state = data.state;
          action.pending = true;
        }
      });

    this.socketService.onActionStateFailed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.actions.find(a => a.id === data.actionId);
        if (action) {
          const revertTo = data.lastState ?? this.pendingPrevState.get(data.actionId);
          if (revertTo !== undefined) action.state = revertTo;
          this.pendingPrevState.delete(data.actionId);
          this.latestCommandId.delete(data.actionId);
          action.pending = false;
        }
        this.snackBar.open('Device did not confirm the change', 'Close', { duration: 3000 });
      });

    this.socketService.onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        this.actions.filter(a => a.deviceId === deviceId).forEach(a => a.online = online);
      });
  }

  onCardDragMoved(event: CdkDragMove) {
    this.dragUpActive = event.distance.y < -80;
  }

  onCardDragEnded(event: CdkDragEnd, action: DeviceActionView) {
    const draggedUp = event.distance.y < -80;
    event.source.reset();
    this.dragUpActive = false;
    if (draggedUp) this.removeFromGroup(action);
  }

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  openCameraFullscreen(action: DeviceActionView) {
    if (!action.state) return;
    const win = window.open();
    win?.document.write(`<img src="data:image/jpeg;base64,${action.state}" style="max-width:100%;max-height:100vh;">`);
  }

  renameAction(action: DeviceActionView) {
    const ref = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      panelClass: 'glass-dialog',
      data: { name: action.name },
    });
    ref.afterClosed().subscribe((newName: string | undefined) => {
      if (!newName) return;
      this.userActionsService.updateUserAction({ ...action, name: newName }).subscribe(() => {
        action.name = newName;
        this.snackBar.open('Action renamed', 'Close', { duration: 2000 });
      });
    });
  }

  removeFromGroup(action: DeviceActionView) {
    const remaining = this.actions.filter(a => a.id !== action.id);

    if (remaining.length === 0) {
      // Last item: clear group_name on the removed one too
      this.userActionsService.setActionGroup(action.id, null).subscribe(() => {
        this.sheetRef.dismiss(true);
      });
      return;
    }

    if (remaining.length === 1) {
      // Only 1 left after removal: dissolve the group entirely
      forkJoin([
        this.userActionsService.setActionGroup(action.id, null),
        this.userActionsService.setActionGroup(remaining[0].id, null),
      ]).subscribe(() => {
        this.sheetRef.dismiss(true);
      });
      return;
    }

    this.userActionsService.setActionGroup(action.id, null).subscribe(() => {
      this.actions = remaining;
      this.sheetRef.dismiss(true);
    });
  }

  close() {
    this.sheetRef.dismiss(false);
  }

  // ── Arc dial ────────────────────────────────────────────────────

  dialTrackPath(): string {
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - TOTAL_SWEEP);
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

    const dx = sp.x - CX;
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
