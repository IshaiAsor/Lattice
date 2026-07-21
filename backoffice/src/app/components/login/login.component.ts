import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { AuthService } from '../../services/auth.service';
import { GoogleLinkService } from '../../services/google-link.service';
import { TermsConsentDialogComponent } from '../terms-consent-dialog/terms-consent-dialog.component';
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
  // Undefined until the config fetch + GSI script both land (see initGoogleClient).
  googleClient?: { requestCode: () => void };
  username = '';
  password = '';
  error = '';
  rememberMe = true;

  // Set when login is blocked because the email isn't verified (F15.8) — the template then
  // offers to resend the verification email to this address.
  unverifiedEmail = '';
  resendState: 'idle' | 'sent' = 'idle';

  // Google Home account linking: google-home redirects here with ?google_link=<requestId> instead
  // of rendering its own login form. When set, a successful sign-in finishes the OAuth handshake
  // rather than landing on the dashboard.
  googleLinkRequest = '';
  linking = false;

  private authService = inject(AuthService);
  private googleLinkService = inject(GoogleLinkService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private dialog = inject(MatDialog);

  ngOnInit() {
    // Subscribe rather than read the snapshot: useAnotherAccount() re-navigates to this same
    // route, which reuses the component and would leave a snapshot-read value stale.
    this.route.queryParamMap.subscribe((params) => {
      this.googleLinkRequest = params.get('google_link') ?? '';
    });

    // The client id is per-environment (staging and prod have their own OAuth client) and the
    // bundle is environment-agnostic, so it comes from the API rather than environment.ts.
    this.authService.getAuthConfig().subscribe({
      next: (config) => this.initGoogleClient(config.googleClientId),
      error: (err) => console.error('Failed to load Google auth config', err),
    });
  }

  // Signed-in user to offer the link to, if any — the linking flow shows a "continue as" step
  // instead of the credential form so an existing session doesn't force a re-login.
  get linkedUsername(): string | null {
    if (!this.googleLinkRequest || !this.authService.isLoggedIn()) return null;
    const user = this.authService.getCurrentUser();
    return user?.username || user?.email || 'Your account';
  }

  // Hand the (now authenticated) session back to google-home, which mints the OAuth code and
  // gives us the Google redirect to bounce to.
  completeGoogleLink() {
    this.error = '';
    this.linking = true;
    this.googleLinkService.authorize(this.googleLinkRequest).subscribe({
      next: ({ redirectUrl }) => (window.location.href = redirectUrl),
      error: (err) => {
        this.linking = false;
        this.error =
          (err as { status?: number })?.status === 410
            ? 'This linking request expired. Start again from the Google Home app.'
            : 'Could not link your account to Google Home. Please try again.';
        console.error('Google Home link error:', err);
      },
    });
  }

  // Sign out but stay in the linking flow, so the user can link a different account.
  useAnotherAccount() {
    this.authService.logout();
    this.router.navigate(['/login'], { queryParams: { google_link: this.googleLinkRequest } });
  }

  private initGoogleClient(clientId: string, attempt = 0) {
    // index.html loads the GSI script async, so it may not have landed yet. Poll briefly instead
    // of hooking window.onload — that can have fired already, and it clobbers other handlers.
    // @ts-expect-error google is loaded via script tag
    if (typeof google === 'undefined') {
      if (attempt >= 50) {
        console.error('Google identity script failed to load');
        return;
      }
      setTimeout(() => this.initGoogleClient(clientId, attempt + 1), 100);
      return;
    }

    // @ts-expect-error google is loaded via script tag
    this.googleClient = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: 'openid email profile',
      ux_mode: 'popup',
      callback: (response: GoogleOAuthResponse) => this.handleAuthCode(response),
    });
  }

  handleAuthCode(response: GoogleOAuthResponse) {
    if (response.error) {
      this.error = 'Google authentication was cancelled or failed.';
      console.error('Google login failed', response.error);
      return;
    }

    this.authService.loginWithGoogle(response.code, this.rememberMe).subscribe({
      next: (result) => {
        // Brand-new Google user: capture Terms consent before the account is created.
        if ('pendingConsent' in result) {
          this.promptTermsConsent(result.signupToken);
          return;
        }
        this.loginSuccess();
      },
      error: (err) => {
        this.error = (err as { error?: { message?: string } })?.error?.message || 'Google login failed. Please try again.';
        console.error('Google login error:', err);
      },
    });
  }

  private promptTermsConsent(signupToken: string) {
    this.dialog
      .open(TermsConsentDialogComponent, {
        width: '380px',
        // Match the app's dialogs: glass surface + compact-dialog anchors it as a content-sized
        // bottom sheet on phones instead of a full-height centered box.
        panelClass: ['glass-dialog', 'compact-dialog'],
      })
      .afterClosed()
      .subscribe((accepted) => {
        if (!accepted) return;
        this.authService.completeGoogleSignup(signupToken, this.rememberMe).subscribe({
          next: () => this.loginSuccess(),
          error: (err) => {
            this.error =
              (err as { error?: { error?: string } })?.error?.error ||
              'Google sign-up failed. Please try again.';
            console.error('Google sign-up error:', err);
          },
        });
      });
  }

  loginWithGoogle() {
    if (!this.googleClient) {
      this.error = 'Google sign-in is not available right now. Please try again in a moment.';
      return;
    }
    this.googleClient.requestCode();
  }

  onSubmit() {
    this.error = '';
    this.unverifiedEmail = '';
    this.resendState = 'idle';
    this.authService.loginWithUserPass(this.username, this.password, this.rememberMe).subscribe({
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
    if (this.googleLinkRequest) {
      this.completeGoogleLink();
      return;
    }
    this.router.navigate(['/dashboard']);
  }
}
