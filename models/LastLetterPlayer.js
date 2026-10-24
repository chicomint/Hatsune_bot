const mongoose = require('mongoose');

module.exports = mongoose.model('LastLetterPlayer', new mongoose.Schema({
  discordUserId: { type: String, required: true, unique: true },
  bestStreak: { type: Number, min: 0, default: 0 },
}, { versionKey: false }));
