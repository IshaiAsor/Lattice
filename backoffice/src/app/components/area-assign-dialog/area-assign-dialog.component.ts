import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { AreasService, AreaView } from 'src/app/services/areas.service';

export interface AreaAssignData {
  deviceId: number;
  deviceName: string;
  currentAreaId: number | null;
}

// Assign one device to an Area (F10.0): pick an existing area, create a new one inline, or
// clear the tag ("No area"). Self-contained — it performs the create/assign itself and closes
// with the resulting area_id so the caller just reloads. null selection = unassigned.
@Component({
  selector: 'app-area-assign-dialog',
  imports: [SHARED_MATERIAL],
  templateUrl: './area-assign-dialog.component.html',
  styleUrls: ['./area-assign-dialog.component.css'],
})
export class AreaAssignDialogComponent implements OnInit {
  private areasService = inject(AreasService);
  private dialogRef = inject(MatDialogRef<AreaAssignDialogComponent>);
  private snack = inject(MatSnackBar);
  data: AreaAssignData = inject(MAT_DIALOG_DATA);

  areas: AreaView[] = [];
  loading = true;
  saving = false;
  // The selected target: a numeric area id, or null for "No area".
  selectedAreaId: number | null = null;
  newAreaName = '';
  creating = false;

  ngOnInit(): void {
    this.selectedAreaId = this.data.currentAreaId;
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

  createArea(): void {
    const name = this.newAreaName.trim();
    if (!name || this.creating) return;
    this.creating = true;
    this.areasService.create(name).subscribe({
      next: (area) => {
        this.areas = [...this.areas, area];
        this.selectedAreaId = area.id;
        this.newAreaName = '';
        this.creating = false;
      },
      error: (err) => {
        this.creating = false;
        const msg = err?.status === 409 ? 'An area with this name already exists' : 'Failed to create area';
        this.snack.open(msg, 'Close', { duration: 3000 });
      },
    });
  }

  save(): void {
    if (this.saving) return;
    // Nothing changed — just close.
    if (this.selectedAreaId === this.data.currentAreaId) {
      this.dialogRef.close();
      return;
    }
    this.saving = true;
    this.areasService.assignDevices(this.selectedAreaId, [this.data.deviceId]).subscribe({
      next: () => this.dialogRef.close({ areaId: this.selectedAreaId }),
      error: () => {
        this.saving = false;
        this.snack.open('Failed to assign area', 'Close', { duration: 3000 });
      },
    });
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
