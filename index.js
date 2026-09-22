require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, PermissionsBitField, ActivityType, version } = require('discord.js');
const User = require('./models/User');
const Guild = require('./models/Guild');
const { osuGet } = require('./osu');

mongoose.set('bufferCommands', false);
const P = PermissionsBitField.Flags;
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  allowedMentions: { parse: [], repliedUser: false },
});
const queues = new Map();
const warningCooldowns = new Map();
const osuCooldowns = new Map();
let scheduler;
let checkingCountdown = false;

function seconds(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 1 || value > 86400) throw new Error(`Invalid ${name}`);
  return value * 1000;
}

// Never log raw errors: database and HTTP errors can contain credentials.
function logFailure(context) { console.error(`${context} failed. Check connectivity and permissions.`); }
function isAdmin(message) {
  return message.author.id === message.guild.ownerId || message.member?.permissions.has(P.Administrator);
}
function canConfigureGuild(message) {
  const user = message.author || message.user;
  if (!message.guild || !message.member || !user) return false;
  return user.id === process.env.OWNER_ID
    || message.guild.ownerId === user.id
    || message.member.permissions.has(P.Administrator);
}
function canSend(channel) {
  if (!channel?.isTextBased() || typeof channel.send !== 'function') return false;
  const permissions = channel.permissionsFor(client.user);
  return Boolean(permissions?.has([P.ViewChannel, channel.isThread() ? P.SendMessagesInThreads : P.SendMessages])
    && !(channel.isThread() && (channel.archived || channel.locked)));
}
async function send(channel, payload) {
  if (!canSend(channel)) return null;
  try { return await channel.send(payload); }
  catch { logFailure('Sending message'); return null; }
}
function reply(message, content) { return send(message.channel, content); }
async function interactionReply(interaction, content, ephemeral = false) {
  try {
    if (interaction.replied || interaction.deferred) return interaction.followUp({ content, ephemeral });
    return interaction.reply({ content, ephemeral });
  } catch { logFailure('Sending interaction reply'); return null; }
}

// Keep messages and configuration changes in arrival order within each guild.
function inGuildOrder(guildId, task) {
  const next = (queues.get(guildId) || Promise.resolve()).then(task);
  const settled = next.catch(() => { logFailure('Guild task'); });
  queues.set(guildId, settled);
  void settled.then(() => { if (queues.get(guildId) === settled) queues.delete(guildId); });
  return next;
}

function parseOffset(text) {
  const match = /^(?:(?:GMT|UTC))?([+-])(\d{1,2})(?::([0-5]\d))?$/i.exec(text);
  if (!match) return null;
  const offset = (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '-' ? -1 : 1);
  return offset >= -720 && offset <= 840 ? offset : null;
}
function countdownDate(offset, now = Date.now()) {
  const local = new Date(now + offset * 60000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return {
    date: local.toISOString().slice(0, 10),
    days: Math.round((Date.UTC(local.getUTCFullYear() + 1, 0, 1) - midnight) / 86400000),
    newYear: local.getUTCMonth() === 0 && local.getUTCDate() === 1,
  };
}
function hasLink(text) {
  return /(?:\bhttps?:\/\/[^\s<>]+|\bwww\.(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\b|\/)|\bdiscord\.gg\/[a-z0-9-]+)/i.test(text);
}
function onCooldown(map, key, duration) {
  const now = Date.now();
  if ((map.get(key) || 0) > now) return true;
  map.set(key, now + duration);
  return false;
}

async function saveGuild(guildId, changes) {
  return Guild.findOneAndUpdate({ guildId }, changes, { upsert: true, new: true, runValidators: true });
}

async function configureSlash(interaction, command) {
  if (!canConfigureGuild(interaction)) return interactionReply(interaction, 'Only the server owner, an Administrator, or the bot owner can configure this.', true);
  const guildId = interaction.guild.id;
  if (command === 'set') {
    const action = interaction.options.getSubcommand();
    const timezone = interaction.options.getString('timezone');
    const cancel = action === 'cancel';
    if (cancel) { await Guild.updateOne({ guildId }, { $unset: { countdown: 1 } }); return interactionReply(interaction, 'Countdown disabled for this server.', true); }
    const offset = parseOffset(timezone || '');
    if (offset === null) return interactionReply(interaction, 'Use GMT+7, UTC-5, or UTC+5:30 (UTC-12 to UTC+14).', true);
    if (!canSend(interaction.channel)) return interactionReply(interaction, 'I cannot send messages in this channel.', true);
    await saveGuild(guildId, { $set: { 'countdown.enabled': true, 'countdown.channelId': interaction.channelId, 'countdown.utcOffsetMinutes': offset } });
    return interactionReply(interaction, 'Daily New Year countdown enabled in this channel.', true);
  }
  if (command === 'number') {
    if (interaction.options.getSubcommand() === 'cancel') { await Guild.updateOne({ guildId }, { $unset: { counting: 1 } }); return interactionReply(interaction, 'Counting disabled for this server.', true); }
    if (!canSend(interaction.channel)) return interactionReply(interaction, 'I cannot send messages in this channel.', true);
    await saveGuild(guildId, { $set: { counting: { enabled: true, channelId: interaction.channelId, currentNumber: 0, lastUserId: null } } });
    return interactionReply(interaction, 'Counting enabled! Start at 1. Consecutive turns are allowed.', true);
  }
  if (command === 'rule') {
    if (interaction.options.getSubcommand() === 'cancel') { await Guild.updateOne({ guildId }, { $unset: { autoRoleId: 1 } }); return interactionReply(interaction, 'Auto-role disabled. Existing roles were not removed.', true); }
    const role = await interaction.options.getRole('role');
    const me = await interaction.guild.members.fetchMe();
    if (!me.permissions.has(P.ManageRoles)) return interactionReply(interaction, 'I need Manage Roles permission.', true);
    if (!role || role.id === guildId) return interactionReply(interaction, 'Choose a role from this server other than @everyone.', true);
    if (role.managed) return interactionReply(interaction, 'Managed/integration roles cannot be assigned.', true);
    if (me.roles.highest.comparePositionTo(role) <= 0 || !role.editable) return interactionReply(interaction, 'Move my highest role above the role you want me to assign.', true);
    await saveGuild(guildId, { $set: { autoRoleId: role.id } });
    return interactionReply(interaction, `Auto-role enabled: <@&${role.id}>.`, true);
  }
  if (command === 'delink') {
    if (interaction.options.getSubcommand() === 'cancel') { await Guild.updateOne({ guildId }, { $unset: { antiLinkChannelId: 1 } }); return interactionReply(interaction, 'Anti-link disabled for this server.', true); }
    const channel = await interaction.options.getChannel('channel');
    if (!channel || channel.guildId !== guildId || !canSend(channel)) return interactionReply(interaction, 'Choose a text channel in this server where I can view and send messages.', true);
    if (!channel.permissionsFor(client.user)?.has(P.ManageMessages)) return interactionReply(interaction, 'I need Manage Messages permission in that channel.', true);
    await saveGuild(guildId, { $set: { antiLinkChannelId: channel.id } });
    return interactionReply(interaction, `Anti-link enabled in <#${channel.id}>. Owner/Admin messages are exempt.`, true);
  }
}
// Kept as a small test/helper adapter; production configuration is dispatched only through interactions.
async function configure(message, command, args) {
  const options = new Map();
  const value = args === 'cancel' ? true : args;
  if (command === 'set') { options.set('cancel', args === 'countdown cancel'); options.set('timezone', args.split(/\s+/).pop()); }
  if (command === 'number' || command === 'rule' || command === 'delink') options.set('cancel', args === 'cancel');
  const interaction = { ...message, user: message.author, commandName: command, channelId: message.channel.id,
    isChatInputCommand: () => true, replied: false, deferred: false,
    options: { getString: name => options.get(name) || null, getBoolean: name => options.get(name) || false,
      getSubcommand: () => command === 'set' ? (args === 'countdown cancel' ? 'cancel' : 'countdown') : (args === 'cancel' ? 'cancel' : command === 'number' ? 'enable' : 'set'),
      getRole: () => message.guild.roles?.fetch ? message.guild.roles.fetch((args.match(/\d+/) || [])[0]) : null,
      getChannel: () => message.guild.channels?.fetch ? message.guild.channels.fetch((args.match(/\d+/) || [])[0]) : null },
    reply: content => { message.sent?.push(content.content); return content; },
  };
  return configureSlash(interaction, command);
}

async function moderateLink(message, settings) {
  if (settings?.antiLinkChannelId !== message.channel.id || isAdmin(message) || !hasLink(message.content)) return false;
  if (!message.channel.permissionsFor(client.user)?.has([P.ViewChannel, P.ManageMessages]) || !message.deletable) return true;
  try { await message.delete(); } catch { logFailure('Deleting link'); return true; }
  if (onCooldown(warningCooldowns, `${message.guild.id}:${message.author.id}`,
    seconds('LINK_WARNING_COOLDOWN_SECONDS', 30))) return true;
  const warning = `Links aren't allowed in #${message.channel.name}.`;
  try { await message.author.send({ content: warning, allowedMentions: { parse: [] } }); }
  catch {
    const sent = await send(message.channel, {
      content: `<@${message.author.id}> ${warning}`,
      allowedMentions: { users: [message.author.id] },
    });
    if (sent) setTimeout(() => { void sent.delete().catch(() => {}); },
      seconds('LINK_WARNING_DELETE_SECONDS', 5)).unref();
  }
  return true;
}

async function countMessage(message, settings) {
  const counting = settings?.counting;
  if (!counting?.enabled || counting.channelId !== message.channel.id) return;
  const text = message.content.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return;
  const number = Number(text);
  const correct = /^\d+$/.test(text) && Number.isSafeInteger(number) && number === counting.currentNumber + 1;
  // Compare-and-set also prevents lost writes if state changes outside this process.
  const result = await Guild.updateOne({
    guildId: message.guild.id, 'counting.enabled': true,
    'counting.channelId': message.channel.id, 'counting.currentNumber': counting.currentNumber,
  }, { $set: {
    'counting.currentNumber': correct ? number : 0,
    'counting.lastUserId': correct ? message.author.id : null,
  } });
  if (result.matchedCount && !correct) await reply(message, 'Count reset. Start at 1.');
}

async function osuCommand(message, args) {
  const respond = (content) => message.isChatInputCommand?.() ? interactionReply(message, content) : reply(message, content);
  const actor = message.author || message.user;
  if (onCooldown(osuCooldowns, actor.id, seconds('OSU_COMMAND_COOLDOWN_SECONDS', 5))) {
    return respond('Please wait a few seconds before using osu! again.');
  }
  let targetUsername;
  let targetUserId;
  try {
    if (/^add(?:\s|$)/i.test(args)) {
      const match = /^add\s+(?:"([^"\r\n]+)"|([^"\r\n]+))$/i.exec(args);
      const username = (match?.[1] || match?.[2] || '').trim();
      if (!username || username.length > 32) return respond('Use /osu add with a username.');
      targetUsername = username;
      const user = await osuGet(`/users/${encodeURIComponent(username)}/osu?key=username`);
      await User.findOneAndUpdate({ discordUserId: actor.id }, { $set: {
        osuUsername: user.username, osuUserId: String(user.id),
      } }, { upsert: true, runValidators: true });
      return respond(`Connected your osu! account: ${user.username}.`);
    }
    if (args) {
      const match = /^(?:"([^"\r\n]+)"|([^"\r\n]+))$/.exec(args);
      targetUsername = (match?.[1] || match?.[2] || '').trim();
      if (!targetUsername || targetUsername.length > 32) return respond('Use /osu with a username.');
    } else {
      const saved = await User.findOne({ discordUserId: message.author.id }).lean();
      if (!saved) return respond("You haven't connected your osu! account yet.\n\nUse:\n/osu add username");
      targetUserId = saved.osuUserId;
    }
    const user = await osuGet(`/users/${encodeURIComponent(targetUserId || targetUsername)}/osu?key=${targetUserId ? 'id' : 'username'}`);
    const scores = await osuGet(`/users/${encodeURIComponent(user.id)}/scores/recent?mode=osu&include_fails=1&limit=1`);
    const score = scores[0];
    if (!score) return respond(`No recent osu! Standard plays found for ${user.username}.`);
    const map = score.beatmap;
    const set = score.beatmapset;
    const mods = (score.mods || []).map(mod => typeof mod === 'string' ? mod : mod.acronym).join(', ') || 'None';
    const played = new Date(score.ended_at || score.created_at);
    const title = `${set?.artist || 'Unknown artist'} - ${set?.title || 'Unknown map'} [${map?.version || 'Unknown difficulty'}]`;
    const url = map?.id ? `https://osu.ppy.sh/beatmaps/${map.id}` : `https://osu.ppy.sh/users/${user.id}`;
    const stars = Number.isFinite(Number(map?.difficulty_rating)) ? `${Number(map.difficulty_rating).toFixed(2)}★` : '★ unavailable';
    const modLabel = mods === 'None' ? 'NM' : mods.replace(/, /g, '');
    const scoreValue = Number(score.total_score ?? score.score ?? 0).toLocaleString('en-US');
    const accuracy = `${(score.accuracy * 100).toFixed(2)}%`;
    const misses = score.statistics?.miss ?? score.statistics?.count_miss ?? 0;
    const judgments = [score.statistics?.count_300 ?? score.statistics?.great ?? 0,
      score.statistics?.count_100 ?? score.statistics?.ok ?? 0,
      score.statistics?.count_50 ?? score.statistics?.meh ?? 0, misses].join('/');
    const length = Number.isFinite(Number(map?.total_length))
      ? `${Math.floor(map.total_length / 60)}:${String(map.total_length % 60).padStart(2, '0')}` : '?:??';
    const stat = (value, suffix = '') => Number.isFinite(Number(value)) ? `${value}${suffix}` : '?';
    const playedAt = Number.isNaN(played.getTime()) ? 'Unknown time' : `<t:${Math.floor(played.getTime() / 1000)}:f>`;
    return respond([
      `**${title} +${modLabel}**`, `**${stars}**`, '',
      `▸ **${score.rank || '—'}** • **${score.pp == null ? '—' : `${Number(score.pp).toFixed(2)}pp`}** • ${accuracy}`,
      `▸ ${scoreValue} • x${score.max_combo ?? 0}/${map?.max_combo ?? '?'} • [${judgments}]`,
      `▸ ${score.perfect || score.perfect_combo || misses === 0 ? 'FC' : `${misses} miss`}`,
      `▸ ${length} • ${stat(map?.ar, ' AR')} ${stat(map?.od, ' OD')} ${stat(map?.hp, ' HP')} ${stat(map?.cs, ' CS')}`,
      '', `Try #1 • osu! Bancho • ${playedAt}`, `[Beatmap](${url})`,
    ].join('\n'));
  } catch (error) {
    if (error.status === 404) return respond(`Could not find osu! user "${targetUsername || 'linked account'}".`);
    if (error.message === 'OSU_NOT_CONFIGURED') return respond('The bot owner needs to configure the osu! API credentials.');
    logFailure('osu! command');
    return respond('Could not load or save the osu! account right now. Please try again later.');
  }
}

const fortunes = [
  'not really.', 'Stay home. Just... stay home.', 'Maybe today is not your day (^///^)',
  'Good luck.', 'You are Fucked', 'Excellent Luck', 'Very Bad Luck', 'Bad Luck',
  'Better not tell you now', 'Chicken is watching you. Be careful.', 'Reply hazy, try again',
  'Average Luck', 'Outlook good', 'Godly Luck', 'Good news will come to you by mail',
  'pls stop. Im tired', 'play osu.', 'Can i not telling you??', '(≧∀≦)ゞ', 'Dont play osu.',
];
async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const command = interaction.commandName;
  try {
    if (mongoose.connection.readyState !== 1) return interactionReply(interaction, 'Database temporarily unavailable. Please try again shortly.', true);
    if (['set', 'rule', 'number', 'delink'].includes(command)) return configureSlash(interaction, command);
    if (command === 'osu') {
      const action = interaction.options.getSubcommand();
      if (action === 'add') return osuCommand(interaction, `add "${interaction.options.getString('username')}"`);
      return osuCommand(interaction, interaction.options.getString('username') || '');
    }
    if (command === 'help') return interactionReply(interaction, [
      'Slash commands:', '/help', '/osu recent', '/osu recent username:<username>', '/osu add username:<username>',
      '/set countdown timezone:<GMT+7>', '/set countdown cancel', '/rule set role:@role', '/rule cancel',
      '/number enable', '/number cancel', '/delink set channel:#chat', '/delink cancel', '/status', '/fortune',
      '', 'Configuration commands require the Server Owner, Administrator, or Bot Owner.',
      'Counting starts at 1; wrong numbers reset it. Anti-link exempts owner/Admin, bots, and webhooks.',
    ].join('\n'));
    if (command === 'fortune') return interactionReply(interaction, `**Your Fortune:**\n${fortunes[Math.floor(Math.random() * fortunes.length)]}`);
    if (command === 'status') {
      const minutes = Math.floor(process.uptime() / 60);
      return interactionReply(interaction, ['Bot Status', `Servers: ${client.guilds.cache.size}`,
        `Users (approx.): ${client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0).toLocaleString('en-US')}`,
        `Uptime: ${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h ${minutes % 60}m`,
        `RAM: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
        `Ping: ${client.ws.ping < 0 ? 'Measuring...' : `${client.ws.ping}ms`}`, `Node.js: ${process.version}`, `discord.js: ${version}`].join('\n'));
    }
  } catch { logFailure('Interaction handling'); if (!interaction.replied) await interactionReply(interaction, 'Something went wrong. Please try again shortly.', true); }
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  try {
    await inGuildOrder(message.guild.id, async () => {
      if (mongoose.connection.readyState !== 1) return;
      const settings = await Guild.findOne({ guildId: message.guild.id }).lean();
      if (await moderateLink(message, settings)) return true;
      await countMessage(message, settings);
    });
  } catch {
    logFailure('Message handling');
  }
}

async function checkCountdowns() {
  if (checkingCountdown || mongoose.connection.readyState !== 1 || !client.isReady()) return;
  checkingCountdown = true;
  try {
    const settings = await Guild.find({ 'countdown.enabled': true }).lean();
    for (const setting of settings) {
      await inGuildOrder(setting.guildId, async () => {
        const current = await Guild.findOne({ guildId: setting.guildId, 'countdown.enabled': true }).lean();
        if (!current) return;
        const { countdown } = current;
        const today = countdownDate(countdown.utcOffsetMinutes);
        if (countdown.lastSentDate === today.date) return;
        const guild = client.guilds.cache.get(setting.guildId);
        if (!guild) return;
        const channel = await guild.channels.fetch(countdown.channelId).catch(() => null);
        if (!canSend(channel)) return;
        // Claim before sending: a crash cannot cause a duplicate after restart.
        const claimed = await Guild.updateOne({
          guildId: setting.guildId, 'countdown.enabled': true,
          'countdown.channelId': countdown.channelId,
          'countdown.utcOffsetMinutes': countdown.utcOffsetMinutes,
          'countdown.lastSentDate': { $ne: today.date },
        }, { $set: { 'countdown.lastSentDate': today.date } });
        if (!claimed.modifiedCount) return;
        await send(channel, today.newYear ? ' Happy New Year!' : ` ${today.days} ${today.days === 1 ? 'Day' : 'Days'} Until New Year!`);
      }).catch(() => { logFailure('Guild countdown'); });
    }
    const now = Date.now();
    for (const map of [warningCooldowns, osuCooldowns]) {
      for (const [key, expiry] of map) if (expiry <= now) map.delete(key);
    }
  } catch { logFailure('Countdown scheduler'); }
  finally { checkingCountdown = false; }
}

client.on('interactionCreate', interaction => { void handleInteraction(interaction); });
client.on('messageCreate', message => { void handleMessage(message); });
client.on('guildMemberAdd', member => {
  void inGuildOrder(member.guild.id, async () => {
    const settings = await Guild.findOne({ guildId: member.guild.id }).lean();
    if (!settings?.autoRoleId) return;
    const role = await member.guild.roles.fetch(settings.autoRoleId);
    const me = await member.guild.members.fetchMe();
    if (!role || role.id === member.guild.id || role.managed || !role.editable
      || !me.permissions.has(P.ManageRoles) || me.roles.highest.comparePositionTo(role) <= 0) return;
    await member.roles.add(role, 'Configured automatic role');
  }).catch(() => { logFailure('Auto-role'); });
});
client.on('error', () => logFailure('Discord client'));
mongoose.connection.on('error', () => logFailure('MongoDB'));
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected; persistent features are temporarily unavailable.'));

async function start() {
  if (!process.env.DISCORD_TOKEN || !process.env.MONGODB_URI) throw new Error('Missing DISCORD_TOKEN or MONGODB_URI');
  const type = ActivityType[Object.keys(ActivityType).find(key => key.toUpperCase() === (process.env.BOT_ACTIVITY_TYPE || 'LISTENING').toUpperCase())];
  if (typeof type !== 'number') throw new Error('Invalid BOT_ACTIVITY_TYPE');
  const status = process.env.BOT_STATUS || 'online';
  if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) throw new Error('Invalid BOT_STATUS');
  const url = process.env.BOT_ACTIVITY_URL || undefined;
  if (url && !['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid BOT_ACTIVITY_URL');
  const interval = seconds('COUNTDOWN_CHECK_SECONDS', 60);
  seconds('LINK_WARNING_COOLDOWN_SECONDS', 30);
  seconds('LINK_WARNING_DELETE_SECONDS', 5);
  seconds('OSU_COMMAND_COOLDOWN_SECONDS', 5);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 15000 });
  await Promise.all([User.init(), Guild.init()]);
  console.log('MongoDB connected.');
  client.once('clientReady', () => {
    client.user.setPresence({ activities: [{ name: process.env.BOT_ACTIVITY_NAME || 'Hatsune bot', type, ...(url && { url }) }], status });
    scheduler = setInterval(() => { void checkCountdowns(); }, interval);
    void checkCountdowns();
    console.log(`Logged in as ${client.user.tag}\nServing ${client.guilds.cache.size} guilds.`);
  });
  await client.login(process.env.DISCORD_TOKEN);
}

async function shutdown() {
  clearInterval(scheduler);
  client.destroy();
  await Promise.allSettled([...queues.values()]);
  await mongoose.disconnect();
}
if (require.main === module) {
  start().catch(async () => {
    console.error('Startup failed. Check .env, Node version, database access, and Discord intents.');
    await shutdown();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void shutdown().catch(() => { process.exitCode = 1; });
  });
}

module.exports = { parseOffset, countdownDate, hasLink, inGuildOrder, countMessage, configure, configureSlash, isAdmin, canConfigureGuild, moderateLink, checkCountdowns, osuCommand, handleInteraction, client };
