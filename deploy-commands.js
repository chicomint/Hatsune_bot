require('dotenv').config({ quiet: true });
const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');

if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
}

const commands = [
  new SlashCommandBuilder().setName('help').setDescription("Show Kai's commands"),
  new SlashCommandBuilder().setName('osu').setDescription('View recent osu!standard plays')
    .addSubcommand(sub => sub.setName('recent').setDescription('View a recent play').addStringOption(option => option.setName('username').setDescription('Optional osu! username')))
    .addSubcommand(sub => sub.setName('add').setDescription('Link your osu! account').addStringOption(option => option.setName('username').setDescription('osu! username').setRequired(true))),
  new SlashCommandBuilder().setName('set').setDescription('Configure server settings')
    .addSubcommand(sub => sub.setName('countdown').setDescription('Configure the New Year countdown.')
      .addStringOption(option => option.setName('timezone').setDescription('For example GMT+7 or UTC-5').setRequired(false))
      .addBooleanOption(option => option.setName('cancel').setDescription('Disable the countdown').setRequired(false))),
  new SlashCommandBuilder().setName('rule').setDescription('Configure the automatic member role')
    .addSubcommand(sub => sub.setName('set').setDescription('Set the automatic role').addRoleOption(option => option.setName('role').setDescription('Role to assign').setRequired(true)))
    .addSubcommand(sub => sub.setName('cancel').setDescription('Disable auto-role')),
  new SlashCommandBuilder().setName('number').setDescription('Configure the counting channel')
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable counting'))
    .addSubcommand(sub => sub.setName('cancel').setDescription('Disable counting')),
  new SlashCommandBuilder().setName('delink').setDescription('Configure anti-link protection')
    .addSubcommand(sub => sub.setName('set').setDescription('Enable anti-link').addChannelOption(option => option.setName('channel').setDescription('Channel where links are blocked').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sub => sub.setName('cancel').setDescription('Disable anti-link')),
  new SlashCommandBuilder().setName('status').setDescription("Show Kai's status"),
  new SlashCommandBuilder().setName('fortune').setDescription('Check your fortune'),
].map(command => command.setDMPermission(false).toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands })
  .then(() => console.log(`Registered ${commands.length} global slash commands.`))
  .catch(error => { console.error('Command registration failed.'); process.exitCode = 1; });
