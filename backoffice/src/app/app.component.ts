import { Component, inject, signal } from '@angular/core';
import { RouterModule } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from './shared-ui';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { ExportService } from './services/export.service';

@Component({
  imports: [RouterModule, SHARED_MATERIAL],
  standalone: true,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent {
  authService  = inject(AuthService);
  themeService = inject(ThemeService);
  private exportSvc = inject(ExportService);
  private snack     = inject(MatSnackBar);

  drawerOpen = signal(false);

  toggleDrawer(): void { this.drawerOpen.set(!this.drawerOpen()); }
  closeDrawer(): void  { this.drawerOpen.set(false); }

  logout(): void {
    this.authService.logout();
    this.closeDrawer();
  }

  exportMyConfig(): void {
    this.exportSvc.exportUserConfig().subscribe({
      error: () => this.snack.open('Export failed', 'OK', { duration: 3000 }),
    });
  }

  exportSystemConfig(): void {
    this.exportSvc.exportSystemConfig().subscribe({
      error: () => this.snack.open('Export failed', 'OK', { duration: 3000 }),
    });
  }

  get isDark(): boolean { return this.themeService.theme() === 'dark'; }
}
