const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { PermissionsBitField, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const Guild = require('./models/Guild');
const User = require('./models/User');
const bot = require('./index');
const finder = require('./beatmap-finder');
const definition = require('./osum-command');

afterEach(() => mock.restoreAll());

function slashOptions(values = {}) {
  const get = key => values[key] ?? null;
  return { getString: get, getBoolean: get, getInteger: get, getNumber: get };
}
function beatmap(overrides = {}) {
  return { id: 123, user_id: 7, mode: 'osu', mode_int: 0, convert: false,
    ar: 9, drain: 6, cs: 4, accuracy: 8, bpm: 180, total_length: 150,
    difficulty_rating: 5.2, status: 'ranked', version: 'Another', ...overrides };
}
function beatmapset(maps = [beatmap()]) {
  return { id: 42, user_id: 7, artist: 'xi', title: 'FREEDOM DiVE', creator: 'Mapper', status: 'ranked',
    covers: { cover: 'https://assets.ppy.sh/beatmaps/42/covers/cover.jpg' }, beatmaps: maps };
}
function page(maps = [beatmap()], extras = {}) {
  return { total: 1, beatmapsets: [beatmapset(maps)], cursor_string: null, ...extras };
}

test('all supplied prefix examples parse optional and partial filters without shifting', () => {
  const cases = [
    ['freedom dive', {}], ['freedom dive ar=9', { ar: 9 }],
    ['freedom dive ar=9 hp=6', { ar: 9, hp: 6 }],
    ['freedom dive ar=9 hp=6 cs=4', { ar: 9, hp: 6, cs: 4 }],
    ['freedom dive ar=9 hp=6 cs=4 acc=98', { ar: 9, hp: 6, cs: 4, acc: 98 }],
    ['"freedom dive" 9 6 4 98', { ar: 9, hp: 6, cs: 4, acc: 98 }],
    ['freedom dive ar=9 cs=4', { ar: 9, cs: 4 }],
    ['"freedom dive" 9 - 4 -', { ar: 9, cs: 4 }],
    ['cs=4 freedom dive acc=98 ar=9', { ar: 9, cs: 4, acc: 98 }],
    ['freedom dive hp=6', { hp: 6 }], ['freedom dive cs=4', { cs: 4 }],
    ['freedom dive acc=98', { acc: 98 }],
  ];
  for (const [text, values] of cases) {
    assert.deepEqual(finder.parsePrefix(text), { name: 'freedom dive', random: false, mode: 'osu', ...values }, text);
  }
});

test('random prefix examples need no name and accept positional placeholders', () => {
  for (const [text, values] of [
    ['-r', {}], ['-r ar=9', { ar: 9 }], ['-r hp=6 cs=4', { hp: 6, cs: 4 }],
    ['-r ar=9 hp=6 cs=4 acc=98', { ar: 9, hp: 6, cs: 4, acc: 98 }],
    ['-r 9 6 4 98', { ar: 9, hp: 6, cs: 4, acc: 98 }],
    ['-r 9 - 4 -', { ar: 9, cs: 4 }],
    ['-r ar=9 time=120-180 stars=4.5-6', { ar: 9, time_min: 120, time_max: 180, stars_min: 4.5, stars_max: 6 }],
  ]) assert.deepEqual(finder.parsePrefix(text), { name: '', random: true, mode: 'osu', ...values }, text);
});

test('names with apostrophes, spaces and numeric titles are preserved', () => {
  assert.equal(finder.parsePrefix("can't deflate the party ar=9").name, "can't deflate the party");
  assert.equal(finder.parsePrefix('1984').name, '1984');
  assert.equal(finder.parsePrefix('"Blue Zenith 727" 9').name, 'Blue Zenith 727');
  assert.deepEqual(finder.parsePrefix('-r time_min=120 stars_max=6'),
    { name: '', random: true, mode: 'osu', time_min: 120, stars_max: 6 });
});

test('slash and prefix normalize identically for partial filters, ranges, and modes', () => {
  for (const [prefix, values] of [
    ['freedom dive ar=9 cs=4', { name: 'freedom dive', ar: 9, cs: 4 }],
    ['-r hp=6 cs=4 acc=98 time=120-180 stars=4-6',
      { random: true, hp: 6, cs: 4, acc: 98, time_min: 120, time_max: 180, stars_min: 4, stars_max: 6 }],
    ['-r mode=mania cs=12', { random: true, mode: 'mania', cs: 12 }],
    ['-r mode=catch', { random: true, mode: 'fruits' }],
    ['-r ar=0 hp=0 cs=0 acc=0 time=0 stars=0',
      { random: true, ar: 0, hp: 0, cs: 0, acc: 0, time_min: 0, time_max: 0, stars_min: 0, stars_max: 0 }],
  ]) assert.deepEqual(finder.fromSlash(slashOptions(values)), finder.parsePrefix(prefix));
});

test('invalid numbers, reversed ranges, unknown/duplicate filters and malformed quotes are rejected', () => {
  for (const input of ['-r ar=11', '-r hp=-1', '-r cs=11', '-r acc=101', '-r acc=NaN',
    '-r ar=Infinity', '-r ar=', '-r time=180-120', '-r stars=6-4', '-r time=1.5', '-r time=-1',
    '-r time=90000', '-r stars=101', '-r ar=9 ar=8', '-r nope=1', '-r mode=invalid',
    '"unclosed', '-r 1 2 3 4 5', '"map" 9 ar=8', '-r time=1-2 time_min=1']) {
    assert.throws(() => finder.parsePrefix(input), finder.FinderInputError, input);
  }
  assert.throws(() => finder.fromSlash(slashOptions({ time_min: 180, time_max: 120 })), finder.FinderInputError);
  assert.throws(() => finder.normalizeOptions({ acc: NaN }), finder.FinderInputError);
});

test('query includes each map constraint but never target accuracy or OD', () => {
  const query = finder.buildQuery(finder.parsePrefix('-r ar=9 hp=6 cs=4 acc=98 time=120-180 stars=4-6'));
  assert.equal(query, 'ar=9 hp=6 cs=4 length>=120 length<=180 stars>=4 stars<=6');
  assert.doesNotMatch(query, /acc|98|od=/);
});

test('precise filters use API drain for HP and inspect all stats on the same difficulty', () => {
  const options = finder.parsePrefix('-r ar=9 hp=6 cs=4 acc=98 time=120-180 stars=4-6');
  assert.equal(finder.matches(beatmap(), options), true);
  for (const changes of [{ ar: 8.99 }, { drain: 5.99 }, { cs: 3.99 }, { total_length: 119 },
    { total_length: 181 }, { difficulty_rating: 3.99 }, { difficulty_rating: 6.01 },
    { mode: 'mania', mode_int: 3 }, { convert: true }, { drain: undefined }, { ar: NaN }, { id: null }]) {
    assert.equal(finder.matches(beatmap(changes), options), false, JSON.stringify(changes));
  }
  assert.equal(finder.matches(beatmap({ accuracy: 2 }), options), true, 'target accuracy never filters OD');
  assert.equal(finder.matches(beatmap({ total_length: 120, difficulty_rating: 4 }), options), true);
  assert.equal(finder.matches(beatmap({ total_length: 180, difficulty_rating: 6 }), options), true);
});

test('name search follows cursors past nonmatching difficulties and rechecks the final map', async () => {
  const calls = [];
  const result = await finder.findBeatmap(finder.parsePrefix('freedom dive ar=9 cs=4'), {
    get: async path => {
      calls.push(path);
      if (path.startsWith('/beatmaps/')) return beatmap();
      const params = new URL(path, 'https://osu.ppy.sh').searchParams;
      assert.equal(params.get('m'), '0'); assert.equal(params.get('s'), 'any');
      if (params.has('cursor_string')) { assert.equal(params.get('cursor_string'), 'opaque+/='); return page(); }
      return page([beatmap({ ar: 8 }), beatmap({ cs: 5 })], { total: 2, cursor_string: 'opaque+/=' });
    },
  });
  assert.equal(result.map.id, 123);
  assert.equal(calls.length, 3);
});

test('random search selects deep pages and all returned maps satisfy the filters', async () => {
  const pages = [];
  const options = finder.parsePrefix('-r ar=9 cs=4 time=120-180');
  const result = await finder.findBeatmap(options, {
    random: () => 0.999,
    get: async path => {
      if (path.startsWith('/beatmaps/')) return beatmap({ id: 999 });
      const params = new URL(path, 'https://osu.ppy.sh').searchParams;
      pages.push(Number(params.get('page') || 1));
      if (!params.has('page')) return page([beatmap()], { total: 5000 });
      return page([beatmap({ id: 998, ar: 8 }), beatmap({ id: 999 })], { total: 5000 });
    },
  });
  assert.deepEqual(pages, [1, 100]);
  assert.equal(result.map.id, 999);
  assert.equal(finder.matches(result.map, options), true);
});

test('random selection can return different difficulties on a single page', async () => {
  const ids = [];
  for (const random of [() => 0, () => 0.999]) {
    const result = await finder.findBeatmap({ random: true }, { random,
      get: async path => path.startsWith('/beatmaps/')
        ? beatmap({ id: Number(path.split('/').at(-1)) }) : page([beatmap({ id: 1 }), beatmap({ id: 2 })]),
    });
    ids.push(result.map.id);
  }
  assert.deepEqual(ids, [2, 1]);
});

test('broad random searches partition dates before jumping to a page', async () => {
  const queries = [];
  const result = await finder.findBeatmap({ random: true, hp: 6 }, {
    now: new Date('2026-10-24'), random: () => 0.999,
    get: async path => {
      if (path.startsWith('/beatmaps/')) return beatmap();
      const params = new URL(path, 'https://osu.ppy.sh').searchParams;
      const query = params.get('q'); queries.push(query);
      if (!query.includes('created>=')) return page([], { total: 10000 }); // capped total
      if (!query.includes('2026-07-02')) return page([], { total: 15000 });
      return page([beatmap()], { total: 50 });
    },
  });
  assert.equal(result.map.id, 123);
  assert.equal(queries.length, 3);
  assert.match(queries[1], /hp=6 created>=2026-01-01 created<2027-01-01/);
  assert.match(queries[2], /hp=6 created>=2026-07-02 created<2027-01-01/);
});

test('random empty date windows retry and bounded searches never fabricate an eligible map', async () => {
  let count = 0;
  const result = await finder.findBeatmap({ random: true }, {
    get: async () => { count++; return page([], { total: count === 1 ? 10000 : 0 }); },
  });
  assert.equal(result.found, false); assert.equal(result.exhaustive, false);
  assert.ok(count <= 10 && count > 2);
  assert.deepEqual(await finder.findBeatmap({ random: true, ar: 9 }, { get: async () => page([], { total: 0 }) }),
    { found: false, exhaustive: true });
});

test('deleted maps and maps changed after indexing are skipped; filters never relax', async () => {
  const result = await finder.findBeatmap({ name: 'map', ar: 9 }, {
    get: async path => {
      if (path.endsWith('/1')) throw Object.assign(new Error('gone'), { status: 404 });
      if (path.endsWith('/2')) return beatmap({ id: 2, ar: 8 });
      if (path.endsWith('/3')) return beatmap({ id: 3 });
      return page([beatmap({ id: 1 }), beatmap({ id: 2 }), beatmap({ id: 3 })]);
    },
  });
  assert.equal(result.map.id, 3);
  const none = await finder.findBeatmap({ random: true, ar: 9 }, {
    get: async () => page([beatmap({ ar: 8 })]),
  });
  assert.equal(none.found, false);
});

test('network errors and malformed search responses propagate for safe command handling', async () => {
  await assert.rejects(finder.findBeatmap({ random: true }, { get: async () => { throw new Error('network'); } }), /network/);
  for (const response of [null, {}, { total: 0 }, { total: 0, beatmapsets: [], error: 'backend down' }]) {
    await assert.rejects(finder.findBeatmap({ random: true }, { get: async () => response }), /OSU_SEARCH_FAILED/);
  }
});

test('embed shows real API stats, target accuracy, cover and clickable map without invented PP', () => {
  const embed = finder.beatmapEmbed({ map: beatmap(), set: beatmapset(), options: { mode: 'osu', acc: 98 } }).toJSON();
  assert.equal(embed.url, 'https://osu.ppy.sh/beatmaps/123');
  assert.match(embed.title, /xi.*FREEDOM DiVE/);
  assert.equal(embed.fields.find(f => f.name === 'Mapper').value, 'Mapper');
  assert.equal(embed.fields.find(f => f.name === 'Difficulty stats (NM)').value, 'AR 9 / HP 6 / CS 4 / OD 8');
  assert.equal(embed.fields.find(f => f.name === 'Target accuracy').value, '98%');
  assert.equal(embed.fields.find(f => f.name === 'Length').value, '2:30');
  assert.equal(embed.fields.some(f => /\bPP\b/i.test(f.name)), false);
  assert.equal(embed.image.url, beatmapset().covers.cover);
  assert.match(embed.footer.text, /PP unavailable/);
  const withoutAcc = finder.beatmapEmbed({ map: beatmap(), set: beatmapset(), options: { mode: 'osu' } }).toJSON();
  assert.equal(withoutAcc.fields.some(f => f.name === 'Target accuracy'), false);
});

let commandClock = Date.now();
function mockCommandApi({ respond } = {}) {
  process.env.OSU_CLIENT_ID = 'finder-test-id'; process.env.OSU_CLIENT_SECRET = 'finder-test-secret';
  mock.method(Date, 'now', () => { commandClock += 2000; return commandClock; });
  const searches = [];
  mock.method(global, 'fetch', async url => {
    if (url.includes('/oauth/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (respond) return respond(url);
    if (url.includes('/beatmapsets/search')) { searches.push(new URL(url).searchParams); return Response.json(page()); }
    if (url.endsWith('/beatmaps/123')) return Response.json(beatmap());
    throw new Error('Unexpected test request');
  });
  return searches;
}
function message(content, userId) {
  const sent = [];
  return { guild: { id: 'finder-guild', ownerId: 'owner' }, author: { id: userId }, content,
    member: { permissions: new PermissionsBitField() },
    channel: { id: 'finder-channel', isTextBased: () => true, isThread: () => false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
      send: async payload => { sent.push(payload); } }, sent };
}
function interaction(values, userId) {
  const sent = [];
  const source = { guild: { id: 'finder-guild' }, user: { id: userId }, commandName: 'osum',
    options: slashOptions(values), isChatInputCommand: () => true, replied: false, deferred: false,
    deferReply: async () => { source.deferred = true; sent.push('deferred'); },
    reply: async payload => { source.replied = true; sent.push(payload); },
    editReply: async payload => { assert.equal(source.deferred, true); sent.push(payload); }, sent };
  return source;
}

test('real message and slash dispatch return identical embeds and queries with partial filters', async () => {
  const searches = mockCommandApi();
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  mock.method(Guild, 'findOne', () => ({ lean: async () => null }));
  try {
    const prefix = message('.osum freedom dive ar=9 cs=4 acc=98', 'prefix-dispatch');
    const slash = interaction({ name: 'freedom dive', ar: 9, cs: 4, acc: 98 }, 'slash-dispatch');
    await bot.handleMessage(prefix); await bot.handleInteraction(slash);
    assert.equal(prefix.sent.length, 1); assert.equal(slash.sent[0], 'deferred');
    assert.deepEqual(prefix.sent[0].embeds[0].toJSON(), slash.sent[1].embeds[0].toJSON());
    assert.equal(searches[0].toString(), searches[1].toString());
  } finally { mongoose.connection.readyState = previous; }
});

test('both random command types work without names or database access', async () => {
  const searches = mockCommandApi();
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 0;
  mock.method(Guild, 'findOne', () => { throw new Error('finder must not need the database'); });
  try {
    const prefix = message('.osum -r hp=6 cs=4', 'prefix-random');
    const slash = interaction({ random: true, hp: 6, cs: 4 }, 'slash-random');
    await bot.handleMessage(prefix); await bot.handleInteraction(slash);
    assert.equal(prefix.sent[0].embeds[0].toJSON().url, 'https://osu.ppy.sh/beatmaps/123');
    assert.equal(slash.sent[1].embeds[0].toJSON().url, 'https://osu.ppy.sh/beatmaps/123');
    assert.equal(searches[0].get('q'), 'hp=6 cs=4');
  } finally { mongoose.connection.readyState = previous; }
});

test('usage, invalid filters, bot/webhook messages and other prefix names never search', async () => {
  mock.method(global, 'fetch', () => { throw new Error('must not call API'); });
  const prefix = message('.osum', 'prefix-usage');
  await bot.osumCommand(prefix, '');
  assert.match(prefix.sent[0].content, /Find a beatmap/);
  const slash = interaction({}, 'slash-usage');
  await bot.handleInteraction(slash);
  assert.match(slash.sent[0].content, /Find a beatmap/); assert.equal(slash.deferred, false);
  const invalid = interaction({ random: true, ar: 11 }, 'slash-invalid');
  await bot.handleInteraction(invalid);
  assert.match(invalid.sent[0].content, /ar must be/); assert.equal(invalid.deferred, false);
  for (const msg of [message('.osumextra', 'unknown'), { ...message('.osum -r', 'hook'), webhookId: 'hook' },
    { ...message('.osum -r', 'bot'), author: { id: 'bot', bot: true } }]) {
    await bot.handleMessage(msg); assert.equal(msg.sent.length, 0);
  }
});

test('prefix moderation still runs before the finder', async () => {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  mock.method(Guild, 'findOne', () => ({ lean: async () => ({ antiLinkChannelId: 'finder-channel' }) }));
  mock.method(global, 'fetch', () => { throw new Error('moderated command must not search'); });
  try {
    const msg = message('.osum https://example.com', 'moderated');
    await bot.handleMessage(msg); assert.equal(msg.sent.length, 0);
  } finally { mongoose.connection.readyState = previous; }
});

test('prefix and slash share the same user cooldown', async () => {
  mockCommandApi();
  const previous = process.env.OSU_COMMAND_COOLDOWN_SECONDS;
  process.env.OSU_COMMAND_COOLDOWN_SECONDS = '1000';
  try {
    const msg = message('.osum -r', 'shared-cooldown');
    await bot.osumCommand(msg, '-r');
    const slash = interaction({ random: true }, 'shared-cooldown');
    await bot.handleInteraction(slash);
    assert.match(slash.sent[0].content, /wait a few seconds/);
    assert.equal(slash.deferred, false);
  } finally {
    if (previous === undefined) delete process.env.OSU_COMMAND_COOLDOWN_SECONDS;
    else process.env.OSU_COMMAND_COOLDOWN_SECONDS = previous;
  }
});

test('existing /osu recent still resolves linked accounts and completes a deferred reply', async () => {
  mockCommandApi({ respond: async url => url.includes('/scores/recent') ? Response.json([])
    : Response.json({ id: 42, username: 'linked-player' }) });
  mock.method(User, 'findOne', filter => {
    assert.equal(filter.discordUserId, 'recent-slash-user');
    return { lean: async () => ({ osuUserId: '42' }) };
  });
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  try {
    const slash = interaction({}, 'recent-slash-user');
    slash.commandName = 'osu'; slash.options.getSubcommand = () => 'recent';
    await bot.handleInteraction(slash);
    assert.equal(slash.sent[0], 'deferred');
    assert.match(slash.sent[1].content, /No recent osu! Standard plays found for linked-player/);
  } finally { mongoose.connection.readyState = previous; }
});

test('command errors edit deferred slash responses without exposing raw error data', async () => {
  mockCommandApi({ respond: async () => new Response(null, { status: 429, headers: { 'Retry-After': '17' } }) });
  const slash = interaction({ random: true }, 'rate-limited-command');
  await bot.handleInteraction(slash);
  assert.equal(slash.sent[0], 'deferred');
  assert.match(slash.sent[1].content, /rate limiting.*17 seconds/);
});

test('slash definition has all optional types/ranges and registration retains every existing command once', async () => {
  const command = definition.toJSON();
  const expected = { name: ApplicationCommandOptionType.String, random: ApplicationCommandOptionType.Boolean,
    ar: ApplicationCommandOptionType.Number, hp: ApplicationCommandOptionType.Number, cs: ApplicationCommandOptionType.Number,
    acc: ApplicationCommandOptionType.Number, time_min: ApplicationCommandOptionType.Integer, time_max: ApplicationCommandOptionType.Integer,
    stars_min: ApplicationCommandOptionType.Number, stars_max: ApplicationCommandOptionType.Number, mode: ApplicationCommandOptionType.String };
  assert.deepEqual(Object.fromEntries(command.options.map(o => [o.name, o.type])), expected);
  assert.ok(command.options.every(o => !o.required));
  process.env.DISCORD_TOKEN = 'test-token'; process.env.DISCORD_CLIENT_ID = '1234567890';
  let registration;
  mock.method(REST.prototype, 'put', async (route, body) => { registration = { route, body }; });
  mock.method(console, 'log', () => {});
  require('./deploy-commands');
  await Promise.resolve();
  assert.equal(registration.route, Routes.applicationCommands('1234567890'));
  const names = registration.body.body.map(c => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), ['delink', 'fortune', 'help', 'lastletter', 'number', 'osu', 'osum', 'rule', 'set', 'status']);
  const lastletter = registration.body.body.find(command => command.name === 'lastletter');
  assert.deepEqual(lastletter.options.map(subcommand => subcommand.name), ['start', 'stop']);
  assert.ok(lastletter.options.every(subcommand => subcommand.options.length === 1
    && subcommand.options[0].name === 'channel' && subcommand.options[0].type === ApplicationCommandOptionType.Channel
    && !subcommand.options[0].required));
});

test('osu! client honors Retry-After without repeatedly hitting a limited API', async () => {
  delete require.cache[require.resolve('./osu')];
  const { osuGet } = require('./osu');
  let calls = 0;
  mock.method(global, 'fetch', async url => {
    if (url.includes('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    calls++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  });
  await assert.rejects(osuGet('/beatmaps/123'), e => e.status === 429 && e.retryAfter === 60);
  await assert.rejects(osuGet('/beatmaps/123'), e => e.status === 429 && e.retryAfter <= 60);
  assert.equal(calls, 1);
});

test('osu! client serializes concurrent requests, paces starts, and shares OAuth tokens', async () => {
  delete require.cache[require.resolve('./osu')];
  const { osuGet } = require('./osu');
  const starts = []; let tokens = 0;
  mock.method(global, 'fetch', async url => {
    if (url.includes('/oauth/token')) { tokens++; return Response.json({ access_token: 'token', expires_in: 3600 }); }
    starts.push(Date.now()); return Response.json({});
  });
  await Promise.all([osuGet('/beatmaps/1'), osuGet('/beatmaps/2')]);
  assert.equal(tokens, 1);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 1050);
});
