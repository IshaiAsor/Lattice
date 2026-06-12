import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { forkJoin } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { CdkDragDrop, CdkDragMove, moveItemInArray } from '@angular/cdk/drag-drop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { GroupTileComponent } from '../group-tile/group-tile.component';
import { CameraDisplayComponent } from '../camera-display/camera-display.component';
import { GroupBottomSheetComponent } from '../group-bottom-sheet/group-bottom-sheet.component';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { controlTypeFor, iconForCapability, unitFor, ControlType, COLOR_OPTIONS } from 'src/app/utils/device-type.utils';
import type { UserAction, UserActionGroup } from 'src/app/models';

export interface DashboardAction extends UserAction {
  _controlType: ControlType;
  _icon: string;
  _unit: string;
}

export interface DashboardGroup {
  group: UserActionGroup;
  actions: DashboardAction[];
}

export interface DashboardItem {
  kind: 'action' | 'group';
  sortOrder: number;
  action?: DashboardAction;
  dashGroup?: DashboardGroup;
}

// ── SVG arc dial constants ────────────────────────────────────────────────────
const CX = 60, CY = 52, R = 36, START = 225, SWEEP = 270;
function toSvgPt(deg: number) {
  const r = (deg * Math.PI) / 180;
  return { x: CX + R * Math.cos(r), y: CY - R * Math.sin(r) };
}

@Component({
  selector: 'app-user-dashboard',
  imports: [SHARED_MATERIAL, GroupTileComponent, CameraDisplayComponent],
  templateUrl: './user-dashboard.html',
  styleUrl: './user-dashboard.css',
})
export class UserDashboard implements OnInit {
  private actionsService = inject(UserActionsService);
  private socketService  = inject(DeviceSocketService);
  private destroyRef     = inject(DestroyRef);
  private dialog         = inject(MatDialog);
  private snackBar       = inject(MatSnackBar);
  private bottomSheet    = inject(MatBottomSheet);

  items: DashboardItem[] = [];
  isDragging = false;
  draggingIndex = -1;
  groupDropTargetIndex: number | null = null;

  private groups: UserActionGroup[] = [];
  private lastPointerPos = { x: 0, y: 0 };
  private draggingActionId: number | null = null;

  colorOptions = COLOR_OPTIONS;
  controlTypeFor = controlTypeFor;

  @HostListener('document:pointerup')
  onPointerUp() { this.draggingActionId = null; }

  ngOnInit(): void {
    this.load();

    this.socketService.onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ actionId, state }) => {
        const a = this.findAction(actionId);
        if (a) a.state = state;
      });

    this.socketService.onDeviceStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        for (const item of this.items) {
          if (item.kind === 'action' && item.action!.user_device_id === deviceId) {
            item.action!.user_device!.online = online;
          } else if (item.kind === 'group') {
            item.dashGroup!.actions
              .filter(a => a.user_device_id === deviceId)
              .forEach(a => { if (a.user_device) a.user_device.online = online; });
          }
        }
      });
  }

  private load(): void {
    forkJoin({
      actions: this.actionsService.getUserActions(),
      groups:  this.actionsService.getGroups(),
    }).subscribe(({ actions, groups }) => {
      this.groups = groups;
      this.items = this.buildItems(actions as DashboardAction[], groups);
    });
  }

  private reload(): void { this.load(); }

  private enrich(a: UserAction): DashboardAction {
    const cap = a.action_def?.capability;
    return Object.assign(a as DashboardAction, {
      _controlType: controlTypeFor(cap),
      _icon:        iconForCapability(cap),
      _unit:        unitFor(cap),
    });
  }

  private buildItems(raw: UserAction[], groups: UserActionGroup[]): DashboardItem[] {
    const actions = raw.map(a => this.enrich(a));
    const groupMap = new Map<number, DashboardAction[]>();
    const standalone: DashboardItem[] = [];

    for (const a of actions) {
      if (a.user_action_group_id != null) {
        const arr = groupMap.get(a.user_action_group_id) ?? [];
        arr.push(a);
        groupMap.set(a.user_action_group_id, arr);
      } else {
        standalone.push({ kind: 'action', sortOrder: a.sort_order, action: a });
      }
    }

    const groupItems: DashboardItem[] = groups
      .filter(g => groupMap.has(g.id))
      .map(g => {
        const members = groupMap.get(g.id)!;
        return {
          kind: 'group' as const,
          sortOrder: Math.min(...members.map(m => m.sort_order)),
          dashGroup: { group: g, actions: members },
        };
      });

    return [...standalone, ...groupItems].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private findAction(id: number): DashboardAction | undefined {
    for (const item of this.items) {
      if (item.kind === 'action' && item.action!.id === id) return item.action;
      if (item.kind === 'group') {
        const found = item.dashGroup!.actions.find(a => a.id === id);
        if (found) return found;
      }
    }
    return undefined;
  }

  itemTrackId(item: DashboardItem): string {
    return item.kind === 'action'
      ? `action-${item.action!.id}`
      : `group-${item.dashGroup!.group.id}`;
  }

  // ── Drag lifecycle ────────────────────────────────────────────────────────

  onDragStarted(i: number)  { this.isDragging = true; this.draggingIndex = i; }
  onDragEnded()             { this.isDragging = false; this.draggingIndex = -1; this.groupDropTargetIndex = null; }

  onDragMoved(e: CdkDragMove) {
    this.lastPointerPos = { x: e.pointerPosition.x, y: e.pointerPosition.y };
    this.groupDropTargetIndex = this.cardAt(this.lastPointerPos.x, this.lastPointerPos.y);
  }

  private cardAt(px: number, py: number): number | null {
    const els = document.querySelectorAll<HTMLElement>('.device-card-wrapper[data-item-index]');
    for (const el of Array.from(els)) {
      if (el.classList.contains('cdk-drag-preview')) continue;
      const idx = +el.getAttribute('data-item-index')!;
      if (idx === this.draggingIndex) continue;
      const r = el.getBoundingClientRect();
      if (r.width && px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return idx;
    }
    return null;
  }

  private reorderTarget(px: number, py: number, from: number): number {
    const cards: { idx: number; cx: number; cy: number }[] = [];
    document.querySelectorAll<HTMLElement>('.device-card-wrapper[data-item-index]').forEach(el => {
      if (el.classList.contains('cdk-drag-preview')) return;
      const idx = +el.getAttribute('data-item-index')!;
      if (idx === from) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      cards.push({ idx, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    });
    cards.sort((a, b) => Math.abs(a.cy - b.cy) < 155 ? a.cx - b.cx : a.cy - b.cy);
    for (const c of cards) {
      const sameRow = Math.abs(py - c.cy) < 155;
      if (sameRow ? px < c.cx : py < c.cy) return c.idx <= from ? c.idx : c.idx - 1;
    }
    return this.items.length - 1;
  }

  drop(event: CdkDragDrop<DashboardItem[]>): void {
    const target = this.cardAt(this.lastPointerPos.x, this.lastPointerPos.y);
    this.groupDropTargetIndex = null;

    if (target !== null) {
      this.handleGroupDrop(this.items[event.previousIndex], this.items[target]);
    } else {
      const to = this.reorderTarget(this.lastPointerPos.x, this.lastPointerPos.y, event.previousIndex);
      moveItemInArray(this.items, event.previousIndex, to);
      this.saveOrder();
    }
  }

  private handleGroupDrop(dragged: DashboardItem, target: DashboardItem): void {
    if (dragged.kind !== 'action') return;
    const draggedAction = dragged.action!;

    if (target.kind === 'group') {
      // Add to existing group
      this.actionsService.setActionGroup(draggedAction.id, target.dashGroup!.group.id)
        .subscribe(() => this.reload());
    } else {
      // Create a new group from these two actions
      this.actionsService.createGroup({ name: 'Group' }).subscribe(newGroup => {
        const targetAction = target.action!;
        forkJoin([
          this.actionsService.setActionGroup(draggedAction.id, newGroup.id),
          this.actionsService.setActionGroup(targetAction.id, newGroup.id),
        ]).subscribe(() => this.reload());
      });
    }
  }

  private saveOrder(): void {
    const ids: number[] = [];
    for (const item of this.items) {
      if (item.kind === 'action') ids.push(item.action!.id);
      else ids.push(...item.dashGroup!.actions.map(a => a.id));
    }
    this.actionsService.reorderActions(ids).subscribe();
  }

  // ── Group actions ─────────────────────────────────────────────────────────

  openGroup(dg: DashboardGroup): void {
    this.bottomSheet.open(GroupBottomSheetComponent, { data: { dashGroup: dg } })
      .afterDismissed().subscribe((reload: boolean) => { if (reload) this.reload(); });
  }

  renameGroup(dg: DashboardGroup): void {
    this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      data: { name: dg.group.name, title: 'Rename Group' },
    }).afterClosed().subscribe((name: string) => {
      if (!name || name === dg.group.name) return;
      this.actionsService.updateGroup(dg.group.id, { name })
        .subscribe(() => { dg.group.name = name; this.snackBar.open('Group renamed', 'OK', { duration: 2000 }); });
    });
  }

  ungroupAll(dg: DashboardGroup): void {
    forkJoin(dg.actions.map(a => this.actionsService.setActionGroup(a.id, null)))
      .subscribe(() => this.actionsService.deleteGroup(dg.group.id).subscribe(() => this.reload()));
  }

  // ── Action controls ───────────────────────────────────────────────────────

  dispatchState(action: DashboardAction, state: string): void {
    action.state = state;
    this.socketService.dispatchAction({
      actionId:     action.id,
      userDeviceId: action.user_device_id,
      mqttType:     action.action_def?.mqtt_type ?? '',
      mqttName:     action.action_def?.mqtt_name ?? '',
      state,
    });
  }

  renameAction(action: DashboardAction): void {
    this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      data: { name: action.name },
    }).afterClosed().subscribe((name: string) => {
      if (!name) return;
      this.actionsService.updateAction(action.id, { name })
        .subscribe(() => { action.name = name; this.snackBar.open('Action renamed', 'OK', { duration: 2000 }); });
    });
  }

  // ── Helpers exposed to template ───────────────────────────────────────────
  iconForCapability = iconForCapability;

  isOnline(action: DashboardAction): boolean { return action.user_device?.online ?? false; }

  // ── Arc dial ──────────────────────────────────────────────────────────────

  dialTrackPath(): string {
    const s = toSvgPt(START), e = toSvgPt(START - SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialActivePath(value: unknown): string {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (v <= 0) return '';
    if (v >= 100) return this.dialTrackPath();
    const s = toSvgPt(START), e = toSvgPt(START - (v / 100) * SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${(v / 100) * SWEEP > 180 ? 1 : 0} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialThumbPt(value: unknown) {
    return toSvgPt(START - (Math.max(0, Math.min(100, Number(value) || 0)) / 100) * SWEEP);
  }

  onDialPointerDown(event: PointerEvent, action: DashboardAction): void {
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.draggingActionId = action.id;
    this.applyDial(event, action);
  }

  onDialPointerMove(event: PointerEvent, action: DashboardAction): void {
    if (this.draggingActionId !== action.id) return;
    this.applyDial(event, action);
  }

  private applyDial(event: PointerEvent, action: DashboardAction): void {
    const svg = event.currentTarget as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX; pt.y = event.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    let angle = (Math.atan2(-(sp.y - CY), sp.x - CX) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    let sweep = START - angle;
    if (sweep < 0) sweep += 360;
    if (sweep > SWEEP) sweep = sweep > SWEEP + (360 - SWEEP) / 2 ? 0 : SWEEP;
    const v = Math.round((sweep / SWEEP) * 100);
    this.dispatchState(action, String(v));
  }
}
