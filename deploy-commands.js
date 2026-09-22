require('dotenv').config({ quiet: true });
const { REST, Routes, SlashCommandBuilder, ChannelType, PermissionsBitField } = require('discord.js');

if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
}

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show bot commands.'),
  new SlashCommandBuilder().setName('osu').setDescription('View an osu!standard recent play.')
    .addStringOption(option => option.setName('username').setDescription('Another osu! username').setRequired(false)),
  new SlashCommandBuilder().setName('osu-add').setDescription('Link your osu! account.')
    .addStringOption(option => option.setName('username').setDescription('osu! username').setRequired(true)),
  new SlashCommandBuilder().setName('set').setDescription('Configure server settings.')
    .addSubcommand(sub => sub.setName('countdown').setDescription('Configure the New Year countdown.')
      .addStringOption(option => option.setName('timezone').setDescription('For example GMT+7 or UTC-5').setRequired(false))
      .addBooleanOption(option => option.setName('cancel').setDescription('Disable the countdown').setRequired(false))),
  new SlashCommandBuilder().setName('rule').setDescription('Configure the automatic member role.')
    .addRoleOption(option => option.setName('role').setDescription('Role to assign').setRequired(false))
    .addBooleanOption(option => option.setName('cancel').setDescription('Disable auto-role').setRequired(false)),
  new SlashCommandBuilder().setName('number').setDescription('Configure counting in this channel.')
    .addBooleanOption(option => option.setName('cancel').setDescription('Disable counting').setRequired(false)),
  new SlashCommandBuilder().setName('delink').setDescription('Configure anti-link moderation.')
    .addChannelOption(option => option.setName('channel').setDescription('Channel where links are blocked').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addBooleanOption(option => option.setName('cancel').setDescription('Disable anti-link').setRequired(false)),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
  new SlashCommandBuilder().setName('fortune').setDescription('Get a random fortune.'),
].map(command => command.setDMPermission(false).toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands })
  .then(() => console.log(`Registered ${commands.length} global slash commands.`))
  .catch(error => { console.error('Command registration failed.'); process.exitCode = 1; });
