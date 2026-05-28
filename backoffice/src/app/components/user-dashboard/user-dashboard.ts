import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RenameActionDialogComponent } from '../rename-action-dialog/rename-action-dialog.component';

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

  ngOnInit(): void {
    this.userActionsService
      .getUserActions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        this.actions = result;
      });

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
      .subscribe((data) => {
        const affected = this.actions.filter((e) => e.deviceId == data.deviceId);
        for (const a of affected) a.state = data.state;
      });
  }

  onToggle(action: DeviceActionView, event: any) {
    const actionState = event.checked ? 'on' : 'off';
    this.socketService.publishActionState(action.id, actionState);
  }

  renameAction(action: DeviceActionView) {
    const dialogRef = this.dialog.open(RenameActionDialogComponent, {
      width: '320px',
      data: { action },
    });

    dialogRef.afterClosed().subscribe((newName: string | undefined) => {
      if (!newName) return;
      this.userActionsService
        .updateUserAction({ ...action, name: newName })
        .subscribe(() => {
          action.name = newName;
          this.snackBar.open('Action renamed', 'Close', { duration: 2000 });
        });
    });
  }
}
