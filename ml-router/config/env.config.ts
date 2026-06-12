import path from 'path';

export const config = {
  port:        +(process.env.PORT ?? 3002),
  onnxModelsDir: process.env.ONNX_MODELS_DIR ?? path.join(process.cwd(), 'models'),
};

export default config;
