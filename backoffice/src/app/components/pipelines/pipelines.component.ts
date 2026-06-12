import { Component, inject, OnInit, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { PipelineService } from 'src/app/services/pipeline.service';
import { downloadJson, readJsonFile } from 'src/app/utils/import-export.utils';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import type { Pipeline, PipelineRun } from 'src/app/models';

@Component({
  selector: 'app-pipelines',
  imports: [SHARED_MATERIAL],
  templateUrl: './pipelines.component.html',
  styleUrl: './pipelines.component.css',
})
export class PipelinesComponent implements OnInit {
  private svc    = inject(PipelineService);
  private snack  = inject(MatSnackBar);
  private socket = inject(DeviceSocketService);

  pipelines: Pipeline[] = [];
  runs      = signal<Record<number, PipelineRun[]>>({});
  showRuns  = signal<number | null>(null);
  triggering = signal<number | null>(null);

  ngOnInit(): void {
    this.load();
    this.socket.onPipelineResult().subscribe(evt => {
      this.snack.open(`Pipeline run #${evt.run_id}: ${evt.status}`, 'OK', { duration: 3000 });
      if (this.showRuns()) this.loadRuns(this.showRuns()!);
    });
  }

  private load(): void {
    this.svc.list().subscribe(p => this.pipelines = p);
  }

  toggle(p: Pipeline): void {
    this.svc.toggle(p.id, !p.enabled).subscribe(() => p.enabled = !p.enabled);
  }

  trigger(p: Pipeline): void {
    this.triggering.set(p.id);
    this.svc.trigger(p.id).subscribe({
      next:  () => { this.snack.open('Pipeline triggered', 'OK', { duration: 2000 }); this.triggering.set(null); },
      error: () => { this.snack.open('Trigger failed', 'OK', { duration: 3000 }); this.triggering.set(null); },
    });
  }

  toggleRuns(p: Pipeline): void {
    if (this.showRuns() === p.id) { this.showRuns.set(null); return; }
    this.showRuns.set(p.id);
    this.loadRuns(p.id);
  }

  private loadRuns(id: number): void {
    this.svc.getRuns(id).subscribe(r => this.runs.update(v => ({ ...v, [id]: r })));
  }

  delete(p: Pipeline): void {
    this.svc.delete(p.id).subscribe(() => {
      this.pipelines = this.pipelines.filter(x => x.id !== p.id);
      this.snack.open('Pipeline deleted', 'OK', { duration: 2000 });
    });
  }

  stageColor(kind: string): string {
    return ({ vlm: 'vlm', sensor_digest: 'digest', llm: 'llm', command_exec: 'exec' } as any)[kind] ?? '';
  }

  runIcon(status: string): string {
    return status === 'completed' ? 'check_circle' : status === 'failed' ? 'error' : 'hourglass_empty';
  }

  runDuration(run: PipelineRun): string {
    if (!run.finished_at) return '';
    const ms = +new Date(run.finished_at) - +new Date(run.started_at);
    return (ms / 1000).toFixed(1) + 's';
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportConfig(): void {
    this.svc.list().subscribe(pipelines =>
      downloadJson('lattice-pipelines.json', { version: '1', exported_at: new Date().toISOString(), pipelines })
    );
  }

  importConfig(file: File): void {
    readJsonFile(file).then(data => {
      this.svc.importPipelines(data).subscribe({
        next: r => { this.snack.open(`Imported ${r.imported} pipeline(s)`, 'OK', { duration: 3000 }); this.load(); },
        error: () => this.snack.open('Import failed', 'OK', { duration: 3000 }),
      });
    }).catch(() => this.snack.open('Invalid JSON file', 'OK', { duration: 3000 }));
  }
}
