/**
 * tiffParser.js
 *
 * Responsabilidade única: interpretar a estrutura de um buffer TIFF
 * (cabeçalho, IFD, tags) e devolver as informações necessárias para
 * que outro módulo saiba ONDE e COMO ler os pixels.
 *
 * Não lê pixels. Não converte temperaturas. Não conhece Planck.
 * Nada aqui é específico da FLIR — é TIFF genérico (baseline 6.0).
 */

// IDs das tags TIFF relevantes (baseline TIFF 6.0)
const TAG = {
  IMAGE_WIDTH: 0x0100,
  IMAGE_HEIGHT: 0x0101,
  BITS_PER_SAMPLE: 0x0102,
  COMPRESSION: 0x0103,
  STRIP_OFFSETS: 0x0111,
  SAMPLES_PER_PIXEL: 0x0115,
  ROWS_PER_STRIP: 0x0116,
  STRIP_BYTE_COUNTS: 0x0117,
  SAMPLE_FORMAT: 0x0153,
};

// Tamanho em bytes de cada tipo de campo TIFF
const FIELD_TYPE_SIZE = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

/**
 * Interpreta um buffer TIFF e retorna metadados estruturais.
 * @param {Uint8Array} tiffBytes
 * @returns {{
 *   width:number, height:number, bitsPerSample:number, compression:number,
 *   sampleFormat:number, stripOffsets:number[], stripByteCounts:number[],
 *   byteOrder:'LE'|'BE'
 * }}
 */
export function parseTiffStructure(tiffBytes) {
  if (!(tiffBytes instanceof Uint8Array)) {
    throw new Error('tiffParser: entrada deve ser um Uint8Array contendo o TIFF.');
  }
  if (tiffBytes.length < 8) {
    throw new Error('tiffParser: buffer curto demais para conter um cabeçalho TIFF válido.');
  }

  const view = new DataView(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength);

  const byteOrder = detectByteOrder(view);
  const littleEndian = byteOrder === 'LE';

  const magic = view.getUint16(2, littleEndian);
  if (magic !== 42) {
    throw new Error(`tiffParser: assinatura TIFF inválida (esperado 42, encontrado ${magic}).`);
  }

  const firstIfdOffset = view.getUint32(4, littleEndian);
  const ifdEntries = readIfd(view, firstIfdOffset, littleEndian);

  const width = getRequiredTagValue(ifdEntries, TAG.IMAGE_WIDTH, 'ImageWidth');
  const height = getRequiredTagValue(ifdEntries, TAG.IMAGE_HEIGHT, 'ImageHeight');
  const bitsPerSample = getRequiredTagValue(ifdEntries, TAG.BITS_PER_SAMPLE, 'BitsPerSample');
  const compression = getTagValue(ifdEntries, TAG.COMPRESSION, 1); // default: sem compressão
  const sampleFormat = getTagValue(ifdEntries, TAG.SAMPLE_FORMAT, 1); // default: uint

  const stripOffsets = getRequiredTagValueArray(ifdEntries, TAG.STRIP_OFFSETS, 'StripOffsets');
  const stripByteCounts = getRequiredTagValueArray(ifdEntries, TAG.STRIP_BYTE_COUNTS, 'StripByteCounts');

  if (stripOffsets.length !== stripByteCounts.length) {
    throw new Error(
      'tiffParser: inconsistência entre StripOffsets e StripByteCounts (quantidades diferentes).'
    );
  }

  if (compression !== 1) {
    throw new Error(
      `tiffParser: compressão não suportada (código ${compression}). Este parser assume dados sem compressão ` +
      '(confirmado como o formato usado pela FLIR E50 via ExifTool: Compression=1).'
    );
  }

  return {
    width,
    height,
    bitsPerSample,
    compression,
    sampleFormat,
    stripOffsets,
    stripByteCounts,
    byteOrder,
  };
}

function detectByteOrder(view) {
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  if (b0 === 0x49 && b1 === 0x49) return 'LE';
  if (b0 === 0x4d && b1 === 0x4d) return 'BE';
  throw new Error('tiffParser: cabeçalho TIFF não começa com "II" nem "MM".');
}

/**
 * Lê um IFD (Image File Directory) e retorna um Map<tagId, entry>.
 */
function readIfd(view, ifdOffset, littleEndian) {
  if (ifdOffset <= 0 || ifdOffset + 2 > view.byteLength) {
    throw new Error('tiffParser: offset de IFD inválido ou fora dos limites do buffer.');
  }

  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const entries = new Map();

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) {
      throw new Error('tiffParser: entrada de IFD ultrapassa o limite do buffer.');
    }

    const tagId = view.getUint16(entryOffset, littleEndian);
    const fieldType = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const valueFieldOffset = entryOffset + 8;

    const entry = { fieldType, count, valueFieldOffset };
    const resolvedArray = resolveEntryValues(view, entry, littleEndian);

    entry.__resolvedArray = resolvedArray;
    entry.__resolvedSingle = resolvedArray[0];

    entries.set(tagId, entry);
  }

  return entries;
}

/**
 * Resolve o(s) valor(es) de uma entrada de IFD, seguindo o ponteiro
 * externo quando o valor não cabe nos 4 bytes inline do campo.
 */
function resolveEntryValues(view, entry, littleEndian) {
  const typeSize = FIELD_TYPE_SIZE[entry.fieldType];
  if (!typeSize) {
    throw new Error(`tiffParser: tipo de campo TIFF desconhecido (${entry.fieldType}).`);
  }

  const totalSize = typeSize * entry.count;
  const dataOffset = totalSize <= 4 ? entry.valueFieldOffset : view.getUint32(entry.valueFieldOffset, littleEndian);

  const values = [];
  for (let i = 0; i < entry.count; i++) {
    const offset = dataOffset + i * typeSize;
    values.push(readTypedValue(view, offset, entry.fieldType, littleEndian));
  }
  return values;
}

function readTypedValue(view, offset, fieldType, littleEndian) {
  switch (fieldType) {
    case 1: // BYTE
    case 2: // ASCII
    case 7: // UNDEFINED
      return view.getUint8(offset);
    case 3: // SHORT
      return view.getUint16(offset, littleEndian);
    case 4: // LONG
      return view.getUint32(offset, littleEndian);
    case 6: // SBYTE
      return view.getInt8(offset);
    case 8: // SSHORT
      return view.getInt16(offset, littleEndian);
    case 9: // SLONG
      return view.getInt32(offset, littleEndian);
    case 11: // FLOAT
      return view.getFloat32(offset, littleEndian);
    case 12: // DOUBLE
      return view.getFloat64(offset, littleEndian);
    case 5: { // RATIONAL
      const num = view.getUint32(offset, littleEndian);
      const den = view.getUint32(offset + 4, littleEndian);
      return den === 0 ? 0 : num / den;
    }
    case 10: { // SRATIONAL
      const num = view.getInt32(offset, littleEndian);
      const den = view.getInt32(offset + 4, littleEndian);
      return den === 0 ? 0 : num / den;
    }
    default:
      throw new Error(`tiffParser: leitura não implementada para o tipo de campo ${fieldType}.`);
  }
}

function getTagValue(entries, tagId, defaultValue) {
  const entry = entries.get(tagId);
  if (!entry) return defaultValue;
  return entry.__resolvedSingle;
}

function getRequiredTagValue(entries, tagId, tagName) {
  const entry = entries.get(tagId);
  if (!entry) {
    throw new Error(`tiffParser: tag obrigatória ausente no IFD: ${tagName} (0x${tagId.toString(16)}).`);
  }
  return entry.__resolvedSingle;
}

function getRequiredTagValueArray(entries, tagId, tagName) {
  const entry = entries.get(tagId);
  if (!entry) {
    throw new Error(`tiffParser: tag obrigatória ausente no IFD: ${tagName} (0x${tagId.toString(16)}).`);
  }
  return entry.__resolvedArray;
}
