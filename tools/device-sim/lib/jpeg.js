// Generates a small mock camera frame (320x240 JPEG) with the generation timestamp burned into
// the pixels, via jimp's bundled bitmap font. Real firmware sends actual camera-sensor JPEG
// bytes; the backend transport (device-gateway WS /ws/stream + /ws/capture, and POST
// /api/camera/frame) only forwards bytes, so this is purely a sim-side visual aid for eyeballing
// frame delivery — see PARITY.md for the "sim-only, not firmware-accurate" note.
//
// Uses jimp's bitmap font (rasterized from a bundled glyph atlas) rather than sharp's SVG <text>
// compositing — SVG text rendering goes through the system's font/fontconfig setup, which proved
// unreliable depending on how the sim process was launched (worked in an interactive shell, but
// rendered as tofu boxes when run via nodemon/VS Code launch). A bitmap font has no such
// dependency: the glyphs ship inside the npm package.

const { Jimp, JimpMime, loadFont } = require('jimp');
const { SANS_16_WHITE } = require('jimp/fonts');

const WIDTH = 320;
const HEIGHT = 240;
const BAR_HEIGHT = 28;

// Solid-color base — cheap to regenerate every call, and gives the text overlay contrast.
const BG = 0x1e2836ff;

// loadFont reads/parses the bundled font atlas — do it once and reuse across frames rather than
// on every makeFrame() call.
let fontPromise = null;
function getFont() {
  if (!fontPromise) fontPromise = loadFont(SANS_16_WHITE);
  return fontPromise;
}

// Darkens a horizontal band at the bottom of the image so the (white) timestamp text stays
// readable regardless of the background color.
function darkenBottomBar(img) {
  img.scan(0, HEIGHT - BAR_HEIGHT, WIDTH, BAR_HEIGHT, function (x, y, idx) {
    this.bitmap.data[idx] = Math.round(this.bitmap.data[idx] * 0.45);
    this.bitmap.data[idx + 1] = Math.round(this.bitmap.data[idx + 1] * 0.45);
    this.bitmap.data[idx + 2] = Math.round(this.bitmap.data[idx + 2] * 0.45);
  });
}

// Returns a Promise<Buffer> of a JPEG frame with the current ISO timestamp stamped in the
// bottom-left corner. Async because jimp's font loading and buffer encoding are promise-based;
// call sites must await this.
async function makeFrame() {
  const isoTimestamp = new Date().toISOString();
  const img = new Jimp({ width: WIDTH, height: HEIGHT, color: BG });
  darkenBottomBar(img);
  const font = await getFont();
  img.print({ font, x: 8, y: HEIGHT - BAR_HEIGHT + 6, text: isoTimestamp });
  return img.getBuffer(JimpMime.jpeg, { quality: 70 });
}

module.exports = { makeFrame, WIDTH, HEIGHT };
