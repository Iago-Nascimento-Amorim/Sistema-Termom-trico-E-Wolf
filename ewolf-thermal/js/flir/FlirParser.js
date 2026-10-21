/**
 * FlirParser.js
 *
 * Única porta de entrada pública. app.js só conhece esta interface.
 *
 *   const img = await FlirParser.parse(file);
 *   img.thermal   { width, height, rawPixels, temperatures }
 *   img.rgb       { width, height, jpegBytes, getBlob() } | null
 *   img.metadata  modelo, série, emissividade...
 *   img.geometry  campos 0x2A crus (Real2IR, offsets, PiP) | null
 *   img.quality   { minC, medianC, maxC, validRatio, warnings }
 *
 * Compatibilidade com o app atual:
 *   img.width, img.height, img.temperatureMap, img.getTemperature(x, y)
 */

import { parseThermalImage } from './thermalParser.js';

export class FlirParseError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'FlirParseError';
    this.stage = stage;
  }
}

async function parse(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new FlirParseError('FlirParser: entrada precisa ser File ou Blob.', 'input');
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new FlirParseError(`FlirParser: não foi possível ler o arquivo. ${error.message}`, 'input');
  }

  let frame;
  try {
    frame = await parseThermalImage(buffer);
  } catch (error) {
    throw new FlirParseError(error.message, 'parse');
  }

  const { thermal, rgb, metadata, geometry, quality } = frame;
  const { width, height, temperatures } = thermal;

  return {
    model: metadata.cameraModel || null,
    serialNumber: metadata.cameraSerialNumber || null,
    thermal,
    rgb: rgb ? { ...rgb, getBlob: () => new Blob([rgb.jpegBytes], { type: 'image/jpeg' }) } : null,
    metadata,
    geometry,
    quality,

    // legado
    width,
    height,
    temperatureMap: temperatures,
    getTemperature(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
      return temperatures[y * width + x];
    },
  };
}

export const FlirParser = { parse };

if (typeof window !== 'undefined') {
  window.FlirParser = FlirParser;
  window.FlirParseError = FlirParseError;
}
