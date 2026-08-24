import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import {
  TileDensityService,
  DENSITIES,
  type Density,
  type TileFields,
} from '../../services/tile-density.service';

/**
 * The Display picker's contents, extracted so the menu (desktop) and the bottom sheet (mobile)
 * render exactly the same thing rather than two copies that drift.
 *
 * `MatBottomSheetRef` is optional: when this is inside a menu there is no sheet to close, and
 * injecting it unconditionally would throw.
 */
@Component({
  selector: 'app-display-panel',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatSlideToggleModule],
  template: `
    <div class="dp-panel" [class.as-sheet]="sheetRef !== null">
      @if (sheetRef !== null) {
        <div class="dp-grip"></div>
      }

      <div class="dp-label">Tile size</div>
      <div class="dp-list">
        @for (d of densities; track d.key) {
          <button
            type="button"
            class="dp-option"
            [class.on]="density() === d.key"
            (click)="pick(d.key)"
          >
            <mat-icon class="dp-check">{{ density() === d.key ? 'check' : '' }}</mat-icon>
            <span class="dp-option-text">
              <span class="dp-option-name">{{ d.label }}</span>
              <span class="dp-option-desc">{{ d.description }}</span>
            </span>
            <span class="dp-option-size">{{ size(d) }}</span>
          </button>
        }
      </div>

      <div class="dp-divider"></div>
      <div class="dp-label">Show on every tile</div>
      @for (f of fieldRows; track f.key) {
        <div class="dp-field">
          <span>{{ f.label }}</span>
          <mat-slide-toggle
            [checked]="fields()[f.key]"
            (change)="toggle(f.key)"
          ></mat-slide-toggle>
        </div>
      }

      @if (sheetRef !== null) {
        <button type="button" class="dp-done" (click)="close()">Done</button>
      }
    </div>
  `,
  styleUrls: ['./display-panel.component.css'],
})
export class DisplayPanelComponent {
  private tiles = inject(TileDensityService);
  /** Null when rendered inside the desktop menu. */
  sheetRef = inject(MatBottomSheetRef<DisplayPanelComponent>, { optional: true });

  readonly densities = DENSITIES;
  density = this.tiles.density;
  fields = this.tiles.fields;

  readonly fieldRows: { key: keyof TileFields; label: string }[] = [
    { key: 'sparkline', label: 'Sparkline' },
    { key: 'chart', label: 'Full chart' },
    { key: 'lastCommand', label: 'Last command' },
    { key: 'deviceName', label: 'Device name' },
  ];

  pick(d: Density): void {
    this.tiles.applyDensity(d);
  }

  toggle(key: keyof TileFields): void {
    this.tiles.toggleField(key);
  }

  close(): void {
    this.sheetRef?.dismiss();
  }

  size(d: (typeof DENSITIES)[number]): string {
    return d.fullWidth ? 'full width' : `${d.width} × ${d.height}`;
  }
}
