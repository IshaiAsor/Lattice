import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceMgmtService } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { MgmtDeviceRegisterComponent } from '../mgmt-device-register/mgmt-device-register.component';
import { MgmtDeviceEdit } from '../mgmt-device-edit/mgmt-device-edit';
import { DeviceCapabilityDialogComponent } from './device-capability-dialog.component';
import type { UserDevice } from 'src/app/models';

@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-device-list',
  templateUrl: './mgmt-device-list.component.html',
  styleUrls: ['./mgmt-device-list.component.css'],
})
export class MgmtDeviceListComponent implements OnInit {
  private svc    = inject(DeviceMgmtService);
  private snack  = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private socket = inject(DeviceSocketService);
  private destroy = inject(DestroyRef);

  devices: UserDevice[] = [];
  loading = true;

  tableColumns = ['status', 'name', 'model', 'version', 'last_seen', 'actions'];

  ngOnInit(): void {
    this.load();

    this.socket.onDeviceStatusChange()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe(({ deviceId, online }) => {
        const d = this.devices.find(x => x.id === deviceId);
        if (d) d.online = online;
      });
  }

  private load(): void {
    this.loading = true;
    this.svc.getDevices().subscribe({
      next: devices => { this.devices = devices; this.loading = false; },
      error: ()      => { this.loading = false; },
    });
  }

  rename(device: UserDevice): void {
    this.dialog.open(MgmtDeviceEdit, { width: '300px', data: { deviceName: device.name } })
      .afterClosed().subscribe(name => {
        if (!name) return;
        this.svc.renameDevice(device.id, name).subscribe({
          next: () => { device.name = name; this.snack.open('Device renamed', 'OK', { duration: 2000 }); },
        });
      });
  }

  delete(device: UserDevice): void {
    this.svc.deleteDevice(device.id).subscribe({
      next: () => {
        this.devices = this.devices.filter(d => d.id !== device.id);
        this.snack.open('Device deleted', 'OK', { duration: 2000 });
      },
    });
  }

  command(device: UserDevice, cmd: 'reprovision' | 'soft-reset' | 'hard-reset' | 'restart'): void {
    const labels: Record<string, string> = {
      reprovision: 'Reprovision', 'soft-reset': 'Soft reset',
      'hard-reset': 'Hard reset', restart: 'Restart',
    };
    const call = cmd === 'reprovision'  ? this.svc.reprovisionDevice(device.id)
               : cmd === 'soft-reset'   ? this.svc.softResetDevice(device.id)
               : cmd === 'hard-reset'   ? this.svc.hardResetDevice(device.id)
               :                          this.svc.restartDevice(device.id);
    call.subscribe({
      next:  () => this.snack.open(`${labels[cmd]} command sent`, 'OK', { duration: 2000 }),
      error: () => this.snack.open(`${labels[cmd]} failed`, 'OK', { duration: 3000 }),
    });
  }

  configure(device: UserDevice): void {
    this.dialog.open(DeviceCapabilityDialogComponent, {
      data: { device },
      width: '600px',
      maxWidth: '95vw',
    });
  }

  openRegister(): void {
    const knownIds = new Set(this.devices.map(d => d.id));
    this.dialog.open(MgmtDeviceRegisterComponent)
      .afterClosed().subscribe((result: { registered?: boolean } | undefined) => {
        if (!result?.registered) { this.load(); return; }
        this.svc.getDevices().subscribe(devices => {
          this.devices = devices;
          const newDevice = devices.find(d => !knownIds.has(d.id));
          if (newDevice) this.configure(newDevice);
        });
      });
  }

  lastSeen(d: UserDevice): string {
    if (d.online) return 'Online now';
    if (!d.last_seen_at) return '—';
    const ms = Date.now() - new Date(d.last_seen_at).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1)  return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
}
