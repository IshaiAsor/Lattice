import { Component, inject, OnInit, signal } from '@angular/core';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  AdminCatalogCapability,
  AdminDeviceConfigService,
  SealedIdentity,
  SealedTemplate,
  SealedTemplateEntry,
  SealedTemplateSummary,
  SealedTemplateTarget,
} from 'src/app/services/admin.device.config.service';

// One composed action instance in the editor. A capability may be added multiple times (e.g. 8
// i2c_socket_8 channels); the server assigns each a unique mqtt_action_name from base_mqtt_name.
interface DraftInstance {
  capability_key: string;
  label: string; // catalog label (display)
  base_mqtt_name: string; // capability's base mqtt_action_name (server suffixes _2/_3…)
  action_label: string;
  default_trait_value: string | null;
  traitOptions: string[];
  pins: { pin_slot_key: string; label: string; mode: string; pin_number: number | null }[];
  behaviors: { behavior: string; enabled: boolean; interval_ms: number | null }[];
}

const BEHAVIORS = ['command', 'interval', 'on_demand'];

@Component({
  selector: 'app-sealed-templates',
  imports: [SHARED_MATERIAL],
  templateUrl: './sealed-templates.component.html',
  styleUrls: ['./sealed-templates.component.css'],
})
export class SealedTemplatesComponent implements OnInit {
  private service = inject(AdminDeviceConfigService);

  templates = signal<SealedTemplateSummary[]>([]);
  identities = signal<SealedIdentity[]>([]);
  selected = signal<SealedTemplate | null>(null);

  // New-template inline creator (replaces a native prompt so name entry stays in-app).
  creating = signal(false);
  newName = '';

  // Editor state
  name = '';
  targets: SealedTemplateTarget[] = [];
  palette: AdminCatalogCapability[] = []; // capabilities of the reference version (to add from)
  instances: DraftInstance[] = []; // composed action instances (flat list)
  referenceDeviceId: number | null = null;
  message = signal<string>('');
  loading = signal(false);

  ngOnInit() {
    this.reload();
    this.service.getSealedIdentities().subscribe((ids) => this.identities.set(ids));
  }

  reload() {
    this.service.listSealedTemplates().subscribe((t) => this.templates.set(t));
  }

  get sealedTypes(): string[] {
    return [...new Set(this.identities().map((i) => i.type))];
  }
  versionsForType(type: string): string[] {
    return this.identities()
      .filter((i) => i.type === type)
      .map((i) => i.version);
  }

  startCreate() {
    this.newName = '';
    this.creating.set(true);
  }
  cancelCreate() {
    this.creating.set(false);
    this.newName = '';
  }
  confirmCreate() {
    const name = this.newName.trim();
    if (!name) return;
    this.service.createSealedTemplate(name).subscribe((t) => {
      this.creating.set(false);
      this.newName = '';
      this.reload();
      this.open(t.id);
    });
  }

  open(id: number) {
    this.service.getSealedTemplate(id).subscribe((t) => {
      this.selected.set(t);
      this.name = t.name;
      this.targets = t.targets.map((x) => ({ ...x }));
      this.referenceDeviceId = null;
      this.palette = [];
      this.instances = [];
      this.message.set('');
      // Load the palette from the first target's newest matching identity so existing instances
      // can be rebuilt against their capability metadata.
      const firstTarget = t.targets[0];
      if (firstTarget) {
        const match = this.identities().find((i) => i.type === firstTarget.device_type);
        if (match) this.loadPalette(match.id, t.entries);
      }
    });
  }

  addTarget() {
    const type = this.sealedTypes[0] ?? '';
    const versions = this.versionsForType(type);
    this.targets.push({
      device_type: type,
      version_min: versions[0] ?? '',
      version_max: versions[versions.length - 1] ?? '',
    });
  }
  removeTarget(i: number) {
    this.targets.splice(i, 1);
  }

  // Load the capability palette from a reference sealed version; rebuild instances from existing
  // entries (each entry → one instance).
  loadPalette(deviceId: number, existing?: SealedTemplateEntry[]) {
    this.referenceDeviceId = deviceId;
    this.service.getCapabilities(deviceId).subscribe((caps) => {
      this.palette = caps;
      this.instances = (existing ?? [])
        .map((e) => this.entryToInstance(e))
        .filter((x): x is DraftInstance => x !== null);
    });
  }
  onReferenceChange() {
    if (this.referenceDeviceId != null) this.loadPalette(this.referenceDeviceId, this.selected()?.entries);
  }

  private capByKey(key: string): AdminCatalogCapability | undefined {
    return this.palette.find((c) => c.capability_key === key);
  }

  // How many instances of a capability are already composed (shown next to the palette add button).
  instanceCount(key: string): number {
    return this.instances.filter((i) => i.capability_key === key).length;
  }

  addInstance(cap: AdminCatalogCapability) {
    const n = this.instanceCount(cap.capability_key);
    this.instances.push(this.freshInstance(cap, n === 0 ? cap.label : `${cap.label} ${n + 1}`));
  }
  removeInstance(i: number) {
    this.instances.splice(i, 1);
  }

  private freshInstance(c: AdminCatalogCapability, label: string): DraftInstance {
    return {
      capability_key: c.capability_key,
      label: c.label,
      base_mqtt_name: c.mqtt_action_name,
      action_label: label,
      default_trait_value: null,
      traitOptions: c.google_traits ?? [],
      pins: c.configurable_pins.map((p) => ({
        pin_slot_key: p.key,
        label: p.label,
        mode: p.mode,
        pin_number: null,
      })),
      behaviors: BEHAVIORS.map((b) => ({ behavior: b, enabled: false, interval_ms: null })),
    };
  }

  private entryToInstance(e: SealedTemplateEntry): DraftInstance | null {
    const c = this.capByKey(e.capability_key);
    if (!c) return null; // capability no longer in the reference version — drop it
    return {
      capability_key: e.capability_key,
      label: c.label,
      base_mqtt_name: c.mqtt_action_name,
      action_label: e.action_label,
      default_trait_value: e.default_trait_value ?? null,
      traitOptions: c.google_traits ?? [],
      pins: c.configurable_pins.map((p) => ({
        pin_slot_key: p.key,
        label: p.label,
        mode: p.mode,
        pin_number: e.pins.find((pp) => pp.pin_slot_key === p.key)?.pin_number ?? null,
      })),
      behaviors: BEHAVIORS.map((b) => {
        const pb = e.behaviors.find((x) => x.behavior === b);
        return { behavior: b, enabled: !!pb, interval_ms: pb?.interval_ms ?? null };
      }),
    };
  }

  save() {
    const t = this.selected();
    if (!t) return;
    this.loading.set(true);
    this.service
      .updateSealedTemplate(t.id, { name: this.name, targets: this.targets, entries: this.toWireEntries() })
      .subscribe({
        next: (updated) => {
          this.selected.set(updated);
          this.loading.set(false);
          this.message.set('Saved.');
          this.reload();
        },
        error: (e) => {
          this.loading.set(false);
          this.message.set(e?.error?.message ?? 'Save failed');
        },
      });
  }

  release() {
    const t = this.selected();
    if (!t) return;
    if (!confirm('Release this template? It will be applied to all matching provisioned devices.')) return;
    this.loading.set(true);
    // Persist current edits first, then release.
    this.service
      .updateSealedTemplate(t.id, { name: this.name, targets: this.targets, entries: this.toWireEntries() })
      .subscribe({
        next: () => {
          this.service.releaseSealedTemplate(t.id).subscribe({
            next: (r) => {
              this.loading.set(false);
              this.message.set(`Released — applied to ${r.affected} device(s).`);
              this.open(t.id);
              this.reload();
            },
            error: (e) => {
              this.loading.set(false);
              this.message.set(e?.error?.message ?? 'Release failed');
            },
          });
        },
        error: (e) => {
          this.loading.set(false);
          this.message.set(e?.error?.message ?? 'Save failed');
        },
      });
  }

  remove() {
    const t = this.selected();
    if (!t || !confirm(`Delete template "${t.name}"?`)) return;
    this.service.deleteSealedTemplate(t.id).subscribe(() => {
      this.selected.set(null);
      this.reload();
    });
  }

  private toWireEntries(): SealedTemplateEntry[] {
    return this.instances.map((e, i) => ({
      capability_key: e.capability_key,
      mqtt_action_name: e.base_mqtt_name, // server suffixes _2/_3… per repeated instance
      action_label: e.action_label,
      default_trait_value: e.default_trait_value,
      sort_order: i,
      pins: e.pins
        .filter((p) => p.pin_number != null)
        .map((p) => ({ pin_slot_key: p.pin_slot_key, pin_number: p.pin_number as number })),
      behaviors: e.behaviors
        .filter((b) => b.enabled)
        .map((b) => ({ behavior: b.behavior, interval_ms: b.behavior === 'interval' ? b.interval_ms : null })),
    }));
  }
}
