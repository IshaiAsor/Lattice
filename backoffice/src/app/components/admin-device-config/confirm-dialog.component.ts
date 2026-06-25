import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

export interface ConfirmDialogData {
  title: string;
  message: string;
  confirmLabel?: string;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <div class="sheet-handle"></div>
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p class="message">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="warn" (click)="confirm()">
        {{ data.confirmLabel ?? 'Delete' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .sheet-handle {
      width: 36px; height: 4px;
      background: var(--border-strong, #ccc);
      border-radius: 2px;
      margin: 12px auto 0;
    }
    .message { margin: 0; font-size: 14px; color: var(--text-muted); line-height: 1.5; }
  `],
})
export class ConfirmDialogComponent {
  data: ConfirmDialogData = inject(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<ConfirmDialogComponent>);

  confirm() { this.dialogRef.close(true); }
}
