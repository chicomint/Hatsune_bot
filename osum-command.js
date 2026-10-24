const { SlashCommandBuilder } = require('discord.js');

// Imported by the existing registration script; importing this never contacts Discord.
module.exports = new SlashCommandBuilder().setName('osum').setDescription('Find one osu! beatmap by name or at random')
  .addStringOption(o => o.setName('name').setDescription('Beatmap title, artist, or search keywords').setMaxLength(200))
  .addBooleanOption(o => o.setName('random').setDescription('Choose a random map, optionally within the name search'))
  .addNumberOption(o => o.setName('ar').setDescription('Exact no-mod Approach Rate').setMinValue(0).setMaxValue(10))
  .addNumberOption(o => o.setName('hp').setDescription('Exact no-mod HP Drain').setMinValue(0).setMaxValue(10))
  .addNumberOption(o => o.setName('cs').setDescription('Exact no-mod Circle Size (keys in mania)').setMinValue(0).setMaxValue(18))
  .addNumberOption(o => o.setName('acc').setDescription('Your target accuracy percentage, not a beatmap filter').setMinValue(0).setMaxValue(100))
  .addIntegerOption(o => o.setName('time_min').setDescription('Minimum total length in seconds').setMinValue(0).setMaxValue(86400))
  .addIntegerOption(o => o.setName('time_max').setDescription('Maximum total length in seconds').setMinValue(0).setMaxValue(86400))
  .addNumberOption(o => o.setName('stars_min').setDescription('Minimum no-mod star rating').setMinValue(0).setMaxValue(100))
  .addNumberOption(o => o.setName('stars_max').setDescription('Maximum no-mod star rating').setMinValue(0).setMaxValue(100))
  .addStringOption(o => o.setName('mode').setDescription('Game mode (defaults to osu!standard)').addChoices(
    { name: 'osu!standard', value: 'osu' }, { name: 'osu!taiko', value: 'taiko' },
    { name: 'osu!catch', value: 'fruits' }, { name: 'osu!mania', value: 'mania' },
  ));
