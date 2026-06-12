// Stub for sharp — returns a blank 640×640 pixel buffer so preprocessImage
// doesn't fail when an image is decoded during tests.
const mockChain = {
  resize:   jest.fn().mockReturnThis(),
  raw:      jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue({
    data:    Buffer.alloc(640 * 640 * 3, 128),
    info:    { width: 640, height: 640, channels: 3 },
  }),
};

const sharp = jest.fn().mockImplementation(() => mockChain);
export default sharp;
