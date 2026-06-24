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

    this.authService.register(this.username, this.email, this.password, this.termsAccepted).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.error = (err as { error?: { message?: string } })?.error?.message || 'Registration failed. Please try again.';
      },
    });
  }
}
