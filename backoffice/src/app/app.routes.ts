import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { LegalComponent } from './components/legal/legal.component';
import { MgmtDeviceListComponent } from './components/mgmt-device-list/mgmt-device-list.component';
import { UserDashboard } from './components/user-dashboard/user-dashboard';
import { AdminDeviceConfigComponent } from './components/admin-device-config/admin-device-config.component';
import { DeviceConfigComponent } from './components/device-config/device-config.component';
import { AutomationsComponent } from './components/automations/automations.component';

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
    redirectTo: '/automations?tab=rules',
    pathMatch: 'full',
  },
  {
    path: 'automations',
    component: AutomationsComponent,
    canActivate: [authGuard],
  },
  {
    path: 'device-config',
    component: DeviceConfigComponent,
    canActivate: [authGuard],
  },
  {
    path: 'admin/templates',
    component: AdminDeviceConfigComponent,
    canActivate: [authGuard, adminGuard],
  },
  { path: 'login', component: LoginComponent, data: { hideSidebar: true } },
  { path: 'register', component: RegisterComponent, data: { hideSidebar: true } },
  { path: 'legal', component: LegalComponent, data: { hideSidebar: true } },
  { path: '**', redirectTo: '/dashboard' },
];
