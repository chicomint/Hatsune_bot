const { test } = require('node:test');
const assert = require('node:assert/strict');
const { crc32, inflateSync } = require('node:zlib');
const { Client, Collection, MessageManager } = require('discord.js');
const { DIGIT_EMOJIS, numberReactions } = require('./number-reactions');
const { LastLetter, submissionReactions } = require('./lastletter');

async function collect(reactions) {
  const result = [];
  for await (const emoji of reactions) result.push(emoji);
  return result;
}

function applicationEmojis({ existing = [], fetchFailures = 0, createFailures = 0 } = {}) {
  return {
    cache: new Collection(existing.map(emoji => [emoji.id, emoji])), fetches: 0, uploads: [],
    async fetch() {
      this.fetches++;
      if (fetchFailures-- > 0) throw new Error('Discord fetch failed');
      return this.cache;
    },
    async create(upload) {
      this.uploads.push(upload);
      if (createFailures-- > 0) throw new Error('Discord upload failed');
      const emoji = { id: String(100000000000000000n + BigInt(this.uploads.length)), name: upload.name };
      this.cache.set(emoji.id, emoji);
      return emoji;
    },
  };
}

function fixture(count, manager) {
  let game = { _id: 'guild:channel', active: true, requiredLetter: 'a', lastPlayerId: 'previous',
    usedWords: Array.from({ length: count - 1 }, (_, i) => `previous-word-${i}`),
    players: [], pendingBests: {}, revision: 0 };
  const before = structuredClone(game), reactions = [], failures = [], sent = [];
  const store = {
    read: async () => structuredClone(game),
    commit: async (_, changes) => { game = { ...game, ...changes, revision: game.revision + 1 }; return structuredClone(game); },
    flush: async () => {}, best: async () => 0,
  };
  const service = new LastLetter({ store, words: new Set(['apple']),
    logFailure: context => failures.push(context) });
  const message = { guild: { id: 'guild' }, channel: { id: 'channel', send: async payload => sent.push(payload) },
    author: { id: 'player' }, content: 'apple', client: { application: { emojis: manager } },
    react: async emoji => { reactions.push(emoji); } };
  return { service, message, before, reactions, failures, sent, state: () => game };
}

const examples = [
  [8, ['✅', '8️⃣']], [9, ['✅', '9️⃣']], [10, ['✅', '1️⃣', '0️⃣']],
  [11, ['✅', '1️⃣', '🥇']], [12, ['✅', '1️⃣', '2️⃣']], [22, ['✅', '2️⃣', '🥈']],
  [98, ['✅', '9️⃣', '8️⃣']], [99, ['✅', '9️⃣', '🕘']],
  [100, ['✅', '1️⃣', '0️⃣', '⭕']], [101, ['✅', '1️⃣', '0️⃣', '🥇']],
  [102, ['✅', '1️⃣', '0️⃣', '2️⃣']], [111, ['✅', '1️⃣', '🥇', '🕐']],
  [222, ['✅', '2️⃣', '🥈', '🕑']], [333, ['✅', '3️⃣', '🥉', '🕒']],
  [444, ['✅', '4️⃣', '🕓', '🕟']], [555, ['✅', '5️⃣', '🕔', '🕠']],
  [666, ['✅', '6️⃣', '🕕', '🕡']], [777, ['✅', '7️⃣', '🕖', '🕢']],
  [888, ['✅', '8️⃣', '🕗', '🕣']], [999, ['✅', '9️⃣', '🕘', '🕤']],
  [1000, ['✅', '1️⃣', '0️⃣', '⭕', '🅾️']], [1111, ['✅', '1️⃣', '🥇', '🕐', '🕜']],
  [2222, ['✅', '2️⃣', '🥈', '🕑', '🕝']], [9090, ['✅', '9️⃣', '0️⃣', '🕘', '⭕']],
];
for (const [count, expected] of examples) {
  test(`accepted word ${count} gets ordered, unique reactions without changing counting`, async () => {
    const { service, message, reactions, failures, sent, before, state } = fixture(count);
    await service.handleMessage(message);
    assert.deepEqual(reactions, expected);
    assert.equal(new Set(reactions).size, reactions.length);
    assert.deepEqual(failures, []); assert.deepEqual(sent, []);
    assert.deepEqual(state().usedWords, [...before.usedWords, 'apple']);
    assert.equal(state().revision, before.revision + 1);
    assert.equal(state().lastPlayerId, 'player');
    assert.equal(state().players[0].validWords, 1);
  });
}

test('all Unicode alternatives are globally distinct even after stripping variation selectors', () => {
  const emojis = Object.values(DIGIT_EMOJIS).flat().map(emoji => emoji.replace(/\uFE0F/g, ''));
  assert.equal(new Set(emojis).size, emojis.length);
  for (const variants of Object.values(DIGIT_EMOJIS)) assert.ok(variants.length >= 3);
});

test('occurrences reset per message and successive counts never skip a digit', async () => {
  const manager = applicationEmojis();
  for (let count = 0; count <= 12000; count++) {
    const reactions = await collect(numberReactions(count, manager));
    assert.equal(reactions.length, String(count).length, `digit count for ${count}`);
    assert.equal(new Set(reactions).size, reactions.length, `unique emoji for ${count}`);
    const decoded = reactions.map(emoji => {
      const digit = Object.keys(DIGIT_EMOJIS).find(key => DIGIT_EMOJIS[key].includes(emoji));
      return digit ?? /lastletter_digit_(\d)_/.exec(emoji)[1];
    }).join('');
    assert.equal(decoded, String(count));
  }
  assert.deepEqual(await collect(numberReactions(11)), ['1️⃣', '🥇']);
  assert.deepEqual(await collect(numberReactions(11)), ['1️⃣', '🥇']);
});

test('long repeats for every digit use reusable custom numerals after Unicode alternatives run out', async () => {
  const manager = applicationEmojis();
  for (let digit = 0; digit <= 9; digit++) {
    // Nine repeats are representable by the existing array-length counter;
    // zero needs a leading nonzero digit to preserve every zero position.
    const count = digit === 0 ? 1000000000 : Number(String(digit).repeat(9));
    const reactions = await collect(numberReactions(count, manager));
    assert.equal(reactions.length, String(count).length);
    assert.equal(new Set(reactions).size, reactions.length);
    assert.deepEqual(reactions.slice(digit === 0 ? 1 : 0, (digit === 0 ? 1 : 0) + DIGIT_EMOJIS[digit].length), DIGIT_EMOJIS[digit]);
    assert.ok(reactions.at(-1).includes(`lastletter_digit_${digit}_9`));
    const uploads = manager.uploads.length;
    assert.deepEqual(await collect(numberReactions(count, manager)), reactions);
    assert.equal(manager.uploads.length, uploads);
  }
  assert.equal(manager.fetches, 1);
  assert.equal((await collect(numberReactions(Number.MAX_SAFE_INTEGER, manager))).length, 16);
});

test('simultaneous channels share each pending application emoji upload', async () => {
  const manager = applicationEmojis();
  const [one, two] = await Promise.all([collect(numberReactions(77777, manager)), collect(numberReactions(77777, manager))]);
  assert.deepEqual(one, two);
  assert.equal(manager.fetches, 1); assert.equal(manager.uploads.length, 2);
  assert.deepEqual(manager.uploads.map(upload => upload.name), ['lastletter_digit_7_4', 'lastletter_digit_7_5']);
});

test('an accepted word uses a custom numeral for its fourth seven without count notices', async () => {
  const manager = applicationEmojis();
  const { service, message, reactions, failures, sent, state } = fixture(7777, manager);
  await service.handleMessage(message);
  assert.deepEqual(reactions, ['✅', '7️⃣', '🕖', '🕢', '<:lastletter_digit_7_4:100000000000000001>']);
  assert.deepEqual(failures, []); assert.deepEqual(sent, []);
  assert.equal(state().usedWords.length, 7777); assert.equal(state().lastPlayerId, 'player');
});

test('application emoji uploaded in a previous process are found by name instead of recreated', async () => {
  const emoji = { id: '123456789012345678', name: 'lastletter_digit_7_4' };
  const manager = applicationEmojis({ existing: [emoji] });
  assert.deepEqual(await collect(numberReactions(7777, manager)), ['7️⃣', '🕖', '🕢', `<:${emoji.name}:${emoji.id}>`]);
  assert.equal(manager.fetches, 1); assert.equal(manager.uploads.length, 0);
});

for (const failure of ['fetchFailures', 'createFailures']) {
  test(`a failed custom emoji ${failure} is logged without changing the accepted count and can recover`, async () => {
    const manager = applicationEmojis({ [failure]: 1 });
    const { service, message, reactions, failures, state } = fixture(7777, manager);
    await assert.doesNotReject(service.handleMessage(message));
    assert.equal(state().usedWords.length, 7777); assert.equal(state().lastPlayerId, 'player');
    assert.deepEqual(reactions, ['✅', '7️⃣', '🕖', '🕢']);
    assert.deepEqual(failures, ['Last Letter reactions']);
    const recovered = await collect(numberReactions(7777, manager));
    assert.equal(recovered.length, 4); assert.match(recovered.at(-1), /lastletter_digit_7_4/);
  });
}

test('custom numeral attachments are valid 128px PNGs with complete image data', async () => {
  const manager = applicationEmojis();
  await collect(numberReactions(7777, manager));
  const png = manager.uploads[0].attachment;
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = new Map();
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length));
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.equal(offset, png.length);
  assert.equal(chunks.get('IHDR').readUInt32BE(0), 128);
  assert.equal(chunks.get('IHDR').readUInt32BE(4), 128);
  assert.equal(chunks.get('IHDR')[8], 8); assert.equal(chunks.get('IHDR')[9], 6);
  assert.ok(chunks.has('IEND'));
  const pixels = inflateSync(chunks.get('IDAT'));
  assert.equal(pixels.length, 128 * (1 + 128 * 4));
  for (let row = 0; row < 128; row++) assert.equal(pixels[row * (1 + 128 * 4)], 0);
  assert.ok(pixels.includes(255)); assert.ok(png.length < 256 * 1024);
});

test('the installed discord.js library accepts both Unicode and application emoji reaction formats', async () => {
  const client = new Client({ intents: [] }), routes = [];
  client.rest.put = async route => routes.push(route);
  const messages = new MessageManager({ id: '111111111111111111', client });
  const manager = applicationEmojis();
  try {
    for await (const emoji of submissionReactions({ code: 'accepted', game: { usedWords: { length: 7777 } } }, manager)) {
      await messages.react('222222222222222222', emoji);
    }
    assert.equal(routes.length, 5);
    assert.ok(routes[0].endsWith(`/reactions/${encodeURIComponent('✅')}/@me`));
    assert.ok(routes[1].endsWith(`/reactions/${encodeURIComponent('7️⃣')}/@me`));
    assert.ok(routes[4].endsWith(`/reactions/${encodeURIComponent('lastletter_digit_7_4:100000000000000001')}/@me`));
  } finally { client.destroy(); }
});

test('reactions wait for completion before adding the next digit', async () => {
  const { service, message, reactions, state } = fixture(111);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstAdded;
  const started = new Promise(resolve => { firstAdded = resolve; });
  message.react = async emoji => {
    reactions.push(emoji);
    if (emoji === '1️⃣') { firstAdded(); await gate; }
  };
  const handling = service.handleMessage(message);
  await started;
  assert.deepEqual(reactions, ['✅', '1️⃣']);
  release(); await handling;
  assert.deepEqual(reactions, ['✅', '1️⃣', '🥇', '🕐']);
  assert.equal(state().usedWords.length, 111);
});

for (const code of [10008, 10014, 30010, 50001, 50013]) {
  test(`Discord API error ${code} stops the sequence without changing the accepted count or turn`, async () => {
    const { service, message, reactions, failures, state } = fixture(111);
    message.react = async emoji => {
      reactions.push(emoji);
      if (emoji === '🥇') throw Object.assign(new Error('Discord reaction failed'), { code });
    };
    await assert.doesNotReject(service.handleMessage(message));
    assert.deepEqual(reactions, ['✅', '1️⃣', '🥇']);
    assert.deepEqual(failures, ['Last Letter reactions']);
    assert.equal(state().usedWords.length, 111); assert.equal(state().lastPlayerId, 'player');
    assert.equal((await service.submit({ guildId: 'guild', channelId: 'channel', userId: 'player', content: 'apple' })).code, 'cooldown');
  });
}

test('non-accepted submissions keep their existing status reactions', async () => {
  for (const [code, expected] of [['ignored', []], ['cooldown', ['⏳']], ['invalid', ['❌']],
    ['duplicate', ['❌']], ['wrong-letter', ['❌']]]) {
    assert.deepEqual(await collect(submissionReactions({ code })), expected);
  }
});
