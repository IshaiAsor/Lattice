import { Component, Inject,OnInit } from '@angular/core';
import { FormGroup, FormControl, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Observable } from 'rxjs';
import { GoogleActionsTraitsService, GoogleActionTrait } from 'src/app/services/google.actions.traits.service';
import { GoogleActionsTypesService, GoogleActionType } from 'src/app/services/google.actions.types.service';
import { MgmtActionAddComponent } from '../mgmt-action-add/mgmt-action-add.component';
import { DeviceActionView, DeviceMgmtService, DeviceView } from 'src/app/services/device.mgmt.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-action-edit',
  templateUrl: './mgmt-action-edit.component.html',
  styleUrls: ['./mgmt-action-edit.component.css']
})
export class MgmtActionEditComponent implements OnInit{
constructor(
    private deviceMgmtService: DeviceMgmtService,
    private traitsService: GoogleActionsTraitsService,
    private typesService: GoogleActionsTypesService,
    public dialogRef: MatDialogRef<MgmtActionAddComponent>,
    @Inject(MAT_DIALOG_DATA) public data: DeviceActionView
  ) {}

  actionTypes$!: Observable<GoogleActionType[]>;
  actionTraits$!: Observable<GoogleActionTrait[]>;
  userDevices$!: Observable<DeviceView[]>;
  
  userActionForm: FormGroup = new FormGroup({
    id: new FormControl('', Validators.required),
    name: new FormControl('', Validators.required),
    type: new FormControl('', Validators.required),
    trait: new FormControl('', Validators.required),
    pins: new FormControl(''),
  });

  actionPinGroup: FormGroup = new FormGroup({
    pinNumber: new FormControl('', Validators.required),
    pinMode: new FormControl('', Validators.required),
    pinType: new FormControl('', Validators.required),
    deviceId: new FormControl('', Validators.required),
  });



  ngOnInit(): void {
    this.actionTypes$ = this.typesService.getGoogleActionTypes();
    this.actionTraits$ = this.traitsService.getGoogleActionTraits();
    this.userDevices$ = this.deviceMgmtService.getDevices();
    this.userActionForm.patchValue(this.data);
  }

  onClose(): void {
    this.dialogRef.close();
  }
  saveAction() {
    console.log('Form submitted');
    this.dialogRef.close(this.userActionForm.value);
  }

  deletePin(index: number) {
    this.userActionForm.value.pins.splice(index, 1);

  }


  addPin() {
    const newPin = this.actionPinGroup.value;

    this.userActionForm.value.pins.push(newPin);

    this.actionPinGroup.reset();
  
  }
}
