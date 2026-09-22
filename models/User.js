const mongoose = require('mongoose');

module.exports = mongoose.model('User', new mongoose.Schema({
  discordUserId: { type: String, required: true, unique: true },
  osuUsername: { type: String, required: true },
  osuUserId: { type: String, required: true },
}, { versionKey: false }));
