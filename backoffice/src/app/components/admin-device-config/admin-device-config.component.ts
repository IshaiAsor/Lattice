import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  AdminDeviceConfigService,
  AdminDeviceType,
  AdminDeviceAction,
  AdminTraitView,
} from 'src/app/services/admin.device.config.service';

export interface DeviceTypeGroup {
  type: string;
  versions: AdminDeviceType[];
}

@Component({
  selector: 'app-admin-device-config',
  imports: [SHARED_MATERIAL],
  templateUrl: './admin-device-config.component.html',
  styleUrls: ['./admin-device-config.component.css'],
})
export class AdminDeviceConfigComponent implements OnInit {
  private service = inject(AdminDeviceConfigService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  deviceTypes: AdminDeviceType[] = [];
  deviceTypeGroups: DeviceTypeGroup[] = [];
  selectedType: string | null = null;
  selectedDevice: AdminDeviceType | null = null;
  actions: AdminDeviceAction[] = [];
  loading = false;

  ngOnInit() {
    // Load the list first, then let the URL's id decide which device type is open — the id lookup
    // needs the loaded types. Subscribing handles back/forward and our own selectDevice navigations.
    this.loadDeviceTypes(() => {
      this.route.paramMap.subscribe((pm) => this.applyRouteId(pm.get('id')));
    });
  }

  loadDeviceTypes(onLoaded?: () => void) {
    this.service.getDeviceTypes().subscribe((types) => {
      this.deviceTypes = types;
      this.deviceTypeGroups = this.buildGroups(types);
      if (this.selectedDevice) {
        this.selectedDevice = types.find((t) => t.id === this.selectedDevice!.id) ?? null;
      }
      onLoaded?.();
    });
  }

  // Open whatever the URL points at. The guard against the already-open id keeps our own
  // selectDevice navigations from re-fetching actions once the param arrives.
  private applyRouteId(idStr: string | null): void {
    const id = idStr ? Number(idStr) : null;
    if (id === (this.selectedDevice?.id ?? null)) return;
    if (id === null) {
      this.selectedDevice = null;
      this.actions = [];
      return;
    }
    const device = this.deviceTypes.find((t) => t.id === id);
    if (!device) {
      // A stale or deleted id — drop back to the no-selection state without leaving it in the URL.
      this.router.navigate(['/admin/templates'], { replaceUrl: true });
      return;
    }
    this.selectedType = device.type; // expand the group the selected version belongs to
    this.selectedDevice = device;
    this.loadActions();
  }

  private buildGroups(types: AdminDeviceType[]): DeviceTypeGroup[] {
    const map = new Map<string, AdminDeviceType[]>();
    for (const t of types) {
      const group = map.get(t.type) ?? [];
      group.push(t);
      map.set(t.type, group);
    }
    return Array.from(map.entries()).map(([type, versions]) => ({
      type,
      versions: versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })),
    }));
  }

  toggleType(type: string) {
    this.selectedType = this.selectedType === type ? null : type;
  }

  // Selecting is just navigation — the id in the URL drives the actual selection via applyRouteId,
  // so a refresh reopens the same device type.
  selectDevice(device: AdminDeviceType) {
    this.router.navigate(['/admin/templates', device.id]);
  }

  loadActions() {
    if (!this.selectedDevice) return;
    this.loading = true;
    this.service.getActions(this.selectedDevice.id).subscribe({
      next: (actions) => { this.actions = actions; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  pinsLabel(action: AdminDeviceAction): string {
    return action.pins?.map(p => `${p.label} (${p.mode})`).join(', ') || '—';
  }

  traitShortName(trait: AdminTraitView): string {
    return trait.value.replace('action.devices.traits.', '');
  }

  setDefaultTrait(action: AdminDeviceAction, trait: AdminTraitView) {
    if (trait.is_default) return;
    this.service.setDefaultTrait(action.id, trait.id).subscribe(() => {
      action.google_traits.forEach(t => (t.is_default = t.id === trait.id));
    });
  }
}
