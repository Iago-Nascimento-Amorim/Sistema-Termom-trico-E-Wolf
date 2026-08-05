/**
 * flirExtractor.js
 *
 * Responsabilidade única: localizar e extrair os dados térmicos brutos
 * (RawThermalImage) embutidos dentro de um JPEG produzido pela câmera
 * FLIR E50 (linha Exx).
 *
 * Câmeras FLIR armazenam seus dados térmicos num container binário
 * próprio, o "FLIR File Format" (assinatura "FFF\0"), dentro de um ou
 * mais segmentos APP1 do JPEG identificados por "FLIR\0". Como um
 * único APP1 tem limite de 65533 bytes e o container costuma ser maior,
 * a câmera fragmenta os dados em vários segmentos que precisam ser
 * remontados em ordem antes de interpretarmos o container.
 *
 * O container FFF tem um cabeçalho fixo de 64 bytes seguido de um
 * diretório de registros (cada registro com um tipo, offset e tamanho).
 * O registro do tipo 0x01 ("RawData") contém a imagem térmica bruta.
 *
 * IMPORTANTE (confirmado com um arquivo real da E50, via inspeção
 * hexadecimal): ao contrário do que o campo RawThermalImageType=TIFF do
 * ExifTool sugere, o registro RawData NÃO contém um arquivo TIFF
 * embutido nesta câmera/firmware. A estrutura real é bem mais simples:
 *   [0..1]   flag/versão (observado: 2)
 *   [2..3]   largura (uint16 LE) — ex.: 240
 *   [4..5]   altura (uint16 LE) — ex.: 180
 *   [6..31]  demais campos do cabeçalho interno (não usados aqui)
 *   [32..]   pixels brutos de 16 bits (LE), width×height×2 bytes, sem
 *            nenhum wrapper de arquivo de imagem
 * O ExifTool provavelmente descreve isso como "TIFF" porque é assim que
 * ele *reconstrói/expõe* esse dado ao extrair com `-b`, não porque o
 * arquivo grava um TIFF literal nesse ponto.
 *
 * Este módulo mantém, como plano B, uma busca pela assinatura TIFF
 * dentro do registro — caso algum outro arquivo real venha embrulhado
 * de outra forma, ele ainda funciona sem precisar de código novo.
 *
 * Este módulo NÃO calcula temperaturas — apenas localiza e devolve os
 * bytes brutos de pixel (e a forma de interpretá-los).
 */

const JPEG_SOI = 0xffd8;
const APP1_MARKER = 0xffe1;
const FLIR_APP1_IDENTIFIER = [0x46, 0x4c, 0x49, 0x52, 0x00]; // "FLIR\0"
const FFF_HEADER_LENGTH = 0x40;
const FFF_RECORD_ENTRY_SIZE = 0x20;

export const FFF_RECORD_TYPE = {
  RAW_DATA: 0x01,
  CAMERA_INFO: 0x20,
};

// Janela de busca por uma assinatura TIFF dentro do registro RawData —
// usada só como plano B (ver nota acima). 4 KB é mais que suficiente
// para qualquer cabeçalho real; o registro inteiro costuma ter dezenas
// de KB de pixels depois disso.
const TIFF_SIGNATURE_SEARCH_WINDOW = 4096;

// Limites de sanidade para width/height lidos do cabeçalho interno —
// qualquer câmera térmica real fica muito abaixo disso.
const MAX_SANE_DIMENSION = 2000;

/**
 * Localiza e devolve os dados térmicos brutos do registro RawData, já
 * identificando qual dos dois formatos encontrados na prática se
 * aplica a este arquivo.
 *
 * @param {ArrayBuffer} jpegArrayBuffer - JPEG completo.
 * @returns {
 *   | { mode: 'raw', width: number, height: number, littleEndian: boolean, pixelBytes: Uint8Array }
 *   | { mode: 'tiff', tiffBytes: Uint8Array }
 * }
 */
export function extractRawThermalPayload(jpegArrayBuffer) {
  const flirBlob = reconstructFlirBlob(jpegArrayBuffer);
  const directory = parseFffDirectory(flirBlob);

  const rawDataRecord = directory.records.get(FFF_RECORD_TYPE.RAW_DATA);
  if (!rawDataRecord) {
    throw new Error('flirExtractor: registro RawData (tipo 0x01) não encontrado no diretório FFF.');
  }

  const recordStart = rawDataRecord.offset;
  const recordEnd = rawDataRecord.offset + rawDataRecord.length;

  if (recordEnd > flirBlob.length || recordStart >= recordEnd) {
    throw new Error('flirExtractor: registro RawData aponta para fora dos limites do bloco FLIR.');
  }

  // Plano A (confirmado com arquivo real): cabeçalho pequeno com
  // width/height inline, seguido de pixels de 16 bits crus.
  const rawAttempt = tryParseRawHeader(flirBlob, recordStart, recordEnd, directory.littleEndian);
  if (rawAttempt) return rawAttempt;

  // Plano B: procura uma assinatura TIFF dentro do registro, caso este
  // arquivo específico venha embrulhado de outra forma.
  const searchEnd = Math.min(recordStart + TIFF_SIGNATURE_SEARCH_WINDOW, recordEnd - 4);
  for (let offset = recordStart; offset <= searchEnd; offset++) {
    if (looksLikeTiffHeader(flirBlob.subarray(offset, offset + 4))) {
      return { mode: 'tiff', tiffBytes: flirBlob.subarray(offset, recordEnd) };
    }
  }

  const previewLength = Math.min(48, recordEnd - recordStart);
  const preview = Array.from(flirBlob.subarray(recordStart, recordStart + previewLength))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  throw new Error(
    'flirExtractor: não consegui interpretar o registro RawData nem como cabeçalho cru ' +
    `(largura×altura implícitas não bateram com o tamanho do registro, ${rawDataRecord.length} bytes) ` +
    `nem encontrando uma assinatura TIFF nos primeiros ${TIFF_SIGNATURE_SEARCH_WINDOW} bytes. ` +
    `Primeiros ${previewLength} bytes do registro, em hexadecimal: ${preview}`
  );
}

/**
 * Tenta interpretar o registro como [cabeçalho pequeno com width/height
 * inline] + [pixels de 16 bits crus]. Confirma a hipótese checando se
 * "tamanho do registro − width×height×2" dá um cabeçalho de tamanho
 * plausível (achado real: 32 bytes) — se não bater, devolve null e
 * quem chamou tenta o plano B.
 */
function tryParseRawHeader(flirBlob, recordStart, recordEnd, littleEndian) {
  if (recordEnd - recordStart < 8) return null;

  const view = new DataView(flirBlob.buffer, flirBlob.byteOffset + recordStart, recordEnd - recordStart);
  const width = view.getUint16(2, littleEndian);
  const height = view.getUint16(4, littleEndian);

  if (!(width > 0 && width <= MAX_SANE_DIMENSION && height > 0 && height <= MAX_SANE_DIMENSION)) {
    return null;
  }

  const pixelBytesNeeded = width * height * 2;
  const headerLength = recordEnd - recordStart - pixelBytesNeeded;

  // Cabeçalho precisa ser pequeno e não-negativo — um valor grande ou
  // negativo aqui indica que width/height lidos não eram isso de fato
  // (coincidência de bytes), então rejeitamos e deixamos o plano B tentar.
  if (headerLength < 0 || headerLength > 256) return null;

  const pixelStart = recordStart + headerLength;
  return {
    mode: 'raw',
    width,
    height,
    littleEndian,
    pixelBytes: flirBlob.subarray(pixelStart, recordEnd),
  };
}

/**
 * Reconstrói o container binário FLIR completo (cabeçalho FFF + diretório
 * + registros), remontando os segmentos APP1 "FLIR\0" fragmentados do JPEG.
 * Exportado para reuso por outros módulos internos (ex.: extração de
 * metadados radiométricos), evitando duplicar a lógica de remontagem.
 * @param {ArrayBuffer} jpegArrayBuffer
 * @returns {Uint8Array}
 */
export function reconstructFlirBlob(jpegArrayBuffer) {
  if (!(jpegArrayBuffer instanceof ArrayBuffer)) {
    throw new Error('flirExtractor: entrada deve ser um ArrayBuffer contendo o JPEG.');
  }

  const view = new DataView(jpegArrayBuffer);
  const bytes = new Uint8Array(jpegArrayBuffer);

  if (bytes.length < 4 || view.getUint16(0, false) !== JPEG_SOI) {
    throw new Error('flirExtractor: arquivo não começa com uma assinatura JPEG (SOI) válida.');
  }

  const chunks = collectFlirChunks(view, bytes);

  if (chunks.length === 0) {
    throw new Error(
      'flirExtractor: nenhum segmento APP1 "FLIR" foi encontrado neste JPEG. ' +
      'Este arquivo provavelmente não é uma imagem radiométrica FLIR.'
    );
  }

  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const totalLength = ordered.reduce((sum, c) => sum + c.data.length, 0);
  const blob = new Uint8Array(totalLength);

  let cursor = 0;
  for (const chunk of ordered) {
    blob.set(chunk.data, cursor);
    cursor += chunk.data.length;
  }

  return blob;
}

/**
 * Interpreta o cabeçalho FFF (64 bytes) e o diretório de registros que o segue.
 * @param {Uint8Array} flirBlob
 * @returns {{ littleEndian: boolean, records: Map<number, {offset:number, length:number}> }}
 */
export function parseFffDirectory(flirBlob) {
  if (flirBlob.length < FFF_HEADER_LENGTH) {
    throw new Error('flirExtractor: bloco FLIR reconstruído é curto demais para conter um cabeçalho FFF.');
  }

  const view = new DataView(flirBlob.buffer, flirBlob.byteOffset, flirBlob.byteLength);

  const signature = String.fromCharCode(flirBlob[0], flirBlob[1], flirBlob[2]);
  if (signature !== 'FFF' && signature !== 'AFF') {
    throw new Error(`flirExtractor: assinatura de container inválida (esperado "FFF\\0", encontrado "${signature}").`);
  }

  // O byte order do container é determinado testando as DUAS ordens e
  // pontuando qual delas produz valores plausíveis em três campos
  // (versão, offset do diretório, número de entradas) — não só a
  // versão isolada. Checar um único campo já se mostrou frágil na
  // prática: para pelo menos um arquivo real, o valor de versão lido
  // como big-endian "por coincidência" caía dentro do intervalo válido
  // (100–199), fazendo o código parar aí e nunca chegar a testar
  // little-endian — mesmo o arquivo sendo little-endian de verdade
  // (confirmado via ExifTool: MakerNoteByteOrder=II nesta câmera).
  const candidateLE = readHeaderCandidate(view, true, flirBlob.length);
  const candidateBE = readHeaderCandidate(view, false, flirBlob.length);

  let littleEndian;
  if (candidateLE.score >= candidateBE.score && candidateLE.versionOk) {
    littleEndian = true;
  } else if (candidateBE.versionOk) {
    littleEndian = false;
  } else if (candidateLE.versionOk) {
    littleEndian = true;
  } else {
    throw new Error(
      'flirExtractor: versão de container FFF não plausível em nenhuma das duas ordens de bytes ' +
      `(little-endian: ${candidateLE.version}, big-endian: ${candidateBE.version}).`
    );
  }

  const { directoryOffset, entryCount } = littleEndian ? candidateLE : candidateBE;

  const records = new Map();

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = directoryOffset + i * FFF_RECORD_ENTRY_SIZE;
    if (entryOffset + FFF_RECORD_ENTRY_SIZE > flirBlob.length) {
      throw new Error(`flirExtractor: entrada ${i} do diretório FFF ultrapassa os limites do bloco.`);
    }

    const recordType = view.getUint16(entryOffset + 0x00, littleEndian);
    if (recordType === 0) continue; // registro vazio/livre

    const recordOffset = view.getUint32(entryOffset + 0x0c, littleEndian);
    const recordLength = view.getUint32(entryOffset + 0x10, littleEndian);

    records.set(recordType, { offset: recordOffset, length: recordLength });
  }

  return { littleEndian, records };
}

/**
 * Lê os três campos-chave do cabeçalho FFF numa ordem de bytes
 * candidata e devolve uma pontuação de quão plausíveis eles são —
 * usado para decidir entre little-endian e big-endian sem depender de
 * um único campo (ver comentário acima).
 */
function readHeaderCandidate(view, littleEndian, blobLength) {
  const version = view.getUint32(0x14, littleEndian);
  const directoryOffset = view.getUint32(0x18, littleEndian);
  const entryCount = view.getUint32(0x1c, littleEndian);

  const versionOk = version >= 100 && version < 200;
  const directoryOk = directoryOffset > 0 && directoryOffset < blobLength;
  const entryCountOk = entryCount > 0 && entryCount < 200;

  const score = (versionOk ? 1 : 0) + (directoryOk ? 1 : 0) + (entryCountOk ? 1 : 0);

  return { version, directoryOffset, entryCount, versionOk, directoryOk, entryCountOk, score };
}

function hasFlirIdentifier(bytes, start) {
  if (start + FLIR_APP1_IDENTIFIER.length > bytes.length) return false;
  for (let i = 0; i < FLIR_APP1_IDENTIFIER.length; i++) {
    if (bytes[start + i] !== FLIR_APP1_IDENTIFIER[i]) return false;
  }
  return true;
}

/**
 * Estrutura de um segmento APP1 "FLIR\0":
 *   [0..4]  "FLIR\0"  (5 bytes de identificador)
 *   [5]     byte de versão/tipo
 *   [6]     índice do chunk atual (0-based)
 *   [7]     total de chunks
 *   [8..]   payload deste chunk
 */
function parseFlirSegment(bytes, start, end) {
  const headerLength = 8; // 5 bytes "FLIR\0" + 3 bytes de cabeçalho de chunk
  const payloadStart = start + headerLength;

  if (payloadStart > end) return null;

  const chunkIndex = bytes[start + 6];
  return { index: chunkIndex, data: bytes.subarray(payloadStart, end) };
}

function collectFlirChunks(view, bytes) {
  const chunks = [];
  let offset = 2; // pula o SOI

  while (offset < bytes.length - 1) {
    const marker = view.getUint16(offset, false);
    offset += 2;

    if (marker === 0xffda || marker === 0xffd9) break; // SOS ou EOI: fim dos metadados
    if (marker >= 0xffd0 && marker <= 0xffd7) continue; // RST/TEM: sem payload

    if (offset + 2 > bytes.length) break;

    const segmentLength = view.getUint16(offset, false);
    const segmentDataStart = offset + 2;
    const segmentDataEnd = offset + segmentLength;

    if (segmentDataEnd > bytes.length) break;

    if (marker === APP1_MARKER && hasFlirIdentifier(bytes, segmentDataStart)) {
      const chunk = parseFlirSegment(bytes, segmentDataStart, segmentDataEnd);
      if (chunk) chunks.push(chunk);
    }

    offset = segmentDataEnd;
  }

  return chunks;
}

function looksLikeTiffHeader(bytes) {
  if (bytes.length < 4) return false;
  const isLittleEndian = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const isBigEndian = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  return isLittleEndian || isBigEndian;
}
