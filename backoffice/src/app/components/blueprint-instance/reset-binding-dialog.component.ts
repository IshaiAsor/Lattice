import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { ProfileOption } from 'src/app/services/blueprints.service';

// Resetting ONE bound device (F11.4). Two acts behind one button, because they are the same act
// from the user's side: the process this device was running has ended, and either it starts over
// on the same schedule or it starts something else.
//
// Offering the profile here rather than in a separate "change profile" screen is deliberate — a
// device's schedule is only safe to swap when its clock is being discarded anyway, which is exactly
// what reset does.

export interface ResetBindingDialogData {
  label: string;
  currentProfileKey: string | null;
  profiles: ProfileOption[];
}

/** The chosen profile, or null to keep the one it is on. */
export interface ResetBindingResult {
  profile_key: string | null;
}

@Component({
  selector: 'app-reset-binding-dialog',
  imports: [SHARED_MATERIAL],
  template: `
    <h2 mat-dialog-title>Reset “{{ data.label }}”</h2>
    <mat-dialog-content>
      <p class="lead">
        It goes back to not started and the time counted in every phase is discarded. The device
        itself, and anything you tuned for it, are kept.
      </p>

      @if (data.profiles.length > 1) {
        <mat-form-field appearance="outline" class="full">
          <mat-label>Schedule from here</mat-label>
          <mat-select [(ngModel)]="profileKey" name="profileKey">
            @for (profile of data.profiles; track profile.key) {
              <mat-option [value]="profile.key">
                {{ profile.label }}
                @if (profile.key === data.currentProfileKey) {
                  <span class="muted">— current</span>
                }
              </mat-option>
            }
          </mat-select>
          <mat-hint>Pick a different one if this device is now running something else.</mat-hint>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-flat-button color="warn" (click)="confirm()">Reset</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .lead {
        margin: 0 0 1rem;
        opacity: 0.85;
      }
      .full {
        width: 100%;
      }
      .muted {
        opacity: 0.6;
        font-size: 0.85em;
      }
    `,
  ],
})
export class ResetBindingDialogComponent {
  data = inject<ResetBindingDialogData>(MAT_DIALOG_DATA);
  private dialogRef =
    inject<MatDialogRef<ResetBindingDialogComponent, ResetBindingResult>>(MatDialogRef);

  profileKey: string | null = this.data.currentProfileKey;

  confirm(): void {
    // Only send a profile when it actually changes — an unchanged one would still be a valid
    // request, but sending it makes the server log a re-profile that never happened.
    this.dialogRef.close({
      profile_key: this.profileKey === this.data.currentProfileKey ? null : this.profileKey,
    });
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
