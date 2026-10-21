/**
 * flirExtractor.js
 *
 * Responsabilidade única: abrir o container FLIR dentro do JPEG e
 * entregar os registros brutos. Não calcula temperatura.
 *
 * Estrutura confirmada nos arquivos reais da E50 (IR, MSX e PiP):
 *  - Segmentos APP1 "FLIR\0" fragmentados; payload começa 8 bytes após o
 *    início do identificador (byte 6 = índice do fragmento). Remontados
 *    em ordem formam o container FFF.
 *  - Cabeçalho FFF de 64 bytes + diretório de entradas de 32 bytes.
 *    O DIRETÓRIO é big-endian.
 *  - O CONTEÚDO dos registros é little-endian (primeiro uint16 = 2 ou 3).
 *  - Registro 0x01 = térmico: 32 bytes de cabeçalho + PNG 16 bits 240×180.
 *  - Registro 0x0E = RGB: 32 bytes de cabeçalho + JPEG 2048×1536.
 *  - Registro 0x20 = CameraInfo; 0x2A = geometria (PiP/offsets).
 *  - A ordem dos registros no diretório varia entre arquivos; por isso
 *    tudo é buscado por TIPO, nunca por posição.
 */

const APP1_MARKER = 0xffe1;
const SOS_MARKER = 0xffda;
const EOI_MARKER = 0xffd9;
const FLIR_ID = [0x46, 0x4c, 0x49, 0x52, 0x00]; // "FLIR\0"
const FFF_HEADER_LENGTH = 0x40;
const FFF_ENTRY_SIZE = 0x20;
const RECORD_HEADER_LENGTH = 32;

export const FFF_RECORD_TYPE = {
  RAW_DATA: 0x01,
  EMBEDDED_IMAGE: 0x0e,
  CAMERA_INFO: 0x20,
  PALETTE_INFO: 0x22,
  PIP: 0x2a,
};

export function reconstructFlirBlob(jpegArrayBuffer) {
  if (!(jpegArrayBuffer instanceof ArrayBuffer)) {
    throw new Error('flirExtractor: entrada deve ser um ArrayBuffer.');
  }
  const bytes = new Uint8Array(jpegArrayBuffer);
  const view = new DataView(jpegArrayBuffer);
  if (bytes.length < 4 || view.getUint16(0, false) !== 0xffd8) {
    throw new Error('flirExtractor: arquivo não é um JPEG (SOI ausente).');
  }

  const chunks = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = view.getUint16(offset, false);
    if (marker === SOS_MARKER || marker === EOI_MARKER) break;
    const length = view.getUint16(offset + 2, false);
    const dataStart = offset + 4;
    const dataEnd = offset + 2 + length;
    if (dataEnd > bytes.length) break;

    if (marker === APP1_MARKER && hasFlirId(bytes, dataStart) && dataEnd - dataStart >= 8) {
      chunks.push({ index: bytes[dataStart + 6], data: bytes.subarray(dataStart + 8, dataEnd) });
    }
    offset = dataEnd;
  }

  if (chunks.length === 0) {
    throw new Error('flirExtractor: nenhum segmento APP1 "FLIR" encontrado. Não parece uma imagem radiométrica FLIR.');
  }

  chunks.sort((a, b) => a.index - b.index);
  const total = chunks.reduce((s, c) => s + c.data.length, 0);
  const blob = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) { blob.set(c.data, cursor); cursor += c.data.length; }
  return blob;
}

/**
 * @returns {{ records: Map<number, {offset,length,subtype,id}> }}
 */
export function parseFffDirectory(blob) {
  if (blob.length < FFF_HEADER_LENGTH) throw new Error('flirExtractor: container FLIR curto demais.');
  const sig = String.fromCharCode(blob[0], blob[1], blob[2]);
  if (sig !== 'FFF' && sig !== 'AFF') throw new Error(`flirExtractor: assinatura de container inválida ("${sig}").`);

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  // Diretório: big-endian nos arquivos reais. LE só como plano B.
  let le = false;
  const versionBE = view.getUint32(0x14, false);
  const versionLE = view.getUint32(0x14, true);
  if (!(versionBE >= 100 && versionBE < 200)) {
    if (versionLE >= 100 && versionLE < 200) le = true;
    else throw new Error(`flirExtractor: versão FFF implausível (BE ${versionBE}, LE ${versionLE}).`);
  }

  const dirOffset = view.getUint32(0x18, le);
  const count = view.getUint32(0x1c, le);
  if (dirOffset <= 0 || dirOffset >= blob.length || count === 0 || count > 200) {
    throw new Error('flirExtractor: cabeçalho FFF com diretório inválido.');
  }

  const records = new Map();
  for (let i = 0; i < count; i++) {
    const e = dirOffset + i * FFF_ENTRY_SIZE;
    if (e + FFF_ENTRY_SIZE > blob.length) break;
    const type = view.getUint16(e, le);
    if (type === 0) continue;
    const rec = {
      subtype: view.getUint16(e + 2, le),
      id: view.getUint32(e + 8, le),
      offset: view.getUint32(e + 0x0c, le),
      length: view.getUint32(e + 0x10, le),
    };
    if (rec.offset + rec.length > blob.length) continue; // registro corrompido: ignora
    if (!records.has(type)) records.set(type, rec);
  }
  return { records };
}

/** Bytes de um registro + ordem de bytes do seu CONTEÚDO. */
export function getRecord(blob, directory, type) {
  const rec = directory.records.get(type);
  if (!rec) return null;
  const bytes = blob.subarray(rec.offset, rec.offset + rec.length);
  return { bytes, littleEndian: detectContentLittleEndian(bytes), meta: rec };
}

// O primeiro uint16 do conteúdo vale 2 ou 3 ("02 00" / "03 00" = little-endian).
function detectContentLittleEndian(bytes) {
  if (bytes.length < 2) return true;
  const le = bytes[0] | (bytes[1] << 8);
  const be = (bytes[0] << 8) | bytes[1];
  if (le >= 1 && le <= 4) return true;
  if (be >= 1 && be <= 4) return false;
  return true;
}

/** Térmico: dimensões do cabeçalho do registro + bytes do PNG. */
export function extractThermalPng(blob, directory) {
  const rec = getRecord(blob, directory, FFF_RECORD_TYPE.RAW_DATA);
  if (!rec) throw new Error('flirExtractor: registro térmico (0x01) não encontrado.');

  const view = new DataView(rec.bytes.buffer, rec.bytes.byteOffset, rec.bytes.byteLength);
  const width = view.getUint16(2, rec.littleEndian);
  const height = view.getUint16(4, rec.littleEndian);

  const start = findSequence(rec.bytes, [0x89, 0x50, 0x4e, 0x47], RECORD_HEADER_LENGTH * 2);
  if (start < 0) throw new Error('flirExtractor: PNG não encontrado no início do registro térmico (0x01).');

  return { width, height, pngBytes: rec.bytes.subarray(start) };
}

/** RGB: JPEG original da câmera (independente do JPEG principal). null se ausente. */
export function extractRgbJpeg(blob, directory) {
  const rec = getRecord(blob, directory, FFF_RECORD_TYPE.EMBEDDED_IMAGE);
  if (!rec) return null;

  const view = new DataView(rec.bytes.buffer, rec.bytes.byteOffset, rec.bytes.byteLength);
  const width = view.getUint16(2, rec.littleEndian);
  const height = view.getUint16(4, rec.littleEndian);

  const start = findSequence(rec.bytes, [0xff, 0xd8, 0xff], RECORD_HEADER_LENGTH * 2);
  if (start < 0) return null;

  let end = rec.bytes.length;
  for (let i = rec.bytes.length - 2; i >= Math.max(start, rec.bytes.length - 32); i--) {
    if (rec.bytes[i] === 0xff && rec.bytes[i + 1] === 0xd9) { end = i + 2; break; }
  }
  return { width, height, jpegBytes: rec.bytes.subarray(start, end) };
}

function hasFlirId(bytes, start) {
  if (start + FLIR_ID.length > bytes.length) return false;
  for (let i = 0; i < FLIR_ID.length; i++) if (bytes[start + i] !== FLIR_ID[i]) return false;
  return true;
}

function findSequence(bytes, seq, maxOffset) {
  const limit = Math.min(maxOffset, bytes.length - seq.length);
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
