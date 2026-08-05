/**
 * flirMetadata.js
 *
 * Módulo interno (não é a interface pública do parser — quem o consome
 * é apenas thermalParser.js). Responsabilidade única: ler o registro
 * "CameraInfo" (tipo 0x20) do container FFF da FLIR e extrair os
 * parâmetros radiométricos necessários para a equação de Planck, além
 * de informações descritivas da câmera.
 *
 * Reaproveita a remontagem do container e o parsing do diretório de
 * registros já implementados em flirExtractor.js, para não duplicar
 * essa lógica.
 */

import { reconstructFlirBlob, parseFffDirectory, FFF_RECORD_TYPE } from './flirExtractor.js';

// Offsets documentados do registro CameraInfo (formato público do FFF da FLIR).
// Ainda não validados byte a byte contra um arquivo real da E50 — ver nota
// no README sobre a validação pendente.
const CAMERA_INFO_OFFSET = {
  EMISSIVITY: 0x20,
  OBJECT_DISTANCE: 0x24,
  REFLECTED_APPARENT_TEMPERATURE_K: 0x28,
  ATMOSPHERIC_TEMPERATURE_K: 0x2c,
  IR_WINDOW_TEMPERATURE_K: 0x30,
  IR_WINDOW_TRANSMISSION: 0x34,
  RELATIVE_HUMIDITY: 0x3c,
  PLANCK_R1: 0x58,
  PLANCK_B: 0x5c,
  PLANCK_F: 0x60,
  ATMOSPHERIC_TRANS_ALPHA1: 0x70,
  ATMOSPHERIC_TRANS_ALPHA2: 0x74,
  ATMOSPHERIC_TRANS_BETA1: 0x78,
  ATMOSPHERIC_TRANS_BETA2: 0x7c,
  ATMOSPHERIC_TRANS_X: 0x80,
  CAMERA_MODEL: 0xd4,
  CAMERA_SERIAL_NUMBER: 0x104,
  PLANCK_O: 0x308,
  PLANCK_R2: 0x30c,
};

const KELVIN_OFFSET = 273.15;

/**
 * @param {ArrayBuffer} jpegArrayBuffer
 * @returns {{
 *   radiometricParams: object, // pronto para uso em planck.rawToTemperature()
 *   info: object               // metadados descritivos (modelo, número de série etc.)
 * }}
 */
export function extractFlirMetadata(jpegArrayBuffer) {
  const flirBlob = reconstructFlirBlob(jpegArrayBuffer);
  const directory = parseFffDirectory(flirBlob);

  const cameraInfoRecord = directory.records.get(FFF_RECORD_TYPE.CAMERA_INFO);
  if (!cameraInfoRecord) {
    throw new Error('flirMetadata: registro CameraInfo (tipo 0x20) não encontrado no diretório FFF.');
  }

  const recordEnd = cameraInfoRecord.offset + cameraInfoRecord.length;
  if (recordEnd > flirBlob.length) {
    throw new Error('flirMetadata: registro CameraInfo aponta para fora dos limites do bloco FLIR.');
  }

  const view = new DataView(flirBlob.buffer, flirBlob.byteOffset + cameraInfoRecord.offset, cameraInfoRecord.length);
  const littleEndian = directory.littleEndian;

  const readFloat = (offset) => view.getFloat32(offset, littleEndian);
  const readInt32 = (offset) => view.getInt32(offset, littleEndian);
  const readString = (offset, maxLength) => readNullTerminatedString(view, offset, maxLength);

  const reflectedApparentTemperatureK = readFloat(CAMERA_INFO_OFFSET.REFLECTED_APPARENT_TEMPERATURE_K);
  const atmosphericTemperatureK = readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TEMPERATURE_K);
  const irWindowTemperatureK = readFloat(CAMERA_INFO_OFFSET.IR_WINDOW_TEMPERATURE_K);

  const relativeHumidityRaw = readFloat(CAMERA_INFO_OFFSET.RELATIVE_HUMIDITY);
  // O valor pode vir como fração (0..1) ou já multiplicado por 100; normalizamos para fração.
  const relativeHumidityFraction = relativeHumidityRaw > 2 ? relativeHumidityRaw / 100 : relativeHumidityRaw;

  const radiometricParams = {
    emissivity: readFloat(CAMERA_INFO_OFFSET.EMISSIVITY),
    objectDistance: readFloat(CAMERA_INFO_OFFSET.OBJECT_DISTANCE),
    reflectedApparentTemperature: reflectedApparentTemperatureK - KELVIN_OFFSET,
    atmosphericTemperature: atmosphericTemperatureK - KELVIN_OFFSET,
    irWindowTemperature: irWindowTemperatureK - KELVIN_OFFSET,
    irWindowTransmission: readFloat(CAMERA_INFO_OFFSET.IR_WINDOW_TRANSMISSION),
    relativeHumidity: relativeHumidityFraction * 100,
    planckR1: readFloat(CAMERA_INFO_OFFSET.PLANCK_R1),
    planckB: readFloat(CAMERA_INFO_OFFSET.PLANCK_B),
    planckF: readFloat(CAMERA_INFO_OFFSET.PLANCK_F),
    planckO: readInt32(CAMERA_INFO_OFFSET.PLANCK_O),
    planckR2: readFloat(CAMERA_INFO_OFFSET.PLANCK_R2),
    atmosphericTransAlpha1: readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TRANS_ALPHA1),
    atmosphericTransAlpha2: readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TRANS_ALPHA2),
    atmosphericTransBeta1: readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TRANS_BETA1),
    atmosphericTransBeta2: readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TRANS_BETA2),
    atmosphericTransX: readFloat(CAMERA_INFO_OFFSET.ATMOSPHERIC_TRANS_X),
  };

  validateRadiometricParams(radiometricParams);

  const info = {
    cameraModel: readString(CAMERA_INFO_OFFSET.CAMERA_MODEL, 32),
    cameraSerialNumber: readString(CAMERA_INFO_OFFSET.CAMERA_SERIAL_NUMBER, 16),
    emissivity: radiometricParams.emissivity,
    objectDistance: radiometricParams.objectDistance,
    atmosphericTemperature: radiometricParams.atmosphericTemperature,
    relativeHumidity: radiometricParams.relativeHumidity,
  };

  return { radiometricParams, info };
}

function readNullTerminatedString(view, offset, maxLength) {
  const chars = [];
  for (let i = 0; i < maxLength && offset + i < view.byteLength; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function validateRadiometricParams(params) {
  const numericFields = Object.keys(params);
  const invalid = numericFields.filter((key) => !Number.isFinite(params[key]));
  if (invalid.length > 0) {
    throw new Error(
      `flirMetadata: valores radiométricos inválidos (não numéricos) para: ${invalid.join(', ')}. ` +
      'O registro CameraInfo pode estar corrompido ou em um layout de câmera não suportado.'
    );
  }
}
