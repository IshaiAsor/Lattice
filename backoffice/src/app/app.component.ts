import { Component, inject, signal, OnInit } from '@angular/core';
import { RouterModule, Router, NavigationEnd, ActivatedRoute } from '@angular/router';
import { UpperCasePipe } from '@angular/common';
import { filter } from 'rxjs/operators';
import { SHARED_MATERIAL } from './shared-ui';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { ChatComponent } from './components/chat.component/chat.component';
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
