'use strict';

const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');
const Guild = require('../models/Guild');
const models = require('../models/ChikoChan');
const { Source, Thread, Reply, Delivery } = models;
const { ChikoChanApi, baseUrl } = require('../chikochan/api');
const { ChikoChanFeed, canUseChannel } = require('../chikochan/feed');
const { formatReply, htmlToDiscord, attachments } = require('../chikochan/format');
const { buildCommand, handleChikoChan } = require('../chikochan/command');

let mongo;
let server;
let origin;
let clock;
let fixture;
let client;
let locks;
let failures;

function post(no, resto, extra = {}) {
  return { no: String(no), resto: String(resto), time: 1792480000 + Number(no),
    name: 'Anonymous', com: `Reply ${no}`, ...extra };
}

function thread(board, no, replies = []) {
  if (!fixture.boards.has(board)) fixture.boards.set(board, new Map());
  const value = { posts: [post(no, 0), ...replies], modified: 42 };
  fixture.boards.get(board).set(String(no), value);
  return value;
}

function channel(guildId, id = 'destination') {
  const messages = [];
  const seenNonces = new Map();
  const result = {
    id, guildId, type: ChannelType.GuildText, messages,
    permissions: new PermissionsBitField(['ViewChannel', 'SendMessages', 'EmbedLinks']),
    permissionsFor() { return this.permissions; },
    async send(payload) {
      if (seenNonces.has(payload.nonce) && payload.enforceNonce) return seenNonces.get(payload.nonce);
      messages.push(payload);
      const message = { id: `message-${messages.length}` };
      seenNonces.set(payload.nonce, message);
      return message;
    },
  };
  let guild = client.guilds.cache.get(guildId);
  if (!guild) {
    const channels = new Map();
    guild = { id: guildId, channels: { cache: channels, fetch: async key => channels.get(key) },
      members: { fetchMe: async () => ({ id: 'bot' }) } };
    client.guilds.cache.set(guildId, guild);
  }
  guild.channels.cache.set(id, result);
  return result;
}

function inGuildOrder(guildId, task) {
  const result = (locks.get(guildId) || Promise.resolve()).then(task);
  locks.set(guildId, result.catch(() => {}));
  return result;
}

function feed() {
  return new ChikoChanFeed({ client, inGuildOrder, url: origin, now: () => clock,
    logFailure: context => failures.push(context), reconcileMs: 600000 });
}

function interaction(guildId, action, selected, permissions = ['ManageGuild']) {
  const responses = [];
  return {
    guild: client.guilds.cache.get(guildId),
    memberPermissions: new PermissionsBitField(permissions),
    options: { getSubcommand: () => action, getChannel: () => selected },
    responses,
    reply: async payload => responses.push({ method: 'reply', ...payload }),
    deferReply: async payload => responses.push({ method: 'defer', ...payload }),
    editReply: async payload => responses.push({ method: 'edit', ...payload }),
  };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('chikochan-feed-tests'));
  await Promise.all([Guild.init(), ...Object.values(models).map(model => model.init())]);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    fixture.requests.push(req.url);
    const failure = fixture.errors.get(req.url) || fixture.errors.get(url.pathname);
    if (failure) {
      res.writeHead(failure.status, failure.headers || {});
      res.end('{}');
      return;
    }
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/boards.json') return json({ boards: [...fixture.boards.keys()].map(board => ({ board })) });
    const listing = /^\/([^/]+)\/threads\.json$/.exec(url.pathname);
    if (listing) {
      const board = fixture.boards.get(listing[1]);
      if (!board) { res.writeHead(404); return res.end(); }
      if (fixture.requirePage && !url.searchParams.has('page')) { res.writeHead(400); return res.end(); }
      const summaries = [...board].map(([no, value]) => ({ no, last_modified: value.modified,
        replies: value.posts.filter(item => Number(item.resto) > 0).length }));
      const all = summaries.map((summary, index) => ({ page: fixture.pageBase + index, threads: [summary] }));
      if (fixture.allPages) return json(all.length ? all : [{ page: fixture.pageBase, threads: [] }]);
      const page = Number(url.searchParams.get('page') ?? fixture.pageBase);
      const selected = summaries[page - fixture.pageBase];
      if (fixture.repeatLast && !selected && summaries.length) {
        return json([{ page, threads: [summaries.at(-1)] }]);
      }
      if (fixture.end404 && !selected) { res.writeHead(404); return res.end(); }
      return json([{ page, threads: selected ? [selected] : [] }]);
    }
    const detail = /^\/([^/]+)\/thread\/(\d+)\.json$/.exec(url.pathname);
    if (detail) {
      const value = fixture.boards.get(detail[1])?.get(detail[2]);
      if (!value) { res.writeHead(404); return res.end(); }
      return json({ posts: value.posts });
    }
    if (url.pathname.startsWith('/src/')) {
      if (fixture.missingImages.has(url.pathname)) res.writeHead(404);
      else res.setHeader('Content-Type', 'image/png');
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([Guild.deleteMany({}), ...Object.values(models).map(model => model.deleteMany({}))]);
  clock = Date.parse('2026-10-20T12:00:00Z');
  fixture = { boards: new Map([['g', new Map()], ['chiko', new Map()]]), requests: [], errors: new Map(),
    missingImages: new Set(), pageBase: 1, allPages: false, repeatLast: false, end404: false };
  client = { user: { id: 'bot' }, guilds: { cache: new Map() } };
  locks = new Map(); failures = [];
});

afterEach(async () => {
  await Promise.allSettled([...locks.values()]);
  mock.restoreAll();
});

after(async () => {
  await mongoose.disconnect();
  await new Promise(resolve => server.close(resolve));
  await mongo.stop();
});

test('slash command uses the native text channel picker and guild contexts', () => {
  const command = buildCommand().toJSON();
  assert.deepEqual(command.contexts, [0]);
  assert.deepEqual(command.integration_types, [0]);
  assert.deepEqual(command.options.map(option => option.name), ['enable', 'disable']);
  const option = command.options[0].options[0];
  assert.equal(option.type, 7);
  assert.equal(option.required, true);
  assert.deepEqual(option.channel_types, [ChannelType.GuildText]);
});

test('feed is opt-in: defaults are disabled and polling does not access the source', async () => {
  const saved = await Guild.create({ guildId: 'A' });
  assert.equal(saved.chikochan.enabled, false);
  await feed().tick();
  assert.deepEqual(fixture.requests, []);
  assert.equal(await Delivery.countDocuments(), 0);
});

test('configuration requires Manage Server or Administrator, including for the bot owner', async () => {
  const destination = channel('A');
  for (const action of ['enable', 'disable']) {
    const request = interaction('A', action, destination, []);
    request.user = { id: process.env.OWNER_ID || 'bot-owner' };
    await handleChikoChan(request, feed());
    assert.equal(request.responses[0].flags, MessageFlags.Ephemeral);
    assert.match(request.responses[0].content, /Manage Server or Administrator/);
  }
  assert.equal(await Guild.countDocuments(), 0);
  for (const permissions of [['ManageGuild'], ['Administrator']]) {
    const request = interaction('A', 'enable', destination, permissions);
    const service = feed();
    await handleChikoChan(request, service);
    await inGuildOrder('A', () => {});
    assert.equal(request.responses[0].method, 'defer');
    assert.equal(request.responses[0].flags, MessageFlags.Ephemeral);
    assert.match(request.responses.at(-1).content, /enabled in/);
  }
});

test('server-only commands reject direct-message interactions', async () => {
  const request = interaction('missing', 'enable', null);
  await handleChikoChan(request, feed());
  assert.match(request.responses[0].content, /in a server/);
  assert.equal(request.responses[0].flags, MessageFlags.Ephemeral);
  assert.equal(await Guild.countDocuments(), 0);
});

test('each missing channel permission, foreign channels, and non-text channels are rejected privately', async () => {
  const destination = channel('A');
  const service = feed();
  for (const missing of ['ViewChannel', 'SendMessages', 'EmbedLinks']) {
    destination.permissions = new PermissionsBitField(['ViewChannel', 'SendMessages', 'EmbedLinks'].filter(name => name !== missing));
    assert.equal(canUseChannel(destination, client.user, 'A'), false);
    const request = interaction('A', 'enable', destination);
    await handleChikoChan(request, service);
    assert.equal(request.responses[0].flags, MessageFlags.Ephemeral);
    assert.match(request.responses.at(-1).content, /View Channel, Send Messages, and Embed Links/);
  }
  for (const selected of [{ ...destination, guildId: 'B' }, { ...destination, type: ChannelType.PublicThread },
    { ...destination, type: ChannelType.GuildVoice }, { ...destination, type: ChannelType.GuildForum }]) {
    const request = interaction('A', 'enable', selected);
    await handleChikoChan(request, service);
    assert.match(request.responses.at(-1).content, /text channel in this server/);
  }
  assert.equal(await Guild.countDocuments(), 0);
  assert.deepEqual(fixture.requests, []);
});

test('first enable scans all boards/pages and sends only the single newest existing reply', async () => {
  thread('g', 1, [post(2, 1)]);
  thread('g', 3, [post(4, 3)]);
  thread('g', 5, [post(6, 5)]);
  thread('chiko', 10, [post(11, 10), post(12, 10)]);
  thread('future_board', 20, [post(21, 20)]);
  thread('future_board', 999); // A newer opening post must not count as a reply.
  const destination = channel('A');
  const service = feed();
  await service.enable('A', destination.id);
  assert.equal(await Reply.countDocuments(), 6);
  assert.equal(await Delivery.countDocuments(), 0);
  await service.deliver('A');
  assert.equal(destination.messages.length, 1);
  assert.match(destination.messages[0].embeds[0].title, /\/future_board\/.*#21/);
  assert.ok(fixture.requests.includes('/g/threads.json?page=3'));
  assert.ok(fixture.requests.includes('/g/threads.json?page=4'));
  assert.deepEqual((await Source.findById(origin).lean()).boards, ['g', 'chiko', 'future_board']);
  assert.equal(await Delivery.countDocuments({ sent: true }), 1);
  await service.tick();
  assert.equal(destination.messages.length, 1);
});

test('pagination supports zero-based pages, multi-page responses, repeated last pages, and 404 at the end', async () => {
  thread('g', 1); thread('g', 3); thread('g', 5);
  for (const mode of ['zero', 'all', 'repeat', '404']) {
    fixture.requests = [];
    fixture.pageBase = mode === 'zero' ? 0 : 1;
    fixture.allPages = mode === 'all';
    fixture.repeatLast = mode === 'repeat';
    fixture.end404 = mode === '404';
    const summaries = await new ChikoChanApi(origin).threads('g');
    assert.deepEqual(summaries.map(item => item.no), ['1', '3', '5'], mode);
    assert.ok(fixture.requests.length <= 4, mode);
  }
});

test('a hosted installation requiring an explicit page parameter is scanned completely', async () => {
  fixture.requirePage = true;
  thread('g', 1); thread('g', 3); thread('g', 5);
  const summaries = await new ChikoChanApi(origin).threads('g');
  assert.deepEqual(summaries.map(item => item.no), ['1', '3', '5']);
  assert.ok(fixture.requests.includes('/g/threads.json?page=1'));
  assert.ok(fixture.requests.includes('/g/threads.json?page=4'));
});

test('new boards are discovered automatically and source polling is shared across servers', async () => {
  thread('g', 1);
  const first = channel('A'); const second = channel('B');
  const service = feed();
  await service.enable('A', first.id); await service.enable('B', second.id);
  fixture.requests = [];
  thread('newboard', 30, [post(31, 30)]);
  await service.tick();
  assert.equal(fixture.requests.filter(path => path === '/boards.json').length, 1);
  assert.equal(first.messages.length, 1); assert.equal(second.messages.length, 1);
  assert.match(first.messages[0].embeds[0].url, /\/newboard\/thread\/30#p31$/);
  await service.tick();
  assert.equal(first.messages.length, 1); assert.equal(second.messages.length, 1);
});

test('enable and destination changes preserve the same subscription and deduplicate concurrent queue work', async () => {
  const value = thread('g', 1, [post(2, 1)]);
  const first = channel('A'); const second = channel('A', 'new-destination');
  const service = feed();
  await service.enable('A', first.id); await service.deliver('A');
  const before = (await Guild.findOne({ guildId: 'A' }).lean()).chikochan;
  const requests = fixture.requests.length;
  await service.enable('A', second.id);
  const after = (await Guild.findOne({ guildId: 'A' }).lean()).chikochan;
  assert.equal(before.generation, after.generation); assert.equal(before.cursor, after.cursor);
  assert.equal(fixture.requests.length, requests);
  value.posts.push(post(3, 1));
  await Promise.all([service.tick(), service.tick(), service.deliver('A')]);
  assert.equal(first.messages.length, 1); assert.equal(second.messages.length, 1);
  assert.equal(await Guild.countDocuments({ guildId: 'A' }), 1);
  assert.equal(await Delivery.countDocuments({ sent: true }), 2);
});

test('re-enabling establishes a fresh baseline without replaying the disabled period', async () => {
  const value = thread('g', 1, [post(2, 1)]);
  const first = channel('A'); const second = channel('B');
  const service = feed();
  await service.enable('A', first.id); await service.deliver('A');
  await service.enable('B', second.id); await service.deliver('B');
  await service.disable('A');
  value.posts.push(post(3, 1)); await service.tick();
  assert.equal(first.messages.length, 1); assert.equal(second.messages.length, 2);
  await service.enable('A', first.id); await service.tick();
  assert.equal(first.messages.length, 1);
  value.posts.push(post(4, 1)); await service.tick();
  assert.equal(first.messages.length, 2); assert.equal(second.messages.length, 3);
  assert.match(first.messages[1].embeds[0].title, /#4$/);
});

test('database reconnect and fresh feed instances restore baselines, seeds, and completed deliveries', async () => {
  const value = thread('g', 1, [post(2, 1)]);
  const destination = channel('A');
  await feed().enable('A', destination.id); // Crash before even creating the seed delivery.
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri('chikochan-feed-tests'));
  let service = feed();
  await service.tick();
  assert.equal(destination.messages.length, 1);
  value.posts.push(post(3, 1)); await service.tick();
  assert.equal(destination.messages.length, 2);
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri('chikochan-feed-tests'));
  service = feed(); await service.tick();
  assert.equal(destination.messages.length, 2);
  assert.equal(await Delivery.countDocuments({ sent: true }), 2);
});

test('sage count changes trigger rereads without modification changes and reconciliation catches count-neutral replacements', async () => {
  const value = thread('g', 1, [post(2, 1)]);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id); await service.deliver('A');
  value.posts.push(post(3, 1));
  await service.tick(); assert.equal(destination.messages.length, 2);
  assert.equal(value.modified, 42);
  value.posts.pop(); value.posts.push(post(4, 1));
  await service.tick(); assert.equal(destination.messages.length, 2);
  clock += 600001;
  await service.tick(); assert.equal(destination.messages.length, 3);
  assert.match(destination.messages[2].embeds[0].title, /#4$/);
});

test('post IDs are scoped by board and existing IDs do not resend after repeated full scans', async () => {
  const first = thread('g', 1); const second = thread('chiko', 1);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id);
  first.posts.push(post(2, 1)); second.posts.push(post(2, 1));
  await service.tick(); assert.equal(destination.messages.length, 2);
  clock += 600001; await service.tick();
  assert.equal(destination.messages.length, 2);
  assert.equal(await Reply.countDocuments(), 2);
  assert.equal(await Delivery.countDocuments(), 2);
});

test('failed sends retry persistently in chronological order, honor rate limits, and isolate servers', async () => {
  const one = thread('g', 1); const two = thread('chiko', 10);
  const first = channel('A'); const second = channel('B');
  let service = feed();
  await service.enable('A', first.id); await service.enable('B', second.id);
  const send = first.send.bind(first);
  const nonces = [];
  let fail = true;
  first.send = async payload => {
    nonces.push(payload.nonce);
    if (fail) { fail = false; const error = new Error('temporary failure'); error.retry_after = 120; throw error; }
    return send(payload);
  };
  // Discovery order differs from posting order.
  one.posts.push(post(3, 1, { time: 200 })); two.posts.push(post(11, 10, { time: 100 }));
  await service.tick();
  assert.equal(first.messages.length, 0); assert.equal(second.messages.length, 2);
  assert.match(second.messages[0].embeds[0].title, /#11$/);
  const pending = await Delivery.findOne({ guildId: 'A', attempts: 1 }).lean();
  assert.equal(pending.sent, false);
  assert.equal(pending.retryAt.getTime(), clock + 120000);
  service = feed(); clock += 119000; await service.tick();
  assert.equal(nonces.length, 1); assert.equal(first.messages.length, 0);
  clock += 1001; await service.tick();
  assert.equal(first.messages.length, 2);
  assert.match(first.messages[0].embeds[0].title, /#11$/);
  assert.equal(nonces[0], nonces[1]); assert.equal(nonces[0].length, 24);
  assert.equal(await Delivery.countDocuments({ guildId: 'A', sent: true }), 2);
});

test('source polling continues while a Discord send is waiting', async () => {
  const value = thread('g', 1);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id);
  let release; let started;
  const blocked = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { started = resolve; });
  const send = destination.send.bind(destination);
  destination.send = async payload => { started(); await blocked; return send(payload); };
  value.posts.push(post(2, 1));
  const first = service.tick();
  await sending;
  const calls = fixture.requests.filter(path => path === '/boards.json').length;
  value.posts.push(post(3, 1));
  const second = service.tick();
  // Waiting for the source lock lets the second poll finish without waiting for delivery.
  await service.polling;
  assert.equal(fixture.requests.filter(path => path === '/boards.json').length, calls + 1);
  assert.equal(await Reply.countDocuments(), 2);
  release(); await Promise.all([first, second]);
  await service.tick();
  assert.equal(destination.messages.length, 2);
});

test('revoked permissions keep deliveries pending and channel changes route pending work without duplicates', async () => {
  const value = thread('g', 1);
  const first = channel('A'); const second = channel('A', 'replacement');
  const service = feed(); await service.enable('A', first.id);
  first.permissions.remove('EmbedLinks'); value.posts.push(post(2, 1));
  await service.tick();
  assert.equal(first.messages.length, 0);
  assert.equal(await Delivery.countDocuments({ sent: false }), 1);
  await service.enable('A', second.id); await service.deliver('A');
  assert.equal(second.messages.length, 1); assert.equal(first.messages.length, 0);
  await service.tick(); assert.equal(second.messages.length, 1);
});

test('queue insertion before a failed cursor write is idempotent on restart', async () => {
  const value = thread('g', 1); const destination = channel('A');
  let service = feed(); await service.enable('A', destination.id);
  value.posts.push(post(2, 1)); await service.sync();
  const updateOne = Guild.updateOne.bind(Guild);
  let fail = true;
  mock.method(Guild, 'updateOne', (filter, update, ...rest) => {
    if (fail && update.$set?.['chikochan.cursor']) { fail = false; throw new Error('lost database connection'); }
    return updateOne(filter, update, ...rest);
  });
  await assert.rejects(service.deliver('A'));
  assert.equal(await Delivery.countDocuments(), 1); assert.equal(destination.messages.length, 0);
  service = feed(); await service.tick();
  assert.equal(destination.messages.length, 1); assert.equal(await Delivery.countDocuments(), 1);
});

test('a lost database acknowledgement retries with the same nonce and records success only after acceptance', async () => {
  thread('g', 1, [post(2, 1)]);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id);
  const updateOne = Delivery.updateOne.bind(Delivery);
  let fail = true;
  mock.method(Delivery, 'updateOne', (filter, update, ...rest) => {
    if (fail && update.$set?.sent === true) { fail = false; throw new Error('lost database acknowledgement'); }
    return updateOne(filter, update, ...rest);
  });
  await service.deliver('A');
  assert.equal(destination.messages.length, 1);
  assert.equal(await Delivery.countDocuments({ sent: true }), 0);
  clock += 5001; await feed().tick();
  assert.equal(destination.messages.length, 1);
  assert.equal(await Delivery.countDocuments({ sent: true }), 1);
});

test('source failures do not prevent pending-send retries', async () => {
  thread('g', 1, [post(2, 1)]);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id);
  const send = destination.send.bind(destination);
  let fail = true;
  destination.send = async payload => { if (fail) { fail = false; throw new Error('temporary failure'); } return send(payload); };
  await service.deliver('A');
  fixture.errors.set('/boards.json', { status: 503 }); clock += 30000;
  await service.tick();
  assert.equal(destination.messages.length, 1);
});

test('incomplete baselines do not enable a subscription; source Retry-After survives a fresh feed instance', async () => {
  const destination = channel('A'); let service = feed();
  fixture.errors.set('/g/threads.json', { status: 429, headers: { 'Retry-After': '120' } });
  await assert.rejects(service.enable('A', destination.id), /BASELINE_FAILED/);
  assert.equal(await Guild.countDocuments(), 0);
  const calls = fixture.requests.length;
  fixture.errors.clear(); service = feed();
  await assert.rejects(service.enable('A', destination.id), /BASELINE_FAILED/);
  assert.equal(fixture.requests.length, calls);
  clock += 120001; await service.enable('A', destination.id);
  assert.equal((await Guild.findOne({ guildId: 'A' }).lean()).chikochan.enabled, true);
});

test('first setup chooses an existing reply rather than a historically recorded deleted reply', async () => {
  const value = thread('g', 1, [post(2, 1), post(3, 1)]);
  channel('A'); const destination = channel('B');
  const service = feed(); await service.enable('A', 'destination');
  value.posts.pop();
  await service.enable('B', destination.id); await service.deliver('B');
  assert.match(destination.messages[0].embeds[0].title, /#2$/);
  assert.equal(await Reply.countDocuments(), 2); // IDs are retained for deduplication.
});

test('full rereads refresh text and spoiler metadata without replaying an existing reply', async () => {
  const value = thread('g', 1, [post(2, 1, { tim: 'image', ext: '.png' })]);
  const first = channel('A'); const second = channel('B'); const service = feed();
  await service.enable('A', first.id); await service.deliver('A');
  assert.ok(first.messages[0].embeds[0].image);
  value.posts[1].spoiler = 1; value.posts[1].com = 'Edited comment';
  await service.enable('B', second.id); await service.deliver('B');
  assert.equal(second.messages[0].embeds[0].image, undefined);
  assert.ok(second.messages[0].embeds[0].description.includes('Edited comment'));
  await service.tick(); assert.equal(first.messages.length, 1);
});

test('HTML conversion decodes entities, preserves breaks and quote references, and escapes Discord formatting', () => {
  const text = htmlToDiscord('<p>&quot;Hi&quot; &amp; &copy; &eacute; &#x1F600; <b>**bold**</b></p>'
    + '<a class="quotelink" href="#p12">&gt;&gt;12</a><br>next<br><br>last'
    + '<script>hidden()</script><style>hidden{}</style> @everyone &lt;@123&gt; [bad](https://bad)');
  assert.ok(text.includes('"Hi" & © é 😀'));
  assert.ok(text.includes('\\>\\>12\nnext\n\nlast'));
  assert.ok(text.includes('\\*\\*bold\\*\\*'));
  assert.ok(text.includes('@\u200beveryone'));
  assert.ok(text.includes('\\[bad\\]\\(https://bad\\)'));
  assert.ok(!text.includes('hidden'));
});

test('embeds include poster, tripcode, original date, exact reply link, and stored attachment paths', () => {
  const value = post(12, 1, { name: 'Chiko &amp; friend', trip: '!trip', com: 'Hello<br>&gt;&gt;1',
    tim: '001234567890123456789-uuid', ext: '.png', filename: 'wrong-original-name' });
  const payload = formatReply('https://boards.chiko.cc', { board: 'chiko', post: value });
  const embed = payload.embeds[0];
  assert.equal(embed.url, 'https://boards.chiko.cc/chiko/thread/1#p12');
  assert.equal(embed.timestamp, new Date(value.time * 1000).toISOString());
  assert.equal(embed.author.name, 'Chiko & friend !trip');
  assert.match(embed.footer.text, /Post #12.*Parent thread #1/);
  assert.equal(embed.image.url, 'https://boards.chiko.cc/src/001234567890123456789-uuid.png');
  assert.ok(!JSON.stringify(payload).includes('wrong-original-name'));
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test('extra pictures, spoilers, deleted files, missing files, and non-images remain one graceful notification', async () => {
  const value = thread('g', 1, [post(2, 1, { tim: 'primary', ext: '.png', spoiler: 1,
    extra_files: [{ tim: 'spoiler-extra', ext: '.jpg' }] })]);
  const destination = channel('A'); const service = feed();
  await service.enable('A', destination.id); await service.deliver('A');
  const secret = JSON.stringify(destination.messages[0]);
  assert.ok(!secret.includes('/src/primary')); assert.ok(!secret.includes('/src/spoiler-extra'));
  assert.ok(!fixture.requests.some(path => path.startsWith('/src/')));
  value.posts.push(post(3, 1, { tim: 'missing', ext: '.png', extra_files: [
    { tim: 'extra-one', ext: '.webp' }, { tim: 'extra-two', ext: '.jpg' },
    { tim: 'video', ext: '.webm', media_type: 'video' }, { filedeleted: 1 },
    { tim: 'secret', ext: '.jpg', spoiler: 1 },
  ] }));
  fixture.missingImages.add('/src/missing.png');
  await service.tick();
  assert.equal(destination.messages.length, 2);
  const payload = destination.messages[1];
  assert.equal(payload.embeds.length, 2);
  assert.equal(payload.embeds[0].image.url, `${origin}/src/extra-one.webp`);
  assert.equal(payload.embeds[1].image.url, `${origin}/src/extra-two.jpg`);
  const body = JSON.stringify(payload);
  assert.ok(body.includes('unavailable or deleted')); assert.ok(body.includes('/src/video.webm'));
  assert.ok(body.includes('Spoiler attachment')); assert.ok(!body.includes('/src/secret'));
});

test('Discord text/field/embed limits hold for long escaped comments, names, and many attachments', () => {
  const value = post(12, 1, { name: '*'.repeat(1000), trip: '_'.repeat(1000), com: '[long] **@everyone** 😀\n'.repeat(1000),
    extra_files: Array.from({ length: 40 }, (_, index) => ({ tim: `file-${index}`, ext: '.png' })) });
  const payload = formatReply('https://boards.chiko.cc', { board: 'g', post: value });
  const embed = payload.embeds[0];
  assert.ok(embed.description.length <= 4096); assert.ok(embed.author.name.length <= 256);
  assert.ok(embed.title.length <= 256); assert.ok(embed.fields[0].value.length <= 1024);
  assert.equal(payload.embeds.length, 10);
  assert.match(embed.description, /Read complete reply/); assert.ok(embed.description.endsWith('#p12)'));
  const characters = payload.embeds.reduce((sum, item) => sum + (item.title?.length || 0) + (item.description?.length || 0)
    + (item.author?.name?.length || 0) + (item.footer?.text?.length || 0)
    + (item.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0), 0);
  assert.ok(characters <= 6000);
});

test('API identifiers retain exact numeric source digits and attachment tim is always treated as a string', async () => {
  const api = new ChikoChanApi(origin, { fetchImpl: async () => new Response(
    '{"posts":[{"no":9007199254740993,"resto":9007199254740991,"tim":1234567890123456789,"ext":".jpg"}]}',
    { headers: { 'Content-Type': 'application/json' } }) });
  const [value] = await api.posts('g', '1');
  assert.equal(value.no, '9007199254740993'); assert.equal(value.tim, '1234567890123456789');
  assert.equal(attachments(origin, value)[0].url, `${origin}/src/1234567890123456789.jpg`);
  assert.ok(!attachments(origin, { tim: 'malicious) ](https://example.com', ext: '.png' })[0].url
    .includes('](https://example.com'));
});

test('unsafe base URLs and malformed source payloads are rejected without treating them as empty baselines', async () => {
  assert.equal(baseUrl('https://boards.chiko.cc/'), 'https://boards.chiko.cc');
  for (const value of ['file:///tmp/source', 'https://user:secret@example.org', 'https://example.org/?x=1']) {
    assert.throws(() => baseUrl(value));
  }
  const api = new ChikoChanApi(origin, { fetchImpl: async () => Response.json({ boards: [{ board: '../private' }] }) });
  await assert.rejects(api.boards(), /INVALID_BOARD/);
  api.fetch = async () => Response.json({ unexpected: true });
  await assert.rejects(api.threads('g'), /INVALID_THREADS/);
  await assert.rejects(api.posts('g', '1'), /INVALID_POSTS/);
});
