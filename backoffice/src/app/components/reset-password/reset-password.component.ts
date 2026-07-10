import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SHARED_MATERIAL } from '../../shared-ui';
import { AuthService } from '../../services/auth.service';

// Complete a password reset from the emailed link (F15.9). On success the user is sent to
// login to sign in fresh — no auto-session, so a leaked link can't also grant access.
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [SHARED_MATERIAL, RouterLink],
  template: `
    <div class="auth-mini">
      <div class="auth-mini-card">
        @if (done()) {
          <mat-icon class="mini-icon">check_circle</mat-icon>
          <h2>Password updated</h2>
          <p>You can now sign in with your new password.</p>
          <a routerLink="/login" class="mini-link">Go to sign in</a>
        } @else {
          <mat-icon class="mini-icon">password</mat-icon>
          <h2>Set a new password</h2>
          <form (ngSubmit)="submit()">
            @if (error()) { <div class="mini-error">{{ error() }}</div> }
            <div class="mini-input">
              <mat-icon>lock</mat-icon>
              <input type="password" name="pw" [(ngModel)]="password" placeholder="New password (min 8 chars)" required />
            </div>
            <div class="mini-input">
              <mat-icon>lock_reset</mat-icon>
              <input type="password" name="pw2" [(ngModel)]="confirm" placeholder="Confirm new password" required />
            </div>
            <button type="submit" class="mini-btn" [disabled]="submitting">Update password</button>
          </form>
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
      h2 { margin: 12px 0 16px; }
      .mini-input { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
      .mini-input mat-icon { color: var(--text-muted); }
      .mini-input input { border: none; outline: none; background: transparent; flex: 1; color: var(--text); font-size: 0.95rem; }
      .mini-btn { width: 100%; padding: 11px; border: none; border-radius: 10px; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; }
      .mini-btn:disabled { opacity: 0.6; cursor: default; }
      .mini-error { background: rgba(229, 72, 77, 0.12); color: #e5484d; padding: 8px 10px; border-radius: 8px; margin-bottom: 12px; font-size: 0.85rem; }
      .mini-link { display: inline-block; margin-top: 16px; color: var(--primary); font-weight: 600; }
    `,
  ],
})
export class ResetPasswordComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private auth = inject(AuthService);

  private token = '';
  password = '';
  confirm = '';
  submitting = false;
  error = signal('');
  done = signal(false);

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!this.token) this.error.set('This reset link is missing its token.');
  }

  submit(): void {
    this.error.set('');
    if (this.password.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    if (this.password !== this.confirm) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.submitting = true;
    this.auth.resetPassword(this.token, this.password).subscribe({
      next: () => {
        this.submitting = false;
        this.done.set(true);
      },
      error: (err) => {
        this.submitting = false;
        this.error.set(
          (err as { error?: { error?: string } })?.error?.error ||
            'This reset link is invalid or has expired.',
        );
      },
    });
  }
}
