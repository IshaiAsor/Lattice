import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
// import * as google from 'google-one-tap';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
})
export class LoginComponent implements OnInit {
  declare googleClient: any;
  username = '';
  password = '';
  error = '';
  private apiUrl = `${environment.apiUrl}`;

  constructor(
    private authService: AuthService,
    private router: Router,
    private http: HttpClient,
  ) {}
  ngOnInit() {
    window.onload = () => {
      // @ts-ignore
      this.googleClient = google.accounts.oauth2.initCodeClient({
        client_id: environment.googleClientId,
        scope: 'openid email profile', // Add more scopes here if you need Google APIs
        ux_mode: 'popup',
        callback: (response: any) => this.handleAuthCode(response),
      });
    };
  }

  handleAuthCode(response: any) {
    if (response.error) {
      this.error = 'Google authentication was cancelled or failed.';
      console.error('Google login failed', response.error);
      return;
    }

    this.authService.loginWithGoogle(response.code).subscribe({
      next: () => this.loginSuccess(),
      error: (err) => {
        this.error = err?.error?.message || 'Google login failed. Please try again.';
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
        this.error = err?.error?.message || 'Invalid username or password.';
        console.error('Login error:', err);
      },
    });
  }

  loginSuccess() {
    this.router.navigate(['/devices']);
  }
}
