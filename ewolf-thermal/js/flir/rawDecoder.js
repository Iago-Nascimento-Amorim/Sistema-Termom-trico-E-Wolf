/**
 * rawDecoder.js
 *
 * Responsabilidade única: usando a estrutura já interpretada pelo
 * tiffParser (StripOffsets/StripByteCounts/byteOrder), ler os bytes
 * de pixel do TIFF e convertê-los em uma matriz Uint16Array.
 *
 * Não interpreta temperaturas. Não conhece Planck. Não lê JPEG.
 */

/**
 * Decodifica um array de bytes de pixels de 16 bits crus (sem nenhum
 * wrapper TIFF) — o formato confirmado do registro RawData da FLIR E50.
 * @param {Uint8Array} pixelBytes
 * @param {number} width
 * @param {number} height
 * @param {boolean} littleEndian
 * @returns {Uint16Array}
 */
export function decodeRawPixelsFromBytes(pixelBytes, width, height, littleEndian) {
  const expectedPixelCount = width * height;
  const expectedByteCount = expectedPixelCount * 2;

  if (pixelBytes.length < expectedByteCount) {
    throw new Error(
      `rawDecoder: bytes de pixel insuficientes (esperado ${expectedByteCount}, recebido ${pixelBytes.length}).`
    );
  }

  const view = new DataView(pixelBytes.buffer, pixelBytes.byteOffset, pixelBytes.byteLength);
  const rawPixels = new Uint16Array(expectedPixelCount);
  for (let i = 0; i < expectedPixelCount; i++) {
    rawPixels[i] = view.getUint16(i * 2, littleEndian);
  }
  return rawPixels;
}

/**
 * @param {Uint8Array} tiffBytes - buffer completo do TIFF (retornado pelo flirExtractor).
 * @param {object} tiffStructure - objeto retornado por tiffParser.parseTiffStructure().
 * @returns {{width:number, height:number, rawPixels:Uint16Array}}
 */
export function decodeRawPixels(tiffBytes, tiffStructure) {
  if (!(tiffBytes instanceof Uint8Array)) {
    throw new Error('rawDecoder: tiffBytes deve ser um Uint8Array.');
  }
  if (!tiffStructure) {
    throw new Error('rawDecoder: tiffStructure é obrigatório (saída do tiffParser).');
  }

  const { width, height, bitsPerSample, stripOffsets, stripByteCounts, byteOrder } = tiffStructure;

  if (bitsPerSample !== 16) {
    throw new Error(`rawDecoder: apenas 16 bits por amostra é suportado (recebido: ${bitsPerSample}).`);
  }

  const expectedPixelCount = width * height;
  const littleEndian = byteOrder === 'LE';

  const view = new DataView(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength);
  const rawPixels = new Uint16Array(expectedPixelCount);

  let pixelCursor = 0;

  for (let stripIndex = 0; stripIndex < stripOffsets.length; stripIndex++) {
    const stripOffset = stripOffsets[stripIndex];
    const stripByteCount = stripByteCounts[stripIndex];

    if (stripOffset + stripByteCount > tiffBytes.length) {
      throw new Error(
        `rawDecoder: strip ${stripIndex} aponta para fora dos limites do buffer TIFF ` +
        `(offset ${stripOffset}, tamanho ${stripByteCount}, buffer tem ${tiffBytes.length} bytes).`
      );
    }

    const pixelsInStrip = stripByteCount / 2;
    if (!Number.isInteger(pixelsInStrip)) {
      throw new Error(`rawDecoder: strip ${stripIndex} tem tamanho ímpar em bytes, incompatível com 16 bits.`);
    }

    for (let i = 0; i < pixelsInStrip; i++) {
      if (pixelCursor >= expectedPixelCount) {
        break; // strips com padding extra além do necessário são ignorados
      }
      const byteOffset = stripOffset + i * 2;
      rawPixels[pixelCursor] = view.getUint16(byteOffset, littleEndian);
      pixelCursor++;
    }
  }

  if (pixelCursor !== expectedPixelCount) {
    throw new Error(
      `rawDecoder: quantidade de pixels lida (${pixelCursor}) não corresponde a width×height ` +
      `(${expectedPixelCount}).`
    );
  }

  return { width, height, rawPixels };
}
