import { getMeter } from '@lattice/otel';

// Custom metrics for automation-worker. See services/digest-service/src/metrics.ts for the shared
// conventions — including why the instrument is built lazily rather than at module scope
// (initOTel installs the global MeterProvider only after every import has been evaluated, so an
// eagerly-created instrument binds to a no-op and records nothing, silently).
let cache: ReturnType<typeof build> | null = null;

function build(meter: ReturnType<typeof getMeter>) {
  return {
    // How stale a command action's confirmation had become by the time the sweep reached it
    // (F23.5). A histogram rather than a per-device gauge on purpose: labelling by device id is
    // unbounded cardinality against a fleet, and "how stale is the fleet getting" is a
    // distributional question anyway — the tail is the part worth watching.
    confirmationAge: meter.createHistogram('lattice_action_confirmation_age_seconds', {
      description: 'Age of an action state confirmation when the reconcile sweep selected it',
      unit: 's',
    }),
  };
}

function instruments() {
  cache ??= build(getMeter('automation-worker'));
  return cache;
}

export const confirmationAge = {
  record: (value: number, attributes?: Record<string, string>) =>
    instruments().confirmationAge.record(value, attributes),
};
