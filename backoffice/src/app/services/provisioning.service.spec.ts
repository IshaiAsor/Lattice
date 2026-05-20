import { TestBed } from '@angular/core/testing';

import { ProvisioningService } from './provisioning.service';

describe('ProvisioningService', () => {
  let service: ProvisioningService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ProvisioningService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
