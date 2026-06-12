import { Component, inject, OnInit, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { BlueprintService } from 'src/app/services/blueprint.service';
import { CatalogService } from 'src/app/services/catalog.service';
import type { Blueprint, DeviceModel, MlModel } from 'src/app/models';
import { downloadJson, readJsonFile } from 'src/app/utils/import-export.utils';
import { forkJoin as forkJoinRxjs } from 'rxjs';

@Component({
  selector: 'app-blueprint-builder',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprint-builder.component.html',
  styleUrl: './blueprint-builder.component.css',
})
export class BlueprintBuilderComponent implements OnInit {
  private svc     = inject(BlueprintService);
  private catalog = inject(CatalogService);
  private snack   = inject(MatSnackBar);

  blueprints: Blueprint[]   = [];
  deviceModels: DeviceModel[] = [];
  mlModels: MlModel[]        = [];

  selected  = signal<Blueprint | null>(null);
  loading   = signal(true);
  publishing = signal<number | null>(null);

  // ── New blueprint form ─────────────────────────────────────────────────────
  showNewForm  = signal(false);
  newName      = '';
  newDesc      = '';
  newCategory  = '';

  // ── Add slot form ──────────────────────────────────────────────────────────
  showSlotForm  = signal(false);
  slotModelId   = '';
  slotRole      = '';
  slotMin       = 1;
  slotMax: number | '' = '';

  // ── Add pipeline form ──────────────────────────────────────────────────────
  showPipelineForm = signal(false);
  pipeName         = '';
  pipeTrigger      = 'telemetry';
  pipeTriggerCap   = '';

  // ── Add stage form ─────────────────────────────────────────────────────────
  showStageForm = signal(false);
  stagePipeId   = signal<number | null>(null);
  stageKind     = 'sensor_digest';
  stageMlId     = '';
  stageVersion  = '';

  readonly triggerKinds = ['telemetry', 'schedule', 'rule'];
  readonly stageKinds   = ['vlm', 'sensor_digest', 'llm', 'command_exec'];

  ngOnInit(): void {
    forkJoin({
      blueprints:   this.svc.listAll(),
      deviceModels: this.catalog.getModels(),
      mlModels:     this.catalog.getMlModels(),
    }).subscribe({
      next: ({ blueprints, deviceModels, mlModels }) => {
        this.blueprints   = blueprints;
        this.deviceModels = deviceModels;
        this.mlModels     = mlModels;
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  select(bp: Blueprint): void {
    if (this.selected()?.id === bp.id) { this.selected.set(null); return; }
    this.svc.getFullById(bp.id).subscribe(full => this.selected.set(full));
  }

  create(): void {
    this.svc.create({ name: this.newName, description: this.newDesc || null, category: this.newCategory || null }).subscribe(bp => {
      this.blueprints = [bp, ...this.blueprints];
      this.snack.open('Blueprint created', 'OK', { duration: 2000 });
      this.cancelNew();
    });
  }
  cancelNew(): void { this.showNewForm.set(false); this.newName = ''; this.newDesc = ''; this.newCategory = ''; }

  publish(bp: Blueprint, event: Event): void {
    event.stopPropagation();
    this.publishing.set(bp.id);
    this.svc.publish(bp.id).subscribe({
      next: () => {
        bp.status = 'published';
        if (this.selected()?.id === bp.id) this.selected.update(s => s ? { ...s, status: 'published' } : s);
        this.snack.open('Blueprint published', 'OK', { duration: 2000 });
        this.publishing.set(null);
      },
      error: () => { this.snack.open('Publish failed', 'OK', { duration: 3000 }); this.publishing.set(null); },
    });
  }

  delete(bp: Blueprint, event: Event): void {
    event.stopPropagation();
    this.svc.delete(bp.id).subscribe(() => {
      this.blueprints = this.blueprints.filter(b => b.id !== bp.id);
      if (this.selected()?.id === bp.id) this.selected.set(null);
      this.snack.open('Blueprint deleted', 'OK', { duration: 2000 });
    });
  }

  // ── Slots ──────────────────────────────────────────────────────────────────
  addSlot(): void {
    const bp = this.selected(); if (!bp) return;
    this.svc.addSlot(bp.id, {
      device_model_id: +this.slotModelId,
      role:       this.slotRole,
      min_count:  this.slotMin,
      max_count:  this.slotMax === '' ? null : +this.slotMax,
      sort_order: (bp.slots?.length ?? 0) + 1,
    }).subscribe(slot => {
      this.selected.update(s => s ? { ...s, slots: [...(s.slots ?? []), slot] } : s);
      this.cancelSlot();
      this.snack.open('Slot added', 'OK', { duration: 2000 });
    });
  }
  cancelSlot(): void { this.showSlotForm.set(false); this.slotModelId = ''; this.slotRole = ''; this.slotMin = 1; this.slotMax = ''; }

  deleteSlot(slotId: number): void {
    const bp = this.selected(); if (!bp) return;
    this.svc.deleteSlot(bp.id, slotId).subscribe(() => {
      this.selected.update(s => s ? { ...s, slots: (s.slots ?? []).filter(sl => sl.id !== slotId) } : s);
    });
  }

  // ── Pipelines ──────────────────────────────────────────────────────────────
  addPipeline(): void {
    const bp = this.selected(); if (!bp) return;
    this.svc.addPipeline(bp.id, {
      name: this.pipeName,
      trigger_kind: this.pipeTrigger,
      trigger_capability: this.pipeTriggerCap || null,
      enabled: true,
    }).subscribe(pipe => {
      this.selected.update(s => s ? { ...s, pipelines: [...(s.pipelines ?? []), pipe] } : s);
      this.cancelPipeline();
      this.snack.open('Pipeline added', 'OK', { duration: 2000 });
    });
  }
  cancelPipeline(): void { this.showPipelineForm.set(false); this.pipeName = ''; this.pipeTrigger = 'telemetry'; this.pipeTriggerCap = ''; }

  deletePipeline(pipeId: number): void {
    const bp = this.selected(); if (!bp) return;
    this.svc.deletePipeline(bp.id, pipeId).subscribe(() => {
      this.selected.update(s => s ? { ...s, pipelines: (s.pipelines ?? []).filter(p => p.id !== pipeId) } : s);
    });
  }

  openAddStage(pipeId: number): void {
    this.stagePipeId.set(pipeId);
    this.stageKind = 'sensor_digest'; this.stageMlId = ''; this.stageVersion = '';
    this.showStageForm.set(true);
  }

  addStage(): void {
    const bp = this.selected(); const pipeId = this.stagePipeId();
    if (!bp || !pipeId) return;
    const pipe = (bp.pipelines ?? []).find(p => p.id === pipeId);
    this.svc.addStage(bp.id, pipeId, {
      stage_kind: this.stageKind,
      ml_model_id: this.stageMlId ? +this.stageMlId : null,
      component_version: this.stageVersion || null,
      position: (pipe?.stages?.length ?? 0) + 1,
    }).subscribe(stage => {
      this.selected.update(s => {
        if (!s) return s;
        const pipes = (s.pipelines ?? []).map(p =>
          p.id === pipeId ? { ...p, stages: [...(p.stages ?? []), stage] } : p);
        return { ...s, pipelines: pipes };
      });
      this.showStageForm.set(false);
      this.snack.open('Stage added', 'OK', { duration: 2000 });
    });
  }

  deleteStage(pipeId: number, stageId: number): void {
    const bp = this.selected(); if (!bp) return;
    this.svc.deleteStage(bp.id, pipeId, stageId).subscribe(() => {
      this.selected.update(s => {
        if (!s) return s;
        const pipes = (s.pipelines ?? []).map(p =>
          p.id === pipeId ? { ...p, stages: (p.stages ?? []).filter(st => st.id !== stageId) } : p);
        return { ...s, pipelines: pipes };
      });
    });
  }

  stageColor(kind: string): string {
    return ({ vlm: 'vlm', sensor_digest: 'digest', llm: 'llm', command_exec: 'exec' } as Record<string, string>)[kind] ?? '';
  }

  modelName(id: number): string {
    return this.deviceModels.find(m => m.id === id)?.display_name ?? `Model #${id}`;
  }

  mlModelLabel(id: number | null): string {
    if (!id) return '';
    return this.mlModels.find(m => m.id === id)?.name ?? `ML #${id}`;
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportConfig(): void {
    const ids = this.blueprints.map(b => b.id);
    if (!ids.length) { this.snack.open('No blueprints to export', 'OK', { duration: 2000 }); return; }
    forkJoinRxjs(ids.map(id => this.svc.getFullById(id))).subscribe(full => {
      downloadJson('lattice-blueprints.json', {
        version: '1',
        exported_at: new Date().toISOString(),
        blueprints: full.map(bp => ({
          ...bp,
          slots: (bp.slots ?? []).map(s => ({
            ...s,
            model_key:  s.device_model?.model_key,
            version:    s.device_model?.version,
          })),
          pipelines: (bp.pipelines ?? []).map(p => ({
            ...p,
            stages: (p.stages ?? []).map(st => {
              const ml = st.ml_model_id ? this.mlModels.find(m => m.id === st.ml_model_id) : null;
              return { ...st, ml_model_kind: ml?.kind ?? null, ml_model_name: ml?.name ?? null };
            }),
          })),
        })),
      });
    });
  }

  importConfig(file: File): void {
    readJsonFile(file).then(data => {
      this.svc.importBlueprints(data).subscribe({
        next: r => {
          this.snack.open(`Imported ${r.imported} blueprint(s)`, 'OK', { duration: 3000 });
          this.ngOnInit();
        },
        error: () => this.snack.open('Import failed', 'OK', { duration: 3000 }),
      });
    }).catch(() => this.snack.open('Invalid JSON file', 'OK', { duration: 3000 }));
  }
}
