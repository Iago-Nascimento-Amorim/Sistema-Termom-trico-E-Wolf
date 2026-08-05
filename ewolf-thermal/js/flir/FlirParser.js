/**
 * FlirParser.js
 *
 * Única porta de entrada pública do parser radiométrico da FLIR E50.
 * Todo o resto do app (app.js) só deve conhecer esta interface — nunca
 * "FFF\0", RawData, TIFF, ou a equação de Planck diretamente.
 *
 * Uso:
 *   const image = await FlirParser.parse(file); // file: File (do <input type="file">)
 *   image.model            // ex: "FLIR E50"
 *   image.width             // 240
 *   image.height            // 180
 *   image.temperatureMap    // Float32Array, comprimento width*height, em °C
 *   image.getTemperature(x, y) // °C num ponto específico, ou null se fora dos limites
 *
 * app.js é um script clássico (não-module), então este módulo também se
 * expõe como window.FlirParser — assim não precisamos converter o app
 * inteiro para ES Modules só por causa desta peça nova.
 */

import { parseThermalImage } from './thermalParser.js';

/**
 * Erro tipado do parser — permite ao chamador distinguir "não é um
 * arquivo FLIR" (isso já é filtrado antes, na validação por assinatura)
 * de "é um arquivo FLIR, mas o parser não conseguiu ler os dados"
 * (arquivo corrompido, variante de formato não suportada, etc.).
 */
export class FlirParseError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'FlirParseError';
    this.stage = stage; // ex.: 'extract' | 'tiff' | 'raw' | 'metadata' | 'planck'
  }
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{
 *   model: string,
 *   serialNumber: string,
 *   width: number,
 *   height: number,
 *   temperatureMap: Float32Array,
 *   metadata: object,
 *   getTemperature: (x:number, y:number) => number|null,
 * }>}
 */
async function parse(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new FlirParseError('FlirParser: entrada precisa ser um File ou Blob.', 'input');
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new FlirParseError(`FlirParser: não foi possível ler o arquivo. ${error.message}`, 'input');
  }

  let frame;
  try {
    frame = parseThermalImage(buffer);
  } catch (error) {
    throw new FlirParseError(error.message, 'parse');
  }

  const { width, height, temperatures, metadata } = frame;

  return {
    model: metadata.cameraModel || null,
    serialNumber: metadata.cameraSerialNumber || null,
    width,
    height,
    temperatureMap: temperatures,
    metadata,
    getTemperature(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
      return temperatures[y * width + x];
    },
  };
}

export const FlirParser = { parse };

// Exposição para app.js (script clássico, não-module).
if (typeof window !== 'undefined') {
  window.FlirParser = FlirParser;
  window.FlirParseError = FlirParseError;
}
