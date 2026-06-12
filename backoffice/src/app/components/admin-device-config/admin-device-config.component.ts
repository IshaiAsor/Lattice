import { Component, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { CatalogService } from 'src/app/services/catalog.service';
import { DeviceTypeDialogComponent } from './device-type-dialog.component';
import { ActionDialogComponent, ActionDialogData } from './action-dialog.component';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import type { DeviceModel, ModelAction, MlModel } from 'src/app/models';
import { downloadJson, readJsonFile } from 'src/app/utils/import-export.utils';

@Component({
  selector: 'app-admin-device-config',
  imports: [SHARED_MATERIAL],
  templateUrl: './admin-device-config.component.html',
  styleUrls: ['./admin-device-config.component.css'],
})
export class AdminDeviceConfigComponent implements OnInit {
  private svc    = inject(CatalogService);
  private dialog = inject(MatDialog);
  private snack  = inject(MatSnackBar);

  models: DeviceModel[]     = [];
  selectedModel: DeviceModel | null = null;
  actions: ModelAction[]    = [];
  mlModels: MlModel[]       = [];
  loading = false;

  private googleTypeMap  = new Map<number, string>();
  private googleTraitMap = new Map<number, string>();

  ngOnInit(): void {
    forkJoin({
      types:  this.svc.getGoogleActionTypes(),
      traits: this.svc.getGoogleTraits(),
    }).subscribe(({ types, traits }) => {
      types.forEach(t  => this.googleTypeMap.set(t.id, t.name));
      traits.forEach(t => this.googleTraitMap.set(t.id, t.name));
    });
    this.loadModels();
    this.loadMlModels();
  }

  googleTypeName(id: number | null): string { return id != null ? (this.googleTypeMap.get(id) ?? `ID ${id}`) : '—'; }
  googleTraitNames(ids: number[]): string   { return ids?.length ? ids.map(id => this.googleTraitMap.get(id) ?? `ID ${id}`).join(', ') : '—'; }

  // ── Device models ─────────────────────────────────────────────────────────

  loadModels(): void {
    this.svc.getModels().subscribe(models => {
      this.models = models;
      if (this.selectedModel) this.selectedModel = models.find(m => m.id === this.selectedModel!.id) ?? null;
    });
  }

  selectModel(m: DeviceModel): void {
    this.selectedModel = m;
    this.loadActions();
  }

  loadActions(): void {
    if (!this.selectedModel) return;
    this.loading = true;
    this.svc.getActions(this.selectedModel.id).subscribe({
      next: a => { this.actions = a; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  openModelDialog(model?: DeviceModel): void {
    this.dialog.open(DeviceTypeDialogComponent, { data: model ?? null })
      .afterClosed().subscribe(result => {
        if (!result) return;
        const call = model ? this.svc.updateModel(model.id, result) : this.svc.createModel(result);
        call.subscribe(() => {
          this.snack.open(model ? 'Model updated' : 'Model created', 'OK', { duration: 2000 });
          this.loadModels();
        });
      });
  }

  deleteModel(model: DeviceModel): void {
    this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Delete Device Model', message: `Delete "${model.display_name}"? All its actions will be removed.` } as ConfirmDialogData,
    }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.svc.deleteModel(model.id).subscribe(() => {
        this.snack.open('Model deleted', 'OK', { duration: 2000 });
        if (this.selectedModel?.id === model.id) { this.selectedModel = null; this.actions = []; }
        this.loadModels();
      });
    });
  }

  // ── Model actions ─────────────────────────────────────────────────────────

  openActionDialog(action?: ModelAction): void {
    const usedPins = new Map<number, string>();
    for (const a of this.actions) {
      if (action && a.id === action.id) continue;
      for (const p of ((a.pins as unknown as any[]) ?? [])) usedPins.set(p.pinNumber, a.mqtt_name ?? '');
    }
    this.dialog.open(ActionDialogComponent, { data: { action: action ?? null, usedPins } as ActionDialogData })
      .afterClosed().subscribe(result => {
        if (!result || !this.selectedModel) return;
        const call = action
          ? this.svc.updateAction(action.id, result)
          : this.svc.createAction(this.selectedModel.id, result);
        call.subscribe({
          next: () => { this.snack.open(action ? 'Action updated' : 'Action created', 'OK', { duration: 2000 }); this.loadActions(); },
          error: err => {
            const msg = (err?.status === 409 || err?.status === 400) ? (err.error?.error ?? 'Error') : 'Failed to save';
            this.snack.open(msg, 'OK', { duration: 4000 });
          },
        });
      });
  }

  deleteAction(action: ModelAction): void {
    this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Delete Action', message: `Delete action "${action.action_key}"?` } as ConfirmDialogData,
    }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.svc.deleteAction(action.id).subscribe(() => {
        this.snack.open('Action deleted', 'OK', { duration: 2000 });
        this.loadActions();
      });
    });
  }

  pinsLabel(action: ModelAction): string {
    return ((action.pins as unknown as any[]) ?? []).map((p: any) => `GPIO${p.pinNumber}/${p.pinMode}`).join(', ') || '—';
  }

  // ── ML Models ─────────────────────────────────────────────────────────────

  loadMlModels(): void { this.svc.getMlModels().subscribe(m => this.mlModels = m); }

  openMlModelDialog(model?: MlModel): void {
    // Inline simple dialog using MatDialog — reuse ConfirmDialogComponent pattern
    // For MVP, use a prompt-style snack approach; full dialog is Phase extension
    const name    = model?.name ?? '';
    const kind    = model?.kind ?? 'vlm';
    const version = model?.version ?? '';
    // TODO: replace with a proper MlModelDialogComponent when building full UI
    this.snack.open('ML model CRUD: open dedicated dialog (coming soon)', 'OK', { duration: 3000 });
  }

  deleteMlModel(model: MlModel): void {
    this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Delete ML Model', message: `Delete "${model.name} v${model.version}"?` } as ConfirmDialogData,
    }).afterClosed().subscribe(ok => {
      if (!ok) return;
      this.svc.deleteMlModel(model.id).subscribe(() => {
        this.snack.open('ML model deleted', 'OK', { duration: 2000 });
        this.loadMlModels();
      });
    });
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportConfig(): void {
    this.svc.getModels().subscribe(models => {
      this.svc.getMlModels().subscribe(mlModels => {
        downloadJson('lattice-catalog.json', {
          version: '1',
          exported_at: new Date().toISOString(),
          models: models.map(m => ({
            model_key: m.model_key, version: m.version, display_name: m.display_name,
            actions: (m.actions ?? []).map(a => {
              const typeKey = this.googleTypeName(a.google_action_type_id);
              return {
                action_key: a.action_key, capability: a.capability,
                google_action_type_key: typeKey,
                mqtt_type: a.mqtt_type, mqtt_name: a.mqtt_name,
                telemetry_interval_ms: a.telemetry_interval_ms,
                params: a.params ?? {}, pins: a.pins ?? {},
                google_trait_keys: (a.traits ?? []).map((t: any) => this.googleTraitKey(t.google_trait_id)),
              };
            }),
          })),
          ml_models: mlModels.map(({ id: _id, created_at: _c, ...rest }) => rest),
        });
      });
    });
  }

  importConfig(file: File): void {
    readJsonFile(file).then(data => {
      this.svc.importCatalog(data).subscribe({
        next: r => {
          const msg = `Imported: ${r.models_created} models created, ${r.models_updated} updated, ${r.actions_created + r.actions_updated} actions. ${r.errors.length ? r.errors[0] : ''}`;
          this.snack.open(msg, 'OK', { duration: 5000 });
          this.loadModels();
        },
        error: () => this.snack.open('Import failed', 'OK', { duration: 3000 }),
      });
    }).catch(() => this.snack.open('Invalid JSON file', 'OK', { duration: 3000 }));
  }

  private googleTraitKey(id: number): string {
    return this.googleTraitMap.get(id) ?? String(id);
  }
}
