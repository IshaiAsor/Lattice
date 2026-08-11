import { Component, inject, signal, OnInit } from '@angular/core';
import { RouterModule, Router, NavigationEnd, ActivatedRoute } from '@angular/router';
import { UpperCasePipe } from '@angular/common';
import { filter } from 'rxjs/operators';
import { SHARED_MATERIAL } from './shared-ui';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { NotificationsService } from './services/notifications.service';
import { UserPreferencesService } from './services/user-preferences.service';
import { ChatComponent } from './components/chat.component/chat.component';
import { TimezoneDialogComponent } from './components/timezone-dialog/timezone-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';

@Component({
  imports: [RouterModule, SHARED_MATERIAL, MatDividerModule, UpperCasePipe],
  standalone: true,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit {
  title = 'backoffice';
  authService = inject(AuthService);
  themeService = inject(ThemeService);
  notifications = inject(NotificationsService);
  prefs = inject(UserPreferencesService);
  dialog = inject(MatDialog);
  private router = inject(Router);
  private activatedRoute = inject(ActivatedRoute);

  hideSidebar = signal(false);
  sidebarCollapsed = signal(false);

  ngOnInit() {
    this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => {
      this.updateHideSidebar();
    });
    this.updateHideSidebar();
    // Prime the unread badge + wire live updates once a valid session is present. Use
    // isLoggedIn() (checks token expiry), not getCurrentUser(), so a stale "remember me" token
    // on the login page doesn't fire an authenticated request → 403.
    if (this.authService.isLoggedIn()) {
      this.notifications.refreshUnread();
      this.notifications.connectLive();
      // Schedules belong to the user's clock, and the browser is the only thing that knows what it
      // is. Sent once, when nothing is stored — so "local" is the default without anyone choosing.
      this.prefs.adoptBrowserTimeZone();
    }
  }

  openTimezone(): void {
    this.dialog.open(TimezoneDialogComponent, {
      width: '480px',
      maxHeight: '90vh',
      panelClass: 'compact-dialog',
    });
  }

  private updateHideSidebar() {
    let route = this.activatedRoute.firstChild;
    while (route?.firstChild) route = route.firstChild;
    this.hideSidebar.set(!!route?.snapshot.data['hideSidebar']);
  }

  toggleSidebar() {
    this.sidebarCollapsed.update(v => !v);
  }

  openAIEditor(): void {
    this.dialog.open(ChatComponent, {
      width: '640px',
      maxHeight: '90vh',
      panelClass: 'compact-dialog',
      data: { chatMode: 'free' },
    });
  }

  logout() {
    this.authService.logout();
  }
}
