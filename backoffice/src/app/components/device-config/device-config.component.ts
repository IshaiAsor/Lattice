import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceMgmtService, DeviceView, CapabilityView, UserActionView, PinSlot } from 'src/app/services/device.mgmt.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { AuthService } from 'src/app/services/auth.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

export interface ActiveInstance {
  cap: CapabilityView;
  instance: UserActionView;
}

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
  private socketService = inject(DeviceSocketService);
  private destroyRef = inject(DestroyRef);
  authService = inject(AuthService);

  devices: DeviceView[] = [];
  selectedDevice: DeviceView | null = null;
  capabilities: CapabilityView[] = [];
  loadingDevices = false;
  loadingCapabilities = false;

  expandedCapabilityId: number | null = null;
  intervalInputValue: number | null = null;
  pinInputValues: Record<number, number | null> = {};
  resolutionInputValue: string | null = null;
  transportInputValue: string | null = 'http';

  editingInstanceId: number | null = null;
  editName = '';
  editIntervalMs: number | null = null;
  editPinValues: Record<number, number | null> = {};
  editResolution: string | null = null;
  editTransport: string | null = 'http';
  // Enabled behaviors while editing (unified action model). Toggled per available behavior.
  editBehaviors = new Set<string>();

  private readonly behaviorLabels: Record<string, string> = {
    command: 'Accept commands',
    interval: 'Cyclic reading',
    on_demand: 'On-demand reading',
  };
  behaviorLabel(b: string): string {
    return this.behaviorLabels[b] ?? b;
  }
  isBehaviorEnabled(b: string): boolean {
    return this.editBehaviors.has(b);
  }
  toggleBehavior(b: string, on: boolean): void {
    if (on) this.editBehaviors.add(b);
    else this.editBehaviors.delete(b);
  }

  readonly cameraResolutionOptions = [
    { value: 'QQVGA', label: 'QQVGA (160x120)' },
    { value: 'QVGA', label: 'QVGA (320x240)' },
    { value: 'VGA', label: 'VGA (640x480)' },
    { value: 'SVGA', label: 'SVGA (800x600)' },
    { value: 'XGA', label: 'XGA (1024x768)' },
    { value: 'HD', label: 'HD (1280x720)' },
    { value: 'SXGA', label: 'SXGA (1280x1024)' },
    { value: 'UXGA', label: 'UXGA (1600x1200)' },
    { value: 'FHD', label: 'FHD (1920x1080)' },
    { value: 'QXGA', label: 'QXGA (2048x1536)' },
    { value: 'QHD', label: 'QHD (2560x1440)' },
    { value: 'WQXGA', label: 'WQXGA (2560x1600)' },
    { value: 'QSXGA', label: 'QSXGA (2560x1920)' },
  ];
  readonly cameraTransportOptions = [
    { value: 'http', label: 'HTTP' },
    { value: 'ws', label: 'WebSocket' },
  ];

  get isAdmin(): boolean { return this.authService.getCurrentUser()?.role === 'admin'; }

  get activeInstances(): ActiveInstance[] {
    return this.capabilities.flatMap(cap =>
      cap.instances.map(instance => ({ cap, instance }))
    );
  }

  ngOnInit() {
    this.loadingDevices = true;
    this.deviceMgmtService.getDevices().subscribe({
      next: (devices) => { this.devices = devices; this.loadingDevices = false; },
      error: () => { this.snack.open('Failed to load devices', 'Close', { duration: 3000 }); this.loadingDevices = false; },
    });

    this.socketService.onDeviceOnlineStatusChange()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ deviceId, online }) => {
        const device = this.devices.find(d => d.id === deviceId);
        if (device) {
          if (device.online && !online) device.lastOnlineDate = new Date();
          device.online = online;
          if (this.selectedDevice?.id === deviceId) {
            if (this.selectedDevice.online && !online) this.selectedDevice.lastOnlineDate = new Date();
            this.selectedDevice.online = online;
          }
        }
      });
  }

  selectDevice(device: DeviceView) {
    this.selectedDevice = device;
    this.cancelAdd();
    this.cancelEdit();
    this.loadCapabilities();
  }

  loadCapabilities() {
    if (!this.selectedDevice) return;
    this.loadingCapabilities = true;
    this.deviceMgmtService.getDeviceCapabilities(this.selectedDevice.id).subscribe({
      next: (caps) => { this.capabilities = caps; this.loadingCapabilities = false; },
      error: () => { this.snack.open('Failed to load capabilities', 'Close', { duration: 3000 }); this.loadingCapabilities = false; },
    });
  }

  pinSlots(cap: CapabilityView): PinSlot[] {
    return cap.configurable_pins ?? [];
  }

  isCameraCapability(cap: CapabilityView): boolean {
    return cap.implementation_type === 'CameraAction';
  }

  resolutionLabel(value: string | null | undefined): string | null {
    if (!value) return null;
    return this.cameraResolutionOptions.find((r) => r.value === value)?.label ?? value;
  }

  startAdd(cap: CapabilityView) {
    this.expandedCapabilityId = cap.id;
    this.intervalInputValue = cap.min_telemetry_interval_ms ?? null;
    this.pinInputValues = {};
    for (const slot of this.pinSlots(cap)) {
      this.pinInputValues[slot.id] = null;
    }
    this.resolutionInputValue = this.isCameraCapability(cap) ? 'SVGA' : null;
    this.transportInputValue = this.isCameraCapability(cap) ? 'http' : null;
  }

  cancelAdd() {
    this.expandedCapabilityId = null;
    this.intervalInputValue = null;
    this.pinInputValues = {};
    this.resolutionInputValue = null;
    this.transportInputValue = null;
  }

  confirmAdd(cap: CapabilityView) {
    if (!this.selectedDevice) return;

    const slots = this.pinSlots(cap);
    const pins = slots.map(slot => ({
      capability_pin_id: slot.id,
      pin_number: this.pinInputValues[slot.id] as number,
    }));

    const intervalMs = cap.mqtt_action_type === 'telemetry' ? this.intervalInputValue : null;
    const deviceId = this.selectedDevice.id;
    const isCamera = this.isCameraCapability(cap);

    this.deviceMgmtService.activateCapability(
      deviceId, cap.id, intervalMs, pins,
      isCamera ? this.resolutionInputValue : null,
      isCamera ? this.transportInputValue : null,
    ).subscribe({
      next: () => {
        this.snack.open(`${cap.label} added — restarting device`, 'Close', { duration: 2500 });
        this.cancelAdd();
        this.loadCapabilities();
        this.deviceMgmtService.restartDevice(deviceId).subscribe();
      },
      error: () => this.snack.open('Failed to add action', 'Close', { duration: 3000 }),
    });
  }

  startEdit(cap: CapabilityView, instance: UserActionView) {
    this.editingInstanceId = instance.id;
    this.editName = instance.name;
    this.editIntervalMs = instance.intervalMs ?? (cap.min_telemetry_interval_ms ?? null);
    this.editPinValues = {};
    const slots = this.pinSlots(cap);
    for (let i = 0; i < slots.length; i++) {
      this.editPinValues[slots[i].id] = instance.pins?.[i]?.pinNumber ?? null;
    }
    this.editResolution = instance.cameraResolution ?? (this.isCameraCapability(cap) ? 'SVGA' : null);
    this.editTransport = instance.cameraTransport ?? (this.isCameraCapability(cap) ? 'http' : null);
    // Enabled behaviors: the user's explicit selection, or (if none yet) every behavior the
    // capability supports — matching the device's all-enabled default for an unconfigured action.
    this.editBehaviors = new Set(
      instance.enabledBehaviors.length > 0
        ? instance.enabledBehaviors.map((b) => b.behavior)
        : cap.available_behaviors.map((b) => b.behavior),
    );
  }

  cancelEdit() {
    this.editingInstanceId = null;
    this.editName = '';
    this.editIntervalMs = null;
    this.editPinValues = {};
    this.editResolution = null;
    this.editTransport = null;
    this.editBehaviors = new Set();
  }

  saveEdit(cap: CapabilityView, instance: UserActionView) {
    if (!this.selectedDevice) return;
    const slots = this.pinSlots(cap);
    const pins = slots.map(slot => ({
      capability_pin_id: slot.id,
      pin_number: this.editPinValues[slot.id] as number,
    }));
    const deviceId = this.selectedDevice.id;
    const isCamera = this.isCameraCapability(cap);
    this.deviceMgmtService.updateActivatedAction(
      deviceId,
      instance.id,
      {
        name: this.editName,
        ...(cap.mqtt_action_type === 'telemetry' && { telemetry_interval_ms: this.editIntervalMs }),
        ...(slots.length > 0 && { pins }),
        ...(isCamera && { camera_resolution: this.editResolution, camera_transport: this.editTransport }),
      },
    ).subscribe({
      next: () => {
        const finish = () => {
          this.snack.open(`${cap.label} updated — restarting device`, 'Close', { duration: 2500 });
          this.cancelEdit();
          this.loadCapabilities();
          this.deviceMgmtService.restartDevice(deviceId).subscribe();
        };
        // Persist the enabled behaviors (unified action model) if the capability declares any.
        if (cap.available_behaviors.length > 0) {
          const behaviors = [...this.editBehaviors].map((b) => ({
            behavior: b,
            intervalMs: b === 'interval' ? this.editIntervalMs : null,
            cameraResolution: b === 'on_demand' && isCamera ? this.editResolution : null,
            cameraTransport: b === 'on_demand' && isCamera ? this.editTransport : null,
          }));
          this.deviceMgmtService.setActionBehaviors(instance.id, behaviors).subscribe({
            next: finish,
            error: () => this.snack.open('Failed to save behaviors', 'Close', { duration: 3000 }),
          });
        } else {
          finish();
        }
      },
      error: () => this.snack.open('Failed to update action', 'Close', { duration: 3000 }),
    });
  }

  canSaveEdit(cap: CapabilityView): boolean {
    if (!this.editName.trim()) return false;
    const slots = this.pinSlots(cap);
    const allPinsFilled = slots.every(s => {
      const v = this.editPinValues[s.id];
      return v != null && v > 0;
    });
    // Interval value is only required when the `interval` behavior is actually enabled.
    const intervalOk = !(cap.mqtt_action_type === 'telemetry' && this.isBehaviorEnabled('interval'))
      || (this.editIntervalMs != null && this.editIntervalMs >= (cap.min_telemetry_interval_ms ?? 0));
    const cameraOk = !this.isCameraCapability(cap) || (!!this.editResolution && !!this.editTransport);
    return allPinsFilled && intervalOk && cameraOk;
  }

  removeAction(cap: CapabilityView, instance: UserActionView) {
    if (!this.selectedDevice) return;
    const deviceId = this.selectedDevice.id;
    this.userActionsService.deleteAction(instance.id).subscribe({
      next: () => {
        this.snack.open(`${instance.name} removed — restarting device`, 'Close', { duration: 2500 });
        this.loadCapabilities();
        this.deviceMgmtService.restartDevice(deviceId).subscribe();
      },
      error: () => this.snack.open('Failed to remove action', 'Close', { duration: 3000 }),
    });
  }

  canConfirm(cap: CapabilityView): boolean {
    const slots = this.pinSlots(cap);
    const allPinsFilled = slots.every(s => {
      const v = this.pinInputValues[s.id];
      return v != null && v > 0;
    });
    const intervalOk = cap.mqtt_action_type !== 'telemetry'
      || (this.intervalInputValue != null && this.intervalInputValue >= (cap.min_telemetry_interval_ms ?? 0));
    const cameraOk = !this.isCameraCapability(cap) || (!!this.resolutionInputValue && !!this.transportInputValue);
    return allPinsFilled && intervalOk && cameraOk;
  }

  typeChip(cap: CapabilityView): string {
    return cap.mqtt_action_type === 'telemetry' ? 'sensor' : 'command';
  }

  goToTemplates() {
    this.router.navigate(['/admin/templates']);
  }
}
