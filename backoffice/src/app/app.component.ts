import { Component, inject } from '@angular/core';
import { RouterModule } from "@angular/router";   
import { SHARED_MATERIAL } from './shared-ui';
import { AuthService, User } from './services/auth.service';
@Component({
  imports: [RouterModule,SHARED_MATERIAL],
  standalone: true,
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  title = 'backoffice';
  authService = inject(AuthService);

  constructor() {
  }

  logout() {
    this.authService.logout();
  }
}
