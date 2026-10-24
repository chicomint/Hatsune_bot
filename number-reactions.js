const { crc32, deflateSync } = require('node:zlib');

// These are distinct Discord emoji, not text/variation-selector spellings of
// the same emoji. Clocks represent their hour, including half-hour clocks.
const DIGIT_EMOJIS = Object.freeze(Object.fromEntries(Object.entries({
  0: ['0️⃣', '⭕', '🅾️'],
  1: ['1️⃣', '🥇', '🕐', '🕜'],
  2: ['2️⃣', '🥈', '🕑', '🕝'],
  3: ['3️⃣', '🥉', '🕒', '🕞'],
  4: ['4️⃣', '🕓', '🕟'],
  5: ['5️⃣', '🕔', '🕠'],
  6: ['6️⃣', '🕕', '🕡'],
  7: ['7️⃣', '🕖', '🕢'],
  8: ['8️⃣', '🕗', '🕣', '🎱'],
  9: ['9️⃣', '🕘', '🕤'],
}).map(([digit, emojis]) => [digit, Object.freeze(emojis)])));

// There are only a few suitable Unicode emoji for each digit. Further repeats
// use actual digit images owned by the application, without guild emoji slots
// or Use External Emojis permission. Share in-flight uploads across channels.
const applicationStates = new WeakMap();
async function applicationDigit(manager, digit, occurrence) {
  if (!manager) throw new Error('LASTLETTER_APPLICATION_EMOJIS_UNAVAILABLE');
  let state = applicationStates.get(manager);
  if (!state) {
    state = { fetched: null, pending: new Map() };
    applicationStates.set(manager, state);
  }
  const name = `lastletter_digit_${digit}_${occurrence + 1}`;
  if (!state.pending.has(name)) {
    const pending = (async () => {
      if (!state.fetched) {
        state.fetched = manager.fetch().catch(error => { state.fetched = null; throw error; });
      }
      await state.fetched;
      const emoji = manager.cache.find(entry => entry.name === name)
        || await manager.create({ name, attachment: digitImage(digit, occurrence) });
      return `<:${emoji.name}:${emoji.id}>`;
    })();
    state.pending.set(name, pending);
    // A failed upload/fetch can be retried on the next accepted word.
    void pending.catch(() => { state.pending.delete(name); });
  }
  return state.pending.get(name);
}

async function* numberReactions(count, applicationEmojis) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Invalid reaction count');
  const occurrences = new Map();
  const used = new Set();
  for (const digit of String(count)) {
    const occurrence = occurrences.get(digit) || 0;
    const emoji = DIGIT_EMOJIS[digit][occurrence]
      || await applicationDigit(applicationEmojis, digit, occurrence);
    if (used.has(emoji)) throw new Error('LASTLETTER_DUPLICATE_REACTION');
    occurrences.set(digit, occurrence + 1);
    used.add(emoji);
    yield emoji;
  }
}

// Render small, readable numeral PNGs using only Node built-ins. Every extra
// occurrence has its own application emoji ID, even when images look alike.
const GLYPHS = [
  [14, 17, 19, 21, 25, 17, 14], [4, 12, 4, 4, 4, 4, 14],
  [14, 17, 1, 2, 4, 8, 31], [30, 1, 1, 14, 1, 1, 30],
  [2, 6, 10, 18, 31, 2, 2], [31, 16, 16, 30, 1, 1, 30],
  [14, 16, 16, 30, 17, 17, 14], [31, 1, 2, 4, 8, 8, 8],
  [14, 17, 17, 14, 17, 17, 14], [14, 17, 17, 15, 1, 1, 14],
];
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
function digitImage(digit, occurrence) {
  const size = 128;
  const colors = [[88, 101, 242], [35, 115, 80], [170, 65, 100], [120, 75, 180]];
  const color = colors[occurrence % colors.length];
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - 34) / 12), gy = Math.floor((y - 22) / 12);
      const ink = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && (GLYPHS[digit][gy] & (1 << (4 - gx)));
      const offset = y * (1 + size * 4) + 1 + x * 4;
      rows[offset] = ink ? 255 : color[0];
      rows[offset + 1] = ink ? 255 : color[1];
      rows[offset + 2] = ink ? 255 : color[2];
      rows[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA.
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

module.exports = { DIGIT_EMOJIS, numberReactions };
