import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable } from 'rxjs';
import { DeviceMgmtService } from './device.mgmt.service';
import { UserActionsService } from './user.actions.service';
import { UserRulesService } from './user.rules.service';
import { EmergencyService } from './emergency.service';
import { PipelineService } from './pipeline.service';
import { CatalogService } from './catalog.service';
import { BlueprintService } from './blueprint.service';
import { downloadJson } from 'src/app/utils/import-export.utils';

@Injectable({ providedIn: 'root' })
export class ExportService {
  private devices   = inject(DeviceMgmtService);
  private actions   = inject(UserActionsService);
  private rules     = inject(UserRulesService);
  private emergency = inject(EmergencyService);
  private pipelines = inject(PipelineService);
  private catalog   = inject(CatalogService);
  private blueprints = inject(BlueprintService);

  exportUserConfig(): Observable<void> {
    return forkJoin({
      devices:         this.devices.getDevices(),
      actions:         this.actions.getUserActions(),
      groups:          this.actions.getGroups(),
      rules:           this.rules.getRules(),
      emergency_rules: this.emergency.getRules(),
      pipelines:       this.pipelines.list(),
    }).pipe(
      map(data => {
        downloadJson('lattice-user-config.json', {
          version:     '1',
          exported_at: new Date().toISOString(),
          user_config: data,
        });
      }),
    );
  }

  exportSystemConfig(): Observable<void> {
    return forkJoin({
      models:     this.catalog.getModels(),
      ml_models:  this.catalog.getMlModels(),
      blueprints: this.blueprints.listAll(),
    }).pipe(
      map(data => {
        downloadJson('lattice-system-config.json', {
          version:     '1',
          exported_at: new Date().toISOString(),
          system_config: {
            catalog:    { models: data.models, ml_models: data.ml_models },
            blueprints: data.blueprints,
          },
        });
      }),
    );
  }
}
