import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceMgmtService, DeviceView, BlueprintView, PinSlot } from 'src/app/services/device.mgmt.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { AuthService } from 'src/app/services/auth.service';

@Component({
  selector: 'app-device-config',
  imports: [SHARED_MATERIAL],
  templateUrl: './device-config.component.html',
  styleUrls: ['./device-config.component.css'],
})
export class DeviceConfigComponent implements OnInit {
  private deviceMgmtService = inject(DeviceMgmtService);
  private userActionsService = inject(UserActionsService);
  private snack = inject(MatSnackBar);
  private router = inject(Router);
  authService = inject(AuthService);

  devices: DeviceView[] = [];
  selectedDevice: DeviceView | null = null;
  blueprints: BlueprintView[] = [];
  loadingDevices = false;
  loadingBlueprints = false;

  expandedBlueprintId: number | null = null;
  intervalInputValue: number | null = null;
  pinInputValues: Record<string, number | null> = {};

  editingActionId: number | null = null;
  editName = '';
  editIntervalMs: number | null = null;
  editPinValues: Record<string, number | null> = {};

  get isAdmin(): boolean { return this.authService.getCurrentUser()?.role === 'admin'; }
  get active(): BlueprintView[] { return this.blueprints.filter(b => b.activated); }
  get available(): BlueprintView[] { return this.blueprints.filter(b => !b.activated); }

  ngOnInit() {
    this.loadingDevices = true;
    this.deviceMgmtService.getDevices().subscribe({
      next: (devices) => { this.devices = devices; this.loadingDevices = false; },
      error: () => { this.snack.open('Failed to load devices', 'Close', { duration: 3000 }); this.loadingDevices = false; },
    });
  }

  selectDevice(device: DeviceView) {
    this.selectedDevice = device;
    this.cancelAdd();
    this.cancelEdit();
    this.loadBlueprints();
  }

  loadBlueprints() {
    if (!this.selectedDevice) return;
    this.loadingBlueprints = true;
    this.deviceMgmtService.getDeviceBlueprints(this.selectedDevice.id).subscribe({
      next: (blueprints) => { this.blueprints = blueprints; this.loadingBlueprints = false; },
      error: () => { this.snack.open('Failed to load capabilities', 'Close', { duration: 3000 }); this.loadingBlueprints = false; },
    });
  }

  pinSlots(bp: BlueprintView): PinSlot[] {
    return bp.configurable_pins ?? [];
  }

  startAdd(bp: BlueprintView) {
    this.expandedBlueprintId = bp.id;
    this.intervalInputValue = bp.min_telemetry_interval_ms ?? null;
    this.pinInputValues = {};
    for (const slot of this.pinSlots(bp)) {
      this.pinInputValues[slot.key] = null;
    }
  }

  cancelAdd() {
    this.expandedBlueprintId = null;
    this.intervalInputValue = null;
    this.pinInputValues = {};
  }

  confirmAdd(bp: BlueprintView) {
    if (!this.selectedDevice) return;

    const slots = this.pinSlots(bp);
    const pins = slots.map(slot => ({
      pinNumber: this.pinInputValues[slot.key] as number,
      pinMode: slot.mode,
    }));

    const intervalMs = bp.mqtt_action_type === 'telemetry' ? this.intervalInputValue : null;
    const deviceId = this.selectedDevice.id;

    this.deviceMgmtService.activateBlueprint(deviceId, bp.id, intervalMs, pins).subscribe({
      next: () => {
        this.snack.open(`${bp.label} added — restarting device`, 'Close', { duration: 2500 });
        this.cancelAdd();
        this.loadBlueprints();
        this.deviceMgmtService.restartDevice(deviceId).subscribe();
      },
      error: () => this.snack.open('Failed to add action', 'Close', { duration: 3000 }),
    });
  }

  startEdit(bp: BlueprintView) {
    if (bp.userDeviceActionId == null) return;
    this.editingActionId = bp.userDeviceActionId;
    this.editName = bp.currentName ?? bp.label;
    this.editIntervalMs = bp.currentIntervalMs ?? (bp.min_telemetry_interval_ms ?? null);
    this.editPinValues = {};
    const slots = this.pinSlots(bp);
    for (let i = 0; i < slots.length; i++) {
      this.editPinValues[slots[i].key] = bp.currentPins?.[i]?.pinNumber ?? null;
    }
  }

  cancelEdit() {
    this.editingActionId = null;
    this.editName = '';
    this.editIntervalMs = null;
    this.editPinValues = {};
  }

  saveEdit(bp: BlueprintView) {
    if (!this.selectedDevice || bp.userDeviceActionId == null) return;
    const slots = this.pinSlots(bp);
    const pins = slots.map(slot => ({
      pinNumber: this.editPinValues[slot.key] as number,
      pinMode: slot.mode,
    }));
    const deviceId = this.selectedDevice.id;
    this.deviceMgmtService.updateActivatedAction(
      deviceId,
      bp.userDeviceActionId,
      {
        name: this.editName,
        ...(bp.mqtt_action_type === 'telemetry' && { telemetry_interval_ms: this.editIntervalMs }),
        ...(slots.length > 0 && { pins }),
      },
    ).subscribe({
      next: () => {
        this.snack.open(`${bp.label} updated — restarting device`, 'Close', { duration: 2500 });
        this.cancelEdit();
        this.loadBlueprints();
        this.deviceMgmtService.restartDevice(deviceId).subscribe();
      },
      error: () => this.snack.open('Failed to update action', 'Close', { duration: 3000 }),
    });
  }

  canSaveEdit(bp: BlueprintView): boolean {
    if (!this.editName.trim()) return false;
    const slots = this.pinSlots(bp);
    const allPinsFilled = slots.every(s => {
      const v = this.editPinValues[s.key];
      return v != null && v > 0;
    });
    const intervalOk = bp.mqtt_action_type !== 'telemetry'
      || (this.editIntervalMs != null && this.editIntervalMs >= (bp.min_telemetry_interval_ms ?? 0));
    return allPinsFilled && intervalOk;
  }

  removeAction(bp: BlueprintView) {
    if (bp.userDeviceActionId == null || !this.selectedDevice) return;
    const deviceId = this.selectedDevice.id;
    this.userActionsService.deleteAction(bp.userDeviceActionId).subscribe({
      next: () => {
        this.snack.open(`${bp.label} removed — restarting device`, 'Close', { duration: 2500 });
        this.loadBlueprints();
        this.deviceMgmtService.restartDevice(deviceId).subscribe();
      },
      error: () => this.snack.open('Failed to remove action', 'Close', { duration: 3000 }),
    });
  }

  canConfirm(bp: BlueprintView): boolean {
    const slots = this.pinSlots(bp);
    const allPinsFilled = slots.every(s => {
      const v = this.pinInputValues[s.key];
      return v != null && v > 0;
    });
    const intervalOk = bp.mqtt_action_type !== 'telemetry'
      || (this.intervalInputValue != null && this.intervalInputValue >= (bp.min_telemetry_interval_ms ?? 0));
    return allPinsFilled && intervalOk;
  }

  typeChip(bp: BlueprintView): string {
    return bp.mqtt_action_type === 'telemetry' ? 'sensor' : 'command';
  }

  goToTemplates() {
    this.router.navigate(['/admin/templates']);
  }
}
