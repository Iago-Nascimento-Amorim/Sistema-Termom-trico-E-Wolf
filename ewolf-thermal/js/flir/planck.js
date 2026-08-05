/**
 * planck.js
 *
 * Responsabilidade única: converter valores RAW (uint16) em
 * temperaturas reais (°C), aplicando a equação radiométrica FLIR
 * (baseada na Lei de Planck) com correção de emissividade, distância,
 * atmosfera, umidade relativa e janela IR.
 *
 * Não lê TIFF. Não lê JPEG. Não conhece offsets. Não conhece resolução
 * além do tamanho do array recebido.
 *
 * Referência: equação radiométrica documentada publicamente e usada por
 * diversas implementações open-source de leitura de imagens FLIR
 * (ex.: projetos "flir-image-extractor" e "ThermImageJ").
 */

// Constantes atmosféricas padrão usadas pela equação de transmissão de Tau
const ATMOSPHERIC_TRANS_ALPHA_1_DEFAULT = 0.006569;
const ATMOSPHERIC_TRANS_ALPHA_2_DEFAULT = 0.01262;
const ATMOSPHERIC_TRANS_BETA_1_DEFAULT = -0.002276;
const ATMOSPHERIC_TRANS_BETA_2_DEFAULT = -0.00667;
const ATMOSPHERIC_TRANS_X_DEFAULT = 1.9;

const KELVIN_OFFSET = 273.15;

/**
 * @param {Uint16Array} rawPixels
 * @param {object} params - parâmetros radiométricos extraídos dos metadados FLIR.
 *   Obrigatórios: planckR1, planckR2, planckB, planckF, planckO, emissivity, objectDistance,
 *   reflectedApparentTemperature, atmosphericTemperature.
 *   Opcionais (com defaults sensatos quando ausentes): relativeHumidity, irWindowTemperature,
 *   irWindowTransmission, atmosphericTransAlpha1/2, atmosphericTransBeta1/2, atmosphericTransX.
 * @returns {Float32Array} temperaturas em graus Celsius, mesmo comprimento de rawPixels.
 */
export function rawToTemperature(rawPixels, params) {
  if (!(rawPixels instanceof Uint16Array)) {
    throw new Error('planck: rawPixels deve ser um Uint16Array.');
  }
  validateRequiredParams(params);

  const {
    planckR1,
    planckR2,
    planckB,
    planckF,
    planckO,
    emissivity,
    objectDistance,
    reflectedApparentTemperature,
    atmosphericTemperature,
    relativeHumidity = 50,
    irWindowTemperature = reflectedApparentTemperature,
    irWindowTransmission = 1,
    atmosphericTransAlpha1 = ATMOSPHERIC_TRANS_ALPHA_1_DEFAULT,
    atmosphericTransAlpha2 = ATMOSPHERIC_TRANS_ALPHA_2_DEFAULT,
    atmosphericTransBeta1 = ATMOSPHERIC_TRANS_BETA_1_DEFAULT,
    atmosphericTransBeta2 = ATMOSPHERIC_TRANS_BETA_2_DEFAULT,
    atmosphericTransX = ATMOSPHERIC_TRANS_X_DEFAULT,
  } = params;

  if (emissivity <= 0 || emissivity > 1) {
    throw new Error(`planck: emissivity deve estar no intervalo (0, 1]. Recebido: ${emissivity}.`);
  }

  // Transmissão atmosférica (tau), considerando o teor de vapor d'água do ar.
  const waterVaporPressure = computeWaterVaporPressure(relativeHumidity, atmosphericTemperature);
  const halfDistance = Math.sqrt(objectDistance / 2);

  const tau =
    atmosphericTransX *
      Math.exp(-halfDistance * (atmosphericTransAlpha1 + atmosphericTransBeta1 * Math.sqrt(waterVaporPressure))) +
    (1 - atmosphericTransX) *
      Math.exp(-halfDistance * (atmosphericTransAlpha2 + atmosphericTransBeta2 * Math.sqrt(waterVaporPressure)));

  const planckParams = { planckR1, planckR2, planckB, planckF, planckO };

  // Radiação refletida (do ambiente, não emitida pelo próprio objeto)
  const reflectedRaw = temperatureToRawRadiance(reflectedApparentTemperature, planckParams);
  const reflectedAttn = ((1 - emissivity) / emissivity) * reflectedRaw;

  // Radiação emitida pela própria atmosfera entre o objeto e a câmera
  const atmosphericRaw = temperatureToRawRadiance(atmosphericTemperature, planckParams);
  const atmosphericAttn = ((1 - tau) / (emissivity * tau)) * atmosphericRaw;

  // Radiação atenuada/emitida pela janela IR (quando presente; irWindowTransmission=1 anula o termo)
  const windowRaw = temperatureToRawRadiance(irWindowTemperature, planckParams);
  const windowAttn =
    irWindowTransmission < 1
      ? ((1 - irWindowTransmission) / (emissivity * tau * irWindowTransmission)) * windowRaw
      : 0;

  const denominator = emissivity * tau * irWindowTransmission;

  const temperatures = new Float32Array(rawPixels.length);
  for (let i = 0; i < rawPixels.length; i++) {
    const objectRaw = rawPixels[i] / denominator - atmosphericAttn - reflectedAttn - windowAttn;
    temperatures[i] = rawRadianceToTemperature(objectRaw, planckParams);
  }

  return temperatures;
}

/**
 * Converte uma temperatura (°C) no valor RAW equivalente que a câmera
 * teria medido de um corpo negro naquela temperatura (inverso da
 * equação de Planck usada pela FLIR).
 */
function temperatureToRawRadiance(temperatureCelsius, { planckR1, planckR2, planckB, planckF, planckO }) {
  const temperatureKelvin = temperatureCelsius + KELVIN_OFFSET;
  return planckR1 / (planckR2 * (Math.exp(planckB / temperatureKelvin) - planckF)) - planckO;
}

/**
 * Converte um valor RAW (já corrigido de emissividade/atmosfera/janela)
 * em temperatura real, em graus Celsius.
 */
function rawRadianceToTemperature(rawValue, { planckR1, planckR2, planckB, planckF, planckO }) {
  const ratio = planckR1 / (planckR2 * (rawValue + planckO)) + planckF;
  return planckB / Math.log(ratio) - KELVIN_OFFSET;
}

/**
 * Pressão de vapor d'água (h2o), usada para estimar a atenuação
 * atmosférica em função da umidade relativa e temperatura do ar.
 */
function computeWaterVaporPressure(relativeHumidityPercent, atmosphericTemperatureCelsius) {
  const h2oSaturation =
    Math.exp(
      1.5587 +
        0.06939 * atmosphericTemperatureCelsius -
        0.00027816 * atmosphericTemperatureCelsius ** 2 +
        0.00000068455 * atmosphericTemperatureCelsius ** 3
    );
  return (relativeHumidityPercent / 100) * h2oSaturation;
}

function validateRequiredParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('planck: parâmetros radiométricos são obrigatórios.');
  }
  const required = [
    'planckR1',
    'planckR2',
    'planckB',
    'planckF',
    'planckO',
    'emissivity',
    'objectDistance',
    'reflectedApparentTemperature',
    'atmosphericTemperature',
  ];
  const missing = required.filter((key) => params[key] === undefined || params[key] === null);
  if (missing.length > 0) {
    throw new Error(`planck: parâmetros radiométricos ausentes: ${missing.join(', ')}.`);
  }
}
