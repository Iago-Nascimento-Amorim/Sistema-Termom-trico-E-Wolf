/**
 * pngDecoder.js
 *
 * Responsabilidade única: decodificar um PNG cinza de 16 bits (sem
 * interlace) preservando os 16 bits. Não usa canvas/createImageBitmap
 * porque eles reduzem para 8 bits.
 *
 * Devolve os valores "como o PNG manda" (big-endian). Quem decide se
 * precisa trocar os bytes é o thermalParser.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function decodePng16Gray(pngBytes) {
  if (!(pngBytes instanceof Uint8Array)) {
    throw new Error('pngDecoder: entrada deve ser Uint8Array.');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) throw new Error('pngDecoder: assinatura PNG inválida.');
  }

  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let pos = 8;
  let ihdr = null;
  const idat = [];

  while (pos + 8 <= pngBytes.length) {
    const length = view.getUint32(pos, false);
    const type = String.fromCharCode(pngBytes[pos + 4], pngBytes[pos + 5], pngBytes[pos + 6], pngBytes[pos + 7]);
    const dataStart = pos + 8;
    if (dataStart + length > pngBytes.length) throw new Error(`pngDecoder: chunk ${type} ultrapassa o fim dos dados.`);

    if (type === 'IHDR') {
      ihdr = {
        width: view.getUint32(dataStart, false),
        height: view.getUint32(dataStart + 4, false),
        depth: pngBytes[dataStart + 8],
        colorType: pngBytes[dataStart + 9],
        interlace: pngBytes[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(pngBytes.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + length + 4; // +4 = CRC
  }

  if (!ihdr) throw new Error('pngDecoder: IHDR não encontrado.');
  if (ihdr.depth !== 16 || ihdr.colorType !== 0 || ihdr.interlace !== 0) {
    throw new Error(
      `pngDecoder: só PNG cinza 16 bits sem interlace é suportado ` +
      `(recebido: depth=${ihdr.depth}, colorType=${ihdr.colorType}, interlace=${ihdr.interlace}).`
    );
  }
  if (idat.length === 0) throw new Error('pngDecoder: nenhum IDAT encontrado.');

  const compressed = concat(idat);
  const inflated = await inflateZlib(compressed);

  const { width, height } = ihdr;
  const stride = width * 2;
  if (inflated.length < height * (stride + 1)) {
    throw new Error(`pngDecoder: dados descomprimidos insuficientes (${inflated.length} bytes).`);
  }

  const bytesPerPixel = 2;
  const out = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;

    for (let x = 0; x < stride; x++) {
      const raw = inflated[src + x];
      const a = x >= bytesPerPixel ? out[dst + x - bytesPerPixel] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bytesPerPixel && y > 0 ? out[prev + x - bytesPerPixel] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new Error(`pngDecoder: filtro PNG desconhecido (${filter}) na linha ${y}.`);
      }
      out[dst + x] = v & 0xff;
    }
  }

  const values = new Uint16Array(width * height);
  for (let i = 0; i < values.length; i++) {
    values[i] = (out[i * 2] << 8) | out[i * 2 + 1]; // big-endian, como no padrão PNG
  }
  return { width, height, values };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function inflateZlib(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('pngDecoder: este navegador não tem DecompressionStream (necessário para descomprimir o PNG).');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
