const Game = require('./models/LastLetterGame');
const Player = require('./models/LastLetterPlayer');

class LastLetterStore {
  async read(id) { return Game.findById(id).lean(); }

  async insert(game) {
    try { return (await Game.create(game)).toObject({ flattenMaps: true }); }
    catch (error) { if (error.code === 11000) return null; throw error; }
  }

  async commit(game, changes, best) {
    const update = { $set: changes, $inc: { revision: 1 } };
    if (best) update.$max = { [`pendingBests.${best.userId}`]: best.value };
    return Game.findOneAndUpdate({ _id: game._id, revision: game.revision }, update,
      { returnDocument: 'after', runValidators: true }).lean();
  }

  async best(userId) {
    return (await Player.findOne({ discordUserId: userId }).lean())?.bestStreak || 0;
  }

  async flush(game) {
    for (const [userId, bestStreak] of Object.entries(game.pendingBests || {})) {
      // $max cannot lower a lifetime record, including concurrent games/instances.
      await Player.updateOne({ discordUserId: userId }, { $max: { bestStreak } },
        { upsert: true, runValidators: true, setDefaultsOnInsert: false });
      // A newer pending record must survive this acknowledgement.
      await Game.updateOne({ _id: game._id, [`pendingBests.${userId}`]: bestStreak },
        { $unset: { [`pendingBests.${userId}`]: 1 } });
    }
  }

  async recover() {
    const cursor = Game.find({ pendingBests: { $exists: true, $ne: {} } }).lean().cursor();
    for await (const game of cursor) await this.flush(game);
  }
}

module.exports = { LastLetterStore };
