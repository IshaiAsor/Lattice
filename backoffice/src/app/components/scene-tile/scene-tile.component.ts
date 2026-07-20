import { Component, input, output } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { SceneView } from 'src/app/services/scenes.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

// Tap-to-run tile. Presentational only — the dashboard owns the execute call, matching
// GroupTileComponent. `running` drives the brief in-flight state after a tap.
@Component({
  selector: 'app-scene-tile',
  standalone: true,
  imports: [...SHARED_MATERIAL, MatProgressSpinnerModule],
  templateUrl: './scene-tile.component.html',
  styleUrl: './scene-tile.component.css',
})
export class SceneTileComponent {
  scene = input.required<SceneView>();
  running = input<boolean>(false);
  execute = output<void>();
  edit = output<void>();
  remove = output<void>();
}
