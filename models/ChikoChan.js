'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const options = { versionKey: false };

const sourceSchema = new Schema({
  _id: String,
  boards: [String],
  sequence: { type: Number, default: 0 },
  lastSuccessfulCheck: Date,
  retryAt: Date,
}, options);

const threadSchema = new Schema({
  source: { type: String, required: true },
  board: { type: String, required: true },
  no: { type: String, required: true },
  replies: Number,
  modified: String,
  checkedAt: Date,
}, options);
threadSchema.index({ source: 1, board: 1, no: 1 }, { unique: true });

const replySchema = new Schema({
  source: { type: String, required: true },
  board: { type: String, required: true },
  no: { type: String, required: true },
  sequence: { type: Number, required: true },
  time: { type: Number, required: true },
  post: { type: Schema.Types.Mixed, required: true },
}, options);
replySchema.index({ source: 1, board: 1, no: 1 }, { unique: true });
replySchema.index({ source: 1, sequence: 1 }, { unique: true });
replySchema.index({ source: 1, time: -1, no: -1 });

const deliverySchema = new Schema({
  guildId: { type: String, required: true },
  source: { type: String, required: true },
  replyId: { type: Schema.Types.ObjectId, required: true },
  generation: { type: String, required: true },
  time: Number,
  sequence: Number,
  sent: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  retryAt: Date,
  messageId: String,
  sentAt: Date,
}, options);
deliverySchema.index({ guildId: 1, source: 1, replyId: 1 }, { unique: true });
deliverySchema.index({ guildId: 1, source: 1, generation: 1, sent: 1, time: 1, sequence: 1 });

module.exports = {
  Source: mongoose.model('ChikoChanSource', sourceSchema),
  Thread: mongoose.model('ChikoChanThread', threadSchema),
  Reply: mongoose.model('ChikoChanReply', replySchema),
  Delivery: mongoose.model('ChikoChanDelivery', deliverySchema),
};
