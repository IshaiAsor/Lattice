import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { MgmtDeviceRegisterComponent } from '../mgmt-device-register/mgmt-device-register.component';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { MgmtDeviceEdit } from '../mgmt-device-edit/mgmt-device-edit';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DeviceUpdateDialogComponent } from '../device-update-dialog/device-update-dialog.component';
import { ConfirmDialogComponent } from '../admin-device-config/confirm-dialog.component';

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

  get devicesTotal()     { return this.devices?.length ?? 0; }
  get devicesOnline()    { return this.devices?.filter(d => d.online).length ?? 0; }
  get devicesOffline()   { return this.devices?.filter(d => !d.online).length ?? 0; }
  get updatesAvailable() { return this.devices?.filter(d => d.update_available).length ?? 0; }

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
    this.dialog.open(ConfirmDialogComponent, {
      panelClass: ['glass-dialog', 'compact-dialog'],
      data: {
        title: 'Delete Device',
        message: `Delete "${device.deviceName}"? This will remove all associated actions and cannot be undone.`,
        confirmLabel: 'Delete',
      },
    }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.deviceMgmtService.deleteDevice(device.id).subscribe({
        next: () => { this.loadDevices(); this.snackBar.open('Device deleted', 'Close', { duration: 2000 }); },
        error: () => this.snackBar.open('Failed to delete device', 'Close', { duration: 3000 }),
      });
    });
  }

  reprovisionDevice(device: DeviceView) {
    this.deviceMgmtService.reprovisionDevice(device.id).subscribe({
      next: () => this.snackBar.open('Reprovision command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send reprovision command', 'close', { duration: 3000 }),
    });
  }

  softResetDevice(device: DeviceView) {
    this.dialog.open(ConfirmDialogComponent, {
      panelClass: ['glass-dialog', 'compact-dialog'],
      data: {
        title: 'Soft Reset',
        message: `Send a soft reset command to "${device.deviceName}"? The device will reboot and reconnect.`,
        confirmLabel: 'Reset',
      },
    }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.deviceMgmtService.softResetDevice(device.id).subscribe({
        next: () => this.snackBar.open('Soft reset command sent', 'Close', { duration: 2000 }),
        error: () => this.snackBar.open('Failed to send soft reset command', 'Close', { duration: 3000 }),
      });
    });
  }

  hardResetDevice(device: DeviceView) {
    this.dialog.open(ConfirmDialogComponent, {
      panelClass: ['glass-dialog', 'compact-dialog'],
      data: {
        title: 'Hard Reset',
        message: `Hard reset "${device.deviceName}"? This will erase the device configuration and it will need to be re-provisioned.`,
        confirmLabel: 'Hard Reset',
      },
    }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.deviceMgmtService.hardResetDevice(device.id).subscribe({
        next: () => this.snackBar.open('Hard reset command sent', 'Close', { duration: 2000 }),
        error: () => this.snackBar.open('Failed to send hard reset command', 'Close', { duration: 3000 }),
      });
    });
  }

  restartDevice(device: DeviceView) {
    this.deviceMgmtService.restartDevice(device.id).subscribe({
      next: () => this.snackBar.open('Restart command sent', 'close', { duration: 2000 }),
      error: () => this.snackBar.open('Failed to send restart command', 'close', { duration: 3000 }),
    });
  }

  updateFirmware(device: DeviceView) {
    const dialogRef = this.dialog.open(DeviceUpdateDialogComponent, {
      width: '440px',
      data: { device },
    });
    dialogRef.afterClosed().subscribe((updated) => {
      if (updated) this.loadDevices();
    });
  }

  addDevice() {
    const dialogRef = this.dialog.open(MgmtDeviceRegisterComponent, {});

    dialogRef.afterClosed().subscribe(() => {
      this.loadDevices();
    });
  }
}
