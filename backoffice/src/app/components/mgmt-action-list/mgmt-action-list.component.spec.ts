import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtActionListComponent } from './mgmt-action-list.component';

describe('MgmtActionListComponent', () => {
  let component: MgmtActionListComponent;
  let fixture: ComponentFixture<MgmtActionListComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [MgmtActionListComponent]
    });
    fixture = TestBed.createComponent(MgmtActionListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
