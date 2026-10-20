'use strict';

function baseUrl(value = 'https://boards.chiko.cc') {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 512) {
    throw new Error('Invalid CHIKOCHAN_BASE_URL');
  }
  return url.href.replace(/\/+$/, '');
}

function postId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) ? text : null;
}

function retryDelay(error, attempts = 0) {
  const seconds = Number(error?.retry_after ?? error?.data?.retry_after ?? error?.rawError?.retry_after);
  const milliseconds = Number(error?.retryAfter ?? error?.timeToReset);
  return Math.max(5000 * 2 ** Math.min(attempts, 6),
    Number.isFinite(seconds) ? seconds * 1000 : 0,
    Number.isFinite(milliseconds) ? milliseconds : 0);
}

class ChikoChanApi {
  constructor(url, { fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    this.baseUrl = baseUrl(url);
    this.fetch = fetchImpl;
    this.now = now;
    this.retryAt = 0;
  }

  async get(path) {
    if (this.retryAt > this.now()) throw new Error('CHIKOCHAN_RATE_LIMITED');
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429 || response.status === 503) {
      const header = response.headers.get('retry-after');
      const delay = header && Number.isFinite(Number(header)) ? Number(header) * 1000
        : header ? Date.parse(header) - this.now() : 30000;
      this.retryAt = this.now() + Math.max(1000, Number.isFinite(delay) ? delay : 30000);
    }
    if (!response.ok) {
      const error = new Error('CHIKOCHAN_API_FAILED');
      error.status = response.status;
      throw error;
    }
    // Node 22's reviver context preserves numeric identifiers before IEEE-754 rounding.
    return JSON.parse(await response.text(), (key, value, context) => {
      return ['tim', 'no', 'resto'].includes(key) && typeof value === 'number'
        ? context.source : value;
    });
  }

  async boards() {
    const data = await this.get('/boards.json');
    if (!Array.isArray(data?.boards)) throw new Error('CHIKOCHAN_INVALID_BOARDS');
    const names = data.boards.map(board => board?.board);
    if (names.some(name => typeof name !== 'string' || !/^[a-z0-9_-]+$/i.test(name))) {
      throw new Error('CHIKOCHAN_INVALID_BOARD');
    }
    return [...new Set(names)];
  }

  async threads(board) {
    const path = `/${encodeURIComponent(board)}/threads.json`;
    const found = new Map();
    let page;
    for (;;) {
      let data;
      try { data = await this.get(`${path}${page === undefined ? '' : `?page=${page}`}`); }
      catch (error) {
        if (page === undefined && [400, 404].includes(error.status)) { page = 1; continue; }
        if (page !== undefined && found.size && [404, 410].includes(error.status)) break;
        throw error;
      }
      const pages = Array.isArray(data) ? data : [data];
      if (pages.some(item => !Array.isArray(item?.threads))) throw new Error('CHIKOCHAN_INVALID_THREADS');
      const threads = pages.flatMap(item => item.threads);
      let added = 0;
      for (const thread of threads) {
        const no = postId(thread.no);
        if (!no) throw new Error('CHIKOCHAN_INVALID_THREAD_ID');
        if (!found.has(no)) added++;
        found.set(no, { ...thread, no });
      }
      // Some hosts ignore ?page or repeat their last page, possibly in a different order.
      if (!threads.length || !added) break;
      page = page === undefined
        ? Math.max(...pages.map(item => Number.isInteger(item.page) ? item.page : 1)) + 1
        : page + 1;
    }
    return [...found.values()];
  }

  async posts(board, thread) {
    const data = await this.get(`/${encodeURIComponent(board)}/thread/${thread}.json`);
    if (!Array.isArray(data?.posts)) throw new Error('CHIKOCHAN_INVALID_POSTS');
    return data.posts;
  }

  async imageAvailable(url) {
    try {
      const response = await this.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return response.status === 405 || (response.ok && /^image\//i.test(response.headers.get('content-type') || 'image/'));
    } catch { return false; }
  }
}

module.exports = { ChikoChanApi, baseUrl, postId, retryDelay };
