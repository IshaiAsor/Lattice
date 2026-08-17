import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  AdminCatalogCapability,
  AdminDeviceConfigService,
  SealedIdentity,
  SealedTemplate,
  SealedTemplateEntry,
  SealedTemplateSummary,
  SealedTemplateTarget,
  SealedTemplateUsage,
} from 'src/app/services/admin.device.config.service';

// One composed action instance in the editor. A capability may be added multiple times (e.g. 8
// i2c_socket_8 channels); the server assigns each a unique mqtt_action_name from base_mqtt_name.
interface DraftInstance {
  capability_key: string;
  label: string; // catalog label (display)
  base_mqtt_name: string; // capability's base mqtt_action_name (server suffixes _2/_3…)
  // The name this instance is ALREADY stored under, when it came from a saved entry. Sent back
  // verbatim so a round-trip renames nothing: the catalog's base name and the stored one can
  // legitimately differ (a template seeded through the API may have used the capability_key as its
  // base), and rebuilding from the catalog would silently rename every entry — which is exactly
  // what strands a published blueprint's (slot_key, action_name) reference (F10.10). Null for an
  // instance the admin has just added, which has no name yet and takes the catalog's base.
  mqtt_action_name: string | null;
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
  private route = inject(ActivatedRoute);
  private router = inject(Router);

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

  // F10.10 — what depends on this template. `usage` is loaded with the template (so the admin sees
  // the dependents before editing); `problems` holds the server's list of what a rejected save
  // would break, and `blocked` is what turns Save into an explicit "save anyway".
  usage = signal<SealedTemplateUsage[]>([]);
  problems = signal<string[]>([]);
  blocked = signal(false);
  // References that are broken *already* — what a forced save (or a seeded template edit) leaves
  // behind. Distinct from `problems`, which is what a rejected save would have broken.
  strandedNow = computed(() => this.usage().flatMap((u) => u.stranded));

  ngOnInit() {
    // Load the list + identities first (open() needs the identities to build its palette), then let
    // the URL's id decide which template is open. Subscribing handles back/forward and our own
    // select navigations.
    forkJoin({
      templates: this.service.listSealedTemplates(),
      identities: this.service.getSealedIdentities(),
    }).subscribe(({ templates, identities }) => {
      this.templates.set(templates);
      this.identities.set(identities);
      this.route.paramMap.subscribe((pm) => this.applyRouteId(pm.get('id')));
    });
  }

  reload() {
    this.service.listSealedTemplates().subscribe((t) => this.templates.set(t));
  }

  // Selecting is just navigation — the id in the URL drives the actual open via applyRouteId, so a
  // refresh or shared /admin/sealed-templates/:id link reopens the same template.
  select(id: number) {
    this.router.navigate(['/admin/sealed-templates', id]);
  }

  // Open whatever the URL points at. The guard against the already-open id keeps our own select
  // navigations from re-fetching the template once the param arrives.
  private applyRouteId(idStr: string | null): void {
    const id = idStr ? Number(idStr) : null;
    if (id === (this.selected()?.id ?? null)) return;
    if (id === null) {
      this.selected.set(null);
      return;
    }
    if (!this.templates().some((t) => t.id === id)) {
      // A stale or deleted id — drop back to the no-selection state without leaving it in the URL.
      this.router.navigate(['/admin/sealed-templates'], { replaceUrl: true });
      return;
    }
    this.open(id);
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
      // Refresh the list before routing: applyRouteId validates the id against the loaded list, so
      // the new template must be present before we navigate to it (else it reads as a stale id).
      this.service.listSealedTemplates().subscribe((rows) => {
        this.templates.set(rows);
        this.select(t.id);
      });
    });
  }

  open(id: number) {
    this.service.getSealedTemplateUsage(id).subscribe((u) => this.usage.set(u));
    this.service.getSealedTemplate(id).subscribe((t) => {
      this.selected.set(t);
      this.name = t.name;
      this.targets = t.targets.map((x) => ({ ...x }));
      this.referenceDeviceId = null;
      this.palette = [];
      this.instances = [];
      this.message.set('');
      this.problems.set([]);
      this.blocked.set(false);
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
      mqtt_action_name: null, // new instance — the server names it from the base
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
      mqtt_action_name: e.mqtt_action_name ?? null, // keep the name it is already addressed by
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

  // `force` is only ever passed by the "Save anyway" button, which appears once the server has
  // listed the published blueprint references this edit would strand (F10.10).
  save(force = false) {
    const t = this.selected();
    if (!t) return;
    this.loading.set(true);
    this.problems.set([]);
    this.service
      .updateSealedTemplate(t.id, {
        name: this.name,
        targets: this.targets,
        entries: this.toWireEntries(),
        force,
      })
      .subscribe({
        next: (updated) => {
          this.selected.set(updated);
          this.loading.set(false);
          this.blocked.set(false);
          this.message.set(force ? 'Saved — the references listed above are now broken.' : 'Saved.');
          this.reload();
          // Re-read the dependents: a forced save is exactly when `stranded` becomes non-empty.
          this.service.getSealedTemplateUsage(t.id).subscribe((u) => this.usage.set(u));
        },
        error: (e) => this.failed(e, 'Save failed'),
      });
  }

  // One error path for all three writes: the dependency guard answers 409 with a `details` list,
  // and that list is the whole point — a message alone would say "something breaks" and nothing more.
  private failed(e: unknown, fallback: string) {
    // The api's error body is `{ error, details? }` (exception.middleware) — `error.message` was
    // read here before and is never set, so every failure showed the bare fallback.
    const res = e as { status?: number; error?: { error?: string; message?: string; details?: string[] } };
    this.loading.set(false);
    this.message.set(res?.error?.error ?? res?.error?.message ?? fallback);
    this.problems.set(res?.error?.details ?? []);
    this.blocked.set(res?.status === 409);
  }

  release() {
    const t = this.selected();
    if (!t) return;
    if (!confirm('Release this template? It will be applied to all matching provisioned devices.')) return;
    this.loading.set(true);
    this.problems.set([]);
    // Persist current edits first, then release. The save carries the dependency guard, so a
    // release that would strand a published blueprint is refused here rather than after it is live.
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
            error: (e) => this.failed(e, 'Release failed'),
          });
        },
        error: (e) => this.failed(e, 'Save failed'),
      });
  }

  remove() {
    const t = this.selected();
    if (!t || !confirm(`Delete template "${t.name}"?`)) return;
    this.problems.set([]);
    this.service.deleteSealedTemplate(t.id).subscribe({
      next: () => {
        // Navigating to the base clears the id from the URL (applyRouteId then nulls the selection).
        this.router.navigate(['/admin/sealed-templates']);
        this.reload();
      },
      // A template holding up a blueprint is refused (409). Without this the delete simply did
      // nothing, with no page state to say why.
      error: (e) => this.failed(e, 'Delete failed'),
    });
  }

  private toWireEntries(): SealedTemplateEntry[] {
    return this.instances.map((e, i) => ({
      capability_key: e.capability_key,
      // Its own stored name where it has one, else the capability's base — the server suffixes
      // _2/_3… per repeated instance and steps over names already taken.
      mqtt_action_name: e.mqtt_action_name ?? e.base_mqtt_name,
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
