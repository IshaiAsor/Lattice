import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Observable } from 'rxjs';
import { DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { MgmtDeviceRegisterComponent } from '../mgmt-device-register/mgmt-device-register.component';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MgmtActionEditComponent } from '../mgmt-action-edit/mgmt-action-edit.component';
import { MgmtDeviceEdit } from '../mgmt-device-edit/mgmt-device-edit';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-device-list',
  templateUrl: './mgmt-device-list.component.html',
  styleUrls: ['./mgmt-device-list.component.css'],
})
export class MgmtDeviceListComponent implements OnInit {
  constructor(
    private deviceMgmtService: DeviceMgmtService,
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
  ) {}
  socketService = inject(DeviceSocketService);
  destroyRef = inject(DestroyRef);

  devices: DeviceView[] | undefined;
  ngOnInit(): void {
    this.loadDevices();

    this.socketService
      .onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))

      .subscribe((data) => {
        console.log('Received device state update:', data);
        const device = this.devices?.find((e) => e.id == data.deviceId);
        if (device) {
          device.online = data.state;
        } else {
          console.log(`Device with id ${data.deviceId} not found`);
        }
      });
  }

  private loadDevices() {
    this.deviceMgmtService.getDevices().subscribe((result) => {
      this.devices = result;
    });
  }

  updateName(device: DeviceView) {
    const dialogRef = this.dialog.open(MgmtDeviceEdit, {
      width: '250px',
      data: { deviceName: device.deviceName },
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.deviceMgmtService.updateDevice(device.id, { name: result }).subscribe(
          () => {
            console.log('Device updated');
            this.loadDevices();
            this.snackBar.open('device updated successfully', 'close', { duration: 2000 });
          },
          (err) => {
            console.log(err);
          },
        );
      }
    });
  }

  deleteDevice(device: DeviceView) {
    console.log(device);
    this.deviceMgmtService.deleteDevice(device.id).subscribe(
      () => {
        console.log('Device deleted');
        this.loadDevices();

        this.snackBar.open('device deleted successfully', 'close', { duration: 2000 });
      },
      (err) => {
        console.log(err);
      },
    );
  }

  addDevice() {
    const dialogRef = this.dialog.open(MgmtDeviceRegisterComponent, {});

    dialogRef.afterClosed().subscribe((result) => {
      this.loadDevices();
    });
  }
}
