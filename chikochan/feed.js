'use strict';

const { randomUUID } = require('node:crypto');
const { ChannelType, PermissionsBitField } = require('discord.js');
const Guild = require('../models/Guild');
const { Source, Thread, Reply, Delivery } = require('../models/ChikoChan');
const { ChikoChanApi, postId, retryDelay } = require('./api');
const { attachments, formatReply } = require('./format');

const P = PermissionsBitField.Flags;
function canUseChannel(channel, botUser, guildId) {
  return channel?.guildId === guildId && channel.type === ChannelType.GuildText
    && typeof channel.send === 'function'
    && Boolean(channel.permissionsFor(botUser)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]));
}

function normalizePost(post, thread) {
  const no = postId(post.no);
  const resto = postId(post.resto);
  if (!no || !resto || resto !== thread) return null;
  const time = Number(post.time);
  if (!Number.isFinite(time) || time < 0 || Number.isNaN(new Date(time * 1000).getTime())) {
    throw new Error('CHIKOCHAN_INVALID_POST_TIME');
  }
  const file = value => ({
    tim: value.tim == null ? undefined : String(value.tim), ext: value.ext,
    spoiler: value.spoiler, filedeleted: value.filedeleted, deleted: value.deleted,
    file_deleted: value.file_deleted, media_type: value.media_type,
  });
  const extra = Array.isArray(post.extra_files) ? post.extra_files
    : post.extra_files && typeof post.extra_files === 'object' ? Object.values(post.extra_files) : [];
  return {
    ...file(post), no, resto, time, name: String(post.name || 'Anonymous'),
    trip: post.trip ? String(post.trip) : '', com: String(post.com || ''),
    extra_files: extra.filter(item => item && typeof item === 'object').map(file),
  };
}

class ChikoChanFeed {
  constructor({ client, inGuildOrder, logFailure, url, pollMs = 30000, reconcileMs = 600000,
    api, now = Date.now, ready = () => true } = {}) {
    this.client = client;
    this.inGuildOrder = inGuildOrder;
    this.logFailure = logFailure;
    this.api = api || new ChikoChanApi(url, { now });
    this.source = this.api.baseUrl;
    this.pollMs = pollMs;
    this.reconcileMs = reconcileMs;
    this.now = now;
    this.ready = ready;
    this.sourceQueue = Promise.resolve();
    this.deliveries = new Map();
    this.payloads = new Map();
    this.stopping = false;
  }

  async sync(force = false) {
    const task = this.sourceQueue.then(() => this.scan(force));
    this.sourceQueue = task.catch(() => {});
    return task;
  }

  async scan(force) {
    if (force) this.payloads.clear();
    let state = await Source.findOneAndUpdate({ _id: this.source }, { $setOnInsert: { sequence: 0 } },
      { upsert: true, returnDocument: 'after' }).lean();
    if (state.retryAt?.getTime() > this.now()) return { complete: false, state };
    let complete = true;
    let newest;
    let boards;
    try {
      boards = await this.api.boards();
      await Source.updateOne({ _id: this.source }, { $set: { boards } });
    } catch {
      this.logFailure('ChikoChan board discovery');
      await this.saveRetry();
      return { complete: false, state };
    }
    for (const board of boards) {
      if (this.stopping) return { complete: false, state };
      let summaries;
      try { summaries = await this.api.threads(board); }
      catch { complete = false; continue; }
      const known = await Thread.find({ source: this.source, board }).lean();
      const byId = new Map(known.map(thread => [thread.no, thread]));
      for (const summary of summaries) {
        if (this.stopping) return { complete: false, state };
        const previous = byId.get(summary.no);
        const count = Number(summary.replies);
        const modified = String(summary.last_modified ?? '');
        if (!force && previous && Number.isFinite(count) && previous.replies === count
          && previous.modified === modified && this.now() - previous.checkedAt?.getTime() < this.reconcileMs) continue;
        try {
          const posts = (await this.api.posts(board, summary.no)).map(post => normalizePost(post, summary.no)).filter(Boolean);
          for (const post of posts) {
            if (!newest || post.time > newest.time || (post.time === newest.time && BigInt(post.no) > BigInt(newest.no))) {
              newest = { board, no: post.no, time: post.time };
            }
          }
          const existing = await Reply.find({ source: this.source, board, no: { $in: posts.map(post => post.no) } }).select('no').lean();
          const seen = new Set(existing.map(post => post.no));
          const fresh = posts.filter(post => !seen.has(post.no));
          if (fresh.length) {
            // Allocate first; a crash before insertion leaves harmless gaps. Thread metadata is saved last.
            const counter = await Source.findOneAndUpdate({ _id: this.source }, { $inc: { sequence: fresh.length } }, { returnDocument: 'after' }).lean();
            await Reply.bulkWrite(fresh.map((post, index) => ({ updateOne: {
              filter: { source: this.source, board, no: post.no },
              update: { $setOnInsert: { source: this.source, board, no: post.no, time: post.time,
                post, sequence: counter.sequence - fresh.length + index + 1 } },
              upsert: true,
            } })));
          }
          const updated = posts.filter(post => seen.has(post.no));
          if (updated.length) {
            // Keep edits and changed spoiler/deletion flags current without creating new notifications.
            await Reply.bulkWrite(updated.map(post => ({ updateOne: {
              filter: { source: this.source, board, no: post.no }, update: { $set: { post, time: post.time } },
            } })));
          }
          await Thread.updateOne({ source: this.source, board, no: summary.no }, { $set: {
            replies: Number.isFinite(count) ? count : null, modified, checkedAt: new Date(this.now()),
          } }, { upsert: true });
        } catch (error) {
          // Threads can disappear between listing and fetching.
          if (![404, 410].includes(error.status)) complete = false;
        }
      }
    }
    if (complete) {
      await Source.updateOne({ _id: this.source }, { $unset: { retryAt: 1 } });
    } else {
      this.logFailure('ChikoChan source check');
      await this.saveRetry();
    }
    state = await Source.findById(this.source).lean();
    return { complete, state, newest };
  }

  async saveRetry() {
    if (this.api.retryAt > this.now()) {
      await Source.updateOne({ _id: this.source }, { $set: { retryAt: new Date(this.api.retryAt) } });
    }
  }

  async enable(guildId, channelId) {
    return this.inGuildOrder(guildId, async () => {
      const saved = await Guild.findOne({ guildId }).lean();
      if (saved?.chikochan?.enabled && saved.chikochan.source === this.source) {
        await Guild.updateOne({ guildId }, { $set: { 'chikochan.channelId': channelId } });
        return;
      }
      // Full scans establish a baseline even when the source has been idle or replies didn't bump.
      const { complete, state, newest: latest } = await this.sync(true);
      if (!complete) throw new Error('CHIKOCHAN_BASELINE_FAILED');
      const first = !saved?.chikochan?.generation;
      const newest = first && latest ? await Reply.findOne({ source: this.source, board: latest.board, no: latest.no }).lean() : null;
      const subscription = {
        enabled: true, channelId, source: this.source, generation: randomUUID(), cursor: state.sequence,
        ...(newest && { seedReplyId: newest._id }),
      };
      // Seed and baseline are one durable write, so restart cannot lose the initial notification.
      await Guild.findOneAndUpdate({ guildId }, { $set: { chikochan: subscription } },
        { upsert: true, returnDocument: 'after', runValidators: true });
    });
  }

  async disable(guildId) {
    return this.inGuildOrder(guildId, () => Guild.updateOne({ guildId }, { $set: { 'chikochan.enabled': false } }));
  }

  async enqueue(guildId, subscription) {
    const add = reply => Delivery.updateOne({ guildId, source: this.source, replyId: reply._id }, { $setOnInsert: {
      guildId, source: this.source, replyId: reply._id, generation: subscription.generation,
      time: reply.time, sequence: reply.sequence, sent: false, attempts: 0,
    } }, { upsert: true });
    if (subscription.seedReplyId) {
      const seed = await Reply.findById(subscription.seedReplyId).lean();
      if (seed) await add(seed);
      await Guild.updateOne({ guildId }, { $unset: { 'chikochan.seedReplyId': 1 } });
    }
    let cursor = subscription.cursor;
    for await (const reply of Reply.find({ source: this.source, sequence: { $gt: cursor } }).sort({ sequence: 1 }).lean().cursor()) {
      await add(reply);
      cursor = Math.max(cursor, reply.sequence);
    }
    if (cursor !== subscription.cursor) {
      await Guild.updateOne({ guildId }, { $set: { 'chikochan.cursor': cursor } });
    }
  }

  async payload(reply) {
    const key = String(reply._id);
    if (!this.payloads.has(key)) {
      const pending = (async () => {
        const pictures = attachments(this.source, reply.post).filter(file => file.image && !file.spoiler).slice(0, 10);
        const results = await Promise.allSettled(pictures.map(file => this.api.imageAvailable(file.url)));
        const unavailable = new Set(pictures.filter((file, index) => results[index].status !== 'fulfilled' || !results[index].value).map(file => file.url));
        return formatReply(this.source, reply, unavailable);
      })();
      this.payloads.set(key, pending);
      // Bound the cache. A retry can recheck a previously missing image.
      if (this.payloads.size > 500) this.payloads.delete(this.payloads.keys().next().value);
    }
    return this.payloads.get(key);
  }

  deliver(guildId) {
    if (this.deliveries.has(guildId)) return this.deliveries.get(guildId);
    const task = this.inGuildOrder(guildId, async () => {
      const setting = await Guild.findOne({ guildId, 'chikochan.enabled': true, 'chikochan.source': this.source }).lean();
      if (!setting || this.stopping) return;
      const subscription = setting.chikochan;
      await this.enqueue(guildId, subscription);
      const guild = this.client.guilds.cache.get(guildId);
      const channel = await guild?.channels.fetch(subscription.channelId);
      if (!canUseChannel(channel, this.client.user, guildId)) return;
      const pending = Delivery.find({ guildId, source: this.source, generation: subscription.generation, sent: false })
        .sort({ time: 1, sequence: 1 }).limit(25).lean().cursor();
      for await (const delivery of pending) {
        if (this.stopping || delivery.retryAt?.getTime() > this.now()) break;
        try {
          const reply = await Reply.findById(delivery.replyId).lean();
          if (!reply) throw new Error('CHIKOCHAN_MISSING_REPLY');
          const payload = await this.payload(reply);
          const message = await channel.send({ ...payload, nonce: String(delivery._id), enforceNonce: true });
          if (!message?.id) throw new Error('CHIKOCHAN_SEND_NOT_CONFIRMED');
          // Do not claim successful delivery until Discord has accepted the message.
          await Delivery.updateOne({ _id: delivery._id }, {
            $set: { sent: true, messageId: message.id, sentAt: new Date(this.now()) }, $unset: { retryAt: 1 },
          });
        } catch (error) {
          this.logFailure('ChikoChan delivery');
          this.payloads.delete(String(delivery.replyId));
          await Delivery.updateOne({ _id: delivery._id }, { $inc: { attempts: 1 },
            $set: { retryAt: new Date(this.now() + retryDelay(error, delivery.attempts)) } });
          break; // Preserve chronological order for this server, including after failed sends.
        }
      }
    }).finally(() => { this.deliveries.delete(guildId); });
    this.deliveries.set(guildId, task);
    return task;
  }

  async tick() {
    if (this.stopping || !this.ready()) return;
    if (!this.polling) {
      this.polling = (async () => {
        const settings = await Guild.find({ 'chikochan.enabled': true, 'chikochan.source': this.source }).select('guildId').lean();
        if (!settings.length) return [];
        this.payloads.clear();
        try { await this.sync(); } catch { this.logFailure('ChikoChan polling'); }
        return settings.map(setting => this.deliver(setting.guildId));
      })().catch(() => { this.logFailure('ChikoChan scheduler'); return []; }).finally(() => { this.polling = undefined; });
    }
    // Only source scans share the polling guard. Slow Discord sends cannot stop source polling.
    return this.polling.then(async tasks => {
      const deliveries = await Promise.allSettled(tasks);
      if (deliveries.some(result => result.status === 'rejected')) this.logFailure('ChikoChan delivery queue');
    });
  }

  start() {
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    void this.tick();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.polling;
    await this.sourceQueue;
    await Promise.allSettled([...this.deliveries.values()]);
  }
}

module.exports = { ChikoChanFeed, canUseChannel, normalizePost };
