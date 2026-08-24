import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { DeviceActionView, DeviceMgmtService } from 'src/app/services/device.mgmt.service';
import { isTelemetryAction, isCameraAction } from 'src/app/utils/device-type.utils';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import {
  ActionGroupView,
  DashboardItem,
  UserActionsService,
} from 'src/app/services/user.actions.service';
import { AreasService, AreaView } from 'src/app/services/areas.service';
import { AreaManageDialogComponent } from '../area-manage-dialog/area-manage-dialog.component';
import { UserRulesService } from 'src/app/services/user.rules.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { ActivityFeedComponent } from '../activity-feed/activity-feed.component';
import { DisplayPickerComponent } from '../display-picker/display-picker.component';
import { RangePickerComponent } from '../range-picker/range-picker.component';
import { ChartRangeService } from '../../services/chart-range.service';
import { TileDensityService } from '../../services/tile-density.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { GroupTileComponent } from '../group-tile/group-tile.component';
import { SceneTileComponent } from '../scene-tile/scene-tile.component';
import { SetupTileComponent } from '../setup-tile/setup-tile.component';
import { BlueprintsService, InstanceSummary } from 'src/app/services/blueprints.service';
import { SetupLifecycleService } from '../blueprint-instance/setup-lifecycle.service';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { InstanceView } from 'src/app/services/blueprints.service';
import { SceneEditorDialogComponent } from '../scene-editor-dialog/scene-editor-dialog.component';
import { ScenesService, SceneView } from 'src/app/services/scenes.service';
import { ActionCardComponent } from '../action-card/action-card.component';
import { GroupBottomSheetComponent } from '../group-bottom-sheet/group-bottom-sheet.component';
import { CdkDragDrop, CdkDragMove, moveItemInArray } from '@angular/cdk/drag-drop';
import { HttpClient } from '@angular/common/http';
import { apiUrl } from 'src/app/services/api.config';

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
  imports: [
    SHARED_MATERIAL,
    GroupTileComponent,
    SceneTileComponent,
    SetupTileComponent,
    ActionCardComponent,
    ActivityFeedComponent,
    DisplayPickerComponent,
    RangePickerComponent,
  ],
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
  // Public: the actions bar binds the range picker straight to it.
  chartRange = inject(ChartRangeService);
  // Public: the grid stamps the density so the breakpoint rules can branch on it.
  tiles = inject(TileDensityService);
  private rulesService = inject(UserRulesService);
  private scenesService = inject(ScenesService);
  private blueprintsService = inject(BlueprintsService);
  private setupLifecycle = inject(SetupLifecycleService);
  private router = inject(Router);
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
  // Setups (F11.4). setupsTick is seconds since the last load, applied by each tile to its own
  // current phase, so the countdowns move without the dashboard re-fetching anything.
  setups: InstanceSummary[] = [];
  setupsRunning = 0;
  setupsTick = 0;
  // The actions each setup's bound devices own, and which setup is currently expanded.
  // Derived from allActions + setups by rebuildLayout(); never fetched separately.
  setupActions = new Map<number, DeviceActionView[]>();
  expandedSetupId: number | null = null;
  private allActions: DeviceActionView[] = [];
  private setupsLoadedAt = Date.now();
  private setupsBusy = false;
  isDragging = false;
  groupDropTargetIndex: number | null = null;

  // Stat card values
  devicesOnline = 0;
  devicesTotal = 0;
  activeRules = 0;
  emergencyAlerts = 0;
  firmwareUpdates = 0;

  private lastPointerPos = { x: 0, y: 0 };
  private deviceOnlineState = new Map<number, boolean>();

  // Prior action.state for in-flight commands, so action_state_failed can revert the UI.
  private pendingPrevState = new Map<number, unknown>();
  // Latest commandId dispatched per action. Only that commandId's ack clears pending=true,
  // preventing a stale concurrent ack from clobbering a more recent command's state.
  private latestCommandId = new Map<number, string>();

  ngOnInit(): void {
    this.loadActions();
    this.loadAreas();
    this.loadScenes();
    this.loadSetups();
    this.loadStats();

    // The same ten seconds the setups page and the phase cron use, so a countdown here cannot sit
    // visibly at zero while the phase has in fact already advanced.
    const ticker = setInterval(() => {
      this.setupsTick = Math.floor((Date.now() - this.setupsLoadedAt) / 1000);
    }, 10_000);
    this.destroyRef.onDestroy(() => clearInterval(ticker));

    this.socketService
      .onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.findAction(data.actionId);
        if (action) {
          action.state = data.state;
          action.receivedAt = Date.now();
          // The server just confirmed this from the device, so its stamp moves too — otherwise a
          // reconcile correction would refresh the value while the badge still read "40m ago".
          action.lastConfirmedAt = new Date().toISOString();
          // Only clear pending when this is the latest in-flight commandId. A stale
          // concurrent ack for an older command must not clobber a newer command's pending.
          const isLatest =
            !data.commandId || this.latestCommandId.get(data.actionId) === data.commandId;
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

    // A read-back that found nothing wrong (F23). It carries no state — the value is unchanged —
    // so all it does is stop the freshness badge ageing past a check that really did happen.
    this.socketService.actionStateConfirmed$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ actionId, confirmedAt }) => {
        const action = this.findAction(actionId);
        if (action) action.lastConfirmedAt = confirmedAt;
      });

    this.socketService
      .onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        this.allActions
          .filter((a) => a.deviceId === deviceId)
          .forEach((a) => {
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
    this.deviceMgmtService.getDevices().subscribe((devices) => {
      this.devicesTotal = devices.length;
      this.devicesOnline = devices.filter((d) => d.online).length;
      this.firmwareUpdates = devices.filter((d) => d.update_available).length;
      for (const d of devices) this.deviceOnlineState.set(d.id, d.online);
    });

    this.rulesService.getRules().subscribe((rules) => {
      this.activeRules = rules.filter((r) => r.enabled).length;
    });

    this.http
      .get<{ id: number }[]>(`${apiUrl()}/api/rules/events?limit=50&emergency=true`)
      .subscribe({
        next: (events) => {
          this.emergencyAlerts = events.length;
        },
      });
  }

  private loadActions() {
    this.userActionsService
      .getUserActions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((actions) => {
        this.setActions(actions);
      });
  }

  private reloadActions() {
    this.userActionsService.getUserActions().subscribe((actions) => {
      this.setActions(actions);
    });
  }

  /**
   * Every action the user owns, before the grid takes its cut. Held whole because three things
   * read it: the grid (minus the setups'), each setup tile (its own), and the socket handlers
   * (all of them — a setup's action still goes offline and still acks a command).
   */
  private setActions(actions: DeviceActionView[]) {
    this.allActions = actions;
    this.rebuildLayout();
  }

  /**
   * Splits the actions between the setup tiles and the device grid. A setup's devices used
   * to appear twice — as rails on the tile and as loose cards below — so the readings that say
   * whether a setup is working sat in the same pile as every unrelated switch in the house. The
   * setup's own card now carries them, and the grid stops listing them, so each appears once.
   *
   * Both inputs arrive asynchronously, so this runs on whichever lands second as well as first.
   */
  private rebuildLayout() {
    const owner = new Map<number, number>(); // deviceId -> setup id
    for (const setup of this.setups) {
      for (const deviceId of setup.device_ids) owner.set(deviceId, setup.id);
    }

    const bySetup = new Map<number, DeviceActionView[]>();
    const loose: DeviceActionView[] = [];
    for (const action of this.allActions) {
      const setupId = owner.get(action.deviceId);
      if (setupId === undefined) {
        loose.push(action);
        continue;
      }
      const arr = bySetup.get(setupId) ?? [];
      arr.push(action);
      bySetup.set(setupId, arr);
    }

    this.setupActions = bySetup;
    this.setItems(this.buildItems(loose));
  }

  /** The actions of one setup's bound devices, for its tile. */
  actionsFor(setup: InstanceSummary): DeviceActionView[] {
    return this.setupActions.get(setup.id) ?? [];
  }

  /**
   * One setup open at a time: expanded, a tile is a full-width panel, and two of them stacked
   * push the device grid off the page for a dashboard that is meant to be read at a glance.
   */
  toggleSetupExpanded(setup: InstanceSummary) {
    this.expandedSetupId = this.expandedSetupId === setup.id ? null : setup.id;
  }

  // Single entry point for replacing the flat item list; keeps the derived area sections in sync.
  private setItems(items: DashboardItem[]) {
    this.items = items;
    this.rebuildSections();
  }

  private loadAreas() {
    this.areasService.list().subscribe({
      next: (areas) => {
        this.allAreas = areas;
        this.rebuildSections(); // sort_order may have changed the section order
      },
      error: () => {
        /* non-critical: sections fall back to alphabetical order */
      },
    });
  }

  // Reorder / rename / delete areas. Areas are created by assigning a device on the device page;
  // this dialog is where their order and names live.
  openManageAreas() {
    this.dialog
      .open(AreaManageDialogComponent, {
        width: '440px',
        panelClass: ['glass-dialog', 'compact-dialog'],
      })
      .afterClosed()
      .subscribe((changed: boolean) => {
        if (!changed) return;
        this.loadAreas();
        this.reloadActions(); // a rename/delete changes the names/areas the cards carry
      });
  }

  // ── Setups (F11.4) + their live surface ──────────────────────────
  //
  // The lifecycle is still read-only here, bar the kebab: phases, parameters and bindings are
  // operated on the setup page, and tapping a tile goes there. What the tile does now own is the
  // setup's *devices* — its readings and its switches — because those were the one thing a setup
  // card did not show while the dashboard listed them separately below.

  private loadSetups() {
    this.blueprintsService
      .listInstances()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (setups) => {
          this.setups = setups;
          this.setupsRunning = setups.filter((s) => s.lifecycle_state === 'running').length;
          this.setupsLoadedAt = Date.now();
          this.setupsTick = 0;
          // Which devices belong to a setup only becomes knowable here, and the actions may
          // already have landed — so the split is redone rather than assumed to have happened.
          if (this.expandedSetupId !== null && !setups.some((s) => s.id === this.expandedSetupId)) {
            this.expandedSetupId = null;
          }
          this.rebuildLayout();
        },
        // A dashboard is a summary: if setups cannot be read the strip stays empty rather than
        // taking the whole page down with an error nobody can act on from here. Every action then
        // falls back to the grid, which is where they all were before setups had a live surface.
        error: () => {
          this.setups = [];
          this.expandedSetupId = null;
          this.rebuildLayout();
        },
      });
  }

  openSetup(setup: InstanceSummary) {
    void this.router.navigate(['/blueprints', setup.id]);
  }

  pauseSetup(setup: InstanceSummary) {
    this.actOnSetup(
      this.setupLifecycle.stop(setup.id),
      `Paused: ${setup.name}`,
      'Could not pause this setup',
    );
  }

  resumeSetup(setup: InstanceSummary) {
    this.actOnSetup(
      this.setupLifecycle.start(setup.id, {
        defaultPhaseKey: setup.current_phase?.key ?? null,
        resuming: setup.lifecycle_state === 'stopped',
      }),
      `Started: ${setup.name}`,
      'Could not start this setup',
    );
  }

  resetSetup(setup: InstanceSummary) {
    this.actOnSetup(
      this.setupLifecycle.reset(setup.id),
      `Lifecycle reset: ${setup.name}`,
      'Could not reset',
    );
  }

  /** Each action resolves to null when the user backs out of its confirm — not an error. */
  private actOnSetup(action: Observable<InstanceView | null>, done: string, failed: string) {
    if (this.setupsBusy) return;
    this.setupsBusy = true;
    action.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => {
        this.setupsBusy = false;
        if (!updated) return;
        this.loadSetups();
        this.snackBar.open(done, 'Close', { duration: 2500 });
      },
      error: (err: { error?: { error?: string } }) => {
        this.setupsBusy = false;
        this.snackBar.open(err?.error?.error ?? failed, 'Close', { duration: 3500 });
      },
    });
  }

  // ── Scenes (F10.5) ───────────────────────────────────────────────

  private loadScenes() {
    this.scenesService
      .getScenes()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((scenes) => {
        this.scenes = scenes;
      });
  }

  // Fire-and-forget: the 202 only means "queued". Each device's real state lands via the
  // normal socket action_state_update, so the tiles below update themselves.
  runScene(scene: SceneView) {
    if (this.runningSceneIds.has(scene.id)) return;
    this.runningSceneIds.add(scene.id);
    this.scenesService.execute(scene.id).subscribe({
      next: (res) => {
        this.runningSceneIds.delete(scene.id);
        this.snackBar.open(`${scene.name} — ${res.queued} command(s) sent`, 'Close', {
          duration: 2500,
        });
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
    // Every action, not just the grid's: a setup's devices are as valid a scene member as any
    // other, and they stopped being in `items` when the setup tiles took them over.
    const actions = this.allActions.filter((a) => !isTelemetryAction(a) && !isCameraAction(a));

    const ref = this.dialog.open(SceneEditorDialogComponent, {
      data: { scene, actions },
      panelClass: 'glass-dialog',
      width: '520px',
      maxHeight: '90vh',
    });
    ref.afterClosed().subscribe((saved: boolean) => {
      if (saved) this.loadScenes();
    });
  }

  deleteScene(scene: SceneView) {
    this.scenesService.deleteScene(scene.id).subscribe({
      next: () => {
        this.scenes = this.scenes.filter((s) => s.id !== scene.id);
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
        sortOrder: Math.min(...members.map((m) => m.sortOrder ?? 0)),
        group: {
          id: members[0].groupId!,
          name,
          previewTypes: members.slice(0, 4).map((m) => m.googleType?.value ?? null),
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
    const ids = new Set(item.group!.actions.map((a) => a.areaId ?? null));
    return ids.size === 1 ? [...ids][0] : null;
  }

  private itemAreaName(item: DashboardItem): string | null {
    if (item.kind === 'action') return item.action!.areaName ?? null;
    const areaId = this.itemAreaId(item);
    if (areaId === null) return null;
    return item.group!.actions.find((a) => a.areaId === areaId)?.areaName ?? null;
  }

  private itemOnline(item: DashboardItem): boolean {
    return item.kind === 'action'
      ? !!item.action!.online
      : item.group!.actions.some((a) => a.online);
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
    const orderOf = new Map(this.allAreas.map((a) => [a.id, a.sort_order]));
    const named = [...byKey.values()]
      .filter((s) => s.areaId !== null)
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
    return this.sections.filter((s) => s.key === this.activeAreaFilter);
  }

  // Filter chips: All + one per section (with card counts). Only rendered when the user actually
  // has areas in play — a flat single-bucket dashboard shows no chips at all.
  get areaChips(): { key: string; label: string; count: number }[] {
    if (this.sections.length <= 1) return [];
    const chips = this.sections.map((s) => ({
      key: s.key,
      label: s.areaName ?? 'Unassigned',
      count: s.entries.length,
    }));
    return [{ key: 'all', label: 'All', count: this.items.length }, ...chips];
  }

  setAreaFilter(key: string) {
    this.activeAreaFilter = key;
  }

  // What the actions bar counts. Follows the area filter, so the number always describes the tiles
  // actually on screen rather than everything the page loaded.
  get visibleActionCount(): number {
    return this.visibleSections.reduce((n, s) => n + s.entries.length, 0);
  }

  // Over every action the page loaded, not just the grid's top-level ones: a setup's actions are
  // no longer in `items` at all, and a grouped action never was — both still get socket updates.
  private findAction(actionId: number): DeviceActionView | undefined {
    return this.allActions.find((a) => a.id === actionId);
  }

  itemTrackId(item: DashboardItem): string {
    return item.kind === 'action' ? `action-${item.action!.id}` : `group-${item.group!.name}`;
  }

  // ── Drag lifecycle ───────────────────────────────────────────────

  onDragStarted() {
    this.isDragging = true;
  }

  onDragEnded() {
    this.isDragging = false;
    this.groupDropTargetIndex = null;
    this.areaDropTargetKey = null;
  }

  // ── Group hover detection (works because CDK sorting is disabled) ──
  // No timer — directly track which card the pointer is over.
  // Sorting is disabled so cards don't transform; getBoundingClientRect is accurate.

  onDragMoved(event: CdkDragMove) {
    this.lastPointerPos = { x: event.pointerPosition.x, y: event.pointerPosition.y };
    this.groupDropTargetIndex = this.cardIndexAtPoint(
      this.lastPointerPos.x,
      this.lastPointerPos.y,
      event.source.element.nativeElement,
    );
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
  // The dragged card is excluded by element identity, not by index: CDK restores the source
  // element's visibility and fires (cdkDragEnded) *before* (cdkDropListDropped), so at drop time
  // it is back in the DOM at its original slot with a real rect and any index-based flag is
  // already cleared — hit-testing it would make a card its own drop target (self-group).
  private cardIndexAtPoint(px: number, py: number, dragged: HTMLElement): number | null {
    const wrappers = document.querySelectorAll<HTMLElement>(
      '.device-card-wrapper[data-item-index]',
    );
    for (const w of Array.from(wrappers)) {
      if (w === dragged || w.classList.contains('cdk-drag-preview')) continue;
      const idx = +w.getAttribute('data-item-index')!;
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

    document.querySelectorAll<HTMLElement>('.device-card-wrapper[data-item-index]').forEach((w) => {
      if (w.classList.contains('cdk-drag-preview')) return;
      const idx = +w.getAttribute('data-item-index')!;
      if (idx === draggedIdx) return;
      const r = w.getBoundingClientRect();
      if (r.width === 0) return;
      cards.push({ idx, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    });

    // Sort into reading order (top→bottom, left→right within a row)
    cards.sort((a, b) => (Math.abs(a.cy - b.cy) < 155 ? a.cx - b.cx : a.cy - b.cy));

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
    // The dragged item comes from cdkDragData, not from event.previousIndex: that index counts
    // positions in the drop list (DOM order, area section by area section), which stops matching
    // the flat `items` order as soon as sectioning or a filter chip reorders the cards.
    const dragged: DashboardItem = event.item.data;
    const draggedIdx = this.items.indexOf(dragged);
    if (draggedIdx === -1) return;

    // Re-check pointer position at drop time (lastPointerPos = final cdkDragMoved position).
    // This is more reliable than the *DropTarget fields which reset on any pointer movement.
    const targetIdx = this.cardIndexAtPoint(
      this.lastPointerPos.x,
      this.lastPointerPos.y,
      event.item.element.nativeElement,
    );
    const bandKey =
      targetIdx === null
        ? this.areaBandAtPoint(this.lastPointerPos.x, this.lastPointerPos.y)
        : null;
    this.groupDropTargetIndex = null;
    this.areaDropTargetKey = null;

    if (targetIdx !== null && targetIdx !== draggedIdx && dragged.kind === 'action') {
      // Precedence 1 — dropped onto another card → group them (existing behavior).
      this.handleGroupDrop(dragged, this.items[targetIdx]);
    } else if (bandKey !== null) {
      // Precedence 2 — dropped onto an area band → move the device(s) into that area (C).
      this.reassignItemToArea(dragged, bandKey);
    } else {
      // Precedence 3 — plain reorder. cdkDropListSortingDisabled → currentIndex === previousIndex.
      const to = this.reorderIndex(this.lastPointerPos.x, this.lastPointerPos.y, draggedIdx);
      moveItemInArray(this.items, draggedIdx, to);
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
          : item.group!.actions.map((a) => a.deviceId),
      ),
    ];
    const label = item.kind === 'action' ? item.action!.name : item.group!.name;
    const areaName = this.sections.find((s) => s.key === bandKey)?.areaName ?? 'Unassigned';

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
        this.items.filter((i) => i.kind === 'group').map((i) => i.group!.name),
      );
      groupName = 'Group';
      let n = 2;
      while (existingNames.has(groupName)) groupName = `Group ${n++}`;
      actionIds.push(targetItem.action!.id);
    }

    this.userActionsService.assignActionsToGroup(groupName, actionIds).subscribe(() => {
      this.userActionsService.getUserActions().subscribe((actions) => {
        this.setItems(this.buildItems(actions));
        this.saveOrder();
      });
    });
  }

  private saveOrder() {
    const orderedIds: number[] = [];
    for (const item of this.items) {
      if (item.kind === 'action') orderedIds.push(item.action!.id);
      else orderedIds.push(...item.group!.actions.map((a) => a.id));
    }
    this.userActionsService.reorderActions(orderedIds).subscribe();
  }

  // ── Connected drop-list IDs (one per group item) ─────────────────

  get allGroupTargetIds(): string[] {
    return this.items
      .map((item, i) => (item.kind === 'group' ? `group-drop-${i}` : null))
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
    // autoFocus: 'dialog' — Material's default ('first-tabbable') focused the close button the
    // instant the sheet opened, and CDK marks that `cdk-program-focused`, which paints the icon
    // button's state layer. The result was a large dark disc sitting in the sheet's top-right
    // corner every time it opened, as though the X had been pressed. Focus still moves into the
    // sheet (so the trap and screen readers behave), just onto the container rather than a control.
    const ref = this.bottomSheet.open(GroupBottomSheetComponent, {
      data: { group },
      panelClass: 'glass-bottom-sheet',
      autoFocus: 'dialog',
    });
    ref.afterDismissed().subscribe((needsReload: boolean) => {
      if (needsReload) this.reloadActions();
    });
  }

  renameGroup(group: ActionGroupView) {
    const existingNames = new Set(
      this.items
        .filter((i) => i.kind === 'group' && i.group!.name !== group.name)
        .map((i) => i.group!.name),
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

  // ── Action card actions ──────────────────────────────────────────

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
}
