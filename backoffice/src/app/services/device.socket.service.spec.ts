import { TestBed } from '@angular/core/testing';

import { DeviceSocketService } from './device.socket.service';

describe('DeviceSocketService', () => {
  let service: DeviceSocketService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DeviceSocketService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
