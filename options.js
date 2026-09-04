const SYNC_DEFAULTS = {
  enabled: true,
  keywords: [],
  channels: [],
  hideShortsShelves: false,
  classifierEnabled: true,
  collapseAt: 0.4,
  hideAt: 0.9,
  useThumbnails: true,
  exemptAgeYears: 2,
  exemptSubs: 500000,
};

const $ = (id) => document.getElementById(id);
const toLines = (a) => (a || []).join('\n');
const toList = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean);
const pct = (v) => `${Math.round(v * 100)}%`;

function bindSlider(id, valueId) {
  const el = $(id);
  el.addEventListener('input', () => ($(valueId).textContent = `${el.value}%`));
}
bindSlider('collapseAt', 'collapseVal');
bindSlider('hideAt', 'hideVal');

// Subscriber threshold is exponential, so the slider maps to a scale of
// round numbers rather than a linear count.
const SUB_STEPS = [0, 10e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2e6, 5e6];
const subLabel = (n) =>
  n === 0 ? 'off' : n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`;

$('exemptAgeYears').addEventListener('input', () => {
  const v = +$('exemptAgeYears').value;
  $('ageVal').textContent = v === 1 ? '1 year' : `${v} years`;
});
$('exemptSubs').addEventListener('input', () => {
  $('subsVal').textContent = subLabel(SUB_STEPS[+$('exemptSubs').value]);
});

chrome.storage.sync.get(SYNC_DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('classifierEnabled').checked = s.classifierEnabled;
  $('useThumbnails').checked = s.useThumbnails;
  $('hideShortsShelves').checked = s.hideShortsShelves;
  $('keywords').value = toLines(s.keywords);
  $('channels').value = toLines(s.channels);

  $('collapseAt').value = Math.round(s.collapseAt * 100);
  $('hideAt').value = Math.round(s.hideAt * 100);
  $('collapseVal').textContent = pct(s.collapseAt);
  $('hideVal').textContent = pct(s.hideAt);

  $('exemptAgeYears').value = s.exemptAgeYears;
  $('ageVal').textContent = s.exemptAgeYears === 1 ? '1 year' : `${s.exemptAgeYears} years`;
  const subIdx = SUB_STEPS.indexOf(s.exemptSubs);
  $('exemptSubs').value = subIdx === -1 ? 5 : subIdx;
  $('subsVal').textContent = subLabel(s.exemptSubs);
});

chrome.storage.local.get({ labelQueue: [], allowlist: [], model: null }, (l) => {
  const user = l.labelQueue.filter((x) => x.source === 'user').length;
  const disclosed = l.labelQueue.filter((x) => x.source === 'disclosure').length;
  $('statLabels').textContent = user;
  $('statDisclosed').textContent = disclosed;
  $('statTrusted').textContent = l.allowlist.length;
});

function flash(text) {
  $('status').textContent = text;
  setTimeout(() => ($('status').textContent = ''), 2500);
}

$('save').addEventListener('click', () => {
  const collapseAt = +$('collapseAt').value / 100;
  const hideAt = Math.max(collapseAt, +$('hideAt').value / 100);

  chrome.storage.sync.set(
    {
      enabled: $('enabled').checked,
      classifierEnabled: $('classifierEnabled').checked,
      useThumbnails: $('useThumbnails').checked,
      exemptAgeYears: +$('exemptAgeYears').value,
      exemptSubs: SUB_STEPS[+$('exemptSubs').value],
      hideShortsShelves: $('hideShortsShelves').checked,
      keywords: toList($('keywords').value),
      channels: toList($('channels').value),
      collapseAt,
      hideAt,
    },
    () => flash('Saved.')
  );
});

$('reset').addEventListener('click', () => {
  // Clears learned weights, trusted channels and the unsent label queue.
  // Keyword and channel lists are yours and survive.
  chrome.storage.local.remove(['model', 'allowlist', 'labelQueue', 'globalWeights'], () => {
    $('statLabels').textContent = '0';
    $('statDisclosed').textContent = '0';
    $('statTrusted').textContent = '0';
    flash('Learning cleared. Reload YouTube.');
  });
});

$('export').addEventListener('click', () => {
  chrome.storage.local.get({ labelQueue: [], allowlist: [] }, (l) => {
    const blob = new Blob([JSON.stringify({ ratings: l.labelQueue, trusted: l.allowlist }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'yff-ratings.json';
    a.click();
    URL.revokeObjectURL(url);
    flash(`Exported ${l.labelQueue.length} ratings.`);
  });
});