import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { hasTrait, COLOR_OPTIONS, iconForAction } from 'src/app/utils/device-type.utils';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { ActionGroupView, DashboardItem, UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { GroupTileComponent } from '../group-tile/group-tile.component';
import { CameraDisplayComponent } from '../camera-display/camera-display.component';
import { GroupBottomSheetComponent } from '../group-bottom-sheet/group-bottom-sheet.component';
import { CdkDragDrop, CdkDragMove, moveItemInArray } from '@angular/cdk/drag-drop';
import { forkJoin } from 'rxjs';

// Dial geometry constants
const CX = 60, CY = 52, R = 36;
const START_ANGLE = 225;
const TOTAL_SWEEP = 270;

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

@Component({
  selector: 'app-user-dashboard',
  imports: [SHARED_MATERIAL, GroupTileComponent, CameraDisplayComponent],
  templateUrl: './user-dashboard.html',
  styleUrl: './user-dashboard.css',
})
export class UserDashboard implements OnInit {
  userActionsService = inject(UserActionsService);
  socketService = inject(DeviceSocketService);
  destroyRef = inject(DestroyRef);
  dialog = inject(MatDialog);
  snackBar = inject(MatSnackBar);
  bottomSheet = inject(MatBottomSheet);

  items: DashboardItem[] = [];
  isDragging = false;
  draggingIndex = -1;
  groupDropTargetIndex: number | null = null;

  private lastPointerPos = { x: 0, y: 0 };
  private draggingActionId: number | null = null;

  // Prior action.state for in-flight commands, so action_state_failed can revert the UI.
  private pendingPrevState = new Map<number, unknown>();

  @HostListener('document:pointerup')
  onDocumentPointerUp() { this.draggingActionId = null; }

  ngOnInit(): void {
    this.loadActions();

    this.socketService
      .onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.findAction(data.actionId);
        if (action) {
          action.state = data.state;
          action.pending = false;        // confirmed by the device
          this.pendingPrevState.delete(data.actionId);
        }
      });

    // A command is in flight: show the intended value but mark it pending until the device
    // acks. Stash the prior value so a failure can revert it.
    this.socketService
      .onActionStatePending()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.findAction(data.actionId);
        if (action) {
          this.pendingPrevState.set(data.actionId, action.state);
          action.state = data.state;
          action.pending = true;
        }
      });

    // The device rejected the command or never acked — revert to the prior value.
    this.socketService
      .onActionStateFailed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.findAction(data.actionId);
        if (action) {
          if (this.pendingPrevState.has(data.actionId)) {
            action.state = data.lastState;
            this.pendingPrevState.delete(data.actionId);
          }
          action.pending = false;
        }
        this.snackBar.open('Device did not confirm the change', 'Close', { duration: 3000 });
      });

    this.socketService
      .onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        this.items
          .filter(i => i.kind === 'action')
          .map(i => i.action!)
          .filter(a => a.deviceId === deviceId)
          .forEach(a => a.online = online);
      });
  }

  private loadActions() {
    this.userActionsService
      .getUserActions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((actions) => { this.items = this.buildItems(actions); });
  }

  private reloadActions() {
    this.userActionsService.getUserActions().subscribe(actions => {
      this.items = this.buildItems(actions);
    });
  }

  private buildItems(actions: DeviceActionView[]): DashboardItem[] {
    const groupMap = new Map<string, DeviceActionView[]>();
    const result: DashboardItem[] = [];

    for (const a of actions) {
      if (!a.groupName) {
        result.push({ kind: 'action', sortOrder: a.sortOrder ?? 0, action: a });
      } else {
        const arr = groupMap.get(a.groupName) ?? [];
        arr.push(a);
        groupMap.set(a.groupName, arr);
      }
    }

    for (const [name, members] of groupMap) {
      result.push({
        kind: 'group',
        sortOrder: Math.min(...members.map(m => m.sortOrder ?? 0)),
        group: {
          name,
          previewTypes: members.slice(0, 4).map(m => m.googleType?.value ?? null),
          actions: members,
        },
      });
    }

    return result.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private findAction(actionId: number): DeviceActionView | undefined {
    for (const item of this.items) {
      if (item.kind === 'action' && item.action!.id === actionId) return item.action;
    }
    return undefined;
  }

  itemTrackId(item: DashboardItem): string {
    return item.kind === 'action'
      ? `action-${item.action!.id}`
      : `group-${item.group!.name}`;
  }

  // ── Drag lifecycle ───────────────────────────────────────────────

  onDragStarted(index: number) {
    this.isDragging = true;
    this.draggingIndex = index;
  }

  onDragEnded() {
    this.isDragging = false;
    this.draggingIndex = -1;
    this.groupDropTargetIndex = null;
  }

  // ── Group hover detection (works because CDK sorting is disabled) ──
  // No timer — directly track which card the pointer is over.
  // Sorting is disabled so cards don't transform; getBoundingClientRect is accurate.

  onDragMoved(event: CdkDragMove) {
    this.lastPointerPos = { x: event.pointerPosition.x, y: event.pointerPosition.y };
    this.groupDropTargetIndex = this.cardIndexAtPoint(this.lastPointerPos.x, this.lastPointerPos.y);
  }

  // Returns the index of the card whose bounding rect contains (px, py), excluding the dragged card.
  // Safe to call at drop time because sorting is disabled — no CSS transforms shift rects.
  private cardIndexAtPoint(px: number, py: number): number | null {
    const wrappers = document.querySelectorAll<HTMLElement>('.device-card-wrapper[data-item-index]');
    for (const w of Array.from(wrappers)) {
      if (w.classList.contains('cdk-drag-preview')) continue;
      const idx = +w.getAttribute('data-item-index')!;
      if (idx === this.draggingIndex) continue;
      const r = w.getBoundingClientRect();
      if (r.width === 0) continue; // CDK hides original with display:none → zero rect
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return idx;
    }
    return null;
  }

  // Computes where the dragged item should land for a plain reorder.
  // Needed because cdkDropListSortingDisabled makes event.currentIndex === event.previousIndex.
  private reorderIndex(px: number, py: number, draggedIdx: number): number {
    const cards: { idx: number; cx: number; cy: number }[] = [];

    document.querySelectorAll<HTMLElement>('.device-card-wrapper[data-item-index]')
      .forEach(w => {
        if (w.classList.contains('cdk-drag-preview')) return;
        const idx = +w.getAttribute('data-item-index')!;
        if (idx === draggedIdx) return;
        const r = w.getBoundingClientRect();
        if (r.width === 0) return;
        cards.push({ idx, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
      });

    // Sort into reading order (top→bottom, left→right within a row)
    cards.sort((a, b) => Math.abs(a.cy - b.cy) < 155 ? a.cx - b.cx : a.cy - b.cy);

    for (const c of cards) {
      const sameRow = Math.abs(py - c.cy) < 155;
      const before = sameRow ? px < c.cx : py < c.cy;
      if (before) {
        // Adjust for the gap left by removing draggedIdx
        return c.idx <= draggedIdx ? c.idx : c.idx - 1;
      }
    }

    return this.items.length - 1;
  }

  // ── Drop ─────────────────────────────────────────────────────────

  drop(event: CdkDragDrop<DashboardItem[]>) {
    // Re-check pointer position at drop time (lastPointerPos = final cdkDragMoved position).
    // This is more reliable than groupDropTargetIndex which resets on any pointer movement.
    const targetIdx = this.cardIndexAtPoint(this.lastPointerPos.x, this.lastPointerPos.y);
    this.groupDropTargetIndex = null;

    if (targetIdx !== null) {
      this.handleGroupDrop(this.items[event.previousIndex], this.items[targetIdx]);
    } else {
      // cdkDropListSortingDisabled → currentIndex === previousIndex, so compute manually
      const to = this.reorderIndex(this.lastPointerPos.x, this.lastPointerPos.y, event.previousIndex);
      moveItemInArray(this.items, event.previousIndex, to);
      this.saveOrder();
    }
  }

  private handleGroupDrop(draggedItem: DashboardItem, targetItem: DashboardItem) {
    let groupName: string;

    if (targetItem.kind === 'group') {
      groupName = targetItem.group!.name;
    } else {
      const existingNames = new Set(
        this.items.filter(i => i.kind === 'group').map(i => i.group!.name)
      );
      groupName = 'Group';
      let n = 2;
      while (existingNames.has(groupName)) groupName = `Group ${n++}`;
    }

    const calls = [this.userActionsService.setActionGroup(draggedItem.action!.id, groupName)];
    if (targetItem.kind === 'action') {
      calls.push(this.userActionsService.setActionGroup(targetItem.action!.id, groupName));
    }

    forkJoin(calls).subscribe(() => {
      this.userActionsService.getUserActions().subscribe(actions => {
        this.items = this.buildItems(actions);
        this.saveOrder();
      });
    });
  }

  private saveOrder() {
    const orderedIds: number[] = [];
    for (const item of this.items) {
      if (item.kind === 'action') orderedIds.push(item.action!.id);
      else orderedIds.push(...item.group!.actions.map(a => a.id));
    }
    this.userActionsService.reorderActions(orderedIds).subscribe();
  }

  // ── Connected drop-list IDs (one per group item) ─────────────────

  get allGroupTargetIds(): string[] {
    return this.items
      .map((item, i) => item.kind === 'group' ? `group-drop-${i}` : null)
      .filter((id): id is string => id !== null);
  }

  onGroupOverlayDrop(event: CdkDragDrop<DashboardItem[]>, i: number) {
    const draggedItem: DashboardItem = event.item.data;
    const targetItem = this.items[i];
    if (draggedItem?.kind === 'action' && targetItem?.kind === 'group') {
      this.handleGroupDrop(draggedItem, targetItem);
    }
  }

  // ── Group actions ────────────────────────────────────────────────

  openGroup(group: ActionGroupView) {
    const ref = this.bottomSheet.open(GroupBottomSheetComponent, { data: { group } });
    ref.afterDismissed().subscribe((needsReload: boolean) => {
      if (needsReload) this.reloadActions();
    });
  }

  renameGroup(group: ActionGroupView) {
    const existingNames = new Set(
      this.items.filter(i => i.kind === 'group' && i.group!.name !== group.name).map(i => i.group!.name)
    );
    const ref = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      data: { name: group.name, title: 'Rename Group' },
    });
    ref.afterClosed().subscribe((newName: string | undefined) => {
      if (!newName || newName === group.name) return;
      if (existingNames.has(newName)) {
        this.snackBar.open('A group with that name already exists', 'Close', { duration: 2500 });
        return;
      }
      forkJoin(group.actions.map(a => this.userActionsService.setActionGroup(a.id, newName)))
        .subscribe(() => {
          this.snackBar.open('Group renamed', 'Close', { duration: 2000 });
          this.reloadActions(); // rebuild items with new references so signal inputs re-fire
        });
    });
  }

  ungroupAll(group: ActionGroupView) {
    forkJoin(group.actions.map(a => this.userActionsService.setActionGroup(a.id, null)))
      .subscribe(() => this.reloadActions());
  }

  // ── Device type icon + trait helpers ─────────────────────────────

  iconForAction = iconForAction;
  hasTrait = hasTrait;
  colorOptions = COLOR_OPTIONS;

  // ── Action card actions ──────────────────────────────────────────

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  renameAction(action: DeviceActionView) {
    const ref = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
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
