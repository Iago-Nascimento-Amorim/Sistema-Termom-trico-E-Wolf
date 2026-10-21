/**
 * flirMetadata.js
 *
 * Responsabilidade única: ler os registros CameraInfo (0x20) e PiP/geometria
 * (0x2A) do container FLIR. Offsets conferidos contra o ExifTool -v3 dos
 * três arquivos reais (IR, MSX e PiP). O conteúdo é little-endian.
 */

import { FFF_RECORD_TYPE, getRecord } from './flirExtractor.js';

const K = 273.15;

const CAM = {
  EMISSIVITY: 0x20,
  OBJECT_DISTANCE: 0x24,
  REFLECTED_K: 0x28,
  ATMOSPHERIC_K: 0x2c,
  IR_WINDOW_K: 0x30,
  IR_WINDOW_TRANSMISSION: 0x34,
  RELATIVE_HUMIDITY: 0x3c,
  PLANCK_R1: 0x58,
  PLANCK_B: 0x5c,
  PLANCK_F: 0x60,
  ALPHA1: 0x70,
  ALPHA2: 0x74,
  BETA1: 0x78,
  BETA2: 0x7c,
  X: 0x80,
  RANGE_MAX_K: 0x90,
  RANGE_MIN_K: 0x94,
  MAX_CLIP_K: 0x98,
  MIN_CLIP_K: 0x9c,
  MODEL: 0xd4,
  PART_NUMBER: 0xf4,
  SERIAL: 0x104,
  SOFTWARE: 0x114,
  PLANCK_O: 0x308,
  PLANCK_R2: 0x30c,
  RAW_MEDIAN_CAMERA: 0x338,
};

// Registro 0x2A (geometria). Guardado CRU: significado ainda não validado.
const PIP = { REAL2IR: 0, OFFSET_X: 4, OFFSET_Y: 6, X1: 8, X2: 10, Y1: 12, Y2: 14 };

export function extractFlirMetadata(blob, directory) {
  const cam = getRecord(blob, directory, FFF_RECORD_TYPE.CAMERA_INFO);
  if (!cam) throw new Error('flirMetadata: registro CameraInfo (0x20) não encontrado.');
  if (cam.bytes.length < CAM.PLANCK_R2 + 4) throw new Error('flirMetadata: registro CameraInfo curto demais.');

  const le = cam.littleEndian;
  const v = new DataView(cam.bytes.buffer, cam.bytes.byteOffset, cam.bytes.byteLength);
  const f = (o) => v.getFloat32(o, le);
  const str = (o, max) => {
    let s = '';
    for (let i = 0; i < max && o + i < cam.bytes.length; i++) {
      const c = cam.bytes[o + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const rhRaw = f(CAM.RELATIVE_HUMIDITY);
  const rhFraction = rhRaw > 2 ? rhRaw / 100 : rhRaw;

  const radiometricParams = {
    emissivity: f(CAM.EMISSIVITY),
    objectDistance: f(CAM.OBJECT_DISTANCE),
    reflectedApparentTemperature: f(CAM.REFLECTED_K) - K,
    atmosphericTemperature: f(CAM.ATMOSPHERIC_K) - K,
    irWindowTemperature: f(CAM.IR_WINDOW_K) - K,
    irWindowTransmission: f(CAM.IR_WINDOW_TRANSMISSION),
    relativeHumidity: rhFraction * 100,
    planckR1: f(CAM.PLANCK_R1),
    planckR2: f(CAM.PLANCK_R2),
    planckB: f(CAM.PLANCK_B),
    planckF: f(CAM.PLANCK_F),
    planckO: v.getInt32(CAM.PLANCK_O, le),
    atmosphericTransAlpha1: f(CAM.ALPHA1),
    atmosphericTransAlpha2: f(CAM.ALPHA2),
    atmosphericTransBeta1: f(CAM.BETA1),
    atmosphericTransBeta2: f(CAM.BETA2),
    atmosphericTransX: f(CAM.X),
  };

  const bad = Object.keys(radiometricParams).filter((k) => !Number.isFinite(radiometricParams[k]));
  if (bad.length) {
    throw new Error(`flirMetadata: valores radiométricos inválidos: ${bad.join(', ')}. Layout de CameraInfo não suportado?`);
  }

  const info = {
    cameraModel: str(CAM.MODEL, 32),
    cameraPartNumber: str(CAM.PART_NUMBER, 16),
    cameraSerialNumber: str(CAM.SERIAL, 16),
    cameraSoftware: str(CAM.SOFTWARE, 16),
    emissivity: radiometricParams.emissivity,
    objectDistance: radiometricParams.objectDistance,
    atmosphericTemperature: radiometricParams.atmosphericTemperature,
    relativeHumidity: radiometricParams.relativeHumidity,
    cameraRangeC: [f(CAM.RANGE_MIN_K) - K, f(CAM.RANGE_MAX_K) - K],
    clipRangeC: [f(CAM.MIN_CLIP_K) - K, f(CAM.MAX_CLIP_K) - K],
    // Informativo: mediana gravada pela câmera (não é critério de validação).
    rawMedianCamera: v.getUint16(CAM.RAW_MEDIAN_CAMERA, le),
  };

  return { radiometricParams, info, geometry: readGeometry(blob, directory) };
}

function readGeometry(blob, directory) {
  const rec = getRecord(blob, directory, FFF_RECORD_TYPE.PIP);
  if (!rec || rec.bytes.length < 16) return null;
  const v = new DataView(rec.bytes.buffer, rec.bytes.byteOffset, rec.bytes.byteLength);
  const le = true; // confirmado pelo ExifTool: registro 0x2A é little-endian
  return {
    real2IR: v.getFloat32(PIP.REAL2IR, le),
    offsetX: v.getInt16(PIP.OFFSET_X, le),
    offsetY: v.getInt16(PIP.OFFSET_Y, le),
    pipX1: v.getInt16(PIP.X1, le),
    pipX2: v.getInt16(PIP.X2, le),
    pipY1: v.getInt16(PIP.Y1, le),
    pipY2: v.getInt16(PIP.Y2, le),
  };
}
