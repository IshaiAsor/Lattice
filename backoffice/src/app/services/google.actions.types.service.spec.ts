import { TestBed } from '@angular/core/testing';

import { GoogleActionsTypesService } from './google.actions.types.service';

describe('GoogleActionsTypesService', () => {
  let service: GoogleActionsTypesService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GoogleActionsTypesService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
