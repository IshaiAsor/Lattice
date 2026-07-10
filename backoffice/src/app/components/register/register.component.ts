import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [SHARED_MATERIAL, RouterLink],
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.css'],
})
export class RegisterComponent {
  username = '';
  email = '';
  password = '';
  confirmPassword = '';
  termsAccepted = false;
  error = '';
  submitting = false;

  // Post-submit: registration returns pendingVerification instead of a session, so we show a
  // "check your inbox" panel with a resend option (F15.8).
  pendingVerification = false;
  resendState: 'idle' | 'sent' = 'idle';

  private authService = inject(AuthService);
  private router = inject(Router);

  onSubmit() {
    this.error = '';

    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }

    if (!this.termsAccepted) {
      this.error = 'You must accept the Terms of Service to register.';
      return;
    }

    this.submitting = true;
    this.authService.register(this.username, this.email, this.password, this.termsAccepted).subscribe({
      next: () => {
        this.submitting = false;
        this.pendingVerification = true;
      },
      error: (err) => {
        this.submitting = false;
        this.error =
          (err as { error?: { error?: string } })?.error?.error ||
          'Registration failed. Please try again.';
      },
    });
  }

  resend() {
    this.authService.resendVerification(this.email).subscribe({
      next: () => (this.resendState = 'sent'),
      error: () => (this.resendState = 'sent'),
    });
  }

  goToLogin() {
    this.router.navigate(['/login']);
  }
}
