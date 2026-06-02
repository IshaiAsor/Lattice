import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { LoginComponent } from './components/login/login.component';
import { MgmtDeviceListComponent } from './components/mgmt-device-list/mgmt-device-list.component';
import { UserDashboard } from './components/user-dashboard/user-dashboard';
import { RulesComponent } from './components/rules/rules.component';
import { AdminDeviceConfigComponent } from './components/admin-device-config/admin-device-config.component';

export const routes: Routes = [
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  {
    path: 'mgmt/devices',
    component: MgmtDeviceListComponent,
    canActivate: [authGuard],
  },
  {
    path: 'dashboard',
    component: UserDashboard,
    canActivate: [authGuard],
  },
  {
    path: 'rules',
    component: RulesComponent,
    canActivate: [authGuard],
  },
  {
    path: 'admin/device-config',
    component: AdminDeviceConfigComponent,
    canActivate: [authGuard, adminGuard],
  },
  { path: 'login', component: LoginComponent },
  { path: '**', redirectTo: '/dashboard' },
];