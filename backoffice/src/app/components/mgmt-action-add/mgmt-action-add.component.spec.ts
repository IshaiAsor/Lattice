import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtActionAddComponent } from './mgmt-action-add.component';

describe('MgmtActionAddComponent', () => {
  let component: MgmtActionAddComponent;
  let fixture: ComponentFixture<MgmtActionAddComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [MgmtActionAddComponent]
    });
    fixture = TestBed.createComponent(MgmtActionAddComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
