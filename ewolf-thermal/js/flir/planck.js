/**
 * planck.js
 *
 * Responsabilidade única: converter RAW (uint16) em °C com a equação
 * radiométrica FLIR (mesma formulação do Thermimage/ExifTool: a atmosfera
 * é tratada em duas metades de distância/2, tau1 = tau2).
 *
 * Não lê JPEG, PNG nem conhece offsets.
 */

const KELVIN = 273.15;

export function rawToTemperature(rawPixels, p) {
  if (!(rawPixels instanceof Uint16Array)) throw new Error('planck: rawPixels deve ser Uint16Array.');
  const required = [
    'planckR1', 'planckR2', 'planckB', 'planckF', 'planckO', 'emissivity', 'objectDistance',
    'reflectedApparentTemperature', 'atmosphericTemperature',
  ];
  const missing = required.filter((k) => p?.[k] === undefined || p[k] === null);
  if (missing.length) throw new Error(`planck: parâmetros ausentes: ${missing.join(', ')}.`);

  const {
    planckR1: R1, planckR2: R2, planckB: B, planckF: F, planckO: O,
    emissivity: E, objectDistance: dist,
    reflectedApparentTemperature: Trefl, atmosphericTemperature: Tatm,
    relativeHumidity = 50,
    irWindowTemperature = Trefl,
    irWindowTransmission = 1,
    atmosphericTransAlpha1: a1 = 0.006569,
    atmosphericTransAlpha2: a2 = 0.01262,
    atmosphericTransBeta1: b1 = -0.002276,
    atmosphericTransBeta2: b2 = -0.00667,
    atmosphericTransX: X = 1.9,
  } = p;

  if (!(E > 0 && E <= 1)) throw new Error(`planck: emissividade fora de (0,1]: ${E}.`);

  const h2o = (relativeHumidity / 100) * Math.exp(
    1.5587 + 0.06939 * Tatm - 0.00027816 * Tatm ** 2 + 0.00000068455 * Tatm ** 3
  );
  const sqrtH2o = Math.sqrt(h2o);
  const half = Math.sqrt(dist / 2);
  const tau = X * Math.exp(-half * (a1 + b1 * sqrtH2o)) + (1 - X) * Math.exp(-half * (a2 + b2 * sqrtH2o));
  const tau1 = tau;
  const tau2 = tau;
  const IRT = irWindowTransmission;

  const tempToRaw = (tC) => R1 / (R2 * (Math.exp(B / (tC + KELVIN)) - F)) - O;

  const rawRefl = tempToRaw(Trefl);
  const rawAtm = tempToRaw(Tatm);
  const rawWin = tempToRaw(irWindowTemperature);

  const reflAttn = ((1 - E) / E) * rawRefl;
  const atm1Attn = ((1 - tau1) / E / tau1) * rawAtm;
  const atm2Attn = ((1 - tau2) / E / tau1 / tau2) * rawAtm;
  const winAttn = ((1 - IRT) / E / tau1 / IRT / tau2) * rawWin;
  const denom = E * tau1 * IRT * tau2;
  const offset = atm1Attn + atm2Attn + winAttn + reflAttn;

  const out = new Float32Array(rawPixels.length);
  for (let i = 0; i < rawPixels.length; i++) {
    const rawObj = rawPixels[i] / denom - offset;
    out[i] = B / Math.log(R1 / (R2 * (rawObj + O)) + F) - KELVIN;
  }
  return out;
}
