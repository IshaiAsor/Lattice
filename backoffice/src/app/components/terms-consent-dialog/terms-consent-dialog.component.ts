import { Component, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

// Shown the first time someone signs in with Google (brand-new account). Google has already
// verified their identity; this only captures Terms of Service consent before the account is
// created. Closing with `true` completes signup, anything else cancels it.
@Component({
  selector: 'app-terms-consent-dialog',
  imports: [SHARED_MATERIAL, RouterLink],
  template: `
    <div class="sheet-handle"></div>
    <h2 mat-dialog-title>One more step</h2>
    <mat-dialog-content>
      <p class="message">
        To finish creating your Lattice account, please confirm you've read and agree to our
        <a routerLink="/legal" target="_blank">Terms of Service</a>.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" (click)="accept()">Agree &amp; continue</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .sheet-handle {
        width: 36px;
        height: 4px;
        background: var(--border-strong, #ccc);
        border-radius: 2px;
        margin: 12px auto 0;
      }
      .message {
        margin: 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.5;
      }
    `,
  ],
})
export class TermsConsentDialogComponent {
  private dialogRef = inject(MatDialogRef<TermsConsentDialogComponent>);

  accept() {
    this.dialogRef.close(true);
  }
}
