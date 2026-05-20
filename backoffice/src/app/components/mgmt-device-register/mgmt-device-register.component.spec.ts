import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtDeviceRegisterComponent } from './mgmt-device-register.component';

describe('MgmtDeviceRegisterComponent', () => {
  let component: MgmtDeviceRegisterComponent;
  let fixture: ComponentFixture<MgmtDeviceRegisterComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [MgmtDeviceRegisterComponent]
    });
    fixture = TestBed.createComponent(MgmtDeviceRegisterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
