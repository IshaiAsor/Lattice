import { TestBed } from '@angular/core/testing';

import { GoogleActionsTraitsService } from './google.actions.traits.service';

describe('GoogleActionsTraitsService', () => {
  let service: GoogleActionsTraitsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GoogleActionsTraitsService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
