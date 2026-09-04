// background.js — service worker.
//
// Two jobs the content script can't do itself:
//   1. Fetch and analyse thumbnails (needs a non-tainted canvas, so the image
//      has to be fetched by the extension rather than read off the page).
//   2. Own the right-click "Mark as AI slop" menu item.
//
// This build makes no network requests except thumbnail images from the
// hardcoded i.ytimg.com host. There is no server sync, no client token, and
// no timer. Ratings stay on this machine; export them from the options page
// if you want to move them somewhere.

const THUMB_CACHE_MAX = 500;
const thumbCache = new Map();

// ---------------------------------------------------------------- thumbnails

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return { v: max / 255, s: max === 0 ? 0 : (max - min) / max };
}

async function analyseThumbnail(videoId) {
  if (thumbCache.has(videoId)) return thumbCache.get(videoId);

  const url = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('thumb fetch failed');
  const bitmap = await createImageBitmap(await res.blob());

  const W = 64;
  const H = Math.max(1, Math.round((bitmap.height / bitmap.width) * W));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, W, H);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, W, H);
  const n = W * H;

  let sumV = 0;
  let sumS = 0;
  let brightPixels = 0;
  let skinPixels = 0;
  const palette = new Set();
  const gray = new Float32Array(n);
  const rg = [];
  const yb = [];

  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const { v, s } = rgbToHsv(r, g, b);
    sumV += v;
    sumS += s;
    if (v > 0.8) brightPixels++;

    // Skin detection in YCbCr (Chai & Ngan). Deliberately chrominance-only:
    // skin chrominance sits in a similar band across the full range of human
    // skin tones, while luminance is what varies. A plain RGB range check
    // would only find light skin.
    const yy = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (yy > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) skinPixels++;

    // Quantise to 4 bits/channel — counts *distinct* colours, which is what
    // separates flat vector art and Manim frames from camera footage.
    palette.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    gray[i] = yy;
    rg.push(r - g);
    yb.push(0.5 * (r + g) - b);
  }

  // Sobel-ish gradient magnitude, averaged.
  let edge = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + W] - gray[i - W];
      edge += Math.sqrt(gx * gx + gy * gy);
    }
  }
  edge /= (W - 2) * (H - 2) * 255;

  const meanV = sumV / n;
  const meanS = sumS / n;
  const paletteRatio = palette.size / n;      // low = flat art, high = photo
  const brightRatio = brightPixels / n;

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  const mrg = mean(rg);
  const myb = mean(yb);
  const colorfulness =
    Math.min(1, (Math.sqrt(std(rg, mrg) ** 2 + std(yb, myb) ** 2) +
      0.3 * Math.sqrt(mrg * mrg + myb * myb)) / 120);

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const flat = clamp01((0.45 - paletteRatio) / 0.4);

  const features = {
    // Manim / 3b1b-imitation look: dark field, few colours, thin bright marks.
    darkFlat: clamp01((0.3 - meanV) / 0.3) * flat * clamp01(brightRatio / 0.08),
    // Flat vector illustration: few colours, heavily saturated, crisp edges.
    flatVector: flat * clamp01((meanS - 0.25) / 0.4) * clamp01(edge / 0.12),
    // Camera footage: many distinct colours from sensor noise and real
    // lighting. Flat art and rendered animation can't fake this cheaply.
    photographic: clamp01((paletteRatio - 0.28) / 0.25),
    // Visible hands, faces, people — unboxings, talking heads, anything shot
    // in the real world.
    skin: clamp01(skinPixels / n / 0.12),
    colorfulness,
    edgeDensity: clamp01(edge / 0.25),
  };

  if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(videoId, features);
  return features;
}

// ---------------------------------------------------------------- labels

async function queueLabel(payload) {
  const { labelQueue = [] } = await chrome.storage.local.get({ labelQueue: [] });
  labelQueue.push(payload);
  // Keep the local record bounded; it's a send buffer, not an archive.
  await chrome.storage.local.set({ labelQueue: labelQueue.slice(-2000) });
}

// ---------------------------------------------------------------- wiring

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'yff-mark-slop',
    title: 'Mark as AI slop',
    contexts: ['link', 'image', 'video', 'page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });
  chrome.contextMenus.create({
    id: 'yff-mark-safe',
    title: 'Mark as safe (not AI)',
    contexts: ['link', 'image', 'video', 'page'],
    documentUrlPatterns: ['https://www.youtube.com/*'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = { 'yff-mark-slop': 'markSlop', 'yff-mark-safe': 'markSafe' }[info.menuItemId];
  if (!action || !tab?.id) return;
  // Chrome tells us which link was clicked, which survives right-clicking
  // the hover-preview player — that <video> often lives outside the tile.
  chrome.tabs
    .sendMessage(tab.id, { type: action, linkUrl: info.linkUrl || info.pageUrl })
    .catch(() => console.warn('[YFF] content script not reachable in this tab'));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'thumbFeatures') {
    analyseThumbnail(msg.videoId)
      .then((features) => sendResponse({ ok: true, features }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async
  }
  if (msg.type === 'label') {
    queueLabel(msg.payload);
  }
});