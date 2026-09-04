// content.js — scrapes video tiles, scores them, collapses the likely slop,
// and turns every click you make into a training example.

// NOTE: all three content scripts share one lexical scope, so `const { X }`
// here would redeclare model.js's `class SlopClassifier` and throw a
// SyntaxError that kills this entire file before a single line runs. Read the
// property instead of destructuring it into the same name.
const F = self.YFF_FEATURES;
const Classifier = self.YFF_MODEL.SlopClassifier;

const DEFAULTS = {
  enabled: true,
  keywords: [],
  channels: [],
  hideShortsShelves: false,
  classifierEnabled: true,
  collapseAt: 0.4,    // show a slim "likely AI" bar
  hideAt: 0.9,        // remove entirely
  useThumbnails: true,
};

let settings = { ...DEFAULTS };
let model = null;
let allowlist = new Set();      // channels you've vouched for
let channelProfiles = {};       // channel -> { subs, verified, subscribed }
let thumbCache = new Map();     // videoId -> thumbnail features
const scoreCache = new Map();   // videoId -> { p, reasons, x, named }
// Videos you explicitly clicked "Show" on. apply() recomputes every tile on
// every pass — necessary because YouTube recycles nodes — so without this the
// observer re-flags the tile in the same frame you reveal it.
const revealed = new Set();
let modelVersion = 0;           // bump to invalidate scoreCache

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- selectors

const ITEM_SELECTOR = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-reel-item-renderer',
  'ytm-shorts-lockup-view-model',
  'yt-lockup-view-model',
].join(',');

const SHELF_SELECTOR = 'ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer';

const TITLE_SELECTOR =
  '#video-title, a#video-title-link, h3 a[aria-label], .yt-lockup-metadata-view-model__title';
const CHANNEL_SELECTOR =
  'ytd-channel-name #text, ytd-channel-name a, #channel-name #text, .yt-content-metadata-view-model__metadata-text';
const DURATION_SELECTOR =
  'ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape-wiz__text, .ytThumbnailOverlayBadgeViewModelHost span';
const META_SELECTOR =
  '#metadata-line span, .yt-content-metadata-view-model__metadata-text';

// ---------------------------------------------------------------- parsing

function parseDuration(text) {
  const m = norm(text).match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function parseCount(text) {
  const m = norm(text).match(/([\d.,]+)\s*([kmb])?\s*views?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.round(n * mult);
}

function parseAgeDays(text) {
  const m = norm(text).match(/(\d+)\s*(second|minute|hour|day|week|wk|month|mo|year|yr)/);
  if (!m) return null;
  const per = {
    second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1,
    week: 7, wk: 7, month: 30.4, mo: 30.4, year: 365, yr: 365,
  };
  return +m[1] * (per[m[2]] || 1);
}

function videoIdFrom(el) {
  const a = el.querySelector('a#thumbnail[href], a[href*="/watch?v="], a[href^="/shorts/"]');
  if (!a) return null;
  const href = a.getAttribute('href') || '';
  const watch = href.match(/[?&]v=([\w-]{6,})/);
  if (watch) return watch[1];
  const short = href.match(/\/shorts\/([\w-]{6,})/);
  return short ? short[1] : null;
}

function textOf(el, selector) {
  const node = el.querySelector(selector);
  if (!node) return '';
  return norm(node.getAttribute('title') || node.textContent);
}

function parseTile(el) {
  const title = textOf(el, TITLE_SELECTOR);
  const channel = textOf(el, CHANNEL_SELECTOR);
  if (!title) return null;

  let durationSec = null;
  for (const node of el.querySelectorAll(DURATION_SELECTOR)) {
    const d = parseDuration(node.textContent);
    if (d) { durationSec = d; break; }
  }

  let views = null;
  let ageDays = null;
  for (const node of el.querySelectorAll(META_SELECTOR)) {
    const t = node.textContent;
    views = views ?? parseCount(t);
    ageDays = ageDays ?? parseAgeDays(t);
  }

  const verified = !!el.querySelector(
    '[aria-label*="Verified" i], .badge-style-type-verified, ytd-badge-supported-renderer [d^="M23 12l"]'
  );

  const profile = channelProfiles[norm(channel)] || {};

  return {
    videoId: videoIdFrom(el),
    title,
    channel,
    durationSec,
    views,
    ageDays,
    verified: verified || !!profile.verified,
    subs: profile.subs ?? null,
    subscribed: !!profile.subscribed,
  };
}

// ---------------------------------------------------------------- scoring

function scoreTile(video) {
  const key = video.videoId || video.title;
  const cached = scoreCache.get(key);
  if (cached && cached.v === modelVersion && cached.hadThumb === thumbCache.has(video.videoId)) {
    return cached;
  }

  const thumb = video.videoId ? thumbCache.get(video.videoId) : null;
  const { x, named } = F.extractFeatures({ ...video, thumb });
  const { p, reasons } = model.predict(x, named);

  const result = { p, reasons, x, named, v: modelVersion, hadThumb: !!thumb, video };
  scoreCache.set(key, result);

  // Ask the service worker for thumbnail features; it'll ping us back and we
  // rescore. Done lazily so we only fetch images for borderline cases.
  if (settings.useThumbnails && video.videoId && !thumb && p > 0.25) {
    requestThumb(video.videoId);
  }
  return result;
}

// After you reload the extension at chrome://extensions, any content script
// already running in an open tab is orphaned: chrome.runtime still exists but
// its context is dead, and every call throws. Check before using it.
function extensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const thumbRequested = new Set();
function requestThumb(videoId) {
  if (thumbRequested.has(videoId) || !extensionAlive()) return;
  thumbRequested.add(videoId);
  chrome.runtime.sendMessage({ type: 'thumbFeatures', videoId }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    thumbCache.set(videoId, res.features);
    scheduleApply();
  });
}

// ---------------------------------------------------------------- rendering

function buildCard(tile, result) {
  const { videoId, title, channel } = result.video;

  const card = document.createElement('div');
  card.className = 'yff-card';
  card.dataset.yffVid = videoId || '';

  // Thumbnail preview, so you can judge without revealing the whole tile.
  if (videoId) {
    const thumb = document.createElement('img');
    thumb.className = 'yff-card-thumb';
    thumb.src = `https://i.ytimg.com/vi/${videoId}/default.jpg`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    card.appendChild(thumb);
  }

  const body = document.createElement('div');
  body.className = 'yff-card-body';

  const head = document.createElement('div');
  head.className = 'yff-card-label';
  head.textContent = `Likely AI-generated · ${(result.p * 100).toFixed(0)}%`;

  const name = document.createElement('div');
  name.className = 'yff-card-title';
  name.textContent = title;
  name.title = title;

  const who = document.createElement('div');
  who.className = 'yff-card-why';
  who.textContent = channel
    ? `${channel}${result.reasons.length ? ' — ' + result.reasons.join(' · ') : ''}`
    : result.reasons.join(' · ');

  body.append(head, name, who);

  const actions = document.createElement('div');
  actions.className = 'yff-card-actions';

  const show = document.createElement('button');
  show.textContent = 'Show';
  show.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Remembered, otherwise the next observer pass immediately re-flags it.
    if (videoId) revealed.add(videoId);
    tile.setAttribute('data-yff-revealed', 'true');
    tile.removeAttribute('data-yff-flag');
    card.remove();
  });

  const wrong = document.createElement('button');
  wrong.className = 'yff-primary';
  wrong.textContent = 'Not AI';
  wrong.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (videoId) revealed.add(videoId);
    teach(result, 0);
    vouchChannel(channel);
    tile.removeAttribute('data-yff-flag');
    card.remove();
  });

  actions.append(show, wrong);
  card.append(body, actions);
  return card;
}

function applyFlag(tile, result) {
  const existing = tile.querySelector(':scope > .yff-card');
  const vid = result.video.videoId || '';

  if (existing && existing.dataset.yffVid === vid) return; // already correct
  if (existing) existing.remove();

  tile.setAttribute('data-yff-flag', 'true');
  tile.appendChild(buildCard(tile, result));
}

function clearFlag(tile) {
  if (tile.hasAttribute('data-yff-flag')) tile.removeAttribute('data-yff-flag');
  // Recycled nodes: this marker must not survive into a different video.
  if (tile.hasAttribute('data-yff-revealed')) tile.removeAttribute('data-yff-revealed');
  const card = tile.querySelector(':scope > .yff-card');
  if (card) card.remove();
}

// ---------------------------------------------------------------- main pass

function manualMatch(video) {
  const title = norm(video.title);
  const channel = norm(video.channel);
  if (settings.keywords.some((k) => title.includes(k) || channel.includes(k))) return true;
  if (settings.channels.some((c) => channel && channel.includes(c))) return true;
  return false;
}

function apply() {
  if (!settings.enabled) {
    for (const el of document.querySelectorAll('[data-yff-hidden], [data-yff-flag]')) {
      el.removeAttribute('data-yff-hidden');
      clearFlag(el);
    }
    return;
  }

  for (const tile of document.querySelectorAll(ITEM_SELECTOR)) {
    const video = parseTile(tile);
    if (!video) continue;

    // 1. Explicit filters always win, and hide outright.
    if (manualMatch(video)) {
      tile.setAttribute('data-yff-hidden', 'true');
      clearFlag(tile);
      continue;
    }
    tile.removeAttribute('data-yff-hidden');

    // 2. Channels you've vouched for, are subscribed to, or videos you've
    //    explicitly revealed are never scored.
    if (
      !settings.classifierEnabled ||
      allowlist.has(norm(video.channel)) ||
      subscriptions.has(norm(video.channel)) ||
      video.subscribed ||
      (video.videoId && revealed.has(video.videoId))
    ) {
      clearFlag(tile);
      if (video.videoId && revealed.has(video.videoId)) {
        tile.setAttribute('data-yff-revealed', 'true');
      }
      continue;
    }

    // 3. Model.
    const result = scoreTile(video);
    if (result.p >= settings.hideAt) {
      tile.setAttribute('data-yff-hidden', 'true');
      clearFlag(tile);
    } else if (result.p >= settings.collapseAt) {
      applyFlag(tile, result);
    } else {
      clearFlag(tile);
    }
  }

  const hideShelves = settings.hideShortsShelves;
  for (const shelf of document.querySelectorAll(SHELF_SELECTOR)) {
    if (hideShelves) shelf.setAttribute('data-yff-hidden', 'true');
    else shelf.removeAttribute('data-yff-hidden');
  }
}

let queued = false;
function scheduleApply() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    apply();
  });
}

// ---------------------------------------------------------------- learning

function teach(result, y, source = 'user') {
  model.learn(result.x, y, source);
  modelVersion++;
  scoreCache.clear();
  persistModel();

  if (extensionAlive()) {
    chrome.runtime.sendMessage({
      type: 'label',
      payload: {
        videoId: result.video.videoId,
        label: y,
        source,
        p: result.p,
        ts: Date.now(),
      },
    });
  }
  scheduleApply();
}

let persistTimer = null;
function persistModel() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (extensionAlive()) chrome.storage.local.set({ model: model.toJSON() });
  }, 800);
}

function vouchChannel(channel) {
  const key = norm(channel);
  if (!key || allowlist.has(key)) return;
  allowlist.add(key);
  chrome.storage.local.set({ allowlist: [...allowlist] });
}

// ---------------------------------------------------------------- subscriptions
//
// The guide sidebar lists every channel you're subscribed to. Reading it
// directly is far better than waiting to detect a subscription on a watch
// page, which only covers channels you happen to open.

let subscriptions = new Set();

function harvestSubscriptions() {
  const sections = document.querySelectorAll('ytd-guide-section-renderer');
  let found = null;

  for (const section of sections) {
    const heading = norm(section.querySelector('#guide-section-title, h3')?.textContent);
    if (heading.startsWith('subscription')) {
      found = section;
      break;
    }
  }
  if (!found) return;

  let added = false;
  for (const link of found.querySelectorAll('a#endpoint[href]')) {
    const href = link.getAttribute('href') || '';
    // Skip "Show more", "Manage", "Browse channels" — only real channel links.
    if (!/^\/(@|channel\/|c\/|user\/)/.test(href)) continue;
    const name = norm(link.getAttribute('title') || link.querySelector('.title')?.textContent);
    if (name && !subscriptions.has(name)) {
      subscriptions.add(name);
      added = true;
    }
  }

  if (added) {
    chrome.storage.local.set({ subscriptions: [...subscriptions] });
    scoreCache.clear();
    scheduleApply();
  }
}

// ---------------------------------------------------------------- watch page
//
// The watch page carries three things the feed doesn't: YouTube's own
// synthetic-content disclosure (a free positive label), the channel's
// subscriber count, and whether you're subscribed. Harvest all three.

const DISCLOSURE_PATTERNS = [
  /altered or synthetic content/i,
  /sound or visuals were significantly edited or digitally generated/i,
];

function harvestWatchPage() {
  if (!location.pathname.startsWith('/watch')) return;

  const channel = norm(document.querySelector('#owner #channel-name #text, ytd-channel-name a')?.textContent);
  if (!channel) return;

  const subsText = document.querySelector('#owner-sub-count')?.textContent || '';
  const subsMatch = norm(subsText).match(/([\d.,]+)\s*([kmb])?\s*subscriber/);
  const subs = subsMatch
    ? Math.round(parseFloat(subsMatch[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[subsMatch[2]] || 1))
    : null;

  const subscribed = !!document.querySelector(
    '#subscribe-button [subscribed], ytd-subscribe-button-renderer[subscribed], button[aria-label^="Unsubscribe" i]'
  );
  const verified = !!document.querySelector('#owner ytd-badge-supported-renderer [aria-label*="Verified" i]');

  const prev = channelProfiles[channel] || {};
  const next = { subs: subs ?? prev.subs ?? null, subscribed, verified: verified || prev.verified, ts: Date.now() };
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    channelProfiles[channel] = next;
    chrome.storage.local.set({ channelProfiles });
    scoreCache.clear();
  }
  if (subscribed) vouchChannel(channel);

  // Free training label: YouTube says this one is synthetic.
  const desc = document.querySelector('#description-inner, ytd-watch-metadata')?.innerText || '';
  if (DISCLOSURE_PATTERNS.some((re) => re.test(desc))) {
    const title = norm(document.querySelector('#title h1, h1.ytd-watch-metadata')?.textContent);
    const videoId = new URLSearchParams(location.search).get('v');
    if (title && videoId && !harvested.has(videoId)) {
      harvested.add(videoId);
      const durationSec = Math.round(document.querySelector('video')?.duration || 0) || null;
      const { x, named } = F.extractFeatures({ title, channel, durationSec, subs, verified });
      teach({ x, named, p: 0, video: { videoId, title, channel } }, 1, 'disclosure');
    }
  }
}
const harvested = new Set();

// ---------------------------------------------------------------- right-click

let lastContextTile = null;
document.addEventListener(
  'contextmenu',
  (e) => {
    lastContextTile = e.target instanceof Element ? e.target.closest(ITEM_SELECTOR) : null;
  },
  true
);

// Find a tile from the URL Chrome reports for the right-clicked link. More
// reliable than the last-hovered element, because YouTube's inline preview
// player is frequently not a descendant of the tile it's previewing.
function tileFromLink(linkUrl) {
  if (!linkUrl) return null;
  const m = linkUrl.match(/[?&]v=([\w-]{6,})|\/shorts\/([\w-]{6,})/);
  const id = m && (m[1] || m[2]);
  if (!id) return null;
  for (const a of document.querySelectorAll(`a[href*="${id}"]`)) {
    const tile = a.closest(ITEM_SELECTOR);
    if (tile) return tile;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'markSlop' && msg.type !== 'markSafe') return;

  const tile = tileFromLink(msg.linkUrl) || lastContextTile;
  if (!tile) {
    console.warn('[YFF] could not find a video tile for that click', msg.linkUrl);
    return;
  }

  const video = parseTile(tile);
  if (!video) {
    console.warn('[YFF] found the tile but could not read its title/channel');
    return;
  }

  const result = scoreTile(video);

  if (msg.type === 'markSlop') {
    teach(result, 1);
    tile.setAttribute('data-yff-hidden', 'true');
    console.log('[YFF] marked as slop:', video.title, '—', video.channel);
  } else {
    teach(result, 0);
    vouchChannel(video.channel);
    if (video.videoId) revealed.add(video.videoId);
    clearFlag(tile);
    console.log('[YFF] marked as safe:', video.title, '— channel trusted:', video.channel);
  }
});

// ---------------------------------------------------------------- boot

function loadAll() {
  return Promise.all([
    new Promise((r) => chrome.storage.sync.get(DEFAULTS, r)),
    new Promise((r) =>
      chrome.storage.local.get(
        { model: null, allowlist: [], channelProfiles: {}, globalWeights: null, subscriptions: [] },
        r
      )
    ),
  ]).then(([sync, local]) => {
    settings = {
      ...DEFAULTS,
      ...sync,
      keywords: (sync.keywords || []).map(norm).filter(Boolean),
      channels: (sync.channels || []).map(norm).filter(Boolean),
    };
    model = new Classifier(local.model || {});
    if (local.globalWeights) model.global.w = local.globalWeights;
    allowlist = new Set(local.allowlist || []);
    subscriptions = new Set(local.subscriptions || []);
    channelProfiles = local.channelProfiles || {};
    modelVersion++;
    scoreCache.clear();
  });
}

function start() {
  new MutationObserver(() => {
    scheduleApply();
    harvestWatchPage();
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('yt-navigate-finish', () => {
    harvested.clear();
    scheduleApply();
    setTimeout(harvestWatchPage, 1200);
    setTimeout(harvestSubscriptions, 1200);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' || changes.model || changes.allowlist || changes.globalWeights) {
      loadAll().then(apply);
    }
  });

  scheduleApply();
  setTimeout(harvestWatchPage, 1500);
  // The guide sidebar populates late and re-renders on navigation.
  setTimeout(harvestSubscriptions, 2000);
  setInterval(harvestSubscriptions, 30000);
}

loadAll().then(() => {
  console.log('[YFF] content script running — classifier', settings.classifierEnabled ? 'on' : 'off',
    '· collapse at', settings.collapseAt, '· hide at', settings.hideAt);
  start();
});