/**
 * thermalParser.js
 *
 * Orquestra o pipeline. Entrega térmico e RGB como imagens INDEPENDENTES
 * (requisito para o alinhamento por AprilTags) + metadados e geometria crua.
 *
 * Funciona por tipo de registro, então não depende do modo (IR/MSX/PiP).
 */

import { reconstructFlirBlob, parseFffDirectory, extractThermalPng, extractRgbJpeg } from './flirExtractor.js';
import { decodePng16Gray } from './pngDecoder.js';
import { extractFlirMetadata } from './flirMetadata.js';
import { rawToTemperature } from './planck.js';

// Confirmado nos 3 arquivos da E50: os pixels no PNG vêm com os bytes
// trocados em relação ao padrão PNG (big-endian). Sem a troca a temperatura
// sai de -127 a 175 °C; com a troca, 20 a 35 °C.
const FLIR_PNG_SWAP_BYTES = true;

export async function parseThermalImage(jpegArrayBuffer) {
  const blob = step('extração do container FLIR', () => reconstructFlirBlob(jpegArrayBuffer));
  const directory = step('diretório FFF', () => parseFffDirectory(blob));
  const thermalRec = step('registro térmico', () => extractThermalPng(blob, directory));

  const png = await decodePng16Gray(thermalRec.pngBytes).catch((e) => {
    throw new Error(`thermalParser: falha no PNG térmico. ${e.message}`);
  });
  if (png.width !== thermalRec.width || png.height !== thermalRec.height) {
    throw new Error(
      `thermalParser: dimensões divergentes (registro ${thermalRec.width}×${thermalRec.height}, PNG ${png.width}×${png.height}).`
    );
  }

  const rawPixels = new Uint16Array(png.values.length);
  for (let i = 0; i < rawPixels.length; i++) {
    const v = png.values[i];
    rawPixels[i] = FLIR_PNG_SWAP_BYTES ? ((v & 0xff) << 8) | (v >> 8) : v;
  }

  const meta = step('metadados radiométricos', () => extractFlirMetadata(blob, directory));
  const temperatures = step('equação de Planck', () => rawToTemperature(rawPixels, meta.radiometricParams));
  const rgb = extractRgbJpeg(blob, directory);

  return {
    thermal: { width: png.width, height: png.height, rawPixels, temperatures },
    rgb, // { width, height, jpegBytes } ou null
    metadata: meta.info,
    geometry: meta.geometry, // crua, ainda sem interpretação
    quality: assessQuality(temperatures, meta.info),
    modeHints: { recordTypes: [...directory.records.keys()] },
  };
}

function step(name, fn) {
  try { return fn(); } catch (e) { throw new Error(`thermalParser: falha em ${name}. ${e.message}`); }
}

function assessQuality(temps, info) {
  const sorted = Float32Array.from(temps).sort();
  const n = sorted.length;
  const [lo, hi] = info.clipRangeC;
  let valid = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(temps[i]) && temps[i] >= lo && temps[i] <= hi) valid++;
  const validRatio = valid / n;

  const warnings = [];
  if (validRatio < 0.99) warnings.push(`Só ${(validRatio * 100).toFixed(1)}% dos pixels estão na faixa da câmera (${lo.toFixed(0)}..${hi.toFixed(0)} °C).`);

  return {
    minC: sorted[0],
    medianC: sorted[n >> 1],
    maxC: sorted[n - 1],
    validRatio,
    warnings,
  };
}
