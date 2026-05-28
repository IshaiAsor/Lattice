import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { FormControl, Validators } from '@angular/forms';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  selector: 'app-rename-action-dialog',
  standalone: true,
  imports: [SHARED_MATERIAL],
  templateUrl: './rename-action-dialog.component.html',
})
export class RenameActionDialogComponent {
  dialogRef = inject(MatDialogRef<RenameActionDialogComponent>);
  data: { action: DeviceActionView } = inject(MAT_DIALOG_DATA);

  nameControl = new FormControl(this.data.action.name, [Validators.required, Validators.minLength(1)]);

  save() {
    if (this.nameControl.valid) {
      this.dialogRef.close(this.nameControl.value);
    }
  }

  cancel() {
    this.dialogRef.close(undefined);
  }
}
