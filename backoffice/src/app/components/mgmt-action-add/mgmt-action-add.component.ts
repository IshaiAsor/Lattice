import { Component, OnInit } from '@angular/core';
import { FormControl, FormGroup, Validators, ɵInternalFormsSharedModule } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { Observable } from 'rxjs';
import {
  GoogleActionsTraitsService,
  GoogleActionTrait,
} from 'src/app/services/google.actions.traits.service';
import {
  GoogleActionsTypesService,
  GoogleActionType,
} from 'src/app/services/google.actions.types.service';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from "@angular/material/form-field";
import { SHARED_MATERIAL } from 'src/app/shared-ui';
@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-action-add',
  templateUrl: './mgmt-action-add.component.html',
  styleUrls: ['./mgmt-action-add.component.css'],
})
export class MgmtActionAddComponent implements OnInit {
  constructor(
    private traitsService: GoogleActionsTraitsService,
    private typesService: GoogleActionsTypesService,
    public dialogRef: MatDialogRef<MgmtActionAddComponent>,
  ) {}

  actionTypes$!: Observable<GoogleActionType[]>;
  actionTraits$!: Observable<GoogleActionTrait[]>;

  userActionForm: FormGroup = new FormGroup({
    name: new FormControl('', Validators.required),
    type: new FormControl('', Validators.required),
    trait: new FormControl('', Validators.required),
    pins: new FormControl(''),
  });

  ngOnInit(): void {
    this.actionTypes$ = this.typesService.getGoogleActionTypes();
    this.actionTraits$ = this.traitsService.getGoogleActionTraits();
  }

  onClose(): void {
    this.dialogRef.close();
  }
  onSubmit() {
    console.log('Form submitted');
    this.dialogRef.close(this.userActionForm.value);
  }
}
