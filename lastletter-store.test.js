const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const Game = require('./models/LastLetterGame');
const Player = require('./models/LastLetterPlayer');
const { LastLetterStore } = require('./lastletter-store');
const { LastLetter } = require('./lastletter');

afterEach(() => mock.restoreAll());

test('game writes use an atomic revision predicate and persist the pending record with the accepted turn', async () => {
  const store = new LastLetterStore();
  let captured;
  mock.method(Game, 'findOneAndUpdate', (filter, update, options) => {
    captured = { filter, update, options }; return { lean: async () => ({ revision: 5 }) };
  });
  await store.commit({ _id: 'guild:channel', revision: 4 }, { lastPlayerId: '123', requiredLetter: 'e' }, { userId: '123', value: 7 });
  assert.deepEqual(captured.filter, { _id: 'guild:channel', revision: 4 });
  assert.deepEqual(captured.update.$inc, { revision: 1 });
  assert.deepEqual(captured.update.$max, { 'pendingBests.123': 7 });
  assert.equal(captured.options.returnDocument, 'after'); assert.equal(captured.options.runValidators, true);
});

test('lifetime records use $max and acknowledge only the exact pending record that was saved', async () => {
  const operations = [];
  mock.method(Player, 'updateOne', async (...args) => { operations.push(['record', ...args]); });
  mock.method(Game, 'updateOne', async (...args) => { operations.push(['acknowledge', ...args]); });
  await new LastLetterStore().flush({ _id: 'guild:channel', pendingBests: { 123: 7 } });
  assert.deepEqual(operations[0][1], { discordUserId: '123' });
  assert.deepEqual(operations[0][2], { $max: { bestStreak: 7 } });
  assert.deepEqual(operations[1][1], { _id: 'guild:channel', 'pendingBests.123': 7 });
  assert.deepEqual(operations[1][2], { $unset: { 'pendingBests.123': 1 } });
});

test('a failed lifetime write never acknowledges or clears the durable pending record', async () => {
  mock.method(Player, 'updateOne', async () => { throw new Error('unavailable'); });
  mock.method(Game, 'updateOne', () => { throw new Error('must not acknowledge'); });
  await assert.rejects(new LastLetterStore().flush({ _id: 'guild:channel', pendingBests: { 123: 7 } }), /unavailable/);
});

test('a simultaneous insert conflict is retried, while other database failures propagate', async () => {
  const create = mock.method(Game, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  assert.equal(await new LastLetterStore().insert({}), null);
  create.mock.mockImplementation(async () => { throw new Error('offline'); });
  await assert.rejects(new LastLetterStore().insert({}), /offline/);
});

test('real MongoDB: concurrent instances, durable recovery and restart behavior', {
  skip: !process.env.LASTLETTER_TEST_MONGODB_URI,
}, async () => {
  // Always use a uniquely named disposable database, never the bot's database.
  const dbName = `hatsune_lastletter_test_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(process.env.LASTLETTER_TEST_MONGODB_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  try {
    await Promise.all([Game.init(), Player.init()]);
    const store = new LastLetterStore();
    const options = { store, words: new Set(['apple', 'axe', 'eagle', 'elephant', 'tiger']), pickLetter: () => 'a' };
    const first = new LastLetter(options); const second = new LastLetter(options);
    const input = { guildId: '1', channelId: '2', userId: '123' };
    const starts = await Promise.all([first.start(input), second.start({ ...input, userId: '456' })]);
    assert.deepEqual(starts.map(r => r.code).sort(), ['already-active', 'started']);
    const turns = await Promise.all([first.submit({ ...input, content: 'apple' }), second.submit({ ...input, content: 'axe' })]);
    assert.deepEqual(turns.map(r => r.code).sort(), ['accepted', 'cooldown']);
    const acceptedWord = turns.find(r => r.code === 'accepted').word;
    assert.equal((await store.read('1:2')).requiredLetter, 'e');
    const duplicates = await Promise.all([first.submit({ ...input, userId: '456', content: 'eagle' }),
      second.submit({ ...input, userId: '789', content: 'EAGLE' })]);
    assert.deepEqual(duplicates.map(r => r.code).sort(), ['accepted', 'duplicate']);
    assert.deepEqual((await store.read('1:2')).usedWords, [acceptedWord, 'eagle']);
    const last = (await store.read('1:2')).lastPlayerId;
    const restarted = new LastLetter(options);
    assert.equal((await restarted.submit({ ...input, userId: last, content: 'elephant' })).code, 'cooldown');

    // Exercise the durable outbox against real MongoDB with a transient record failure.
    const failingStore = new LastLetterStore(); failingStore.flush = async () => { throw new Error('record write failed'); };
    const failing = new LastLetter({ ...options, store: failingStore, logFailure: () => {} });
    const result = await failing.submit({ ...input, content: 'elephant' });
    assert.equal(result.code, 'accepted'); assert.equal(result.player.currentStreak, 2);
    assert.equal((await store.read('1:2')).pendingBests['123'], 2);
    await restarted.recover();
    assert.equal(await store.best('123'), 2);
    assert.deepEqual((await store.read('1:2')).pendingBests, {});
    await restarted.stop({ ...input, admin: true }); await restarted.start(input);
    assert.equal((await restarted.submit({ ...input, content: 'apple' })).bestStreak, 2);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
