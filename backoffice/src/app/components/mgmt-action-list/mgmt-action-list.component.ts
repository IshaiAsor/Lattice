import { Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { MatCardModule } from "@angular/material/card";
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { MatDialog } from '@angular/material/dialog';
import { MgmtActionAddComponent } from '../mgmt-action-add/mgmt-action-add.component';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MgmtActionEditComponent } from '../mgmt-action-edit/mgmt-action-edit.component';
import { SHARED_MATERIAL } from 'src/app/shared-ui';

@Component({
  imports: [SHARED_MATERIAL],
  selector: 'app-mgmt-action-list',
  templateUrl: './mgmt-action-list.component.html',
  styleUrls: ['./mgmt-action-list.component.css'],
})
export class MgmtActionListComponent implements OnInit {

  actions$!: Observable<DeviceActionView[]>;

  constructor(private actionsService:UserActionsService,
    public dialog: MatDialog,private snackBar: MatSnackBar) {
  }
  ngOnInit(): void {
    this.actions$ = this.actionsService.getUserActions();

  }

  add(){

     const dialogRef = this.dialog.open(MgmtActionAddComponent, {
      width: '250px', // Optional: set width and other configurations
      data: { /* you can pass data here */ }
    });

    dialogRef.afterClosed().subscribe(result => {
      console.log('The dialog was closed');
      if(result)
      {
        this.actionsService.addUserAction(result).subscribe(() => {
          this.actions$ = this.actionsService.getUserActions();
          this.snackBar.open('Action added successfully', 'Close', {
            duration: 2000,
          });
        });
      }
    });
  }

  edit(action:DeviceActionView){
    console.log(action);
    const dialogRef = this.dialog.open(MgmtActionEditComponent, {
      data: action,
    });

    dialogRef.afterClosed().subscribe(result => {
if(result)
{
  this.actionsService.updateUserAction(result).
  subscribe(()=>{
    this.actions$ = this.actionsService.getUserActions();
    this.snackBar.open('Action updated successfully', 'Close', {
      duration: 2000,
    });
  });
}
    });

  }

  delete(action:DeviceActionView){
    this.actionsService.delete(action)
    .subscribe(()=>{
      this.snackBar.open('Action deleted successfully', 'Close', {
        duration: 2000,
      });
      this.actions$ = this.actionsService.getUserActions();
    });
  }
}
