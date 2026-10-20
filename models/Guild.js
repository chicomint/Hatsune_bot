const mongoose = require('mongoose');

module.exports = mongoose.model('Guild', new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  autoRoleId: String,
  countdown: {
    enabled: { type: Boolean, default: false },
    channelId: String,
    utcOffsetMinutes: Number,
    lastSentDate: String,
  },
  counting: {
    enabled: { type: Boolean, default: false },
    channelId: String,
    currentNumber: { type: Number, default: 0 },
    lastUserId: { type: String, default: null },
  },
  antiLinkChannelId: String,
  chikochan: {
    enabled: { type: Boolean, default: false },
    channelId: String,
    source: String,
    generation: String,
    cursor: { type: Number, default: 0 },
    seedReplyId: mongoose.Schema.Types.ObjectId,
  },
}, { versionKey: false }));
