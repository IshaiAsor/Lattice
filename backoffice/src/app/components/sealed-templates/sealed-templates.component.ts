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

// Draft entry with the include toggle + pin assignments the editor works with (a superset of the
// wire SealedTemplateEntry). A capability from the reference device's catalog the admin composes.
interface DraftEntry {
  include: boolean;
  capability_key: string;
  label: string; // catalog label (for display)
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

  // Editor state
  name = '';
  targets: SealedTemplateTarget[] = [];
  entries: DraftEntry[] = [];
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

  create() {
    const name = prompt('Template name?');
    if (!name?.trim()) return;
    this.service.createSealedTemplate(name.trim()).subscribe((t) => {
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
      this.entries = [];
      this.message.set('');
      // If the template already has entries but no reference device chosen, load the palette from
      // the first target's newest matching identity so the admin sees + edits existing selections.
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

  // Load the capability palette from a reference sealed device version; overlay existing entries.
  loadPalette(deviceId: number, existing?: SealedTemplateEntry[]) {
    this.referenceDeviceId = deviceId;
    this.service.getCapabilities(deviceId).subscribe((caps) => {
      this.entries = caps.map((c) => this.toDraft(c, existing));
    });
  }
  onReferenceChange() {
    if (this.referenceDeviceId != null) this.loadPalette(this.referenceDeviceId, this.selected()?.entries);
  }

  private toDraft(c: AdminCatalogCapability, existing?: SealedTemplateEntry[]): DraftEntry {
    const prior = existing?.find((e) => e.capability_key === c.capability_key);
    return {
      include: !!prior,
      capability_key: c.capability_key,
      label: c.label,
      action_label: prior?.action_label ?? c.label,
      default_trait_value: prior?.default_trait_value ?? null,
      traitOptions: c.google_traits ?? [],
      pins: c.configurable_pins.map((p) => ({
        pin_slot_key: p.key,
        label: p.label,
        mode: p.mode,
        pin_number: prior?.pins.find((pp) => pp.pin_slot_key === p.key)?.pin_number ?? null,
      })),
      behaviors: BEHAVIORS.map((b) => {
        const pb = prior?.behaviors.find((x) => x.behavior === b);
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
    return this.entries
      .filter((e) => e.include)
      .map((e, i) => ({
        capability_key: e.capability_key,
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
