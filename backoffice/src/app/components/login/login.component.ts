import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { HttpClient } from '@angular/common/http';
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
  private apiUrl = `${environment.apiUrl}`;

  private authService = inject(AuthService);
  private router = inject(Router);
  private http = inject(HttpClient);

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
    this.authService.loginWithUserPass(this.username, this.password).subscribe({
      next: () => this.loginSuccess(),
      error: (err) => {
        this.error = (err as { error?: { message?: string } })?.error?.message || 'Invalid username or password.';
        console.error('Login error:', err);
      },
    });
  }

  loginSuccess() {
    this.router.navigate(['/dashboard']);
  }
}
