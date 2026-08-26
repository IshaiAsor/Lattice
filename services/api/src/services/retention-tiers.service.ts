import { RAW_BUCKET } from '@lattice/retention';
import { retentionBucketsService } from './retention-buckets.service';
import { retentionPolicyService } from './retention-policy.service';
import { retentionScopesService } from './retention-scopes.service';
import { retentionBlueprintsService } from './retention-blueprints.service';
import { retentionSweepsService } from './retention-sweeps.service';

// Retention tiers, the bucket catalog, and out-of-band sweeps (F18.9-F18.19).
//
// This was one 1,200-line file. It is now five, split along the lines the ROUTES already follow -
// catalog, platform policy, the four stored scopes, blueprints, sweeps - with the internals they
// share in retention-tiers.shared.ts.
//
// What stays here is a facade, and deliberately so. Several methods call siblings in their own part
// through `this` (setMine -> mine, setPolicyTiers -> listPolicies), which keeps working because the
// composed object below is what callers actually invoke. Import a part directly and those calls
// have no `this` to find - so the parts are internals, and this is the front door.

export const retentionTiersService = {
  ...retentionBucketsService,
  ...retentionPolicyService,
  ...retentionScopesService,
  ...retentionBlueprintsService,
  ...retentionSweepsService,
};

export { RAW_BUCKET };
