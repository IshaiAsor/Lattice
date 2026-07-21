import { afterNextRender, Component, ElementRef, inject, Injector, OnInit, viewChild } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { AreasService, AreaView } from 'src/app/services/areas.service';

// Manage areas (F10.0): the single home for reordering (drag), renaming, and deleting areas.
// Order is persisted to sort_order, which the dashboard uses to order its sections. Deleting an
// area only un-groups its devices (SET NULL server-side) — it never deletes a device.
@Component({
  selector: 'app-area-manage-dialog',
  imports: [SHARED_MATERIAL],
  templateUrl: './area-manage-dialog.component.html',
  styleUrls: ['./area-manage-dialog.component.css'],
})
export class AreaManageDialogComponent implements OnInit {
  private areasService = inject(AreasService);
  private dialogRef = inject(MatDialogRef<AreaManageDialogComponent>);
  private snack = inject(MatSnackBar);
  private injector = inject(Injector);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  areas: AreaView[] = [];
  loading = true;
  editingId: number | null = null;
  editName = '';
  // Set true on any reorder/rename/delete so the dashboard knows to reload on close.
  private changed = false;

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.areasService.list().subscribe({
      next: (areas) => {
        this.areas = areas;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.snack.open('Failed to load areas', 'Close', { duration: 3000 });
      },
    });
  }

  drop(event: CdkDragDrop<AreaView[]>): void {
    if (event.previousIndex === event.currentIndex) return;
    moveItemInArray(this.areas, event.previousIndex, event.currentIndex);
    this.changed = true;
    this.areasService.reorder(this.areas.map((a) => a.id)).subscribe({
      error: () => this.snack.open('Failed to save order', 'Close', { duration: 3000 }),
    });
  }

  startRename(area: AreaView): void {
    this.editingId = area.id;
    this.editName = area.name;
    // Focus the field once the row has switched into edit mode (the `autofocus` attribute is
    // disallowed for a11y reasons, so do it here instead).
    afterNextRender(() => this.renameInput()?.nativeElement.select(), { injector: this.injector });
  }

  cancelRename(): void {
    this.editingId = null;
    this.editName = '';
  }

  saveRename(area: AreaView): void {
    const name = this.editName.trim();
    if (!name || name === area.name) {
      this.cancelRename();
      return;
    }
    this.areasService.rename(area.id, name).subscribe({
      next: (updated) => {
        area.name = updated.name;
        this.changed = true;
        this.cancelRename();
      },
      error: (err) => {
        const msg = err?.status === 409 ? 'An area with this name already exists' : 'Failed to rename area';
        this.snack.open(msg, 'Close', { duration: 3000 });
      },
    });
  }

  remove(area: AreaView): void {
    const msg =
      area.device_count > 0
        ? `Delete "${area.name}"? Its ${area.device_count} device(s) stay — they just leave the area.`
        : `Delete "${area.name}"?`;
    if (!confirm(msg)) return;
    this.areasService.remove(area.id).subscribe({
      next: () => {
        this.areas = this.areas.filter((a) => a.id !== area.id);
        this.changed = true;
      },
      error: () => this.snack.open('Failed to delete area', 'Close', { duration: 3000 }),
    });
  }

  close(): void {
    this.dialogRef.close(this.changed);
  }
}
