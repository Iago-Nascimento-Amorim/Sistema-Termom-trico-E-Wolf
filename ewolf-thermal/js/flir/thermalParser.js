/**
 * thermalParser.js
 *
 * Orquestra o pipeline completo de leitura de uma imagem radiométrica
 * FLIR. Não é a interface pública final do sistema — quem o app usa é
 * FlirParser.js (uma camada fininha por cima disto, expondo a
 * assinatura combinada com o time: FlirParser.parse(file)).
 *
 * Fluxo:
 *   JPEG -> flirExtractor (acha o registro RawData e identifica o modo:
 *   'raw' = pixels de 16 bits crus [confirmado com arquivo real da E50],
 *   'tiff' = plano B, caso outro arquivo venha embrulhado em TIFF)
 *   -> decodifica pixels -> planck (Planck + calibração) -> retorno
 */

import { extractRawThermalPayload } from './flirExtractor.js';
import { parseTiffStructure } from './tiffParser.js';
import { decodeRawPixels, decodeRawPixelsFromBytes } from './rawDecoder.js';
import { rawToTemperature } from './planck.js';
import { extractFlirMetadata } from './flirMetadata.js';

/**
 * @param {ArrayBuffer} jpegArrayBuffer - JPEG completo (ex.: vindo de um <input type="file">).
 * @returns {{
 *   width: number,
 *   height: number,
 *   temperatures: Float32Array,
 *   metadata: object
 * }}
 */
export function parseThermalImage(jpegArrayBuffer) {
  let payload;
  try {
    payload = extractRawThermalPayload(jpegArrayBuffer);
  } catch (error) {
    throw new Error(`thermalParser: falha ao extrair os dados térmicos brutos do JPEG FLIR. ${error.message}`);
  }

  let width, height, rawPixels;

  if (payload.mode === 'raw') {
    width = payload.width;
    height = payload.height;
    try {
      rawPixels = decodeRawPixelsFromBytes(payload.pixelBytes, width, height, payload.littleEndian);
    } catch (error) {
      throw new Error(`thermalParser: falha ao decodificar os pixels RAW. ${error.message}`);
    }
  } else {
    let tiffStructure;
    try {
      tiffStructure = parseTiffStructure(payload.tiffBytes);
    } catch (error) {
      throw new Error(`thermalParser: falha ao interpretar a estrutura do TIFF. ${error.message}`);
    }
    let decoded;
    try {
      decoded = decodeRawPixels(payload.tiffBytes, tiffStructure);
    } catch (error) {
      throw new Error(`thermalParser: falha ao decodificar os pixels RAW (TIFF). ${error.message}`);
    }
    width = decoded.width;
    height = decoded.height;
    rawPixels = decoded.rawPixels;
  }

  let metadata;
  try {
    metadata = extractFlirMetadata(jpegArrayBuffer);
  } catch (error) {
    throw new Error(`thermalParser: falha ao extrair metadados radiométricos FLIR. ${error.message}`);
  }

  let temperatures;
  try {
    temperatures = rawToTemperature(rawPixels, metadata.radiometricParams);
  } catch (error) {
    throw new Error(`thermalParser: falha ao aplicar a equação de Planck. ${error.message}`);
  }

  return {
    width,
    height,
    temperatures,
    metadata: metadata.info,
  };
}
