import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

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
  actions: DeviceActionView[] = [];
  show = false;

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
        console.log('Received action state update:', data);
        const action = this.actions.find((e) => e.id == data.actionId);
        if (action) {
          action.state = data.state;
        } else {
          console.log(`Action with id ${data.actionId} not found`);
        }
      });

    this.socketService
      .onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((data) => {
        console.log('Received device state update:', data);
        const action = this.actions.filter((e) => e.deviceId == data.deviceId);
        if (action) {
          for (let i = 0; i < action.length; i++) action[i].state = data.state;
        } else {
          console.log(`Device with id ${data.deviceId} not found`);
        }
      });
  }

  onToggle(action: DeviceActionView, event: any) {
    const actionState = event.checked ? 'on' : 'off';
    this.socketService.publishActionState(action.id, actionState);
  }

  changeActionState(actionId: number, state: any) {
    console.log(`Changing state of action ${actionId} to ${state}`);
  }
}
