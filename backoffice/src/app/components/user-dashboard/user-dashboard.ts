import { Component, DestroyRef, HostListener, inject, OnInit } from '@angular/core';
import { DeviceActionView, DeviceMgmtService } from 'src/app/services/device.mgmt.service';
import { hasTrait, COLOR_OPTIONS, iconForAction, activeTraitValue, traitIconName, controllableTraits, isTelemetryAction, isCameraAction } from 'src/app/utils/device-type.utils';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { ActionGroupView, DashboardItem, UserActionsService } from 'src/app/services/user.actions.service';
import { AreasService, AreaView } from 'src/app/services/areas.service';
import { AreaManageDialogComponent } from '../area-manage-dialog/area-manage-dialog.component';
import { UserRulesService } from 'src/app/services/user.rules.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { GroupTileComponent } from '../group-tile/group-tile.component';
import { SceneTileComponent } from '../scene-tile/scene-tile.component';
import { SceneEditorDialogComponent } from '../scene-editor-dialog/scene-editor-dialog.component';
import { ScenesService, SceneView } from 'src/app/services/scenes.service';
import { CameraDisplayComponent } from '../camera-display/camera-display.component';
import { ReceivedBadgeComponent } from '../received-badge/received-badge.component';
import { GroupBottomSheetComponent } from '../group-bottom-sheet/group-bottom-sheet.component';
import { CdkDragDrop, CdkDragMove, moveItemInArray } from '@angular/cdk/drag-drop';
import { HttpClient } from '@angular/common/http';
import { apiUrl } from 'src/app/services/api.config';

// Dial geometry constants
const CX = 60, CY = 52, R = 36;
const START_ANGLE = 225;
const TOTAL_SWEEP = 270;

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

// One dashboard section = the cards for a single Area (or the "Unassigned" bucket). Built as a
// view over the flat `items` list: each entry keeps its global index into `items` so the existing
// pointer-based drag hit-testing (which reads data-item-index) keeps working unchanged (F10.0).
interface AreaSection {
  key: string; // 'area-<id>' | 'unassigned'
  areaId: number | null;
  areaName: string | null;
  entries: { item: DashboardItem; index: number }[];
  onlineCount: number;
}

@Component({
  selector: 'app-user-dashboard',
  imports: [SHARED_MATERIAL, GroupTileComponent, SceneTileComponent, CameraDisplayComponent, ReceivedBadgeComponent],
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
  private deviceMgmtService = inject(DeviceMgmtService);
  private areasService = inject(AreasService);
  private rulesService = inject(UserRulesService);
  private scenesService = inject(ScenesService);
  private http = inject(HttpClient);

  items: DashboardItem[] = [];
  // Area sectioning/filtering (F10.0). sections is derived from items; activeAreaFilter narrows
  // which sections render. areaDropTargetKey highlights the band the pointer is over while
  // dragging (drag-to-reassign).
  sections: AreaSection[] = [];
  activeAreaFilter = 'all'; // 'all' | 'area-<id>' | 'unassigned'
  areaDropTargetKey: string | null = null;
  // The user's areas (incl. any with no devices yet) — drives the Manage-areas affordance and,
  // via sort_order, the order the sections render in.
  allAreas: AreaView[] = [];
  scenes: SceneView[] = [];
  // Scene ids with an execute in flight — drives the tile spinner. Cleared on 202, since
  // execution is fire-and-forget (per-device acks arrive later as normal state updates).
  runningSceneIds = new Set<number>();
  isDragging = false;
  draggingIndex = -1;
  groupDropTargetIndex: number | null = null;

  // Stat card values
  devicesOnline = 0;
  devicesTotal = 0;
  activeRules = 0;
  emergencyAlerts = 0;
  firmwareUpdates = 0;

  private lastPointerPos = { x: 0, y: 0 };
  private draggingActionId: number | null = null;
  private deviceOnlineState = new Map<number, boolean>();

  // Prior action.state for in-flight commands, so action_state_failed can revert the UI.
  private pendingPrevState = new Map<number, unknown>();
  // Latest commandId dispatched per action. Only that commandId's ack clears pending=true,
  // preventing a stale concurrent ack from clobbering a more recent command's state.
  private latestCommandId = new Map<number, string>();

  @HostListener('document:pointerup')
  onDocumentPointerUp() { this.draggingActionId = null; }

  ngOnInit(): void {
    this.loadActions();
    this.loadAreas();
    this.loadScenes();
    this.loadStats();

    this.socketService
      .onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.findAction(data.actionId);
        if (action) {
          action.state = data.state;
          action.receivedAt = Date.now();
          // Only clear pending when this is the latest in-flight commandId. A stale
          // concurrent ack for an older command must not clobber a newer command's pending.
          const isLatest = !data.commandId || this.latestCommandId.get(data.actionId) === data.commandId;
          if (isLatest) {
            action.pending = false;
            this.latestCommandId.delete(data.actionId);
            this.pendingPrevState.delete(data.actionId);        
          }
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
          // Only stash prevState if the action is currently settled (not already pending),
          // so we preserve the last *confirmed* state rather than an intermediate pending value.
          if (!action.pending) {
            this.pendingPrevState.set(data.actionId, action.state);
          }
          this.latestCommandId.set(data.actionId, data.commandId);
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
          // lastState is provided by the timeout path; device-rejection omits it.
          // Fall back to the locally stashed prevState when it's missing.
          const revertTo = data.lastState ?? this.pendingPrevState.get(data.actionId);
          if (revertTo !== undefined) action.state = revertTo;
          this.pendingPrevState.delete(data.actionId);
          this.latestCommandId.delete(data.actionId);
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
          .forEach(a => {
            if (a.online && !online) a.lastOnlineDate = new Date();
            a.online = online;
          });

        const wasOnline = this.deviceOnlineState.get(deviceId);
        if (wasOnline !== undefined && wasOnline !== online) {
          this.deviceOnlineState.set(deviceId, online);
          this.devicesOnline = Math.max(0, this.devicesOnline + (online ? 1 : -1));
        }
      });
  }

  private loadStats() {
    this.deviceMgmtService.getDevices().subscribe(devices => {
      this.devicesTotal = devices.length;
      this.devicesOnline = devices.filter(d => d.online).length;
      this.firmwareUpdates = devices.filter(d => d.update_available).length;
      for (const d of devices) this.deviceOnlineState.set(d.id, d.online);
    });

    this.rulesService.getRules().subscribe(rules => {
      this.activeRules = rules.filter(r => r.enabled).length;
    });

    this.http.get<{ id: number }[]>(`${apiUrl()}/api/rules/events?limit=50&emergency=true`)
      .subscribe({ next: events => { this.emergencyAlerts = events.length; } });
  }

  private loadActions() {
    this.userActionsService
      .getUserActions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((actions) => { this.setItems(this.buildItems(actions)); });
  }

  private reloadActions() {
    this.userActionsService.getUserActions().subscribe(actions => {
      this.setItems(this.buildItems(actions));
    });
  }

  // Single entry point for replacing the flat item list; keeps the derived area sections in sync.
  private setItems(items: DashboardItem[]) {
    this.items = items;
    this.rebuildSections();
  }

  private loadAreas() {
    this.areasService.list().subscribe({
      next: areas => {
        this.allAreas = areas;
        this.rebuildSections(); // sort_order may have changed the section order
      },
      error: () => { /* non-critical: sections fall back to alphabetical order */ },
    });
  }

  // Reorder / rename / delete areas. Areas are created by assigning a device on the device page;
  // this dialog is where their order and names live.
  openManageAreas() {
    this.dialog.open(AreaManageDialogComponent, { width: '440px', panelClass: 'glass-dialog' })
      .afterClosed()
      .subscribe((changed: boolean) => {
        if (!changed) return;
        this.loadAreas();
        this.reloadActions(); // a rename/delete changes the names/areas the cards carry
      });
  }

  // ── Scenes (F10.5) ───────────────────────────────────────────────

  private loadScenes() {
    this.scenesService
      .getScenes()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(scenes => { this.scenes = scenes; });
  }

  // Fire-and-forget: the 202 only means "queued". Each device's real state lands via the
  // normal socket action_state_update, so the tiles below update themselves.
  runScene(scene: SceneView) {
    if (this.runningSceneIds.has(scene.id)) return;
    this.runningSceneIds.add(scene.id);
    this.scenesService.execute(scene.id).subscribe({
      next: res => {
        this.runningSceneIds.delete(scene.id);
        this.snackBar.open(`${scene.name} — ${res.queued} command(s) sent`, 'Close', { duration: 2500 });
      },
      error: () => {
        this.runningSceneIds.delete(scene.id);
        this.snackBar.open(`Failed to run ${scene.name}`, 'Close', { duration: 3000 });
      },
    });
  }

  createScene() {
    this.openSceneEditor(null);
  }

  editScene(scene: SceneView) {
    this.openSceneEditor(scene);
  }

  private openSceneEditor(scene: SceneView | null) {
    const actions = this.items
      .flatMap(i => (i.kind === 'action' ? [i.action!] : i.group!.actions))
      .filter(a => !isTelemetryAction(a) && !isCameraAction(a));

    const ref = this.dialog.open(SceneEditorDialogComponent, {
      data: { scene, actions },
      panelClass: 'glass-dialog',
      width: '520px',
    });
    ref.afterClosed().subscribe((saved: boolean) => {
      if (saved) this.loadScenes();
    });
  }

  deleteScene(scene: SceneView) {
    this.scenesService.deleteScene(scene.id).subscribe({
      next: () => {
        this.scenes = this.scenes.filter(s => s.id !== scene.id);
        this.snackBar.open(`Deleted ${scene.name}`, 'Close', { duration: 2500 });
      },
      error: () => this.snackBar.open('Failed to delete scene', 'Close', { duration: 3000 }),
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
          id: members[0].groupId!,
          name,
          previewTypes: members.slice(0, 4).map(m => m.googleType?.value ?? null),
          actions: members,
        },
      });
    }

    return result.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // ── Area sections (F10.0) ────────────────────────────────────────
  // The area a dashboard item belongs to. An action carries its device's areaId directly; a group
  // spans possibly several devices, so it only counts as an area member when ALL its actions share
  // the same area — otherwise it falls into "Unassigned" (a mixed-area group has no single home).
  private itemAreaId(item: DashboardItem): number | null {
    if (item.kind === 'action') return item.action!.areaId ?? null;
    const ids = new Set(item.group!.actions.map(a => a.areaId ?? null));
    return ids.size === 1 ? [...ids][0] : null;
  }

  private itemAreaName(item: DashboardItem): string | null {
    if (item.kind === 'action') return item.action!.areaName ?? null;
    const areaId = this.itemAreaId(item);
    if (areaId === null) return null;
    return item.group!.actions.find(a => a.areaId === areaId)?.areaName ?? null;
  }

  private itemOnline(item: DashboardItem): boolean {
    return item.kind === 'action' ? !!item.action!.online : item.group!.actions.some(a => a.online);
  }

  // Buckets the flat item list into per-area sections (named areas first, alphabetical, then the
  // Unassigned bucket last), preserving each item's global index for the drag hit-testing.
  private rebuildSections() {
    const byKey = new Map<string, AreaSection>();
    this.items.forEach((item, index) => {
      const areaId = this.itemAreaId(item);
      const key = areaId === null ? 'unassigned' : `area-${areaId}`;
      let section = byKey.get(key);
      if (!section) {
        section = { key, areaId, areaName: this.itemAreaName(item), entries: [], onlineCount: 0 };
        byKey.set(key, section);
      }
      if (!section.areaName) section.areaName = this.itemAreaName(item);
      section.entries.push({ item, index });
      if (this.itemOnline(item)) section.onlineCount++;
    });

    // Named sections follow the user's own order (areas.sort_order, set in Manage areas); areas
    // not in the loaded list yet fall to the end, tie-broken by name so the order stays stable.
    const orderOf = new Map(this.allAreas.map(a => [a.id, a.sort_order]));
    const named = [...byKey.values()]
      .filter(s => s.areaId !== null)
      .sort((a, b) => {
        const oa = orderOf.get(a.areaId!) ?? Number.MAX_SAFE_INTEGER;
        const ob = orderOf.get(b.areaId!) ?? Number.MAX_SAFE_INTEGER;
        return oa !== ob ? oa - ob : (a.areaName ?? '').localeCompare(b.areaName ?? '');
      });
    const unassigned = byKey.get('unassigned');
    this.sections = unassigned ? [...named, unassigned] : named;

    // Drop a filter that no longer matches any section (e.g. its last device was reassigned).
    if (this.activeAreaFilter !== 'all' && !byKey.has(this.activeAreaFilter)) {
      this.activeAreaFilter = 'all';
    }
  }

  // Sections actually shown, after the filter chips (B). 'all' shows everything.
  get visibleSections(): AreaSection[] {
    if (this.activeAreaFilter === 'all') return this.sections;
    return this.sections.filter(s => s.key === this.activeAreaFilter);
  }

  // Filter chips: All + one per section (with card counts). Only rendered when the user actually
  // has areas in play — a flat single-bucket dashboard shows no chips at all.
  get areaChips(): { key: string; label: string; count: number }[] {
    if (this.sections.length <= 1) return [];
    const chips = this.sections.map(s => ({
      key: s.key,
      label: s.areaName ?? 'Unassigned',
      count: s.entries.length,
    }));
    return [{ key: 'all', label: 'All', count: this.items.length }, ...chips];
  }

  setAreaFilter(key: string) {
    this.activeAreaFilter = key;
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
    this.areaDropTargetKey = null;
  }

  // ── Group hover detection (works because CDK sorting is disabled) ──
  // No timer — directly track which card the pointer is over.
  // Sorting is disabled so cards don't transform; getBoundingClientRect is accurate.

  onDragMoved(event: CdkDragMove) {
    this.lastPointerPos = { x: event.pointerPosition.x, y: event.pointerPosition.y };
    this.groupDropTargetIndex = this.cardIndexAtPoint(this.lastPointerPos.x, this.lastPointerPos.y);
    // Highlight an area band only when the pointer is over one AND not over a card (a card drop
    // means "group", which wins) — mirrors the drop() precedence so the highlight can't mislead.
    this.areaDropTargetKey =
      this.groupDropTargetIndex === null
        ? this.areaBandAtPoint(this.lastPointerPos.x, this.lastPointerPos.y)
        : null;
  }

  // The area band under (px, py), or null. Bands carry data-area-key; used for drag-to-reassign.
  private areaBandAtPoint(px: number, py: number): string | null {
    const bands = document.querySelectorAll<HTMLElement>('.area-band[data-area-key]');
    for (const b of Array.from(bands)) {
      const r = b.getBoundingClientRect();
      if (r.width === 0) continue;
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        return b.getAttribute('data-area-key');
      }
    }
    return null;
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
    // This is more reliable than the *DropTarget fields which reset on any pointer movement.
    const targetIdx = this.cardIndexAtPoint(this.lastPointerPos.x, this.lastPointerPos.y);
    const bandKey = targetIdx === null ? this.areaBandAtPoint(this.lastPointerPos.x, this.lastPointerPos.y) : null;
    const dragged = this.items[event.previousIndex];
    this.groupDropTargetIndex = null;
    this.areaDropTargetKey = null;

    if (targetIdx !== null && dragged.kind === 'action') {
      // Precedence 1 — dropped onto another card → group them (existing behavior).
      this.handleGroupDrop(dragged, this.items[targetIdx]);
    } else if (bandKey !== null) {
      // Precedence 2 — dropped onto an area band → move the device(s) into that area (C).
      this.reassignItemToArea(dragged, bandKey);
    } else {
      // Precedence 3 — plain reorder. cdkDropListSortingDisabled → currentIndex === previousIndex.
      const to = this.reorderIndex(this.lastPointerPos.x, this.lastPointerPos.y, event.previousIndex);
      moveItemInArray(this.items, event.previousIndex, to);
      this.rebuildSections();
      this.saveOrder();
    }
  }

  // Drag-to-assign (C): reassign the dragged item's device(s) to the target area (or clear it for
  // the Unassigned band). A group carries several devices — all of them move. No-op when the item
  // is already in that area.
  private reassignItemToArea(item: DashboardItem, bandKey: string) {
    const targetAreaId = bandKey === 'unassigned' ? null : Number(bandKey.replace('area-', ''));
    if (this.itemAreaId(item) === targetAreaId) return;

    const deviceIds = [
      ...new Set(
        item.kind === 'action'
          ? [item.action!.deviceId]
          : item.group!.actions.map(a => a.deviceId),
      ),
    ];
    const label = item.kind === 'action' ? item.action!.name : item.group!.name;
    const areaName = this.sections.find(s => s.key === bandKey)?.areaName ?? 'Unassigned';

    this.areasService.assignDevices(targetAreaId, deviceIds).subscribe({
      next: () => {
        this.reloadActions();
        this.snackBar.open(`Moved ${label} to ${areaName}`, 'Close', { duration: 2500 });
      },
      error: () => this.snackBar.open('Failed to move to area', 'Close', { duration: 3000 }),
    });
  }

  private handleGroupDrop(draggedItem: DashboardItem, targetItem: DashboardItem) {
    let groupName: string;
    const actionIds = [draggedItem.action!.id];

    if (targetItem.kind === 'group') {
      groupName = targetItem.group!.name;
    } else {
      const existingNames = new Set(
        this.items.filter(i => i.kind === 'group').map(i => i.group!.name)
      );
      groupName = 'Group';
      let n = 2;
      while (existingNames.has(groupName)) groupName = `Group ${n++}`;
      actionIds.push(targetItem.action!.id);
    }

    this.userActionsService.assignActionsToGroup(groupName, actionIds).subscribe(() => {
      this.userActionsService.getUserActions().subscribe(actions => {
        this.setItems(this.buildItems(actions));
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
    const ref = this.bottomSheet.open(GroupBottomSheetComponent, { data: { group }, panelClass: 'glass-bottom-sheet' });
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
      panelClass: ['glass-dialog', 'compact-dialog'],
      data: { name: group.name, title: 'Rename Group' },
    });
    ref.afterClosed().subscribe((newName: string | undefined) => {
      if (!newName || newName === group.name) return;
      if (existingNames.has(newName)) {
        this.snackBar.open('A group with that name already exists', 'Close', { duration: 2500 });
        return;
      }
      this.userActionsService.renameGroup(group.id, newName).subscribe({
        next: () => {
          this.snackBar.open('Group renamed', 'Close', { duration: 2000 });
          this.reloadActions();
        },
        error: () => this.snackBar.open('Failed to rename group', 'Close', { duration: 3000 }),
      });
    });
  }

  ungroupAll(group: ActionGroupView) {
    this.userActionsService.deleteGroup(group.id).subscribe({
      next: () => this.reloadActions(),
      error: () => this.snackBar.open('Failed to ungroup', 'Close', { duration: 3000 }),
    });
  }

  // ── Device type icon + trait helpers ─────────────────────────────

  iconForAction = iconForAction;
  hasTrait = hasTrait;
  activeTraitValue = activeTraitValue;
  traitIconName = traitIconName;
  controllableTraits = controllableTraits;
  isTelemetryAction = isTelemetryAction;
  isCameraAction = isCameraAction;
  colorOptions = COLOR_OPTIONS;

  setDefaultTrait(action: DeviceActionView, traitId: number) {
    action.defaultTraitId = traitId;
    this.userActionsService.setDefaultTrait(action.id, traitId).subscribe();
  }

  // ── Action card actions ──────────────────────────────────────────

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  renameAction(action: DeviceActionView) {
    const ref = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      panelClass: ['glass-dialog', 'compact-dialog'],
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
