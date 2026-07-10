import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environment } from 'src/environments/environment';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

interface GoogleOAuthResponse {
  code: string;
  error?: string;
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [SHARED_MATERIAL, RouterModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
})
export class LoginComponent implements OnInit {
  declare googleClient: { requestCode: () => void };
  username = '';
  password = '';
  error = '';
  termsAccepted = false;

  // Set when login is blocked because the email isn't verified (F15.8) — the template then
  // offers to resend the verification email to this address.
  unverifiedEmail = '';
  resendState: 'idle' | 'sent' = 'idle';

  private authService = inject(AuthService);
  private router = inject(Router);

  ngOnInit() {
    window.onload = () => {
      // @ts-expect-error google is loaded via script tag
      this.googleClient = google.accounts.oauth2.initCodeClient({
        client_id: environment.googleClientId,
        scope: 'openid email profile',
        ux_mode: 'popup',
        callback: (response: GoogleOAuthResponse) => this.handleAuthCode(response),
      });
    };
  }

  handleAuthCode(response: GoogleOAuthResponse) {
    if (response.error) {
      this.error = 'Google authentication was cancelled or failed.';
      console.error('Google login failed', response.error);
      return;
    }

    this.authService.loginWithGoogle(response.code, this.termsAccepted).subscribe({
      next: () => this.loginSuccess(),
      error: (err) => {
        this.error = (err as { error?: { message?: string } })?.error?.message || 'Google login failed. Please try again.';
        console.error('Google login error:', err);
      },
    });
  }

  loginWithGoogle() {
    this.googleClient.requestCode();
  }

  onSubmit() {
    this.error = '';
    this.unverifiedEmail = '';
    this.resendState = 'idle';
    this.authService.loginWithUserPass(this.username, this.password).subscribe({
      next: () => this.loginSuccess(),
      error: (err) => {
        const body = (err as { error?: { error?: string; email?: string } })?.error;
        if (body?.error === 'email_not_verified') {
          this.unverifiedEmail = body.email ?? '';
          this.error = 'Please verify your email address before signing in.';
        } else {
          this.error = body?.error || 'Invalid username or password.';
        }
        console.error('Login error:', err);
      },
    });
  }

  resendVerification() {
    const email = this.unverifiedEmail;
    if (!email) return;
    this.authService.resendVerification(email).subscribe({
      next: () => (this.resendState = 'sent'),
      error: () => (this.resendState = 'sent'),
    });
  }

  loginSuccess() {
    this.router.navigate(['/dashboard']);
  }
}
