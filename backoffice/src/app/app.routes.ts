import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { LoginComponent } from './components/login/login.component';
import { RegisterComponent } from './components/register/register.component';
import { LegalComponent } from './components/legal/legal.component';
import { UserDashboard } from './components/user-dashboard/user-dashboard';
import { AdminDeviceConfigComponent } from './components/admin-device-config/admin-device-config.component';
import { SealedTemplatesComponent } from './components/sealed-templates/sealed-templates.component';
import { AdminBlueprintsComponent } from './components/admin-blueprints/admin-blueprints.component';
import { BlueprintsComponent } from './components/blueprints/blueprints.component';
import { BlueprintInstanceComponent } from './components/blueprint-instance/blueprint-instance.component';
import { DeviceConfigComponent } from './components/device-config/device-config.component';
import { AutomationsComponent } from './components/automations/automations.component';
import { NotificationsComponent } from './components/notifications/notifications.component';
import { UserSettingsComponent } from './components/user-settings/user-settings.component';
import { AdminRetentionComponent } from './components/admin-retention/admin-retention.component';
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
    // Same component — the id in the URL is which device is selected, so a refresh or a shared
    // link reopens it. Reuses the component instance (only the param changes).
    path: 'devices/:id',
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
    path: 'blueprints',
    component: BlueprintsComponent,
    canActivate: [authGuard],
  },
  {
    // Declared after the list route; Angular matches in order, so the static path wins.
    path: 'blueprints/:id',
    component: BlueprintInstanceComponent,
    canActivate: [authGuard],
  },
  {
    path: 'notifications',
    component: NotificationsComponent,
    canActivate: [authGuard],
  },
  {
    // F5.10 shell, scoped to Data & storage: a user's own retention window plus their usage.
    path: 'settings',
    component: UserSettingsComponent,
    canActivate: [authGuard],
  },
  {
    path: 'admin/templates',
    component: AdminDeviceConfigComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    // Same component — the id in the URL is which device type is selected, so a refresh reopens it.
    path: 'admin/templates/:id',
    component: AdminDeviceConfigComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    path: 'admin/sealed-templates',
    component: SealedTemplatesComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    // Same component — the id in the URL is which sealed template is open, so a refresh reopens it.
    path: 'admin/sealed-templates/:id',
    component: SealedTemplatesComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    path: 'admin/blueprints',
    component: AdminBlueprintsComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    // Platform defaults + the ceiling users may not exceed. A user's own window is /settings.
    path: 'admin/retention',
    component: AdminRetentionComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    // Same component — the id in the URL is which blueprint is open, so a refresh or a shared
    // link reopens it. Reuses the component instance (only the param changes).
    path: 'admin/blueprints/:id',
    component: AdminBlueprintsComponent,
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
