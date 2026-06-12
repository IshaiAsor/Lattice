import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CdkDragEnd, CdkDragMove } from '@angular/cdk/drag-drop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { controlTypeFor, iconForCapability, unitFor, COLOR_OPTIONS } from 'src/app/utils/device-type.utils';
import type { DashboardAction, DashboardGroup } from '../user-dashboard/user-dashboard';

const CX = 60, CY = 52, R = 36, START = 225, SWEEP = 270;
function toSvgPt(deg: number) {
  const r = (deg * Math.PI) / 180;
  return { x: CX + R * Math.cos(r), y: CY - R * Math.sin(r) };
}

@Component({
  selector: 'app-group-bottom-sheet',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './group-bottom-sheet.component.html',
  styleUrl: './group-bottom-sheet.component.css',
})
export class GroupBottomSheetComponent implements OnInit {
  private sheetRef     = inject(MatBottomSheetRef<GroupBottomSheetComponent>);
  private actionsSvc   = inject(UserActionsService);
  private socketSvc    = inject(DeviceSocketService);
  private destroyRef   = inject(DestroyRef);
  private snackBar     = inject(MatSnackBar);
  private dialog       = inject(MatDialog);
  data: { dashGroup: DashboardGroup } = inject(MAT_BOTTOM_SHEET_DATA);

  actions: DashboardAction[] = [];
  dragUpActive = false;
  private draggingActionId: number | null = null;

  iconForCapability = iconForCapability;
  controlTypeFor    = controlTypeFor;
  unitFor           = unitFor;
  colorOptions      = COLOR_OPTIONS;

  @HostListener('document:pointerup')
  onPointerUp() { this.draggingActionId = null; }

  ngOnInit(): void {
    this.actions = [...this.data.dashGroup.actions];

    this.socketSvc.onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ actionId, state }) => {
        const a = this.actions.find(x => x.id === actionId);
        if (a) a.state = state;
      });

    this.socketSvc.onDeviceStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        this.actions.filter(a => a.user_device_id === deviceId)
          .forEach(a => { if (a.user_device) a.user_device.online = online; });
      });
  }

  isOnline(a: DashboardAction): boolean { return a.user_device?.online ?? false; }

  onCardDragMoved(e: CdkDragMove)              { this.dragUpActive = e.distance.y < -80; }
  onCardDragEnded(e: CdkDragEnd, a: DashboardAction) {
    const up = e.distance.y < -80;
    e.source.reset();
    this.dragUpActive = false;
    if (up) this.removeFromGroup(a);
  }

  dispatchState(action: DashboardAction, state: string): void {
    action.state = state;
    this.socketSvc.dispatchAction({
      actionId:     action.id,
      userDeviceId: action.user_device_id,
      mqttType:     action.action_def?.mqtt_type ?? '',
      mqttName:     action.action_def?.mqtt_name ?? '',
      state,
    });
  }

  renameAction(action: DashboardAction): void {
    this.dialog.open(RenameActionDialogComponent, { width: '320px', data: { name: action.name } })
      .afterClosed().subscribe((name: string) => {
        if (!name) return;
        this.actionsSvc.updateAction(action.id, { name })
          .subscribe(() => { action.name = name; this.snackBar.open('Renamed', 'OK', { duration: 2000 }); });
      });
  }

  removeFromGroup(action: DashboardAction): void {
    const remaining = this.actions.filter(a => a.id !== action.id);
    if (remaining.length <= 1) {
      const all = remaining.length === 1 ? [action, remaining[0]] : [action];
      forkJoin(all.map(a => this.actionsSvc.setActionGroup(a.id, null)))
        .subscribe(() => {
          if (remaining.length === 0) this.sheetRef.dismiss(true);
          else this.actionsSvc.deleteGroup(this.data.dashGroup.group.id)
            .subscribe(() => this.sheetRef.dismiss(true));
        });
      return;
    }
    this.actionsSvc.setActionGroup(action.id, null)
      .subscribe(() => { this.actions = remaining; this.sheetRef.dismiss(true); });
  }

  close(): void { this.sheetRef.dismiss(false); }

  // ── Arc dial ──────────────────────────────────────────────────────────────
  dialTrackPath(): string {
    const s = toSvgPt(START), e = toSvgPt(START - SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }
  dialActivePath(value: unknown): string {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (v <= 0) return ''; if (v >= 100) return this.dialTrackPath();
    const s = toSvgPt(START), e = toSvgPt(START - (v / 100) * SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${(v / 100) * SWEEP > 180 ? 1 : 0} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }
  dialThumbPt(value: unknown) { return toSvgPt(START - (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * SWEEP); }

  onDialPointerDown(e: PointerEvent, a: DashboardAction): void {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this.draggingActionId = a.id;
    this.applyDial(e, a);
  }
  onDialPointerMove(e: PointerEvent, a: DashboardAction): void { if (this.draggingActionId === a.id) this.applyDial(e, a); }

  private applyDial(e: PointerEvent, a: DashboardAction): void {
    const svg = e.currentTarget as SVGSVGElement;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    let angle = (Math.atan2(-(sp.y - CY), sp.x - CX) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    let sweep = START - angle; if (sweep < 0) sweep += 360;
    if (sweep > SWEEP) sweep = sweep > SWEEP + (360 - SWEEP) / 2 ? 0 : SWEEP;
    this.dispatchState(a, String(Math.round((sweep / SWEEP) * 100)));
  }
}
