import { getMeter } from '@lattice/otel';

// Custom metrics for digest-service.
//
// Naming: `lattice_<area>_<thing>_<unit>`, counters suffixed `_total`. Everything reaches
// Prometheus through the exporter initOTel() already wires to GET /metrics, so nothing here needs
// its own endpoint or registry.
//
// **Instruments are created lazily, and that is load-bearing.** `initOTel()` is what installs the
// global MeterProvider, and it runs as a statement in index.ts — which happens AFTER every import
// in the module graph has been evaluated. Creating instruments at module scope would therefore
// bind them to the default no-op provider, and they would silently record nothing forever: the
// counters increment, `/metrics` stays empty, and nothing anywhere errors. Resolving on first use
// puts instrument creation after bootstrap without making callers think about ordering.
let cache: ReturnType<typeof build> | null = null;

function build(meter: ReturnType<typeof getMeter>) {
  return {
    // The reconcile loop's three questions (F23.5): are we asking, is the answer ever different,
    // and does anyone answer at all.
    readsIssued: meter.createCounter('lattice_reconcile_reads_issued_total', {
      description: 'State read-backs dispatched to devices, labelled by what triggered them',
    }),
    divergences: meter.createCounter('lattice_reconcile_divergences_total', {
      description:
        'Read-backs where the device reported a state different from the stored one. A spike means acks are being lost, not that devices are misbehaving',
    }),
    readsUnanswered: meter.createCounter('lattice_reconcile_reads_unanswered_total', {
      description: 'State read-backs that timed out with no ack from the device',
    }),
  };
}

function instruments() {
  cache ??= build(getMeter('digest-service'));
  return cache;
}

export const reconcileReadsIssued = {
  add: (value: number, attributes?: Record<string, string>) =>
    instruments().readsIssued.add(value, attributes),
};

export const reconcileDivergences = {
  add: (value: number, attributes?: Record<string, string>) =>
    instruments().divergences.add(value, attributes),
};

export const reconcileReadsUnanswered = {
  add: (value: number, attributes?: Record<string, string>) =>
    instruments().readsUnanswered.add(value, attributes),
};
