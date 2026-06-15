import { Component, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  AdminDeviceConfigService,
  AdminDeviceType,
  AdminDeviceAction,
  DeviceCapabilityBlueprint,
} from 'src/app/services/admin.device.config.service';
import { GoogleActionsTypesService } from 'src/app/services/google.actions.types.service';
import { GoogleActionsTraitsService } from 'src/app/services/google.actions.traits.service';
import { DeviceTypeDialogComponent } from './device-type-dialog.component';
import { ActionDialogComponent, ActionDialogData } from './action-dialog.component';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { AuthService } from 'src/app/services/auth.service';

@Component({
  selector: 'app-admin-device-config',
  imports: [SHARED_MATERIAL],
  templateUrl: './admin-device-config.component.html',
  styleUrls: ['./admin-device-config.component.css'],
})
export class AdminDeviceConfigComponent implements OnInit {
  private service = inject(AdminDeviceConfigService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private typesService = inject(GoogleActionsTypesService);
  private traitsService = inject(GoogleActionsTraitsService);
  private authService = inject(AuthService);

  get isAdmin(): boolean { return this.authService.getCurrentUser()?.role === 'admin'; }

  deviceTypes: AdminDeviceType[] = [];
  selectedDevice: AdminDeviceType | null = null;
  actions: AdminDeviceAction[] = [];
  blueprints: DeviceCapabilityBlueprint[] = [];
  loading = false;

  private googleTypeMap = new Map<number, string>();
  private googleTraitMap = new Map<number, string>();

  ngOnInit() {
    this.typesService.getGoogleActionTypes().subscribe(types =>
      types.forEach(t => this.googleTypeMap.set(t.id, t.name))
    );
    this.traitsService.getGoogleActionTraits().subscribe(traits =>
      traits.forEach(t => this.googleTraitMap.set(t.id, t.name))
    );
    this.loadDeviceTypes();
  }

  googleTypeName(id: number | null): string {
    return id != null ? (this.googleTypeMap.get(id) ?? `ID ${id}`) : '—';
  }

  googleTraitNames(ids: number[]): string {
    if (!ids?.length) return '—';
    return ids.map(id => this.googleTraitMap.get(id) ?? `ID ${id}`).join(', ');
  }

  loadDeviceTypes() {
    this.service.getDeviceTypes().subscribe((types) => {
      this.deviceTypes = types;
      if (this.selectedDevice) {
        this.selectedDevice = types.find((t) => t.id === this.selectedDevice!.id) ?? null;
      }
    });
  }

  selectDevice(device: AdminDeviceType) {
    this.selectedDevice = device;
    this.loadActions();
  }

  loadActions() {
    if (!this.selectedDevice) return;
    this.loading = true;
    this.service.getActions(this.selectedDevice.id).subscribe({
      next: (actions) => { this.actions = actions; this.loading = false; },
      error: () => { this.loading = false; },
    });
    this.service.getBlueprints(this.selectedDevice.id).subscribe({
      next: (blueprints) => { this.blueprints = blueprints; },
    });
  }

  openDeviceTypeDialog(device?: AdminDeviceType) {
    const ref = this.dialog.open(DeviceTypeDialogComponent, { data: device ?? null });
    ref.afterClosed().subscribe((result) => {
      if (!result) return;
      if (device) {
        this.service.updateDeviceType(device.id, result).subscribe(() => {
          this.snack.open('Device type updated', 'Close', { duration: 2000 });
          this.loadDeviceTypes();
        });
      } else {
        this.service.createDeviceType(result).subscribe(() => {
          this.snack.open('Device type created', 'Close', { duration: 2000 });
          this.loadDeviceTypes();
        });
      }
    });
  }

  deleteDeviceType(device: AdminDeviceType) {
    const data: ConfirmDialogData = {
      title: 'Delete Device Type',
      message: `Delete "${device.type} v${device.version}"? This will delete all its actions.`,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.service.deleteDeviceType(device.id).subscribe(() => {
        this.snack.open('Device type deleted', 'Close', { duration: 2000 });
        if (this.selectedDevice?.id === device.id) {
          this.selectedDevice = null;
          this.actions = [];
        }
        this.loadDeviceTypes();
      });
    });
  }

  openActionDialog(action?: AdminDeviceAction) {
    const usedPins = new Map<number, string>();
    for (const a of this.actions) {
      if (action && a.id === action.id) continue;
      for (const p of (a.pins ?? [])) {
        usedPins.set(p.pinNumber, a.mqtt_action_name);
      }
    }
    const dialogData: ActionDialogData = { action: action ?? null, usedPins, blueprints: this.blueprints };
    const ref = this.dialog.open(ActionDialogComponent, { data: dialogData });
    ref.afterClosed().subscribe((result) => {
      if (!result || !this.selectedDevice) return;
      if (action) {
        this.service.updateAction(action.id, result).subscribe({
          next: () => { this.snack.open('Action updated', 'Close', { duration: 2000 }); this.loadActions(); },
          error: (err) => this.handleActionError(err),
        });
      } else {
        this.service.createAction(this.selectedDevice.id, result).subscribe({
          next: () => { this.snack.open('Action created', 'Close', { duration: 2000 }); this.loadActions(); },
          error: (err) => this.handleActionError(err),
        });
      }
    });
  }

  private handleActionError(err: unknown): void {
    const e = err as { error?: { error?: string }; status?: number };
    const serverMsg = e?.error?.error;
    const msg = (e?.status === 409 || e?.status === 400) && serverMsg
      ? serverMsg
      : 'Failed to save action';
    this.snack.open(msg, 'Close', { duration: 4000 });
  }

  deleteAction(action: AdminDeviceAction) {
    const data: ConfirmDialogData = {
      title: 'Delete Action',
      message: `Delete action "${action.default_name}"?`,
    };
    this.dialog.open(ConfirmDialogComponent, { data }).afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.service.deleteAction(action.id).subscribe(() => {
        this.snack.open('Action deleted', 'Close', { duration: 2000 });
        this.loadActions();
      });
    });
  }

  pinsLabel(action: AdminDeviceAction): string {
    return action.pins?.map(p => `GPIO${p.pinNumber}/${p.pinMode}`).join(', ') || '—';
  }
}
