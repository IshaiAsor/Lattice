import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { ActionGroupView } from 'src/app/services/user.actions.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';
import { ActionCardComponent } from '../action-card/action-card.component';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

@Component({
  selector: 'app-group-bottom-sheet',
  standalone: true,
  imports: [SHARED_MATERIAL, ActionCardComponent],
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
  dragging = false;
  dragUpActive = false;
  // Set when intra-group order changed, so the dashboard reloads on dismiss.
  private orderChanged = false;

  // Prior action.state for in-flight commands, so action_state_failed can revert the UI.
  private pendingPrevState = new Map<number, unknown>();
  private latestCommandId = new Map<number, string>();

  ngOnInit() {
    this.actions = [...this.data.group.actions];

    this.socketService.onActionStateUpdate()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        const action = this.actions.find(a => a.id === data.actionId);
        if (action) {
          action.state = data.state;
          action.receivedAt = Date.now();
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
        this.actions
          .filter(a => a.deviceId === deviceId)
          .forEach(a => {
            if (a.online && !online) a.lastOnlineDate = new Date();
            a.online = online;
          });
      });
  }

  // ── Drag: reorder within the group, or drop on the top zone to remove ──
  // The remove zone is its own connected drop list rather than a distance
  // threshold, so dragging a card upward to reorder no longer removes it.

  onDragStarted() { this.dragging = true; }

  onDragEnded() {
    this.dragging = false;
    this.dragUpActive = false;
  }

  drop(event: CdkDragDrop<DeviceActionView[]>) {
    if (event.previousContainer !== event.container) return; // remove zone handles its own drop
    if (event.previousIndex === event.currentIndex) return;
    moveItemInArray(this.actions, event.previousIndex, event.currentIndex);
    this.orderChanged = true;
    this.saveOrder();
  }

  onRemoveZoneDrop(event: CdkDragDrop<DeviceActionView[]>) {
    this.dragUpActive = false;
    this.removeFromGroup(event.item.data as DeviceActionView);
  }

  // reorderActions rewrites sort_order as the absolute array index, so sending
  // only this group's ids would move the whole group to the front of the
  // dashboard. Send the full list instead, permuting just the group's slots.
  private saveOrder() {
    const newOrder = this.actions.map(a => a.id);
    const inGroup = new Set(newOrder);

    this.userActionsService.getUserActions().subscribe(all => {
      let next = 0;
      const orderedIds = [...all]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(a => (inGroup.has(a.id) ? newOrder[next++] : a.id));

      this.userActionsService.reorderActions(orderedIds).subscribe();
    });
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

  removeFromGroup(action: DeviceActionView) {
    const remaining = this.actions.filter(a => a.id !== action.id);

    if (remaining.length === 1) {
      // Only 1 left after removal: dissolve the group entirely (backend purges empty group on next list)
      forkJoin([
        this.userActionsService.removeActionFromGroup(action.id),
        this.userActionsService.removeActionFromGroup(remaining[0].id),
      ]).subscribe(() => {
        this.sheetRef.dismiss(true);
      });
      return;
    }

    this.userActionsService.removeActionFromGroup(action.id).subscribe(() => {
      this.actions = remaining;
      this.sheetRef.dismiss(true);
    });
  }

  close() {
    this.sheetRef.dismiss(this.orderChanged);
  }
}
