const { SlashCommandBuilder, ChannelType } = require('discord.js');

const channelOption = option => option.setName('channel').setDescription('Game channel (defaults to this channel)')
  .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread,
    ChannelType.PrivateThread, ChannelType.AnnouncementThread);

module.exports = new SlashCommandBuilder().setName('lastletter').setDescription('Play Last Letter in this channel')
  .addSubcommand(sub => sub.setName('start').setDescription('Start a word-chain game (admins and owners only)').addChannelOption(channelOption))
  .addSubcommand(sub => sub.setName('stop').setDescription('Stop a game and show results (admins and owners only)').addChannelOption(channelOption));
