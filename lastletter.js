const { randomInt } = require('node:crypto');
const { EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { LastLetterStore } = require('./lastletter-store');
const { numberReactions } = require('./number-reactions');

let dictionary;
function englishDictionary() {
  if (!dictionary) dictionary = new Set(require('an-array-of-english-words'));
  return dictionary;
}
function isCommand(content) { return /^[./]/.test(content.trim()); }
function gameKey(guildId, channelId) { return `${guildId}:${channelId}`; }

class LastLetter {
  constructor({ store = new LastLetterStore(), words, pickLetter = () => String.fromCharCode(97 + randomInt(26)),
    send = async (channel, payload) => channel.send(payload), canSend = () => true,
    logFailure = () => console.error('Last Letter operation failed. Check connectivity and permissions.') } = {}) {
    this.store = store;
    this.words = words;
    this.pickLetter = pickLetter;
    this.send = send;
    this.canSend = canSend;
    this.logFailure = logFailure;
    this.queues = new Map();
  }

  inChannel(id, task) {
    const next = (this.queues.get(id) || Promise.resolve()).then(task);
    const settled = next.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return next;
  }

  async synchronize(game) {
    try { await this.store.flush(game); }
    catch { this.logFailure('Last Letter best-streak synchronization'); }
  }

  async change(id, operation) {
    // A revision check protects against another bot process sharing this database.
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await operation(await this.store.read(id));
      if (result) return result;
    }
    throw new Error('LASTLETTER_CONCURRENT_UPDATE');
  }

  start({ guildId, channelId, userId }) {
    const id = gameKey(guildId, channelId);
    return this.inChannel(id, () => this.change(id, async game => {
      if (game?.active) return { code: 'already-active', game };
      const changes = { active: true, starterId: userId, requiredLetter: this.pickLetter(),
        lastPlayerId: null, usedWords: [], players: [], startedAt: new Date(), stoppedAt: null };
      const saved = game ? await this.store.commit(game, changes)
        : await this.store.insert({ _id: id, guildId, channelId, revision: 0, pendingBests: {}, ...changes });
      if (!saved) return null;
      await this.synchronize(saved);
      return { code: 'started', game: saved };
    }));
  }

  stop({ guildId, channelId, admin = false }) {
    const id = gameKey(guildId, channelId);
    return this.inChannel(id, () => this.change(id, async game => {
      if (!game?.active) return { code: 'inactive' };
      if (!admin) return { code: 'forbidden' };
      const saved = await this.store.commit(game, { active: false, lastPlayerId: null, stoppedAt: new Date() });
      if (!saved) return null;
      await this.synchronize(saved);
      return { code: 'stopped', game: saved };
    }));
  }

  submit({ guildId, channelId, userId, content, bot = false, webhook = false }) {
    const id = gameKey(guildId, channelId);
    return this.inChannel(id, () => this.change(id, async game => {
      if (!game?.active) return { code: 'ignored' };
      if (bot || webhook || isCommand(content)) return { code: 'ignored' };
      // This check MUST precede normalization, dictionary/duplicate/letter checks,
      // player creation, record reads, and writes. Blocked submissions change nothing.
      if (game.lastPlayerId === userId) return { code: 'cooldown', game };
      const word = content.trim().toLowerCase();
      const valid = /^[a-z]+$/.test(word) && (this.words || englishDictionary()).has(word);
      const used = new Set(game.usedWords);
      const code = !valid ? 'invalid' : used.has(word) ? 'duplicate'
        : word[0] !== game.requiredLetter ? 'wrong-letter' : 'accepted';
      const players = game.players.map(player => ({ ...player }));
      let player = players.find(entry => entry.userId === userId);
      if (!player) { player = { userId, currentStreak: 0, highestStreak: 0, validWords: 0 }; players.push(player); }
      if (code !== 'accepted') {
        // A rejected answer ends the current round for everyone. Keep the game
        // active and immediately open a clean round with a fresh starting letter.
        const saved = await this.store.commit(game, { active: true, requiredLetter: this.pickLetter(),
          lastPlayerId: null, usedWords: [], players: [], startedAt: new Date(), stoppedAt: null });
        return saved ? { code, game: saved, restarted: true } : null;
      }
      player.currentStreak++;
      player.validWords++;
      player.highestStreak = Math.max(player.highestStreak, player.currentStreak);
      const saved = await this.store.commit(game, { players, usedWords: [...used, word],
        requiredLetter: word.at(-1), lastPlayerId: userId }, { userId, value: player.highestStreak });
      if (!saved) return null;
      // A pending record is persisted atomically with the accepted turn. If this
      // second collection is unavailable, startup/the next game action repairs it.
      await this.synchronize(saved);
      let bestStreak;
      try { bestStreak = Math.max(player.highestStreak, saved.pendingBests?.[userId] || 0, await this.store.best(userId)); }
      catch { this.logFailure('Last Letter lifetime record lookup'); }
      return { code, game: saved, word, player, bestStreak };
    }));
  }

  async handleMessage(message) {
    if (!message.guild || message.author.bot || message.webhookId || isCommand(message.content)) return;
    try {
      const result = await this.submit({ guildId: message.guild.id, channelId: message.channel.id,
        userId: message.author.id, content: message.content });
      try {
        // Await each request to preserve digit order. Discord.js handles rate
        // limits. Stop on failure so later digits cannot shift into its place.
        for await (const emoji of submissionReactions(result, message.client?.application?.emojis)) {
          await message.react(emoji);
        }
      } catch { this.logFailure('Last Letter reactions'); }
      if (result.restarted) {
        await this.send(message.channel, { embeds: [startEmbed(result.game)], allowedMentions: { parse: [] } });
      }
    } catch { this.logFailure('Last Letter submission'); }
  }

  async handleInteraction(interaction) {
    let deferred = false;
    try {
      const action = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      const memberPermissions = interaction.memberPermissions || interaction.member?.permissions;
      const owner = userId === interaction.guild.ownerId || userId === process.env.OWNER_ID;
      const admin = owner || Boolean(memberPermissions?.has(PermissionsBitField.Flags.Administrator));
      if (!admin) {
        return await interaction.reply({ content: 'Only a server Administrator, the server owner, or the bot owner can start or stop Last Letter.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel?.('channel') || interaction.channel;
      if (!channel || (channel.guildId && channel.guildId !== interaction.guild.id) || !this.canSend(channel)) {
        return await interaction.reply({ content: 'I need permission to view and send messages in this channel.', flags: MessageFlags.Ephemeral });
      }
      const permissions = channel.permissionsFor?.(interaction.client?.user);
      if (permissions && !permissions.has(PermissionsBitField.Flags.EmbedLinks)) {
        return await interaction.reply({ content: 'I need Embed Links permission in this channel.', flags: MessageFlags.Ephemeral });
      }
      if (action === 'start' && permissions && !permissions.has([
        PermissionsBitField.Flags.AddReactions, PermissionsBitField.Flags.ReadMessageHistory,
      ])) {
        return await interaction.reply({ content: 'I need Add Reactions and Read Message History permissions in the game channel.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply(); deferred = true;
      const input = { guildId: interaction.guild.id, channelId: channel.id || interaction.channelId, userId, admin };
      const result = action === 'start' ? await this.start(input) : action === 'stop' ? await this.stop(input) : { code: 'unknown' };
      if (result.code === 'started' || result.code === 'stopped') {
        const payload = { embeds: [result.code === 'started' ? startEmbed(result.game) : resultsEmbed(result.game)], allowedMentions: { parse: [] } };
        if (channel.id && channel.id !== interaction.channelId) {
          const sent = await this.send(channel, payload);
          return await interaction.editReply({ content: sent === null
            ? `The game state in <#${channel.id}> was updated, but I could not post the announcement. Check my channel permissions.`
            : `Last Letter ${result.code === 'started' ? 'started' : 'stopped'} in <#${channel.id}>.` });
        }
        return await interaction.editReply(payload);
      }
      const text = { 'already-active': 'A Last Letter game is already active in this channel.',
        inactive: 'There is no active Last Letter game in this channel.',
        forbidden: 'Only a server Administrator, the server owner, or the bot owner can stop Last Letter.' };
      await interaction.editReply({ content: text[result.code] || 'Use /lastletter start or /lastletter stop.' });
    } catch {
      this.logFailure('Last Letter command');
      try {
        if (deferred) await interaction.editReply({ content: 'Could not finish the Last Letter request. Please try again shortly.' });
        else await interaction.reply({ content: 'Could not start Last Letter. Please try again shortly.', flags: MessageFlags.Ephemeral });
      } catch { this.logFailure('Last Letter reply'); }
    }
  }

  async recover() {
    try { await this.store.recover(); }
    catch { this.logFailure('Last Letter record recovery'); }
  }

  async drain() { await Promise.allSettled([...this.queues.values()]); }
}

function startEmbed(game) {
  return new EmbedBuilder().setColor(0x57f287).setTitle('Last Letter started!')
    .setDescription(`Starting letter: **${game.requiredLetter.toUpperCase()}**\nSend one English word in chat.\nAnother player must submit a valid word before you can play again.\nWords cannot repeat during this game.\n\n✅ Accepted • ❌ Rejected • ⏳ Wait for another player\nNumber reactions mark the accepted-word count.`);
}

async function* submissionReactions(result, applicationEmojis) {
  if (result.code === 'ignored') return;
  if (result.code === 'cooldown') { yield '⏳'; return; }
  if (result.code !== 'accepted') { yield '❌'; return; }
  yield '✅';
  yield* numberReactions(result.game.usedWords.length, applicationEmojis);
}

function resultsEmbed(game) {
  const players = game.players.filter(player => player.validWords > 0);
  const ranked = field => [...players].sort((a, b) => b[field] - a[field]
    || b.highestStreak - a.highestStreak || b.validWords - a.validWords || a.userId.localeCompare(b.userId))
    .slice(0, 10).map((player, index) => `${index + 1}. <@${player.userId}> — ${player[field]}`).join('\n') || 'No accepted words yet.';
  return new EmbedBuilder().setColor(0x5865f2).setTitle('Last Letter finished!')
    .setDescription(`Accepted words: **${game.usedWords.length}** • Players: **${players.length}**`)
    .addFields({ name: 'Top players by valid words', value: ranked('validWords') },
      { name: 'Top players by highest game streak', value: ranked('highestStreak') })
    .setFooter({ text: 'Lifetime best streaks are preserved. Start a new game with /lastletter start.' });
}

module.exports = { LastLetter, englishDictionary, isCommand, gameKey, startEmbed, submissionReactions, resultsEmbed };
