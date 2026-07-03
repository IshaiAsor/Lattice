import { Component, inject, Input, OnInit, OnChanges } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { PipelinesService, PipelineRunSummary, PipelineRunDetail } from 'src/app/services/pipelines.service';
import {
  stageJson,
  inferPrompt as inferPromptUtil,
  inferView as inferViewUtil,
  formatMs as formatMsUtil,
  isDryRunStage as isDryRunStageUtil,
  wouldExecute as wouldExecuteUtil,
  stageError as stageErrorUtil,
} from '../pipeline-stage-view.util';

@Component({
  selector: 'app-pipeline-run-history',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './pipeline-run-history.component.html',
  styleUrl: './pipeline-run-history.component.css',
})
export class PipelineRunHistoryComponent implements OnInit, OnChanges {
  @Input() pipelineId!: number;

  svc = inject(PipelinesService);
  snack = inject(MatSnackBar);

  runs: PipelineRunSummary[] = [];
  expandedRun: PipelineRunDetail | null = null;
  expandedRunId: number | null = null;
  loading = false;

  ngOnInit(): void { this.load(); }
  ngOnChanges(): void { this.load(); }

  load(): void {
    if (!this.pipelineId) return;
    this.loading = true;
    this.svc.getRuns(this.pipelineId, 10).subscribe({
      next: (runs) => { this.runs = runs; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  toggleRun(run: PipelineRunSummary): void {
    if (this.expandedRunId === run.id) {
      this.expandedRunId = null;
      this.expandedRun = null;
      return;
    }
    this.expandedRunId = run.id;
    this.expandedRun = null;
    this.svc.getRun(this.pipelineId, run.id).subscribe((detail) => {
      this.expandedRun = detail;
    });
  }

  canCancel(run: PipelineRunSummary): boolean {
    return run.status === 'queued' || run.status === 'running';
  }

  cancelRun(run: PipelineRunSummary, event: Event): void {
    event.stopPropagation();
    this.svc.cancelRun(this.pipelineId, run.id).subscribe({
      next: () => this.load(),
      error: () => this.snack.open('Failed to cancel run', 'Dismiss', { duration: 3000 }),
    });
  }

  deleteRun(run: PipelineRunSummary, event: Event): void {
    event.stopPropagation();
    if (!confirm('Delete this run from history?')) return;
    this.svc.deleteRun(this.pipelineId, run.id).subscribe({
      next: () => {
        if (this.expandedRunId === run.id) {
          this.expandedRunId = null;
          this.expandedRun = null;
        }
        this.load();
      },
      error: () => this.snack.open('Failed to delete run', 'Dismiss', { duration: 3000 }),
    });
  }

  statusClass(status: string): string {
    if (status === 'completed') return 'status-ok';
    if (status === 'failed') return 'status-err';
    if (status === 'running') return 'status-run';
    return 'status-q';
  }

  duration(run: PipelineRunSummary): string {
    if (!run.completed_at) return '—';
    const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  stageOutput = stageJson;
  stageInput = stageJson;
  inferPrompt = inferPromptUtil;
  inferView = inferViewUtil;
  formatMs = formatMsUtil;
  isDryRunStage = isDryRunStageUtil;
  wouldExecute = wouldExecuteUtil;
  stageError = stageErrorUtil;
}
