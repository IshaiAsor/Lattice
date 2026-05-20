import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MgmtDeviceListComponent } from './mgmt-device-list.component';

describe('MgmtDeviceListComponent', () => {
  let component: MgmtDeviceListComponent;
  let fixture: ComponentFixture<MgmtDeviceListComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [MgmtDeviceListComponent]
    });
    fixture = TestBed.createComponent(MgmtDeviceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
