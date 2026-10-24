const USAGE = {
  help: '.help', status: '.status', fortune: '.fortune',
  osu: '.osu [username] | .osu recent [username] | .osu add <username> | .r [username]',
  r: '.r [username] — alias for /osu recent',
  set: '.set countdown <GMT+7|UTC-5|UTC+5:30> | .set countdown cancel',
  rule: '.rule set @role (or role ID) | .rule cancel',
  number: '.number enable | .number cancel',
  delink: '.delink set #channel (mention or channel ID) | .delink cancel',
};

class PrefixInputError extends Error {}

function username(text, required, command) {
  let value = text.trim();
  if (!value && !required) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value || value.length > 32 || /["\r\n]/.test(value)) throw new PrefixInputError(`Use ${USAGE[command]}`);
  return value;
}

// Parse only command syntax here; permissions and feature behavior stay in index.js.
function parsePrefixCommand(content) {
  const match = /^\.([a-z]+)(?:\s+([\s\S]*))?$/i.exec(content.trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  if (command === 'osum') return { command, args };
  if (!Object.hasOwn(USAGE, command)) return null;
  const invalid = () => { throw new PrefixInputError(`Use ${USAGE[command]}`); };
  if (['help', 'status', 'fortune'].includes(command)) {
    if (args) invalid();
    return { command, values: {} };
  }
  if (command === 'r') return { command: 'osu', subcommand: 'recent', values: { username: username(args, false, command) } };
  if (command === 'osu') {
    const action = /^(add|recent)(?:\s+([\s\S]*))?$/i.exec(args);
    const subcommand = action ? action[1].toLowerCase() : 'recent';
    return { command, subcommand, values: { username: username(action ? action[2] || '' : args, subcommand === 'add', command) } };
  }
  if (command === 'set') {
    const countdown = /^countdown\s+(\S+)$/i.exec(args);
    if (!countdown) invalid();
    const cancel = countdown[1].toLowerCase() === 'cancel';
    return { command, subcommand: 'countdown', values: { timezone: cancel ? null : countdown[1], cancel } };
  }
  if (command === 'number') {
    if (!/^(enable|cancel)$/i.test(args)) invalid();
    return { command, subcommand: args.toLowerCase(), values: {} };
  }
  if (args.toLowerCase() === 'cancel') return { command, subcommand: 'cancel', values: {} };
  const target = command === 'rule' ? /^set\s+(?:<@&(\d+)>|(\d+))$/i.exec(args)
    : /^set\s+(?:<#(\d+)>|(\d+))$/i.exec(args);
  if (!target) invalid();
  return { command, subcommand: 'set', values: { [command === 'rule' ? 'role' : 'channel']: target[1] || target[2] } };
}

module.exports = { PrefixInputError, parsePrefixCommand };
