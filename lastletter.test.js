const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { PermissionsBitField, MessageFlags } = require('discord.js');
const { LastLetter, englishDictionary, submissionReactions, resultsEmbed } = require('./lastletter');
const Game = require('./models/LastLetterGame');
const Player = require('./models/LastLetterPlayer');
const Guild = require('./models/Guild');
const bot = require('./index');

afterEach(() => mock.restoreAll());
const clone = value => value == null ? value : structuredClone(value);
const words = new Set(['apple', 'axe', 'elephant', 'eagle', 'tiger', 'rabbit', 'tree', 'egg', 'goat', 'tea']);
const input = { guildId: 'guild', channelId: 'channel', userId: 'A' };

class MemoryStore {
  constructor() { this.games = new Map(); this.records = new Map(); this.failRecords = false; }
  async read(id) { return clone(this.games.get(id) || null); }
  async insert(game) {
    if (this.games.has(game._id)) return null;
    this.games.set(game._id, clone(game)); return clone(game);
  }
  async commit(game, changes, best) {
    const current = this.games.get(game._id);
    if (current.revision !== game.revision) return null;
    const next = { ...clone(current), ...clone(changes), revision: current.revision + 1 };
    if (best) next.pendingBests[best.userId] = Math.max(next.pendingBests[best.userId] || 0, best.value);
    this.games.set(game._id, next); return clone(next);
  }
  async best(userId) { return this.records.get(userId) || 0; }
  async flush(game) {
    if (this.failRecords) throw new Error('record storage unavailable');
    for (const [userId, value] of Object.entries(game.pendingBests)) {
      this.records.set(userId, Math.max(this.records.get(userId) || 0, value));
      const current = this.games.get(game._id);
      if (current.pendingBests[userId] === value) delete current.pendingBests[userId];
    }
  }
  async recover() { for (const game of this.games.values()) await this.flush(clone(game)); }
}

async function fixture(options = {}) {
  const store = options.store || new MemoryStore();
  const service = new LastLetter({ store, words, pickLetter: () => 'a', logFailure: () => {}, ...options });
  await service.start(input);
  return { store, service, submit: (userId, content, extra = {}) => service.submit({ ...input, userId, content, ...extra }),
    state: () => store.read('guild:channel') };
}

test('the installed English dictionary accepts real words and rejects nonexistent words', () => {
  for (const word of ['apple', 'elephant', 'tiger', 'rabbit', 'tree', 'a', 'i']) assert.equal(englishDictionary().has(word), true);
  assert.equal(englishDictionary().has('zzzzzzzzqxyz'), false);
  assert.ok(englishDictionary().size > 200000);
});

test('new collections preserve existing osu! models and validate game state', () => {
  const game = new Game({ _id: 'guild:channel', ...input, starterId: 'A', requiredLetter: 'a', startedAt: new Date() });
  assert.equal(game.validateSync(), undefined);
  assert.equal(game.active, false); assert.equal(game.lastPlayerId, null); assert.deepEqual(game.usedWords, []);
  assert.ok(Player.schema.indexes().some(([keys, options]) => keys.discordUserId === 1 && options.unique));
  game.requiredLetter = 'AA'; assert.ok(game.validateSync());
  assert.equal(require('./models/User').schema.path('osuUsername').isRequired, true);
});

test('starting an active channel does not clear its used words, players or turn', async () => {
  const { service, submit, state } = await fixture();
  await submit('A', 'apple'); const before = await state();
  assert.equal((await service.start({ ...input, userId: 'B' })).code, 'already-active');
  assert.deepEqual(await state(), before);
});

test('streaks increase across alternating turns and preserve every player’s game and lifetime best', async () => {
  const { submit, state, store } = await fixture();
  for (const [user, word, streak] of [['A', 'APPLE', 1], ['B', 'elephant', 1], ['A', 'tiger', 2],
    ['B', 'rabbit', 2], ['A', 'tree', 3]]) {
    const result = await submit(user, word);
    assert.equal(result.code, 'accepted'); assert.equal(result.player.currentStreak, streak);
    assert.equal(result.bestStreak, streak);
  }
  const game = await state();
  assert.equal(game.requiredLetter, 'e'); assert.equal(game.lastPlayerId, 'A');
  assert.deepEqual(game.players.map(p => [p.userId, p.currentStreak, p.highestStreak, p.validWords]), [['A', 3, 3, 3], ['B', 2, 2, 2]]);
  assert.equal(store.records.get('A'), 3); assert.equal(store.records.get('B'), 2);
});

test('cooldown runs before validation and leaves all state and streaks byte-for-byte unchanged', async () => {
  const { service, submit, state } = await fixture();
  await submit('A', 'apple'); const before = await state();
  service.words = { has: () => { throw new Error('must not validate a blocked turn'); } };
  for (const word of ['elephant', 'apple', 'zzzz', 'two words', '']) {
    assert.equal((await submit('A', word)).code, 'cooldown');
    assert.deepEqual(await state(), before);
  }
});

test('invalid, duplicate and wrong-letter words never unlock the previous player’s turn', async () => {
  const { submit, state } = await fixture();
  await submit('A', 'apple');
  for (const [word, expected] of [['zzzz', 'invalid'], ['APPLE', 'duplicate'], ['tiger', 'wrong-letter']]) {
    assert.equal((await submit('B', word)).code, expected);
    const game = await state();
    assert.deepEqual(game.usedWords, ['apple']); assert.equal(game.requiredLetter, 'e'); assert.equal(game.lastPlayerId, 'A');
    assert.equal((await submit('A', 'elephant')).code, 'cooldown');
  }
  assert.equal((await submit('B', 'elephant')).code, 'accepted');
  assert.equal((await submit('A', 'tiger')).code, 'accepted');
});

for (const [word, expected] of [['zzzz', 'invalid'], ['APPLE', 'duplicate'], ['eagle', 'wrong-letter']]) {
  test(`${expected} resets only the submitting player’s current streak, preserving highest streaks`, async () => {
    const { submit, state, store } = await fixture();
    for (const [user, text] of [['A', 'apple'], ['B', 'elephant'], ['A', 'tiger'], ['B', 'rabbit']]) await submit(user, text);
    assert.equal((await submit('A', word)).code, expected);
    const game = await state();
    assert.deepEqual(game.players.map(p => [p.currentStreak, p.highestStreak]), [[0, 2], [2, 2]]);
    assert.equal(game.requiredLetter, 't'); assert.equal(game.lastPlayerId, 'B'); assert.equal(game.usedWords.length, 4);
    assert.equal(store.records.get('A'), 2);
    const result = await submit('A', 'tree');
    assert.equal(result.player.currentStreak, 1); assert.equal(result.bestStreak, 2);
  });
}

test('dictionary validation precedes duplicate and starting-letter checks; punctuation is not stripped', async () => {
  const { submit, store } = await fixture();
  store.games.get('guild:channel').usedWords.push('zzzz');
  assert.equal((await submit('A', 'zzzz')).code, 'invalid');
  for (const word of ['apple!', 'apple tree', '123', 'éclair', '<@123>']) assert.equal((await submit('A', word)).code, 'invalid');
  assert.equal((await submit('A', '  ApPlE  ')).code, 'accepted');
});

test('simultaneous words from one player cannot bypass the channel queue or turn check', async () => {
  const { submit, state } = await fixture();
  const results = await Promise.all([submit('A', 'apple'), submit('A', 'axe')]);
  assert.deepEqual(results.map(r => r.code), ['accepted', 'cooldown']);
  assert.equal((await state()).usedWords.length, 1);
});

test('revision retries protect duplicate and turn checks across two service instances', async () => {
  const { store, service, state } = await fixture();
  const other = new LastLetter({ store, words, pickLetter: () => 'a' });
  const both = await Promise.all([service.submit({ ...input, content: 'apple' }), other.submit({ ...input, content: 'axe' })]);
  assert.deepEqual(both.map(r => r.code).sort(), ['accepted', 'cooldown']);
  // Use a fresh game so both different players can attempt the same E→E word.
  await service.stop({ ...input, admin: true }); await service.start(input);
  await service.submit({ ...input, content: 'apple' });
  const duplicate = await Promise.all([service.submit({ ...input, userId: 'B', content: 'eagle' }),
    other.submit({ ...input, userId: 'C', content: 'EAGLE' })]);
  assert.deepEqual(duplicate.map(r => r.code).sort(), ['accepted', 'duplicate']);
  assert.deepEqual((await state()).usedWords, ['apple', 'eagle']);
});

test('simultaneous starts create only one active game', async () => {
  const store = new MemoryStore();
  const one = new LastLetter({ store, words, pickLetter: () => 'a' });
  const two = new LastLetter({ store, words, pickLetter: () => 't' });
  const results = await Promise.all([one.start(input), two.start({ ...input, userId: 'B' })]);
  assert.deepEqual(results.map(r => r.code).sort(), ['already-active', 'started']);
  assert.equal(store.games.size, 1);
});

test('channels and servers have independent turns, letters and used words', async () => {
  const { service, submit } = await fixture();
  await service.start({ ...input, channelId: 'other' });
  await service.start({ ...input, guildId: 'other-guild' });
  assert.equal((await submit('A', 'apple')).code, 'accepted');
  assert.equal((await submit('A', 'apple', { channelId: 'other' })).code, 'accepted');
  assert.equal((await submit('A', 'apple', { guildId: 'other-guild' })).code, 'accepted');
  assert.equal((await submit('A', 'elephant')).code, 'cooldown');
});

test('a blocked channel does not block the queue for another channel', async () => {
  const { service, store } = await fixture();
  await service.start({ ...input, channelId: 'other' });
  const read = store.read.bind(store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  store.read = async id => { if (id === 'guild:channel') await gate; return read(id); };
  const pending = service.submit({ ...input, content: 'apple' });
  try { assert.equal((await service.submit({ ...input, channelId: 'other', content: 'apple' })).code, 'accepted'); }
  finally { release(); await pending; }
});

test('stop authorization, final results and new-game resets preserve lifetime bests', async () => {
  const { service, submit, state, store } = await fixture();
  await submit('A', 'apple'); await submit('B', 'elephant'); await submit('A', 'tiger');
  assert.equal((await service.stop({ ...input, userId: 'C' })).code, 'forbidden');
  assert.equal((await service.stop(input)).code, 'forbidden', 'the starter has no authorization bypass');
  assert.equal((await service.stop({ ...input, userId: 'mod', moderator: true })).code, 'forbidden');
  assert.equal((await state()).active, true);
  const stopped = await service.stop({ ...input, userId: 'admin', admin: true });
  assert.equal(stopped.code, 'stopped'); assert.equal(stopped.game.lastPlayerId, null);
  const embed = resultsEmbed(stopped.game).toJSON();
  assert.match(embed.fields[0].value, /1\. <@A> — 2/);
  assert.match(embed.fields[1].value, /1\. <@A> — 2/);
  assert.equal((await submit('B', 'rabbit')).code, 'ignored');
  assert.equal((await service.stop(input)).code, 'inactive');
  await service.start(input);
  const fresh = await state();
  assert.equal(fresh.lastPlayerId, null); assert.deepEqual(fresh.usedWords, []); assert.deepEqual(fresh.players, []);
  assert.equal(store.records.get('A'), 2);
  assert.equal((await submit('A', 'apple')).bestStreak, 2);
});

test('restarting a service preserves active games, duplicate lists, streaks and cooldown', async () => {
  const { store, submit, state } = await fixture();
  await submit('A', 'apple');
  const restarted = new LastLetter({ store, words });
  assert.equal((await restarted.submit({ ...input, content: 'elephant' })).code, 'cooldown');
  assert.equal((await restarted.submit({ ...input, userId: 'B', content: 'elephant' })).code, 'accepted');
  assert.equal((await restarted.submit({ ...input, content: 'APPLE' })).code, 'duplicate');
  assert.deepEqual((await state()).usedWords, ['apple', 'elephant']);
});

test('failed lifetime writes remain durable through stop/start and recover without lowering global records', async () => {
  const { store, service, submit } = await fixture();
  store.failRecords = true;
  await submit('A', 'apple'); await submit('B', 'elephant'); await submit('A', 'tiger');
  assert.equal(store.games.get('guild:channel').pendingBests.A, 2);
  await service.stop({ ...input, admin: true }); await service.start(input);
  assert.equal((await submit('A', 'apple')).bestStreak, 2);
  store.failRecords = false;
  const restarted = new LastLetter({ store, words });
  await restarted.recover();
  assert.equal(store.records.get('A'), 2); assert.equal(store.records.get('B'), 1);
  assert.deepEqual(store.games.get('guild:channel').pendingBests, {});
  store.records.set('A', 12);
  await restarted.submit({ ...input, userId: 'B', content: 'elephant' });
  assert.equal((await restarted.submit({ ...input, content: 'tiger' })).bestStreak, 12);
});

test('failed game writes cannot accept words; queues recover after a failure', async () => {
  const { store, submit, state } = await fixture();
  const before = await state(); const commit = store.commit.bind(store);
  store.commit = async () => { throw new Error('database unavailable'); };
  await assert.rejects(submit('A', 'apple'));
  assert.deepEqual(await state(), before);
  store.commit = commit;
  assert.equal((await submit('A', 'apple')).code, 'accepted');
});

test('bots, webhooks and all command messages leave active game state unchanged', async () => {
  const { submit, state } = await fixture(); const before = await state();
  for (const [text, extra] of [['.r', {}], ['.osum -r', {}], ['/lastletter stop', {}], ['.unknown', {}],
    ['apple', { bot: true }], ['apple', { webhook: true }]]) {
    assert.equal((await submit('A', text, extra)).code, 'ignored');
    assert.deepEqual(await state(), before);
  }
});

function message(userId, content, sent) {
  const reactions = [];
  return { guild: { id: 'guild' }, channel: { id: 'channel', send: async payload => { sent.push(payload); } },
    author: { id: userId }, content, reactions, react: async emoji => { reactions.push(emoji); } };
}

test('every word receives reactions only, including repeated failures and cooldowns, with no bot messages', async () => {
  const { service, state } = await fixture(); const sent = [];
  for (const [user, word, expected] of [['A', 'apple', ['✅', '1️⃣']], ['A', 'elephant', ['⏳']], ['A', 'zzzz', ['⏳']]]) {
    const msg = message(user, word, sent); await service.handleMessage(msg);
    assert.deepEqual(msg.reactions, expected);
  }
  assert.equal((await state()).players[0].currentStreak, 1);
  for (const [user, word, expected] of [['B', 'zzzz', ['❌']], ['B', 'xxxx', ['❌']],
    ['B', 'elephant', ['✅', '2️⃣']], ['B', 'tiger', ['⏳']], ['A', 'apple', ['❌']],
    ['A', 'eagle', ['❌']], ['A', 'tiger', ['✅', '3️⃣']]]) {
    const msg = message(user, word, sent); await service.handleMessage(msg);
    assert.deepEqual(msg.reactions, expected);
  }
  assert.equal(sent.length, 0); assert.equal((await state()).players[1].currentStreak, 1);
  assert.deepEqual((await state()).usedWords, ['apple', 'elephant', 'tiger']);
});

test('number reactions match the screenshot’s running accepted-word count and never misrepresent repeated digits', () => {
  for (const [count, expected] of [[1, ['✅', '1️⃣']], [123, ['✅', '1️⃣', '2️⃣', '3️⃣']],
    [124, ['✅', '1️⃣', '2️⃣', '4️⃣']], [10, ['✅', '1️⃣', '0️⃣']], [11, ['✅']], [101, ['✅']]]) {
    assert.deepEqual(submissionReactions({ code: 'accepted', game: { usedWords: Array(count) } }), expected);
  }
});

test('Discord reaction errors do not roll back an accepted word or unlock its player', async () => {
  let failures = 0;
  const { service, submit } = await fixture({ send: () => { throw new Error('gameplay must not send messages'); }, logFailure: () => { failures++; } });
  const msg = message('A', 'apple', []);
  msg.react = async () => { throw Object.assign(new Error('Deleted message'), { code: 10008 }); };
  await assert.doesNotReject(service.handleMessage(msg));
  assert.equal(failures, 1); assert.equal((await submit('A', 'elephant')).code, 'cooldown');
  assert.equal((await submit('B', 'elephant')).code, 'accepted');
});

test('inactive games and ignored messages get no reactions or messages', async () => {
  const { service } = await fixture(); const sent = [];
  for (const msg of [message('A', '.osum -r', sent), message('A', '/lastletter stop', sent),
    { ...message('A', 'apple', sent), author: { id: 'bot', bot: true } },
    { ...message('A', 'apple', sent), webhookId: 'hook' }]) {
    await service.handleMessage(msg); assert.deepEqual(msg.reactions, []);
  }
  await service.stop({ ...input, admin: true });
  const inactive = message('A', 'apple', sent); await service.handleMessage(inactive);
  assert.deepEqual(inactive.reactions, []); assert.equal(sent.length, 0);
});

function interaction(action, userId = 'A', permissions = action === 'start' ? ['Administrator'] : []) {
  const replies = [];
  return { guild: { id: 'guild', ownerId: 'owner' }, channelId: 'channel', user: { id: userId },
    channel: { id: 'channel', guildId: 'guild', permissionsFor: () => new PermissionsBitField([
      'ViewChannel', 'SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory',
    ]) },
    memberPermissions: new PermissionsBitField(permissions), options: { getSubcommand: () => action },
    deferReply: async () => { replies.push('deferred'); }, reply: async value => { replies.push(value); },
    editReply: async value => { replies.push(value); }, replies };
}

test('slash start/stop display embeds, reject duplicate starts and enforce admin permissions', async () => {
  const service = new LastLetter({ store: new MemoryStore(), words, pickLetter: () => 'a' });
  const start = interaction('start'); await service.handleInteraction(start);
  assert.equal(start.replies[0], 'deferred'); assert.match(start.replies[1].embeds[0].toJSON().description, /\*\*A\*\*/);
  const duplicate = interaction('start', 'B'); await service.handleInteraction(duplicate);
  assert.match(duplicate.replies[1].content, /already active/);
  const unauthorized = interaction('stop', 'B'); await service.handleInteraction(unauthorized);
  assert.match(unauthorized.replies[0].content, /Only a server Administrator/);
  const mod = interaction('stop', 'B', ['ManageMessages']); await service.handleInteraction(mod);
  assert.match(mod.replies[0].content, /Only a server Administrator/);
  const formerStarter = interaction('stop', 'A'); await service.handleInteraction(formerStarter);
  assert.match(formerStarter.replies[0].content, /Only a server Administrator/);
  const stop = interaction('stop', 'B', ['Administrator']); await service.handleInteraction(stop);
  assert.match(stop.replies[1].embeds[0].toJSON().title, /finished/);
});

test('slash permission and Discord failures are handled safely', async () => {
  const service = new LastLetter({ store: new MemoryStore(), words, canSend: () => false, logFailure: () => {} });
  const blocked = interaction('start'); await service.handleInteraction(blocked);
  assert.equal(blocked.replies[0].flags, MessageFlags.Ephemeral);
  service.canSend = () => true;
  const noEmbeds = interaction('start'); noEmbeds.channel.permissionsFor = () => new PermissionsBitField(['SendMessages']);
  await service.handleInteraction(noEmbeds); assert.match(noEmbeds.replies[0].content, /Embed Links/);
  const noReactions = interaction('start');
  noReactions.channel.permissionsFor = () => new PermissionsBitField(['ViewChannel', 'SendMessages', 'EmbedLinks']);
  await service.handleInteraction(noReactions); assert.match(noReactions.replies[0].content, /Add Reactions and Read Message History/);
  const broken = interaction('start'); broken.deferReply = async () => { throw new Error('Discord unavailable'); };
  broken.reply = async () => { throw new Error('Discord unavailable'); };
  await assert.doesNotReject(service.handleInteraction(broken));
});

test('starting requires an administrator or owner, while ordinary users and message moderators are rejected', async () => {
  for (const permissions of [[], ['ManageMessages']]) {
    const store = new MemoryStore(); const service = new LastLetter({ store, words });
    const attempt = interaction('start', 'ordinary-user', permissions);
    await service.handleInteraction(attempt);
    assert.match(attempt.replies[0].content, /Only a server Administrator/);
    assert.equal(attempt.replies[0].flags, MessageFlags.Ephemeral); assert.equal(store.games.size, 0);
  }
  for (const [user, permissions] of [['owner', []], ['admin', ['Administrator']]]) {
    const service = new LastLetter({ store: new MemoryStore(), words });
    const allowed = interaction('start', user, permissions); await service.handleInteraction(allowed);
    assert.equal(allowed.replies[0], 'deferred'); assert.ok(allowed.replies[1].embeds);
    const stop = interaction('stop', user, permissions); await service.handleInteraction(stop);
    assert.equal(stop.replies[0], 'deferred'); assert.ok(stop.replies[1].embeds);
  }
  const previous = process.env.OWNER_ID; process.env.OWNER_ID = 'bot-owner';
  try {
    const service = new LastLetter({ store: new MemoryStore(), words });
    const allowed = interaction('start', 'bot-owner', []); await service.handleInteraction(allowed);
    assert.equal(allowed.replies[0], 'deferred'); assert.ok(allowed.replies[1].embeds);
    const stop = interaction('stop', 'bot-owner', []); await service.handleInteraction(stop);
    assert.equal(stop.replies[0], 'deferred'); assert.ok(stop.replies[1].embeds);
  } finally { if (previous === undefined) delete process.env.OWNER_ID; else process.env.OWNER_ID = previous; }
});

test('optional channel targets only that channel and posts start and final results there', async () => {
  const store = new MemoryStore(); const service = new LastLetter({ store, words, pickLetter: () => 'a' });
  const announcements = [];
  const start = interaction('start');
  const target = { ...start.channel, id: 'word-game', send: async payload => { announcements.push(payload); return {}; } };
  start.options.getChannel = () => target;
  await service.handleInteraction(start);
  assert.equal((await store.read('guild:word-game')).active, true); assert.equal(await store.read('guild:channel'), null);
  assert.match(start.replies[1].content, /started in <#word-game>/); assert.equal(announcements.length, 1);
  assert.equal((await service.submit({ ...input, channelId: 'word-game', userId: 'anyone', content: 'apple' })).code, 'accepted');
  assert.equal((await service.submit({ ...input, content: 'apple' })).code, 'ignored');
  const stop = interaction('stop', 'A', ['Administrator']); stop.options.getChannel = () => target;
  await service.handleInteraction(stop);
  assert.equal((await store.read('guild:word-game')).active, false);
  assert.match(stop.replies[1].content, /stopped in <#word-game>/); assert.equal(announcements.length, 2);
  assert.match(announcements[1].embeds[0].toJSON().title, /finished/);
});

test('channel selection rejects other servers and channels without sending permissions', async () => {
  for (const wrongGuild of [true, false]) {
    const store = new MemoryStore();
    const service = new LastLetter({ store, words, canSend: channel => channel.id !== 'blocked' });
    const attempt = interaction('start');
    attempt.options.getChannel = () => ({ ...attempt.channel, id: 'blocked', guildId: wrongGuild ? 'other-guild' : 'guild' });
    await service.handleInteraction(attempt);
    assert.equal(attempt.replies[0].flags, MessageFlags.Ephemeral); assert.equal(store.games.size, 0);
  }
});

test('the existing event handlers route Last Letter without adding listeners or prefix commands', async () => {
  const previous = mongoose.connection.readyState; mongoose.connection.readyState = 1;
  mock.method(Guild, 'findOne', () => ({ lean: async () => null }));
  let commands = 0; let messages = 0;
  mock.method(bot.lastLetter, 'handleInteraction', async () => { commands++; });
  mock.method(bot.lastLetter, 'handleMessage', async () => { messages++; });
  try {
    await bot.handleInteraction({ isChatInputCommand: () => true, guild: { id: 'guild' }, commandName: 'lastletter' });
    const msg = message('A', 'apple', []);
    await bot.handleMessage(msg);
    assert.equal(commands, 1); assert.equal(messages, 1);
    assert.equal(bot.client.listenerCount('messageCreate'), 1);
    assert.equal(require('./prefix-commands').parsePrefixCommand('.lastletter start'), null);
  } finally { mongoose.connection.readyState = previous; }
});

test('a consumed moderation message is not submitted to Last Letter', async () => {
  const previous = mongoose.connection.readyState; mongoose.connection.readyState = 1;
  mock.method(Guild, 'findOne', () => ({ lean: async () => ({ antiLinkChannelId: 'channel' }) }));
  mock.method(bot.lastLetter, 'handleMessage', () => { throw new Error('moderated message must not enter the game'); });
  try {
    const msg = message('A', 'https://example.com', []);
    msg.guild.ownerId = 'owner'; msg.member = { permissions: new PermissionsBitField() };
    msg.channel.permissionsFor = () => new PermissionsBitField(['ViewChannel']);
    await bot.handleMessage(msg);
  } finally { mongoose.connection.readyState = previous; }
});
