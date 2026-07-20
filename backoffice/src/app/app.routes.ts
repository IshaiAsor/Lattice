import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { LegalComponent } from './components/legal/legal.component';
import { UserDashboard } from './components/user-dashboard/user-dashboard';
import { AdminDeviceConfigComponent } from './components/admin-device-config/admin-device-config.component';
import { SealedTemplatesComponent } from './components/sealed-templates/sealed-templates.component';
import { DeviceConfigComponent } from './components/device-config/device-config.component';
import { AutomationsComponent } from './components/automations/automations.component';
import { NotificationsComponent } from './components/notifications/notifications.component';
import { VerifyEmailComponent } from './components/verify-email/verify-email.component';
import { ForgotPasswordComponent } from './components/forgot-password/forgot-password.component';
import { ResetPasswordComponent } from './components/reset-password/reset-password.component';

export const routes: Routes = [
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  {
    // Devices and device config are one page now; keep the old paths working.
    path: 'mgmt/devices',
    redirectTo: '/devices',
    pathMatch: 'full',
  },
  {
    path: 'device-config',
    redirectTo: '/devices',
    pathMatch: 'full',
  },
  {
    path: 'devices',
    component: DeviceConfigComponent,
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
    path: 'notifications',
    component: NotificationsComponent,
    canActivate: [authGuard],
  },
  {
    path: 'admin/templates',
    component: AdminDeviceConfigComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    path: 'admin/sealed-templates',
    component: SealedTemplatesComponent,
    canActivate: [authGuard, adminGuard],
  },
  { path: 'login', component: LoginComponent, data: { hideSidebar: true } },
  { path: 'register', component: RegisterComponent, data: { hideSidebar: true } },
  { path: 'verify-email', component: VerifyEmailComponent, data: { hideSidebar: true } },
  { path: 'forgot-password', component: ForgotPasswordComponent, data: { hideSidebar: true } },
  { path: 'reset-password', component: ResetPasswordComponent, data: { hideSidebar: true } },
  { path: 'legal', component: LegalComponent, data: { hideSidebar: true } },
  { path: '**', redirectTo: '/dashboard' },
];
