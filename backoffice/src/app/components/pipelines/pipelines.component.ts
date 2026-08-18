/* eslint-disable @typescript-eslint/class-literal-property-style */
import { Component, inject, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { PipelinesService, PipelineListItem } from 'src/app/services/pipelines.service';
import { PipelineEditorDialogComponent } from '../pipeline-editor-dialog/pipeline-editor-dialog.component';
import { PipelineSimulateDialogComponent } from '../pipeline-simulate-dialog/pipeline-simulate-dialog.component';
import { PipelineRunHistoryComponent } from '../pipeline-run-history/pipeline-run-history.component';

@Component({
  selector: 'app-pipelines',
  standalone: true,
  imports: [SHARED_MATERIAL, PipelineRunHistoryComponent],
  templateUrl: './pipelines.component.html',
  styleUrl: './pipelines.component.css',
})
export class PipelinesComponent implements OnInit {
  svc = inject(PipelinesService);
  dialog = inject(MatDialog);
  snack = inject(MatSnackBar);

  pipelines: PipelineListItem[] = [];
  loading = false;
  expandedRunHistory: number | null = null;

  readonly stagePills: { label: string; cls: string }[] = [
    { label: 'enrich', cls: 'pill-enrich' },
    { label: 'infer',  cls: 'pill-infer'  },
    { label: 'exec',   cls: 'pill-exec'   },
  ];

  get totalEnabled(): number { return this.pipelines.filter((p) => p.enabled).length; }
  get runsToday(): number { return 0; }
  get failures(): number {
    return this.pipelines.filter((p) => p.last_run?.status === 'failed').length;
  }

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.svc.getPipelines().subscribe({
      next: (ps) => { this.pipelines = ps; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  openEditor(pipeline?: PipelineListItem): void {
    const ref = this.dialog.open(PipelineEditorDialogComponent, {
      // The board + rail + drawer needs the width; below 600px the global
      // full-bleed rules take over and the drawer becomes a bottom sheet.
      width: '1040px',
      maxWidth: '96vw',
      height: '760px',
      maxHeight: '92vh',
      panelClass: ['glass-dialog', 'pipeline-editor-dialog'],
      data: { pipelineId: pipeline?.id ?? null },
    });
    ref.afterClosed().subscribe((saved) => { if (saved) this.load(); });
  }

  openSimulate(pipeline: PipelineListItem): void {
    this.dialog.open(PipelineSimulateDialogComponent, {
      width: '540px',
      maxHeight: '90vh',
      panelClass: 'glass-dialog',
      data: { pipelineId: pipeline.id, pipelineName: pipeline.name },
    });
  }

  toggleEnabled(pipeline: PipelineListItem): void {
    this.svc.togglePipeline(pipeline.id, !pipeline.enabled).subscribe({
      next: () => { pipeline.enabled = !pipeline.enabled; },
      error: () => this.snack.open('Failed to toggle pipeline', 'Dismiss', { duration: 3000 }),
    });
  }

  triggerRun(pipeline: PipelineListItem): void {
    this.svc.triggerRun(pipeline.id).subscribe({
      next: () => this.snack.open('Pipeline run queued', undefined, { duration: 2000 }),
      error: () => this.snack.open('Failed to trigger run', 'Dismiss', { duration: 3000 }),
    });
  }

  toggleHistory(id: number): void {
    this.expandedRunHistory = this.expandedRunHistory === id ? null : id;
  }

  delete(pipeline: PipelineListItem): void {
    if (!confirm(`Delete pipeline "${pipeline.name}"?`)) return;
    this.svc.deletePipeline(pipeline.id).subscribe({
      next: () => this.load(),
      error: () => this.snack.open('Failed to delete pipeline', 'Dismiss', { duration: 3000 }),
    });
  }

  statusColor(status: string | undefined): string {
    if (!status) return '';
    if (status === 'completed') return 'status-ok';
    if (status === 'failed') return 'status-err';
    if (status === 'running') return 'status-run';
    return 'status-q';
  }

  
}
