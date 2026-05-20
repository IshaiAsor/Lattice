import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  selector: 'app-mgmt-device-edit',
  imports: [SHARED_MATERIAL],
  templateUrl: './mgmt-device-edit.html',
  styleUrl: './mgmt-device-edit.css',
})
export class MgmtDeviceEdit {
 constructor(
    public dialogRef: MatDialogRef<MgmtDeviceEdit>,
    @Inject(MAT_DIALOG_DATA) public data: { deviceName: string }
  ) {}

  onCancel(): void {
    this.dialogRef.close();
  }
}
