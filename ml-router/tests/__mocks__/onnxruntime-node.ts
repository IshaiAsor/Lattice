// Stub for onnxruntime-node — avoids loading native binaries in CI/test.
const mockSession = {
  inputNames:  ['images'],
  outputNames: ['output0'],
  run: jest.fn().mockResolvedValue({
    output0: { data: new Float32Array(0), dims: [1, 7, 0] },
  }),
};

export const InferenceSession = {
  create: jest.fn().mockResolvedValue(mockSession),
};

export class Tensor {
  constructor(
    public type: string,
    public data: Float32Array,
    public dims: number[],
  ) {}
}
