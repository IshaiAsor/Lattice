import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';
import { LoginComponent } from './components/login/login.component';
import { MgmtDeviceListComponent } from './components/mgmt-device-list/mgmt-device-list.component';
import { UserDashboard } from './components/user-dashboard/user-dashboard';
import { RulesComponent } from './components/rules/rules.component';
import { EmergencyComponent } from './components/emergency/emergency.component';
import { PipelinesComponent } from './components/pipelines/pipelines.component';
import { BlueprintGalleryComponent } from './components/blueprint-gallery/blueprint-gallery.component';
import { AdminDeviceConfigComponent } from './components/admin-device-config/admin-device-config.component';
import { BlueprintBuilderComponent } from './components/blueprint-builder/blueprint-builder.component';

export const routes: Routes = [
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  { path: 'dashboard',     component: UserDashboard,             canActivate: [authGuard] },
  { path: 'mgmt/devices',  component: MgmtDeviceListComponent,   canActivate: [authGuard] },
  { path: 'rules',         component: RulesComponent,            canActivate: [authGuard] },
  { path: 'emergency',     component: EmergencyComponent,        canActivate: [authGuard] },
  { path: 'pipelines',     component: PipelinesComponent,        canActivate: [authGuard] },
  { path: 'blueprints',    component: BlueprintGalleryComponent, canActivate: [authGuard] },
  { path: 'admin/catalog',     component: AdminDeviceConfigComponent, canActivate: [authGuard, adminGuard] },
  { path: 'admin/blueprints',  component: BlueprintBuilderComponent,  canActivate: [authGuard, adminGuard] },
  { path: 'login', component: LoginComponent },
  { path: '**', redirectTo: '/dashboard' },
];
