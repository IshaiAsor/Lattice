import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'lattice_ml_' });

export const inferenceDuration = new client.Histogram({
  name:       'lattice_ml_inference_duration_seconds',
  help:       'ML inference duration in seconds',
  labelNames: ['kind', 'name', 'version'] as const,
  buckets:    [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequests = new client.Counter({
  name:       'lattice_ml_http_requests_total',
  help:       'Total HTTP requests to ml-router',
  labelNames: ['method', 'route', 'status'] as const,
});

export { client };
