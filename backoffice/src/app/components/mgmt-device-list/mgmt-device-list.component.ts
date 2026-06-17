import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { MgmtDeviceRegisterComponent } from '../mgmt-device-register/mgmt-device-register.component';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
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
  private deviceMgmtService = inject(DeviceMgmtService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
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
          device.online = data.online;
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

  reprovisionDevice(device: DeviceView) {
    this.deviceMgmtService.reprovisionDevice(device.id).subscribe({
      next: () => this.snackBar.open('Reprovision command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send reprovision command', 'close', { duration: 3000 }),
    });
  }

  softResetDevice(device: DeviceView) {
    this.deviceMgmtService.softResetDevice(device.id).subscribe({
      next: () => this.snackBar.open('Soft reset command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send soft reset command', 'close', { duration: 3000 }),
    });
  }

  hardResetDevice(device: DeviceView) {
    this.deviceMgmtService.hardResetDevice(device.id).subscribe({
      next: () => this.snackBar.open('Hard reset command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send hard reset command', 'close', { duration: 3000 }),
    });
  }

  restartDevice(device: DeviceView) {
    this.deviceMgmtService.restartDevice(device.id).subscribe({
      next: () => this.snackBar.open('Restart command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send restart command', 'close', { duration: 3000 }),
    });
  }

  addDevice() {
    const dialogRef = this.dialog.open(MgmtDeviceRegisterComponent, {});

    dialogRef.afterClosed().subscribe(() => {
      this.loadDevices();
    });
  }
}
