import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SHARED_MATERIAL } from '../../shared-ui';
import { AuthService } from '../../services/auth.service';

// Request a password-reset email (F15.9). The response is always success — we never reveal
// whether the address has an account.
@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [SHARED_MATERIAL, RouterLink],
  template: `
    <div class="auth-mini">
      <div class="auth-mini-card">
        @if (!sent) {
          <mat-icon class="mini-icon">lock_reset</mat-icon>
          <h2>Reset your password</h2>
          <p>Enter your account email and we'll send you a reset link.</p>
          <form (ngSubmit)="submit()">
            <div class="mini-input">
              <mat-icon>email</mat-icon>
              <input type="email" name="email" [(ngModel)]="email" placeholder="you@example.com" required />
            </div>
            <button type="submit" class="mini-btn" [disabled]="!email || submitting">Send reset link</button>
          </form>
          <a routerLink="/login" class="mini-link">Back to sign in</a>
        } @else {
          <mat-icon class="mini-icon">mark_email_read</mat-icon>
          <h2>Check your inbox</h2>
          <p>If an account exists for <strong>{{ email }}</strong>, a reset link is on its way.</p>
          <a routerLink="/login" class="mini-link">Back to sign in</a>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .auth-mini { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .auth-mini-card { text-align: center; max-width: 360px; width: 100%; }
      .mini-icon { font-size: 48px; width: 48px; height: 48px; color: var(--primary); }
      h2 { margin: 12px 0 6px; }
      p { color: var(--text-dim); margin-bottom: 20px; }
      .mini-input { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
      .mini-input mat-icon { color: var(--text-muted); }
      .mini-input input { border: none; outline: none; background: transparent; flex: 1; color: var(--text); font-size: 0.95rem; }
      .mini-btn { width: 100%; padding: 11px; border: none; border-radius: 10px; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; }
      .mini-btn:disabled { opacity: 0.6; cursor: default; }
      .mini-link { display: inline-block; margin-top: 16px; color: var(--primary); font-weight: 600; }
    `,
  ],
})
export class ForgotPasswordComponent {
  private auth = inject(AuthService);
  email = '';
  submitting = false;
  sent = false;

  submit(): void {
    if (!this.email) return;
    this.submitting = true;
    this.auth.forgotPassword(this.email).subscribe({
      next: () => {
        this.submitting = false;
        this.sent = true;
      },
      // Still show success — never leak whether the account exists.
      error: () => {
        this.submitting = false;
        this.sent = true;
      },
    });
  }
}
