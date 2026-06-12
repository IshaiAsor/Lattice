import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import type { DeviceModel } from 'src/app/models';

@Component({
  selector: 'app-device-type-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Edit' : 'Add' }} Device Type</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="dialog-form">
        <mat-form-field appearance="outline">
          <mat-label>Model key (e.g. esp32s3_mini)</mat-label>
          <input matInput formControlName="model_key" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Version (e.g. 1.0)</mat-label>
          <input matInput formControlName="version" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Display name</mat-label>
          <input matInput formControlName="display_name" />
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" [disabled]="form.invalid" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  styles: [`.dialog-form { display: flex; flex-direction: column; gap: 8px; min-width: 320px; padding-top: 8px; }`],
})
export class DeviceTypeDialogComponent {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialogRef<DeviceTypeDialogComponent>);
  data: DeviceModel | null = inject(MAT_DIALOG_DATA);

  form = this.fb.group({
    model_key:    [this.data?.model_key    ?? '', Validators.required],
    version:      [this.data?.version      ?? '', Validators.required],
    display_name: [this.data?.display_name ?? '', Validators.required],
  });

  save() {
    if (this.form.valid) {
      this.dialogRef.close(this.form.value);
    }
  }
}
