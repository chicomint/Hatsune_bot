const mongoose = require('mongoose');

const player = new mongoose.Schema({
  userId: { type: String, required: true },
  currentStreak: { type: Number, min: 0, default: 0 },
  highestStreak: { type: Number, min: 0, default: 0 },
  validWords: { type: Number, min: 0, default: 0 },
}, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, required: true }, // guildId:channelId; MongoDB enforces uniqueness.
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  revision: { type: Number, min: 0, default: 0 },
  active: { type: Boolean, default: false },
  starterId: { type: String, required: true },
  requiredLetter: { type: String, match: /^[a-z]$/, required: true },
  lastPlayerId: { type: String, default: null },
  usedWords: { type: [String], default: [] },
  players: { type: [player], default: [] },
  startedAt: { type: Date, required: true },
  stoppedAt: { type: Date, default: null },
  // Durable, idempotent best-streak updates; never cleared when a new game starts.
  pendingBests: { type: Map, of: Number, default: () => ({}) },
}, { versionKey: false });
schema.index({ guildId: 1, active: 1 });

module.exports = mongoose.model('LastLetterGame', schema);
