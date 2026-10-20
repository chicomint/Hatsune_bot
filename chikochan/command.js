'use strict';

const { SlashCommandBuilder, ChannelType, PermissionsBitField, MessageFlags,
  InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { canUseChannel } = require('./feed');

function buildCommand() {
  return new SlashCommandBuilder().setName('chikochan').setDescription('Configure the opt-in ChikoChan reply feed')
    .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable replies or change the destination (Manage Server required)')
      .addChannelOption(option => option.setName('channel').setDescription('Destination for new replies')
        .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable replies (Manage Server required)'));
}

async function handleChikoChan(interaction, feed) {
  const privateReply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [], repliedUser: false } });
  if (!interaction.guild) return privateReply('Use this command in a server.');
  const action = interaction.options.getSubcommand();
  const permissions = new PermissionsBitField(interaction.memberPermissions ?? interaction.member?.permissions ?? 0n);
  if (!permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return privateReply('You need Manage Server or Administrator permission to change the ChikoChan feed.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = content => interaction.editReply({ content, allowedMentions: { parse: [], repliedUser: false } });
  try {
    const guildId = interaction.guild.id;
    if (action === 'disable') {
      await feed.disable(guildId);
      return respond('ChikoChan reply feed disabled for this server.');
    }
    if (action !== 'enable') return respond('Unknown ChikoChan subcommand.');
    const selected = interaction.options.getChannel('channel', true);
    if (selected.guildId !== guildId || selected.type !== ChannelType.GuildText) {
      return respond('Choose a server text channel in this server.');
    }
    // Fetch current channel overwrites and membership rather than trusting cached permissions.
    const channel = await interaction.guild.channels.fetch(selected.id, { force: true });
    const me = await interaction.guild.members.fetchMe({ force: true });
    if (!canUseChannel(channel, me, guildId)) {
      return respond('I need View Channel, Send Messages, and Embed Links in the selected server text channel.');
    }
    await feed.enable(guildId, channel.id);
    await respond(`ChikoChan reply feed enabled in <#${channel.id}>. All public boards are discovered automatically. The newest existing reply is queued on first setup; future replies follow automatically.`);
    // Configuration has committed. Queue work after the private confirmation.
    void feed.deliver(guildId).catch(() => { feed.logFailure('ChikoChan initial delivery'); });
  } catch (error) {
    feed.logFailure('ChikoChan command');
    return respond(error.message === 'CHIKOCHAN_BASELINE_FAILED'
      ? 'Could not check every ChikoChan board. Your feed settings were not changed. Please try again shortly.'
      : 'Could not update or read the ChikoChan feed. Check the bot permissions and try again shortly.');
  }
}

module.exports = { buildCommand, handleChikoChan };
