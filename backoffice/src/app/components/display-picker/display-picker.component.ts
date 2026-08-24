import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { TileDensityService, DENSITIES } from '../../services/tile-density.service';
import { DisplayPanelComponent } from './display-panel.component';

// The Display picker: tile size, and how much each tile renders.
//
// Cheap to build because F21.1 already made tile geometry one set of custom properties — this just
// writes different values to them. Picking a size applies that size's sensible field defaults; the
// toggles below then let a viewer disagree, so size and content are not rigidly coupled.
//
// The panel itself lives in DisplayPanelComponent so the desktop menu and the mobile bottom sheet
// render one implementation rather than two that drift.
@Component({
  selector: 'app-display-picker',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatMenuModule, DisplayPanelComponent],
  templateUrl: './display-picker.component.html',
  styleUrls: ['./display-picker.component.css'],
})
export class DisplayPickerComponent {
  private tiles = inject(TileDensityService);
  private sheet = inject(MatBottomSheet);

  density = this.tiles.density;

  get currentLabel(): string {
    return DENSITIES.find((d) => d.key === this.density())?.label ?? 'Standard';
  }

  /**
   * On a phone, cancel the menu and open a bottom sheet instead.
   *
   * Evaluated per click rather than once at construction so a rotation or a resized window gets
   * the right shape — the breakpoint matches the one the dashboard's own CSS uses.
   */
  openSheetIfMobile(trigger: MatMenuTrigger, event: MouseEvent): void {
    if (!window.matchMedia('(max-width: 599px)').matches) return;
    event.stopPropagation();
    trigger.closeMenu();
    // autoFocus: 'dialog' for the same reason the group sheet uses it — focusing the first
    // density button on open painted its state layer, so "Compact" looked pre-selected.
    this.sheet.open(DisplayPanelComponent, {
      panelClass: 'glass-bottom-sheet',
      autoFocus: 'dialog',
    });
  }
}
