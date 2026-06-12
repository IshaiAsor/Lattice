// Minimal prom-client stub — avoids real metric registration during tests.
const noop = jest.fn();
const mockHistogram = { observe: noop };
const mockCounter   = { inc: noop };

export default {
  collectDefaultMetrics: jest.fn(),
  Histogram: jest.fn().mockImplementation(() => mockHistogram),
  Counter:   jest.fn().mockImplementation(() => mockCounter),
  register:  { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
};
