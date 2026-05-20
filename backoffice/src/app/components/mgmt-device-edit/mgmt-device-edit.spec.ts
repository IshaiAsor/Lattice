import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtDeviceEdit } from './mgmt-device-edit';

describe('MgmtDeviceEdit', () => {
  let component: MgmtDeviceEdit;
  let fixture: ComponentFixture<MgmtDeviceEdit>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MgmtDeviceEdit]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MgmtDeviceEdit);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
