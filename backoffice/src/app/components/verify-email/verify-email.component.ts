import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { SHARED_MATERIAL } from '../../shared-ui';
import { AuthService } from '../../services/auth.service';

// Landing page for the verify-email link (F15.8): confirms the token, stores the returned
// session, and drops the user on the dashboard.
@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [SHARED_MATERIAL, RouterLink],
  template: `
    <div class="auth-mini">
      <div class="auth-mini-card">
        @if (state() === 'verifying') {
          <mat-icon class="mini-icon spin">progress_activity</mat-icon>
          <h2>Verifying your email…</h2>
        } @else if (state() === 'error') {
          <mat-icon class="mini-icon err">error_outline</mat-icon>
          <h2>Verification failed</h2>
          <p>{{ error() }}</p>
          <a routerLink="/login" class="mini-link">Back to sign in</a>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .auth-mini { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .auth-mini-card { text-align: center; max-width: 360px; }
      .mini-icon { font-size: 48px; width: 48px; height: 48px; color: var(--primary); }
      .mini-icon.err { color: #e5484d; }
      .spin { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      h2 { margin: 12px 0 6px; }
      p { color: var(--text-dim); }
      .mini-link { color: var(--primary); font-weight: 600; }
    `,
  ],
})
export class VerifyEmailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private auth = inject(AuthService);

  state = signal<'verifying' | 'error'>('verifying');
  error = signal('');

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!token) {
      this.state.set('error');
      this.error.set('This link is missing its verification token.');
      return;
    }
    this.auth.verifyEmail(token).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.state.set('error');
        this.error.set(
          (err as { error?: { error?: string } })?.error?.error ||
            'This verification link is invalid or has expired.',
        );
      },
    });
  }
}
