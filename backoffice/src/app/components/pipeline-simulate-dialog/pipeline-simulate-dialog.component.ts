import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Subscription } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  PipelinesService, PipelineDetail, PipelineRunDetail,
  ValidParameters, RangeConstraint, EnumConstraint,
} from 'src/app/services/pipelines.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import {
  stageJson,
  inferPrompt as inferPromptUtil,
  inferView as inferViewUtil,
  formatMs as formatMsUtil,
  isDryRunStage as isDryRunStageUtil,
  wouldExecute as wouldExecuteUtil,
  stageError as stageErrorUtil,
} from '../pipeline-stage-view.util';

type PipelineSensorView = PipelineDetail['sensors'][number];

@Component({
  selector: 'app-pipeline-simulate-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './pipeline-simulate-dialog.component.html',
  styleUrl: './pipeline-simulate-dialog.component.css',
})
export class PipelineSimulateDialogComponent implements OnInit, OnDestroy {
  svc    = inject(PipelinesService);
  socket = inject(DeviceSocketService);
  ref    = inject(MatDialogRef<PipelineSimulateDialogComponent>);
  data: { pipelineId: number; pipelineName: string } = inject(MAT_DIALOG_DATA);

  pipeline: PipelineDetail | null = null;
  sensorValues: Record<number, string> = {};
  imagePreview: Record<number, string> = {};
  imageFileName: Record<number, string> = {};
  step: 'input' | 'running' | 'result' = 'input';
  runResult: PipelineRunDetail | null = null;
  error: string | null = null;

  private runSub: Subscription | null = null;
  private currentRunId: number | null = null;

  get simSensors(): PipelineSensorView[] {
    return this.pipeline?.sensors.filter((s) => s.inject_as_sensor) ?? [];
  }

  get hasImageSensor(): boolean {
    return this.simSensors.some((s) => s.is_image);
  }

  get canRun(): boolean {
    return this.simSensors.every((s) => this.isValueValid(s));
  }

  ngOnInit(): void {
    this.svc.getPipeline(this.data.pipelineId).subscribe({
      next: (p) => {
        this.pipeline = p;
        p.sensors.filter((s) => s.inject_as_sensor).forEach((s) => (this.sensorValues[s.user_device_action_id] = ''));
      },
    });
  }

  ngOnDestroy(): void { this.runSub?.unsubscribe(); }

  sensorKind(s: PipelineSensorView): 'image' | 'enum' | 'range' | 'text' {
    if (s.is_image) return 'image';
    if (s.valid_parameters?.type === 'enum') return 'enum';
    if (s.valid_parameters?.type === 'range') return 'range';
    return 'text';
  }

  enumConstraint(s: PipelineSensorView): EnumConstraint | null {
    return s.valid_parameters?.type === 'enum' ? s.valid_parameters : null;
  }

  rangeConstraint(s: PipelineSensorView): RangeConstraint | null {
    return s.valid_parameters?.type === 'range' ? s.valid_parameters : null;
  }

  isValueValid(s: PipelineSensorView): boolean {
    if (s.is_image) return true; // optional — falls back to the last stored camera frame
    const value = this.sensorValues[s.user_device_action_id];
    if (!value) return true; // optional — enrich treats a blank override as null
    return valueMatchesConstraint(value, s.valid_parameters);
  }

  // Real camera hardware only ever sends JPEG at modest resolution (CameraService.h pins
  // PIXFORMAT_JPEG, and none of this project's supported resolutions exceed XGA/1024px) — so
  // an uploaded file needs both format and size normalized here, or the simulated frame isn't
  // representative of what a real device would send. Format mismatches (WebP, PNG, HEIC...)
  // get silently tolerated by the ONNX/sharp VLM path but rejected by Ollama's stricter image
  // loader; oversized frames (e.g. a phone photo) inflate vision-token count enough to make
  // LLM inference take many times longer than it would for an actual camera frame.
  private static readonly MAX_SIM_IMAGE_DIMENSION = 1024;

  onFileSelected(event: Event, actionId: number): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.imageFileName[actionId] = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(
          1,
          PipelineSimulateDialogComponent.MAX_SIM_IMAGE_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
        );
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        this.imagePreview[actionId] = jpegDataUrl;
        this.sensorValues[actionId] = jpegDataUrl.slice(jpegDataUrl.indexOf(',') + 1);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  clearImage(actionId: number): void {
    delete this.imagePreview[actionId];
    delete this.imageFileName[actionId];
    this.sensorValues[actionId] = '';
  }

  run(): void {
    if (!this.canRun) {
      this.error = 'One or more sensor values are outside the allowed range/options.';
      return;
    }
    this.step = 'running';
    this.error = null;
    const overrides: Record<number, string> = {};
    for (const [k, v] of Object.entries(this.sensorValues)) {
      overrides[Number(k)] = v;
    }
    this.svc.dryRun(this.data.pipelineId, overrides).subscribe({
      next: ({ runId }) => {
        this.currentRunId = runId;
        this.waitForResult(runId);
      },
      error: (err) => {
        this.step = 'input';
        this.error = err?.error?.message ?? 'Simulation failed';
      },
    });
  }

  runAgain(): void {
    this.runSub?.unsubscribe();
    this.step = 'input';
    this.runResult = null;
    this.error = null;
  }

  private waitForResult(runId: number): void {
    this.runSub?.unsubscribe();
    this.runSub = this.socket.pipelineRunUpdate$.subscribe((evt) => {
      if (evt.runId !== runId) return;
      this.runSub?.unsubscribe();
      if (evt.status === 'failed') {
        this.step = 'input';
        this.error = evt.error ?? 'Simulation failed';
        return;
      }
      this.svc.getRun(this.data.pipelineId, runId).subscribe({
        next: (run) => { this.runResult = run; this.step = 'result'; },
      });
    });
  }

  stageOutput = stageJson;
  stageInput = stageJson;
  inferPrompt = inferPromptUtil;
  inferView = inferViewUtil;
  formatMs = formatMsUtil;
  isDryRunStage = isDryRunStageUtil;
  wouldExecute = wouldExecuteUtil;
  stageError = stageErrorUtil;

  sensorLabel(s: PipelineSensorView): string {
    return `${s.group_name} — ${s.user_device_action?.action_name ?? s.user_device_action_id}`;
  }
}

function valueMatchesConstraint(value: string, constraint: ValidParameters | undefined): boolean {
  if (!constraint) return true;
  if (constraint.type === 'enum') return constraint.values.includes(value);
  if (constraint.type === 'range') {
    if (constraint.aliases?.includes(value)) return true;
    const num = Number(value);
    return Number.isFinite(num) && num >= constraint.min && num <= constraint.max;
  }
  return true; // pattern constraints aren't enforced client-side — the server re-validates
}
