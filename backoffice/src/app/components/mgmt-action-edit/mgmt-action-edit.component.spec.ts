import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtActionEditComponent } from './mgmt-action-edit.component';

describe('MgmtActionEditComponent', () => {
  let component: MgmtActionEditComponent;
  let fixture: ComponentFixture<MgmtActionEditComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [MgmtActionEditComponent]
    });
    fixture = TestBed.createComponent(MgmtActionEditComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
