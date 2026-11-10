/**
 * A minimal QR encoder — byte mode, error-correction level M, versions 1-9
 * (up to 182 bytes), which is ample for a join URL.
 *
 * Inlined rather than pulled from a CDN on purpose: the host screen is often
 * the least reliable machine in the room, on venue wifi, and a QR that fails
 * to render is worse than no QR at all.
 *
 * Verified module-for-module against the `segno` reference encoder — see
 * test/qr.spec.ts.
 */

// Level M, versions 1-9: [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
const RS_BLOCKS = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
};

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

// ---- GF(256) with primitive polynomial 0x11d ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generator(count);
  const result = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < count; i++) result[i] ^= mul(gen[i + 1], factor);
  }
  return result;
}

// ---- bit stream ----

function buildCodewords(bytes, version) {
  const [ecPerBlock, g1, d1, g2, d2] = RS_BLOCKS[version];
  const totalData = g1 * d1 + g2 * d2;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // versions 1-9 use an 8-bit count in byte mode
  for (const b of bytes) push(b, 8);

  // Terminator, then pad to a byte boundary, then alternating pad bytes.
  const capacity = totalData * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // Pad bytes always begin at 0xEC and alternate from there, regardless of how
  // many data codewords preceded them.
  for (let pad = 0; codewords.length < totalData; pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  // Split into blocks, compute ECC, then interleave both halves.
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d2;
    const data = codewords.slice(offset, offset + size);
    offset += size;
    blocks.push({ data, ec: ecCodewords(data, ecPerBlock) });
  }

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// ---- BCH for format and version information ----

function bch(value, generatorPoly, bitLength) {
  let result = value << (bitLength - 1);
  const genBits = 32 - Math.clz32(generatorPoly);
  while (32 - Math.clz32(result) >= genBits) {
    result ^= generatorPoly << (32 - Math.clz32(result) - genBits);
  }
  return result;
}

/** 15-bit format info: EC level M (0b00) + mask, BCH(15,5), XOR mask applied. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  return (((data << 10) | bch(data, 0b10100110111, 11)) ^ 0b101010000010010);
}

/** 18-bit version info, only present from version 7. */
function versionBits(version) {
  return (version << 12) | bch(version, 0b1111100100101, 13);
}

// ---- matrix ----

function buildMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, value) => {
    modules[r][c] = value;
    reserved[r][c] = true;
  };

  // Finder patterns with their separators.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, (onBorder && r >= 0 && r <= 6 && c >= 0 && c <= 6) || inCore ? 1 : 0);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns, skipping those that would collide with a finder.
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // Dark module, plus reserving the format-info strips.
  set(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) set(8, i, 0);
    if (!reserved[i][8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) set(8, size - 1 - i, 0);
    if (!reserved[size - 1 - i][8]) set(size - 1 - i, 8, 0);
  }

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  return { modules, reserved, size };
}

function placeData(modules, reserved, size, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern column is skipped
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        modules[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(grid, size) {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a line.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = horizontal ? grid[i][j] : grid[j][i];
        const b = horizontal ? grid[i][j - 1] : grid[j - 1][i];
        if (a === b) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules either side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      for (const horizontal of [true, false]) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const v = horizontal ? grid[i][j + k] : grid[j + k][i];
          if (v !== A[k]) matchA = false;
          if (v !== B[k]) matchB = false;
        }
        if (matchA) score += 40;
        if (matchB) score += 40;
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** Smallest version that fits the payload, or null if it doesn't fit at all. */
function pickVersion(byteLength) {
  for (let version = 1; version <= 9; version++) {
    const [, g1, d1, g2, d2] = RS_BLOCKS[version];
    const capacity = g1 * d1 + g2 * d2 - 2; // mode indicator + count byte
    if (byteLength <= capacity) return version;
  }
  return null;
}

/**
 * Encodes `text` and returns a square array of 0/1 rows, or null if the text
 * is too long. Callers should treat null as "just show the link".
 */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  if (!version) return null;

  const codewords = buildCodewords(bytes, version);
  const { modules, reserved, size } = buildMatrix(version);
  placeData(modules, reserved, size, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = modules.map((row, r) =>
      row.map((value, c) => (reserved[r][c] ? value : value ^ (MASKS[mask](r, c) ? 1 : 0))),
    );
    const bits = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      // Position i counts from the most significant bit: the strip is written
      // MSB-first, not LSB-first.
      const bit = (bits >> (14 - i)) & 1;
      // Top-left strip, split around the timing row/column.
      if (i < 6) grid[8][i] = bit;
      else if (i < 8) grid[8][i + 1] = bit;
      else if (i === 8) grid[7][8] = bit;
      else grid[14 - i][8] = bit;
      // The duplicated copy beside the other two finders.
      if (i < 8) grid[size - 1 - i][8] = bit;
      else grid[8][size - 15 + i] = bit;
    }
    // The second copy's last bit lands on the always-dark module, so restore it.
    grid[size - 8][8] = 1;
    const score = penalty(grid, size);
    if (!best || score < best.score) best = { score, grid };
  }
  return best.grid;
}

/** Renders the matrix as a self-contained SVG string with a quiet zone. */
export function qrSvg(text, { quiet = 4, light = "#f2efe4", dark = "#0e1430" } = {}) {
  const matrix = qrMatrix(text);
  if (!matrix) return null;
  const size = matrix.length;
  const total = size + quiet * 2;

  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code linking to the game">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
