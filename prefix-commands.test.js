const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { PermissionsBitField } = require('discord.js');
const Guild = require('./models/Guild');
const User = require('./models/User');
const bot = require('./index');
const { PrefixInputError, parsePrefixCommand } = require('./prefix-commands');

let readyState;
beforeEach(() => {
  readyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  mock.method(Guild, 'findOne', () => ({ lean: async () => null }));
});
afterEach(() => {
  mock.restoreAll();
  mongoose.connection.readyState = readyState;
});

let userCounter = 0;
function message(content, { owner = false, permissions = [], guildId = 'prefix-guild' } = {}) {
  const sent = [];
  return { content, guild: { id: guildId, ownerId: 'owner' },
    author: { id: owner ? 'owner' : `prefix-user-${++userCounter}` },
    member: { permissions: new PermissionsBitField(permissions) },
    channel: { id: 'prefix-channel', isTextBased: () => true, isThread: () => false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages', 'ManageMessages']),
      send: async payload => { sent.push(payload); return payload; } }, sent };
}
const content = msg => typeof msg.sent.at(-1) === 'string' ? msg.sent.at(-1) : msg.sent.at(-1)?.content;

test('every existing command has a prefix form and .r maps to osu recent', () => {
  for (const command of ['help', 'status', 'fortune']) {
    assert.equal(parsePrefixCommand(`.${command}`).command, command);
  }
  assert.deepEqual(parsePrefixCommand('.r'), { command: 'osu', subcommand: 'recent', values: { username: null } });
  assert.deepEqual(parsePrefixCommand('.R "Player With Spaces"'),
    { command: 'osu', subcommand: 'recent', values: { username: 'Player With Spaces' } });
  for (const text of ['.osu', '.osu recent']) assert.deepEqual(parsePrefixCommand(text), parsePrefixCommand('.r'));
  for (const text of ['.osu peppy', '.osu recent peppy']) assert.deepEqual(parsePrefixCommand(text), parsePrefixCommand('.r peppy'));
  assert.equal(parsePrefixCommand('.osu add peppy').subcommand, 'add');
  assert.equal(parsePrefixCommand('.set countdown GMT+7').values.timezone, 'GMT+7');
  assert.equal(parsePrefixCommand('.rule set <@&123>').values.role, '123');
  assert.equal(parsePrefixCommand('.delink set <#456>').values.channel, '456');
  assert.equal(parsePrefixCommand('.number enable').subcommand, 'enable');
  assert.deepEqual(parsePrefixCommand('.osum freedom dive ar=9'), { command: 'osum', args: 'freedom dive ar=9' });
});

test('prefix argument validation rejects malformed configuration without guessing actions or IDs', () => {
  for (const text of ['.help extra', '.status extra', '.fortune extra', '.osu add', '.r "unclosed',
    '.r ""', `.r ${'a'.repeat(33)}`, '.set', '.set countdown', '.set countdown cancel extra',
    '.rule', '.rule delete', '.rule set <@123>', '.rule set <@&123> extra', '.rule cancel extra',
    '.number', '.number disable', '.number enable extra', '.delink', '.delink set #plain-text',
    '.delink set <#123> extra', '.delink cancel extra']) {
    assert.throws(() => parsePrefixCommand(text), PrefixInputError, text);
  }
  for (const text of ['hello', '.rubbish', '.osuextra', '.status!', '.constructor']) {
    assert.equal(parsePrefixCommand(text), null);
  }
});

test('public prefixes send actual channel responses and help lists both forms', async () => {
  for (const [command, expected] of [['help', /\.r \[username\].*alias for \/osu recent/],
    ['status', /Bot Status/], ['fortune', /Your Fortune/]]) {
    const msg = message(`.${command}`);
    await bot.handleMessage(msg);
    assert.match(content(msg), expected);
    assert.equal(msg.sent.length, 1);
    assert.equal(Object.hasOwn(msg.sent[0], 'ephemeral'), false);
  }
});

test('prefix configuration retains owner/admin/bot-owner permissions', async () => {
  mock.method(Guild, 'updateOne', () => { throw new Error('must not change settings'); });
  mock.method(Guild, 'findOneAndUpdate', () => { throw new Error('must not change settings'); });
  for (const text of ['.set countdown GMT+7', '.set countdown cancel', '.rule set <@&123>', '.rule cancel',
    '.number enable', '.number cancel', '.delink set <#123>', '.delink cancel']) {
    const msg = message(text);
    await bot.handleMessage(msg);
    assert.match(content(msg), /Only the server owner, an Administrator, or the bot owner/);
  }
});

test('all prefix cancellations touch only the chosen guild feature', async () => {
  const writes = [];
  mock.method(Guild, 'updateOne', async (filter, update) => { writes.push({ filter, update }); return {}; });
  for (const [text, field] of [['.set countdown cancel', 'countdown'], ['.rule cancel', 'autoRoleId'],
    ['.number cancel', 'counting'], ['.delink cancel', 'antiLinkChannelId']]) {
    const msg = message(text, { owner: true, guildId: 'target-guild' });
    await bot.handleMessage(msg);
    assert.deepEqual(writes.at(-1), { filter: { guildId: 'target-guild' }, update: { $unset: { [field]: 1 } } });
    assert.match(content(msg), /disabled/);
  }
  assert.equal(writes.length, 4);
});

test('prefix enable operations reuse the existing settings schemas and real role/channel lookups', async () => {
  const writes = [];
  mock.method(Guild, 'findOneAndUpdate', async (filter, update, options) => { writes.push({ filter, update, options }); return {}; });
  const countdown = message('.set countdown UTC+5:30', { permissions: ['Administrator'] });
  await bot.handleMessage(countdown);
  assert.equal(writes.at(-1).update.$set['countdown.utcOffsetMinutes'], 330);
  assert.equal(writes.at(-1).update.$set['countdown.channelId'], 'prefix-channel');

  const counting = message('.number enable', { owner: true });
  await bot.handleMessage(counting);
  assert.deepEqual(writes.at(-1).update.$set.counting,
    { enabled: true, channelId: 'prefix-channel', currentNumber: 0, lastUserId: null });

  const role = message('.rule set <@&123>', { owner: true });
  role.guild.roles = { fetch: async id => { assert.equal(id, '123'); return { id, managed: false, editable: true }; } };
  role.guild.members = { fetchMe: async () => ({ permissions: new PermissionsBitField(['ManageRoles']),
    roles: { highest: { comparePositionTo: () => 1 } } }) };
  await bot.handleMessage(role);
  assert.equal(writes.at(-1).update.$set.autoRoleId, '123');

  const antiLink = message('.delink set 456', { owner: true });
  antiLink.guild.channels = { fetch: async id => { assert.equal(id, '456'); return { ...antiLink.channel, id, guildId: 'prefix-guild' }; } };
  await bot.handleMessage(antiLink);
  assert.equal(writes.at(-1).update.$set.antiLinkChannelId, '456');
  assert.equal(writes.length, 4);
  assert.ok(writes.every(write => write.options.runValidators && write.options.upsert));
});

test('bot owner can run prefix configuration without administrator permissions', async () => {
  const previous = process.env.OWNER_ID;
  process.env.OWNER_ID = 'prefix-bot-owner';
  let wrote = false;
  mock.method(Guild, 'updateOne', async () => { wrote = true; return {}; });
  try {
    const msg = message('.number cancel'); msg.author.id = 'prefix-bot-owner';
    await bot.handleMessage(msg);
    assert.equal(wrote, true); assert.match(content(msg), /Counting disabled/);
  } finally {
    if (previous === undefined) delete process.env.OWNER_ID; else process.env.OWNER_ID = previous;
  }
});

test('invalid configuration never writes and unknown roles are handled gracefully', async () => {
  mock.method(Guild, 'findOneAndUpdate', () => { throw new Error('must not write'); });
  mock.method(Guild, 'updateOne', () => { throw new Error('must not write'); });
  for (const text of ['.rule set 123 extra', '.number delete', '.delink set invalid', '.set countdown UTC+99']) {
    const msg = message(text, { owner: true });
    await bot.handleMessage(msg);
    assert.match(content(msg), /Use /);
  }
  const role = message('.rule set 123', { owner: true });
  role.guild.roles = { fetch: async () => { throw new Error('Unknown Role'); } };
  role.guild.members = { fetchMe: async () => ({ permissions: new PermissionsBitField(['ManageRoles']) }) };
  await bot.handleMessage(role);
  assert.match(content(role), /Choose a role/);
});

test('slash countdown cancel:true and the prefix cancel produce identical writes', async () => {
  const writes = [];
  mock.method(Guild, 'updateOne', async (filter, update) => { writes.push({ filter, update }); return {}; });
  const prefix = message('.set countdown cancel', { owner: true });
  await bot.handleMessage(prefix);
  const replies = [];
  await bot.handleInteraction({ guild: prefix.guild, member: prefix.member, user: prefix.author,
    commandName: 'set', isChatInputCommand: () => true,
    options: { getSubcommand: () => 'countdown', getString: () => null, getBoolean: () => true },
    reply: async payload => { replies.push(payload); } });
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(replies[0].content, content(prefix));
});

test('configuration commands stay in guild arrival order with counting messages', async () => {
  const order = [];
  let settings = null;
  mock.method(Guild, 'findOne', () => ({ lean: async () => settings }));
  mock.method(Guild, 'findOneAndUpdate', async () => {
    await Promise.resolve();
    settings = { counting: { enabled: true, channelId: 'prefix-channel', currentNumber: 0 } };
    order.push('enable'); return settings;
  });
  mock.method(Guild, 'updateOne', async () => { order.push('count'); return { matchedCount: 1 }; });
  await Promise.all([bot.handleMessage(message('.number enable', { owner: true })), bot.handleMessage(message('1'))]);
  assert.deepEqual(order, ['enable', 'count']);
});

let apiClock = Date.now();
function mockRecentApi() {
  process.env.OSU_CLIENT_ID = 'prefix-test-id'; process.env.OSU_CLIENT_SECRET = 'prefix-test-secret';
  mock.method(Date, 'now', () => { apiClock += 2000; return apiClock; });
  const lookups = [];
  mock.method(global, 'fetch', async url => {
    if (url.includes('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.includes('/scores/recent')) return Response.json([]);
    const parsed = new URL(url);
    assert.match(parsed.pathname, /^\/api\/v2\/users\//);
    const requested = decodeURIComponent(parsed.pathname.split('/')[4]);
    lookups.push(requested);
    return Response.json({ id: 42, username: requested });
  });
  return lookups;
}

test('.r, .osu and .osu recent use the linked account and accept optional usernames with spaces', async () => {
  const lookups = mockRecentApi();
  mock.method(User, 'findOne', () => ({ lean: async () => ({ osuUserId: '42' }) }));
  mock.method(User, 'findOneAndUpdate', () => { throw new Error('recent must not change linked accounts'); });
  for (const text of ['.r', '.osu', '.osu recent', '.r Player With Spaces', '.osu "Player With Spaces"', '.osu recent peppy', '.r add']) {
    const msg = message(text);
    await bot.handleMessage(msg);
    assert.match(content(msg), /No recent osu! Standard plays found/);
    assert.equal(msg.sent.length, 1);
  }
  assert.deepEqual(lookups, ['42', '42', '42', 'Player With Spaces', 'Player With Spaces', 'peppy', 'add']);
});

test('.osu add links the invoking Discord user through the existing API and schema', async () => {
  mockRecentApi();
  let write;
  mock.method(User, 'findOneAndUpdate', async (...args) => { write = args; return {}; });
  const msg = message('.osu add "Player With Spaces"');
  await bot.handleMessage(msg);
  assert.deepEqual(write[0], { discordUserId: msg.author.id });
  assert.deepEqual(write[1].$set, { osuUsername: 'Player With Spaces', osuUserId: '42' });
  assert.match(content(msg), /Connected your osu! account: Player With Spaces/);
});

test('.r, .osu and /osu recent share their existing per-user cooldown', async () => {
  mockRecentApi();
  const previous = process.env.OSU_COMMAND_COOLDOWN_SECONDS;
  process.env.OSU_COMMAND_COOLDOWN_SECONDS = '1000';
  try {
    const first = message('.r peppy'); await bot.handleMessage(first);
    const second = message('.osu recent peppy'); second.author = first.author;
    await bot.handleMessage(second);
    assert.match(content(second), /wait a few seconds/);
    const replies = [];
    await bot.handleInteraction({ guild: first.guild, user: first.author, commandName: 'osu',
      isChatInputCommand: () => true, options: { getSubcommand: () => 'recent', getString: () => 'peppy' },
      deferReply: async () => {}, reply: async payload => { replies.push(payload); } });
    assert.match(replies[0].content, /wait a few seconds/);
  } finally {
    if (previous === undefined) delete process.env.OSU_COMMAND_COOLDOWN_SECONDS;
    else process.env.OSU_COMMAND_COOLDOWN_SECONDS = previous;
  }
});

test('bots, webhooks, DMs, unknown commands and moderated prefix messages do not dispatch', async () => {
  for (const msg of [{ ...message('.help'), guild: null }, { ...message('.help'), webhookId: 'hook' },
    { ...message('.help'), author: { bot: true } }, message('.helpful'), message('.unknown')]) {
    await bot.handleMessage(msg); assert.equal(msg.sent.length, 0);
  }
  const moderated = message('.r https://example.com');
  mock.method(Guild, 'findOne', () => ({ lean: async () => ({ antiLinkChannelId: 'prefix-channel' }) }));
  mock.method(global, 'fetch', () => { throw new Error('moderated message must not call API'); });
  await bot.handleMessage(moderated); assert.equal(moderated.sent.length, 0);
});

test('prefixes receive the same database-unavailable response as slash commands', async () => {
  mongoose.connection.readyState = 0;
  for (const text of ['.r', '.osu add peppy', '.help', '.set countdown cancel', '.rule cancel', '.number enable', '.delink cancel']) {
    const msg = message(text, { owner: true });
    await bot.handleMessage(msg);
    assert.match(content(msg), /Database temporarily unavailable/);
  }
});
