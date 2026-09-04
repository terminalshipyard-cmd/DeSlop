// features.js — turns a video's visible metadata into a sparse feature vector.
//
// Two kinds of features:
//   1. NAMED  — hand-designed, interpretable, seeded with prior weights so the
//               extension is useful on day one before it has seen any feedback.
//   2. HASHED — title word/bigram hashes. No prior, purely learned. This is what
//               lets the model pick up slop patterns nobody hand-coded.

const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;

// ---------------------------------------------------------------- lexicons

const MENTAL_HEALTH = [
  'lonely', 'loneliness', 'unlovable', 'why am i', 'painful truth', 'healing',
  'overthinking', 'attachment style', 'avoidant', 'self worth', 'self-worth',
  'nobody likes', 'no one likes', 'feeling nothing', 'emotionally', 'trauma',
  'inner child', 'you are not broken', 'stop caring',
];

const AMBIENT_FILLER = [
  'hours of', 'to fall asleep', 'to forget about', 'chill', 'deep focus',
  'study with', 'facts to', 'compilation', 'background', 'sleep to',
  'relaxing', 'ambient',
];

const EXPLAINER_TEMPLATE = [
  /explained in \d+\s*(minutes?|mins?|seconds?)/i,
  /in under \d+\s*(minutes?|mins?)/i,
  /^every .{3,40}\b(explained|ranked|explained)\b/i,
  /^top \d+\b/i,
  /^\d+\s+(things|facts|reasons|ways)\b/i,
  /\b(a )?complete (guide|history) to\b/i,
  /\(part [ivx]+\)/i,
  /\bfully explained\b/i,
  /\b(iceberg|anomalies)\s+(explained|chart)\b/i,
];

// Generic words that show up in auto-generated channel names.
const GENERIC_CHANNEL_WORDS = [
  'talks', 'talk', 'compilations', 'facts', 'history', 'explained', 'daily',
  'hub', 'zone', 'central', 'media', 'studios', 'studio', 'tv', 'shorts',
  'insights', 'mind', 'minds', 'vault', 'archive', 'lab', 'labs', 'academy',
  'nexus', 'core', 'verse', 'story', 'stories', 'wisdom', 'curious',
];

// ---------------------------------------------------------------- helpers

const lc = (s) => (s || '').toLowerCase();
const words = (s) => lc(s).split(/[^a-z0-9']+/).filter(Boolean);
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const any = (re, s) => (re.some ? re.some((r) => r.test(s)) : re.test(s));

// Squash an unbounded count into [0,1] so one viral video can't dominate.
const logScale = (n, mid) => (n > 0 ? clamp01(Math.log10(1 + n) / Math.log10(1 + mid) / 2) : 0);

// ---------------------------------------------------------------- named features
//
// `seed` is the prior weight in logit space. Positive means "more likely slop".
// These were set by hand from observed patterns and are deliberately mild —
// no single one should flag a video alone. Learning moves them from here.

const NAMED = [
  // --- title shape -------------------------------------------------------
  {
    key: 'title_explainer_template',
    seed: 1.5,
    fn: (v) => (any(EXPLAINER_TEMPLATE, v.title) ? 1 : 0),
  },
  {
    key: 'title_number_in_first_half',
    seed: 0.2,
    fn: (v) => (/\d/.test(v.title.slice(0, Math.ceil(v.title.length / 2))) ? 1 : 0),
  },
  {
    // "goodbye", "i hate feeling lonely..." — a 1-3 word all-lowercase title.
    key: 'title_terse_lowercase',
    seed: 0.35,
    fn: (v) => {
      const w = words(v.title);
      return w.length > 0 && w.length <= 4 && v.title === v.title.toLowerCase() ? 1 : 0;
    },
  },
  {
    // The strongest single tell in the ambient-slop category: an hour-plus
    // runtime attached to a title too short to describe an hour of content.
    key: 'long_runtime_short_title',
    seed: 1.4,
    fn: (v) => {
      if (!v.durationSec || v.durationSec < 2400) return 0;
      const w = words(v.title).length;
      if (w > 8) return 0;
      return clamp01((v.durationSec - 2400) / 5400) * clamp01((9 - w) / 8);
    },
  },
  {
    key: 'title_hours_of',
    seed: 0.8,
    fn: (v) => (/\b(\d+|one|two|three|four|five|six|ten|twelve)\s+hours?\s+of\b/i.test(v.title) ? 1 : 0),
  },
  {
    key: 'title_mental_health_lex',
    seed: 0.5,
    fn: (v) => clamp01(MENTAL_HEALTH.filter((t) => lc(v.title).includes(t)).length / 2),
  },
  {
    key: 'title_ambient_lex',
    seed: 0.5,
    fn: (v) => clamp01(AMBIENT_FILLER.filter((t) => lc(v.title).includes(t)).length / 2),
  },
  {
    // Deliberately NOT matching a bare "Why…"/"How…" opener — that's how most
    // good explainer titles start too. Only the confessional hook shapes.
    key: 'title_second_person_hook',
    seed: 0.35,
    fn: (v) =>
      /\b(the (painful|hard|brutal|uncomfortable) truth|what nobody tells you|why nobody|you('| a)re not (broken|alone)|nobody talks about)\b/i.test(
        v.title
      )
        ? 1
        : 0,
  },
  {
    // "[No AI]" and friends. Protesting too much is itself a signal.
    key: 'title_no_ai_claim',
    seed: 0.7,
    fn: (v) => (/\[?\bno ai\b\]?|100%\s*human|not ai generated/i.test(v.title) ? 1 : 0),
  },

  // --- channel shape -----------------------------------------------------
  {
    // A number *appended* to the name — "Simeon2nd", "NORTH 02" — is the
    // artefact of picking a name that was already taken. A number *inside* a
    // name is usually deliberate branding: 3Blue1Brown, Pudding4TW. Matching
    // digits anywhere flags both, which is wrong.
    key: 'channel_trailing_number',
    seed: 0.5,
    fn: (v) => (/[\s_-]?\d{1,4}\s*(st|nd|rd|th)?$/i.test(v.channel.trim()) ? 1 : 0),
  },
  {
    key: 'channel_generic_compound',
    seed: 0.4,
    fn: (v) => {
      const w = words(v.channel);
      if (w.length < 2 || w.length > 4) return 0;
      const hits = w.filter((x) => GENERIC_CHANNEL_WORDS.includes(x)).length;
      return clamp01(hits / 2);
    },
  },
  {
    key: 'channel_unverified',
    seed: 0.15,
    fn: (v) => (v.verified ? 0 : 1),
  },
  {
    // Only meaningful once we've seen the channel's watch page. Absent = 0.
    key: 'channel_low_subs',
    seed: 0.8,
    fn: (v) => (v.subs == null ? 0 : clamp01((Math.log10(2e5) - Math.log10(v.subs + 1)) / 3)),
  },
  {
    // Views far exceeding subscriber count means the channel lives entirely on
    // algorithmic reach and converts almost nobody — the economics of a slop
    // farm. Deliberately NOT views-per-day: every video is high views-per-day
    // on day two, so that version just flags everything recent.
    key: 'channel_views_exceed_subs',
    seed: 0.7,
    fn: (v) => {
      if (v.subs == null || !v.views || v.subs < 500) return 0;
      const ratio = v.views / v.subs;
      if (ratio < 2) return 0;
      return clamp01(Math.log10(ratio / 2) / Math.log10(10)) * clamp01((5e5 - v.subs) / 5e5);
    },
  },

  // --- metadata ----------------------------------------------------------
  { key: 'meta_views', seed: 0, fn: (v) => logScale(v.views, 1e5) },
  { key: 'meta_age_recent', seed: 0.1, fn: (v) => (v.ageDays == null ? 0 : clamp01((90 - v.ageDays) / 90)) },
  { key: 'meta_duration_norm', seed: 0, fn: (v) => (v.durationSec ? clamp01(v.durationSec / 7200) : 0) },

  // --- thumbnail (filled in asynchronously by the service worker) ---------
  {
    // Manim-style: near-black navy field, very few distinct colours, thin
    // bright strokes. Catches the maths-slop archetype that title text misses.
    key: 'thumb_dark_flat',
    seed: 0.5,
    fn: (v) => v.thumb?.darkFlat ?? 0,
  },
  {
    // Flat vector illustration: high saturation, tiny palette, hard edges.
    key: 'thumb_flat_vector',
    seed: 0.4,
    fn: (v) => v.thumb?.flatVector ?? 0,
  },
  { key: 'thumb_colorfulness', seed: 0, fn: (v) => v.thumb?.colorfulness ?? 0 },
  { key: 'thumb_edge_density', seed: 0, fn: (v) => v.thumb?.edgeDensity ?? 0 },
];

const NAMED_INDEX = Object.fromEntries(NAMED.map((f, i) => [f.key, i]));
const NAMED_COUNT = NAMED.length;

// ---------------------------------------------------------------- hashing

// FNV-1a. Fast, no dependencies, good enough spread for the hashing trick.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % HASH_SIZE;
}

function hashedTitleFeatures(title, out) {
  const w = words(title);
  const push = (token) => {
    const idx = NAMED_COUNT + hash(token);
    out[idx] = (out[idx] || 0) + 1;
  };
  for (let i = 0; i < w.length; i++) {
    push('u:' + w[i]);
    if (i + 1 < w.length) push('b:' + w[i] + '_' + w[i + 1]);
  }
  // L2-normalise the hashed block so long titles don't outweigh short ones.
  let norm = 0;
  for (const k in out) if (+k >= NAMED_COUNT) norm += out[k] * out[k];
  norm = Math.sqrt(norm) || 1;
  for (const k in out) if (+k >= NAMED_COUNT) out[k] /= norm;
}

// ---------------------------------------------------------------- public API

/**
 * @param {object} v  { title, channel, durationSec, views, ageDays, verified, subs, thumb }
 * @returns {{x: Object<number,number>, named: Object<string,number>}}
 */
function extractFeatures(v) {
  const video = { title: v.title || '', channel: v.channel || '', ...v };
  const x = {};
  const named = {};

  for (let i = 0; i < NAMED.length; i++) {
    let val = 0;
    try {
      val = NAMED[i].fn(video) || 0;
    } catch {
      val = 0;
    }
    if (val) {
      x[i] = val;
      named[NAMED[i].key] = val;
    }
  }

  hashedTitleFeatures(video.title, x);
  return { x, named };
}

function seedWeights() {
  const w = {};
  NAMED.forEach((f, i) => {
    if (f.seed) w[i] = f.seed;
  });
  return w;
}

// Human-readable reasons, for the "why was this flagged" line.
const REASON_TEXT = {
  title_explainer_template: 'templated explainer title format',
  long_runtime_short_title: 'hour-plus runtime with a very short title',
  title_hours_of: '“hours of” filler-length framing',
  title_mental_health_lex: 'mental-health hook phrasing',
  title_ambient_lex: 'ambient background-content phrasing',
  title_terse_lowercase: 'minimal lowercase title',
  title_no_ai_claim: 'explicit “no AI” claim in the title',
  channel_trailing_number: 'number appended to the channel name',
  channel_generic_compound: 'generic auto-generated-looking channel name',
  channel_low_subs: 'small channel',
  channel_views_exceed_subs: 'views far exceed subscriber count',
  thumb_dark_flat: 'flat dark animation-style thumbnail',
  thumb_flat_vector: 'flat vector illustration thumbnail',
  title_second_person_hook: 'second-person hook title',
};

const YFF_FEATURES = {
  extractFeatures,
  seedWeights,
  NAMED,
  NAMED_INDEX,
  NAMED_COUNT,
  HASH_SIZE,
  REASON_TEXT,
  DIM: NAMED_COUNT + HASH_SIZE,
};

if (typeof module !== 'undefined') module.exports = YFF_FEATURES;
if (typeof self !== 'undefined') self.YFF_FEATURES = YFF_FEATURES;