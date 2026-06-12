import { Component, input, output } from '@angular/core';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { iconForCapability } from 'src/app/utils/device-type.utils';
import type { DashboardGroup } from '../user-dashboard/user-dashboard';

@Component({
  selector: 'app-group-tile',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './group-tile.component.html',
  styleUrl: './group-tile.component.css',
})
export class GroupTileComponent {
  dashGroup   = input.required<DashboardGroup>();
  expand      = output<void>();
  rename      = output<void>();
  ungroupAll  = output<void>();

  iconForCapability = iconForCapability;

  get previewCaps(): (string | undefined)[] {
    return this.dashGroup().actions.slice(0, 4).map(a => a.action_def?.capability);
  }
}
