const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { osuGet } = require('./osu');

const MODES = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
const POSITIONAL = ['ar', 'hp', 'cs', 'acc'];
const NUMBERS = [...POSITIONAL, 'time_min', 'time_max', 'stars_min', 'stars_max'];
const USAGE = [
  'Find a beatmap: `.osum freedom dive ar=9 cs=4` or `/osum name:freedom dive ar:9 cs:4`.',
  'Random: `.osum -r` or `/osum random:true` (filters are optional).',
  'Positional order: `.osum "freedom dive" 9 - 4 -` = AR, HP, CS, target accuracy; `-` skips a value.',
  'Ranges: `time=120-180` (seconds), `stars=4-6`. Optional `mode=osu|taiko|fruits|mania`.',
].join('\n');

class FinderInputError extends Error {}

function number(value, key, max, integer = false) {
  if (value == null) return undefined;
  if (!['number', 'string'].includes(typeof value)
    || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
    throw new FinderInputError(`${key} must be a number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new FinderInputError(`${key} must be ${integer ? 'a whole number' : 'a number'} from 0 to ${max}.`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  const name = input.name == null ? '' : String(input.name).trim();
  if (name.length > 200) throw new FinderInputError('Keep the beatmap name under 201 characters.');
  const mode = String(input.mode ?? 'osu').toLowerCase().replace(/^catch$/, 'fruits');
  if (!Object.hasOwn(MODES, mode)) throw new FinderInputError('mode must be osu, taiko, fruits (catch), or mania.');
  if (input.random != null && typeof input.random !== 'boolean') throw new FinderInputError('random must be true or false.');
  const options = { name, random: input.random ?? false, mode };
  for (const key of NUMBERS) {
    const max = key.startsWith('time_') ? 86400 : key.startsWith('stars_') || key === 'acc' ? 100
      : key === 'cs' && mode === 'mania' ? 18 : 10;
    const value = number(input[key], key, max, key.startsWith('time_'));
    if (value !== undefined) options[key] = value;
  }
  for (const key of ['time', 'stars']) {
    if (options[`${key}_min`] != null && options[`${key}_max`] != null
      && options[`${key}_min`] > options[`${key}_max`]) {
      throw new FinderInputError(`${key}_min cannot exceed ${key}_max.`);
    }
  }
  return options;
}

// Quotes are only special at the beginning of a token, so apostrophes in titles work.
function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, index + 1);
      if (end === -1 || (end + 1 < text.length && !/\s/.test(text[end + 1]))) {
        throw new FinderInputError('Close quoted beatmap names and separate arguments with spaces.');
      }
      tokens.push({ value: text.slice(index + 1, end), quoted: true });
      index = end + 1;
    } else {
      const value = /^\S+/.exec(text.slice(index))[0];
      tokens.push({ value, quoted: false });
      index += value.length;
    }
  }
  return tokens;
}

function parsePrefix(text) {
  const input = {};
  const title = [];
  const positional = [];
  const tokens = tokenize(text);
  const positionalMode = tokens.some(token => !token.quoted && token.value === '-r')
    || tokens.some(token => token.quoted);
  function assign(key, value) {
    if (Object.hasOwn(input, key)) throw new FinderInputError(`Specify ${key} only once.`);
    input[key] = value;
  }
  for (const token of tokens) {
    const { value, quoted } = token;
    if (!quoted && value === '-r') { assign('random', true); continue; }
    if (!quoted && value.includes('=')) {
      const [key, ...parts] = value.split('=');
      const val = parts.join('=');
      if (NUMBERS.includes(key) || key === 'mode') assign(key, val);
      else if (key === 'time' || key === 'stars') {
        const match = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(val);
        if (!match) throw new FinderInputError(`Use ${key}=min-max or ${key}=value.`);
        assign(`${key}_min`, match[1]); assign(`${key}_max`, match[2] ?? match[1]);
      } else throw new FinderInputError(`Unknown filter. Use ar, hp, cs, acc, time, stars, or mode.\n${USAGE}`);
    } else if (!quoted && positionalMode && (value === '-' || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
      positional.push(value);
    } else {
      if (positional.length) throw new FinderInputError('Put the beatmap name before positional values and quote names that contain spaces.');
      title.push(value);
    }
  }
  if (positional.length > 4) throw new FinderInputError('Use at most four positional values: AR HP CS ACC.');
  positional.forEach((value, index) => { if (value !== '-') assign(POSITIONAL[index], value); });
  return normalizeOptions({ ...input, name: title.join(' ') });
}

function fromSlash(options) {
  const input = { name: options.getString('name'), random: options.getBoolean('random'), mode: options.getString('mode') };
  for (const key of NUMBERS) input[key] = key.startsWith('time_') ? options.getInteger(key) : options.getNumber(key);
  return normalizeOptions(input);
}

function buildQuery(options) {
  const terms = options.name ? [options.name] : [];
  for (const key of ['ar', 'hp', 'cs']) if (options[key] != null) terms.push(`${key}=${options[key]}`);
  for (const [key, field] of [['time', 'length'], ['stars', 'stars']]) {
    if (options[`${key}_min`] != null) terms.push(`${field}>=${options[`${key}_min`]}`);
    if (options[`${key}_max`] != null) terms.push(`${field}<=${options[`${key}_max`]}`);
  }
  // acc is a player's target, never an osu! search field (API "accuracy" means OD).
  return terms.join(' ');
}

function matches(map, options) {
  const mode = map.mode_int ?? MODES[map.mode];
  if (!Number.isSafeInteger(map.id) || map.id <= 0 || map.convert || mode !== MODES[options.mode]) return false;
  for (const key of ['ar', 'hp', 'cs']) {
    const value = map[key === 'hp' ? 'drain' : key];
    if (options[key] != null && value !== options[key]) return false;
  }
  for (const [key, field] of [['time', 'total_length'], ['stars', 'difficulty_rating']]) {
    if ((options[`${key}_min`] != null || options[`${key}_max`] != null) && !Number.isFinite(map[field])) return false;
    if (options[`${key}_min`] != null && map[field] < options[`${key}_min`]) return false;
    if (options[`${key}_max`] != null && map[field] > options[`${key}_max`]) return false;
  }
  return true;
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// osu! search uses 50-set pages and an Elasticsearch offset window of 10,000.
// Broad random searches first pick a creation year, then split that interval as
// needed, allowing old/new maps beyond the global offset window to be selected.
// This is bounded sampling, not a uniform draw from the entire osu! catalogue.
async function findBeatmap(input, { get = osuGet, random = Math.random, now = new Date() } = {}) {
  const options = normalizeOptions(input);
  if (!options.name && !options.random) throw new FinderInputError(USAGE);
  const base = { q: buildQuery(options), m: String(MODES[options.mode]), s: 'any',
    sort: options.random ? 'updated_desc' : 'relevance_desc' };
  let requests = 0;
  const budget = 10;
  const seenMaps = new Set();
  async function search(params) {
    requests++;
    const data = await get(`/beatmapsets/search?${new URLSearchParams(params)}`);
    if (!data || data.error || !Array.isArray(data.beatmapsets) || !Number.isSafeInteger(data.total) || data.total < 0) {
      throw new Error('OSU_SEARCH_FAILED');
    }
    return data;
  }
  async function choose(data) {
    let candidates = data.beatmapsets.flatMap(set => (set.beatmaps || [])
      .filter(map => matches(map, options) && !seenMaps.has(map.id)).map(map => ({ map, set })));
    if (options.random) candidates = shuffle(candidates, random);
    for (const candidate of candidates) {
      if (requests >= budget) break;
      seenMaps.add(candidate.map.id);
      requests++;
      try {
        // Revalidate the selected difficulty, since search indexing can lag edits/deletions.
        const map = await get(`/beatmaps/${candidate.map.id}`);
        if (matches(map, options)) return { map, set: { ...candidate.set, ...map.beatmapset }, options };
      } catch (error) { if (error.status !== 404) throw error; }
    }
    return null;
  }

  let params = { ...base };
  let data = await search(params);
  if (!data.total) return { found: false, exhaustive: true };
  if (options.random && data.total >= 10000) {
    const years = shuffle(Array.from({ length: now.getUTCFullYear() - 2007 + 1 }, (_, i) => 2007 + i), random);
    let start; let end;
    while (requests < budget - 2 && (data.total >= 10000 || !data.total)) {
      if (data.total >= 10000 && start != null && end - start > 86400000) {
        const middle = Math.floor((start + end) / 2 / 86400000) * 86400000;
        if (random() < 0.5) end = middle; else start = middle;
      } else {
        const year = years.pop();
        if (year == null) break;
        start = Date.UTC(year, 0, 1); end = Date.UTC(year + 1, 0, 1);
      }
      const date = value => new Date(value).toISOString().slice(0, 10);
      params = { ...base, q: `${base.q} created>=${date(start)} created<${date(end)}`.trim() };
      data = await search(params);
    }
    if (!data.total || data.total >= 10000) return { found: false, exhaustive: false };
  }

  if (options.random) {
    const pageCount = Math.ceil(Math.min(data.total, 10000) / 50);
    const pages = shuffle(Array.from({ length: pageCount }, (_, i) => i + 1), random);
    while (pages.length && requests < budget - 1) {
      const page = pages.pop();
      const pageData = page === 1 ? data : await search({ ...params, page: String(page) });
      const selected = await choose(pageData);
      if (selected) return selected;
    }
    return { found: false, exhaustive: pages.length === 0 && requests < budget && params.q === base.q };
  }

  const cursors = new Set();
  while (requests < budget) {
    const selected = await choose(data);
    if (selected) return selected;
    if (!data.cursor_string) return { found: false, exhaustive: requests < budget };
    if (requests >= budget - 1 || cursors.has(data.cursor_string)) break;
    cursors.add(data.cursor_string);
    data = await search({ ...params, cursor_string: data.cursor_string });
  }
  return { found: false, exhaustive: false };
}

function beatmapEmbed({ map, set, options }) {
  const text = (value, fallback) => escapeMarkdown(String(value || fallback)).slice(0, 1024);
  const stat = value => Number.isFinite(value) ? String(value) : '?';
  const length = Number.isFinite(map.total_length)
    ? `${Math.floor(map.total_length / 60)}:${String(map.total_length % 60).padStart(2, '0')}` : '?';
  const mapper = map.user_id && map.user_id !== set.user_id
    ? `[Difficulty mapper](https://osu.ppy.sh/users/${map.user_id}) • Host: ${text(set.creator, 'Unknown')}`
    : text(set.creator, 'Unknown');
  const embed = new EmbedBuilder().setColor(0xff66aa)
    .setTitle(`${set.artist || 'Unknown artist'} — ${set.title || 'Unknown title'}`.slice(0, 256))
    .setURL(`https://osu.ppy.sh/beatmaps/${map.id}`)
    .setDescription(`**${text(map.version, 'Unknown difficulty')}**`)
    .addFields(
      { name: 'Mapper', value: mapper },
      { name: 'Stars', value: Number.isFinite(map.difficulty_rating) ? `${map.difficulty_rating.toFixed(2)} ★` : '?', inline: true },
      { name: 'BPM', value: stat(map.bpm), inline: true },
      { name: 'Length', value: length, inline: true },
      { name: 'Difficulty stats (NM)', value: `AR ${stat(map.ar)} / HP ${stat(map.drain)} / CS ${stat(map.cs)} / OD ${stat(map.accuracy)}` },
      { name: 'Status', value: text(map.status || set.status, 'Unknown'), inline: true },
      { name: 'Mode', value: { osu: 'osu!standard', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' }[options.mode], inline: true },
    );
  if (options.acc != null) {
    embed.addFields({ name: 'Target accuracy', value: `${options.acc}%` });
    embed.setFooter({ text: 'Target accuracy is a player goal. PP unavailable: no performance calculator configured.' });
  }
  const cover = set.covers?.['cover@2x'] || set.covers?.cover;
  if (typeof cover === 'string' && /^https:\/\//.test(cover)) embed.setImage(cover);
  return embed;
}

module.exports = { FinderInputError, USAGE, normalizeOptions, parsePrefix, fromSlash, buildQuery, matches, findBeatmap, beatmapEmbed };
