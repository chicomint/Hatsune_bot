'use strict';

const { parseDocument } = require('htmlparser2');

const blocks = new Set(['p', 'div', 'blockquote', 'pre', 'li', 'tr', 'section', 'h1', 'h2', 'h3']);
const hidden = new Set(['script', 'style', 'template']);
const flag = value => value === true || value === 1 || value === '1';
const pathPart = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, char => {
  return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
});

function plainText(html) {
  function render(node) {
    if (node.type === 'text') return node.data;
    if (hidden.has(node.name)) return '';
    if (node.name === 'br') return '\n';
    const text = (node.children || []).map(render).join('');
    return blocks.has(node.name) ? `\n${text}\n` : text;
  }
  return render(parseDocument(String(html ?? ''), { decodeEntities: true }))
    .replace(/\u00a0/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeDiscord(text) {
  // Escape Markdown, quote/list prefixes, links, and Discord-specific mention syntax.
  return String(text).replace(/([\\`*_~|\[\]()<>#+.!-])/g, '\\$1').replace(/@/g, '@\u200b');
}

function htmlToDiscord(html) {
  return escapeDiscord(plainText(html));
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '').replace(/\\$/, '') + '…';
}

function attachments(base, post) {
  const extra = Array.isArray(post.extra_files) ? post.extra_files
    : post.extra_files && typeof post.extra_files === 'object' ? Object.values(post.extra_files) : [];
  const files = [post, ...extra];
  return files.filter(file => file && (file.tim != null || flag(file.filedeleted) || flag(file.deleted)))
    .map(file => {
      const deleted = flag(file.filedeleted) || flag(file.deleted) || flag(file.file_deleted);
      const ext = String(file.ext || '').toLowerCase();
      const tim = file.tim == null ? '' : String(file.tim);
      const url = !deleted && tim && /^\.[a-z0-9]{1,10}$/.test(ext)
        ? `${base}/src/${pathPart(tim)}${ext}` : null;
      return {
        url, ext,
        spoiler: flag(file.spoiler) || flag(post.spoiler),
        image: Boolean(url && /^\.(?:jpe?g|png|gif|webp|avif|bmp)$/.test(ext)
          && (!file.media_type || file.media_type === 'image')),
      };
    });
}

function replyLink(base, board, post) {
  return `${base}/${encodeURIComponent(board)}/thread/${post.resto}#p${post.no}`;
}

function formatReply(base, reply, unavailable = new Set()) {
  const { board, post } = reply;
  const url = replyLink(base, board, post);
  const text = htmlToDiscord(post.com) || '(No comment text)';
  const truncated = text.length > 3500;
  const link = `\n\n[${truncated ? 'Read complete reply' : 'Open reply'}](${url})`;
  const description = `${clip(text, Math.min(3500, 4096 - link.length))}${link}`;
  // Embed author names are plain text; Markdown escapes there would display as backslashes.
  const poster = plainText(post.name || 'Anonymous').replace(/\n/g, ' ').replace(/@/g, '@\u200b');
  const trip = post.trip ? ` ${plainText(post.trip).replace(/\n/g, ' ').replace(/@/g, '@\u200b')}` : '';
  const timestamp = new Date(Number(post.time) * 1000);
  const files = attachments(base, post);
  const images = files.filter(file => file.image && !file.spoiler && !unavailable.has(file.url));
  const embed = {
    title: clip(`/${board}/ · Reply #${post.no}`, 256),
    url,
    author: { name: clip(poster + trip, 256) },
    description,
    color: 0x55b5be,
    footer: { text: clip(`Post #${post.no} · Parent thread #${post.resto}`, 200) },
  };
  if (!Number.isNaN(timestamp.getTime())) embed.timestamp = timestamp.toISOString();
  if (images.length) embed.image = { url: images[0].url };
  if (files.length) {
    const lines = files.map((file, index) => {
      if (file.spoiler) return `[Spoiler attachment ${index + 1} — open reply](${url})`;
      if (!file.url || unavailable.has(file.url)) return `Attachment ${index + 1}: unavailable or deleted`;
      return `[${file.image ? 'Picture' : 'Attachment'} ${index + 1} (${file.ext})](${file.url})`;
    });
    let value = '';
    for (const line of lines) {
      if (value.length + line.length + 1 > 900) {
        value += `\n[See all attachments](${url})`;
        break;
      }
      value += `${value ? '\n' : ''}${line}`;
    }
    embed.fields = [{ name: 'Attachments', value: value || `[View attachments](${url})` }];
  }
  return {
    embeds: [embed, ...images.slice(1, 10).map(file => ({ image: { url: file.url } }))],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

module.exports = { plainText, htmlToDiscord, attachments, replyLink, formatReply, clip };
