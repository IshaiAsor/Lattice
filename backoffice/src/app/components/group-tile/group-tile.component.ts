import { Component, inject, input, output } from '@angular/core';
import { ActionGroupView } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { iconForDeviceType } from 'src/app/utils/device-type.utils';
import { TileDensityService } from 'src/app/services/tile-density.service';

@Component({
  selector: 'app-group-tile',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './group-tile.component.html',
  styleUrl: './group-tile.component.css',
})
export class GroupTileComponent {
  private tiles = inject(TileDensityService);

  /**
   * Stamped as `data-density` for the same reason the action card does it: this tile shares the
   * grid's slot, so it has to shrink with it. Its icon grid was a fixed 56px cell with 20px of
   * padding, which needs 134px of tile — 30px more than a Compact tile has, so the icons were
   * simply cut off. Read from the attribute and not from `:root[data-density]`, which emulated
   * encapsulation never matches.
   */
  density = this.tiles.density;

  group = input.required<ActionGroupView>();
  expand = output<void>();
  rename = output<void>();
  ungroupAll = output<void>();

  iconForType = iconForDeviceType;
}
