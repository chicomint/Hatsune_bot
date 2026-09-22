const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const mongoose = require('mongoose');
const { PermissionsBitField } = require('discord.js');
const Guild = require('./models/Guild');
const User = require('./models/User');
const bot = require('./index');
afterEach(() => mock.restoreAll());

test('fixed offsets validate syntax and real-world boundaries', () => {
  for (const value of ['GMT+7', '+7', 'UTC+7']) assert.equal(bot.parseOffset(value), 420);
  assert.equal(bot.parseOffset('GMT-5'), -300);
  assert.equal(bot.parseOffset('UTC+5:30'), 330);
  assert.equal(bot.parseOffset('UTC-12'), -720);
  assert.equal(bot.parseOffset('+14'), 840);
  for (const value of ['7', 'UTC', '+14:01', '-12:01', '+7:99', '+1.5', '+7 junk']) {
    assert.equal(bot.parseOffset(value), null);
  }
});

test('countdown respects local dates, leap years, and New Year', () => {
  assert.deepEqual(bot.countdownDate(420, Date.parse('2026-12-31T17:00:00Z')),
    { date: '2027-01-01', days: 365, newYear: true });
  assert.equal(bot.countdownDate(-300, Date.parse('2027-01-01T02:00:00Z')).days, 1);
  assert.equal(bot.countdownDate(0, Date.parse('2028-02-28T12:00:00Z')).days, 308);
});

test('link detection ignores ordinary dotted text', () => {
  for (const text of ['https://example.com', 'http://example.com', 'www.example.com', 'discord.gg/abc', '<https://example.com>']) {
    assert.equal(bot.hasLink(text), true, text);
  }
  for (const text of ['hello.world', '1.5', 'This is normal.', 'file.js', 'www.example']) {
    assert.equal(bot.hasLink(text), false, text);
  }
});

test('guild queues serialize work, isolate guilds, and recover after failure', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = bot.inGuildOrder('A', async () => { order.push('first'); await gate; });
  const second = bot.inGuildOrder('A', () => { order.push('second'); });
  await bot.inGuildOrder('B', () => { order.push('other guild'); });
  assert.deepEqual(order, ['first', 'other guild']);
  release();
  await Promise.all([first, second]);
  assert.equal(order.at(-1), 'second');
  mock.method(console, 'error', () => {});
  await assert.rejects(bot.inGuildOrder('A', () => { throw new Error('test'); }));
  await bot.inGuildOrder('A', () => { order.push('recovered'); });
  assert.equal(order.at(-1), 'recovered');
});

test('models enforce unique identifiers and counting defaults', () => {
  assert.ok(User.schema.indexes().some(([keys, options]) => keys.discordUserId === 1 && options.unique));
  assert.ok(Guild.schema.indexes().some(([keys, options]) => keys.guildId === 1 && options.unique));
  const saved = new Guild({ guildId: 'A' });
  assert.equal(saved.counting.currentNumber, 0);
  assert.equal(saved.counting.enabled, false);
});

function message(overrides = {}) {
  const sent = [];
  return {
    guild: { id: 'A', ownerId: 'owner' }, author: { id: 'user' },
    member: { permissions: new PermissionsBitField() },
    channel: {
      id: 'channel', isTextBased: () => true, isThread: () => false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
      send: async content => { sent.push(content); },
    },
    content: '1', sent, ...overrides,
  };
}

test('counting persists correct numbers, resets mistakes, ignores non-numbers and other channels', async () => {
  const writes = [];
  mock.method(Guild, 'updateOne', async (filter, update) => {
    writes.push({ filter, update }); return { matchedCount: 1, modifiedCount: 1 };
  });
  const settings = { counting: { enabled: true, channelId: 'channel', currentNumber: 15 } };
  const msg = message({ content: '16' });
  await bot.countMessage(msg, settings);
  assert.equal(writes[0].filter.guildId, 'A');
  assert.equal(writes[0].filter['counting.currentNumber'], 15);
  assert.equal(writes[0].update.$set['counting.currentNumber'], 16);
  msg.content = '18';
  await bot.countMessage(msg, settings);
  assert.equal(writes[1].update.$set['counting.currentNumber'], 0);
  assert.match(msg.sent[0], /Start at 1/);
  msg.content = 'hello';
  await bot.countMessage(msg, settings);
  msg.content = '16'; msg.channel.id = 'other';
  await bot.countMessage(msg, settings);
  assert.equal(writes.length, 2);
});

test('non-admin configuration is rejected without database writes', async () => {
  mock.method(Guild, 'findOneAndUpdate', () => { throw new Error('Must not write'); });
  mock.method(Guild, 'updateOne', () => { throw new Error('Must not write'); });
  for (const command of ['set', 'rule', 'number', 'delink']) {
    const msg = message();
    await bot.configure(msg, command, 'cancel');
    assert.match(msg.sent[0], /Only the server owner/);
  }
});

test('wrong number at zero still reports a reset even when the stored value is unchanged', async () => {
  mock.method(Guild, 'updateOne', async () => ({ matchedCount: 1, modifiedCount: 0 }));
  const msg = message({ content: '9' });
  await bot.countMessage(msg, { counting: { enabled: true, channelId: 'channel', currentNumber: 0 } });
  assert.deepEqual(msg.sent, ['Count reset. Start at 1.']);
});

test('auto-role rejects missing permission, managed roles, and roles above the bot', async () => {
  mock.method(Guild, 'findOneAndUpdate', () => { throw new Error('Must not save an invalid role'); });
  const msg = message({ author: { id: 'owner' } });
  const role = { id: 'role', managed: false, editable: true };
  const me = { permissions: new PermissionsBitField(), roles: { highest: { comparePositionTo: () => 1 } } };
  msg.guild.roles = { fetch: async () => role };
  msg.guild.members = { fetchMe: async () => me };
  await bot.configure(msg, 'rule', '<@&123>');
  assert.match(msg.sent.pop(), /Manage Roles/);
  me.permissions.add('ManageRoles'); role.managed = true;
  await bot.configure(msg, 'rule', '<@&123>');
  assert.match(msg.sent.pop(), /integration/);
  role.managed = false; me.roles.highest.comparePositionTo = () => -1;
  await bot.configure(msg, 'rule', '<@&123>');
  assert.match(msg.sent.pop(), /above/);
});

test('anti-link rejects a channel from another guild', async () => {
  const msg = message({ author: { id: 'owner' } });
  msg.guild.channels = { fetch: async () => ({ ...msg.channel, guildId: 'B' }) };
  mock.method(Guild, 'findOneAndUpdate', () => { throw new Error('Must not save'); });
  await bot.configure(msg, 'delink', '<#123>');
  assert.match(msg.sent[0], /in this server/);
});

test('anti-link deletes each link but rate-limits DM warnings; owner is exempt', async () => {
  let deleted = 0; let warned = 0;
  const msg = message({ content: 'https://example.com', deletable: true,
    delete: async () => { deleted++; }, author: { id: 'link-test', send: async () => { warned++; } },
  });
  msg.channel.permissionsFor = () => new PermissionsBitField(['ViewChannel', 'SendMessages', 'ManageMessages']);
  const settings = { antiLinkChannelId: 'channel' };
  await bot.moderateLink(msg, settings);
  await bot.moderateLink(msg, settings);
  assert.equal(deleted, 2); assert.equal(warned, 1);
  msg.author.id = 'owner';
  assert.equal(await bot.moderateLink(msg, settings), false);
  assert.equal(deleted, 2);
});

test('anti-link uses a temporary channel mention when DMs are closed', async () => {
  const msg = message({ content: 'discord.gg/test', deletable: true,
    delete: async () => {}, author: { id: 'closed-dms', send: async () => { throw new Error('DM closed'); } },
  });
  msg.channel.permissionsFor = () => new PermissionsBitField(['ViewChannel', 'SendMessages', 'ManageMessages']);
  let deleted = false; let callback;
  msg.channel.send = async payload => {
    assert.deepEqual(payload.allowedMentions, { users: ['closed-dms'] });
    return { delete: async () => { deleted = true; } };
  };
  mock.method(global, 'setTimeout', (fn, delay) => {
    assert.equal(delay, 5000); callback = fn; return { unref() {} };
  });
  await bot.moderateLink(msg, { antiLinkChannelId: 'channel' });
  callback();
  assert.equal(deleted, true);
});

test('owner cancellation touches only their guild and chosen feature', async () => {
  const writes = [];
  mock.method(Guild, 'updateOne', async (filter, update) => writes.push({ filter, update }));
  const msg = message({ author: { id: 'owner' } });
  for (const [command, args] of [['set', 'countdown cancel'], ['number', 'cancel'], ['rule', 'cancel'], ['delink', 'cancel']]) {
    await bot.configure(msg, command, args);
  }
  assert.deepEqual(writes.map(write => write.filter), Array(4).fill({ guildId: 'A' }));
  assert.deepEqual(writes.map(write => Object.keys(write.update.$unset)[0]), ['countdown', 'counting', 'autoRoleId', 'antiLinkChannelId']);
});

test('Administrator permission and owner checks use current guild', () => {
  assert.equal(Boolean(bot.isAdmin(message())), false);
  assert.equal(bot.isAdmin(message({ author: { id: 'owner' } })), true);
  assert.equal(bot.isAdmin(message({ member: { permissions: new PermissionsBitField(['Administrator']) } })), true);
});

test('countdown persists claim before delivery and does not repost after another check', async () => {
  const oldReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const order = [];
  const setting = { guildId: 'countdown-test', countdown: {
    enabled: true, channelId: 'channel', utcOffsetMinutes: 420,
  } };
  const channel = message().channel;
  channel.send = async () => { order.push('send'); };
  bot.client.guilds.cache.set(setting.guildId, { channels: { fetch: async () => channel } });
  mock.method(bot.client, 'isReady', () => true);
  mock.method(Guild, 'find', () => ({ lean: async () => [setting] }));
  mock.method(Guild, 'findOne', () => ({ lean: async () => setting }));
  mock.method(Guild, 'updateOne', async (filter, update) => {
    assert.equal(filter.guildId, setting.guildId);
    order.push('claim');
    setting.countdown.lastSentDate = update.$set['countdown.lastSentDate'];
    return { modifiedCount: 1 };
  });
  try {
    await bot.checkCountdowns();
    await bot.checkCountdowns();
    assert.deepEqual(order, ['claim', 'send']);
  } finally {
    mongoose.connection.readyState = oldReadyState;
    bot.client.guilds.cache.delete(setting.guildId);
  }
});

test('osu! tokens are shared, renewed on 401, and failures are bounded', async () => {
  const previousId = process.env.OSU_CLIENT_ID;
  const previousSecret = process.env.OSU_CLIENT_SECRET;
  process.env.OSU_CLIENT_ID = 'test-id'; process.env.OSU_CLIENT_SECRET = 'test-secret';
  delete require.cache[require.resolve('./osu')];
  const { osuGet } = require('./osu');
  let tokens = 0; let gets = 0;
  mock.method(global, 'fetch', async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      tokens++;
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      assert.equal(options.body.get('scope'), 'public');
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }
    gets++;
    if (gets === 1) return new Response(null, { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer token-2');
    return Response.json([]);
  });
  try {
    await osuGet('/users/1/scores/recent?mode=osu&include_fails=1&limit=1');
    await osuGet('/users/1/osu?key=id');
    assert.equal(tokens, 2); assert.equal(gets, 3);
    mock.method(global, 'fetch', async () => new Response(null, { status: 404 }));
    await assert.rejects(osuGet('/users/missing/osu'), error => error.status === 404);
  } finally {
    if (previousId === undefined) delete process.env.OSU_CLIENT_ID; else process.env.OSU_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.OSU_CLIENT_SECRET; else process.env.OSU_CLIENT_SECRET = previousSecret;
  }
});
