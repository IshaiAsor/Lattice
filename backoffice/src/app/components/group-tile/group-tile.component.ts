import { Component, input, output } from '@angular/core';
import { ActionGroupView } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { iconForDeviceType } from 'src/app/utils/device-type.utils';

@Component({
  selector: 'app-group-tile',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './group-tile.component.html',
  styleUrl: './group-tile.component.css',
})
export class GroupTileComponent {
  group = input.required<ActionGroupView>();
  expand = output<void>();
  rename = output<void>();
  ungroupAll = output<void>();

  iconForType = iconForDeviceType;
}
