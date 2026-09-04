# DeSlop

A browser extension that learns to recognise AI-generated slop in your YouTube feed and collapses it, improving as you correct it.

## Install

1. `chrome://extensions` → Developer mode on → **Load unpacked** → pick this folder.
2. Click the icon, check the settings, reload YouTube.
3. Flagged videos collapse to a bar saying why. Click **Not AI** when it's wrong — that's the training loop.
4. Right-click anything it missed → **Mark as AI slop**.

Firefox needs `browser_specific_settings.gecko.id` in the manifest and uses `about:debugging` for temporary loading.

## The problem with "just detect AI"

There's no reliable classifier for "was this made with AI" from a thumbnail and a title. What *is* detectable is the production pattern that AI slop channels share, because the whole point of these channels is volume, and volume forces templates. The four archetypes you're targeting each leak differently:

| Archetype | What actually gives it away |
|---|---|
| Templated explainer (*"Every Devil Fruit Explained in 8 Minutes (Part I)"*) | Title regex, digits in channel name, tiny subscriber count against high views |
| Ambient mental-health filler (*"The Painful Truth About Feeling Unlovable"*, 2 hours) | Runtime-to-title-length ratio, topic lexicon |
| Terse sadposting (*"goodbye"*, 10 minutes of Minecraft b-roll) | Terse lowercase title, long runtime |
| Manim maths slop | Thumbnail: near-black field, tiny colour palette, thin bright strokes |

No single one of these is decisive. A linear model summing them is, which is the whole design.

## Architecture

```
                    ┌──────────────── content.js ────────────────┐
  DOM tile  ───►  parse  ───►  features.js  ───►  model.js  ───► collapse / hide
 (title, channel,          (24 named +          (logistic          + "why" + buttons
  duration, views,          16k hashed           regression)              │
  age, badge)               title n-grams)                                │
                                  ▲                                       │
                                  │                                  your click
                        thumbnail features                                │
                                  │                                       ▼
                         background.js  ◄────────────── label queue ──────┘
                     (fetch + OffscreenCanvas)                  │
                                                          (opt-in) server
```

### Why logistic regression and not a neural net

The model has to train inside a browser tab, on a handful of labels, update the instant you click a button, and explain itself in the UI. A sparse linear model does all three in about 60 lines. A small transformer over titles would need thousands of labels before it beat the hand-seeded heuristics, and it could never tell you *why* it flagged something — which matters, because a black box that silently eats a channel you like is worse than no filter.

The features do the heavy lifting; the model just learns how much to trust each one. That's the right split when labels are scarce.

### Features

**Named** (`features.js` → `NAMED`) — 24 hand-designed, interpretable, and *seeded with prior weights* so the extension works on day one with zero training data. `long_runtime_short_title` is the strongest, and deliberately continuous rather than a threshold: an 80-minute video with a 3-word title scores far higher than a 45-minute one with 7 words.

**Hashed** — title unigrams and bigrams through FNV-1a into 2^14 buckets. No prior, purely learned. This is what picks up slop vocabulary nobody hand-coded. L2-normalised so long titles don't outvote short ones.

**Thumbnail** (`background.js`) — fetched by the service worker rather than read off the page, because a cross-origin image drawn to a page canvas taints it and `getImageData` throws. Downscaled to 64px, then: mean value, mean saturation, palette diversity at 4 bits/channel, Sobel edge density, Hasler–Süsstrunk colourfulness. Two composites come out: `darkFlat` (Manim-alikes) and `flatVector` (flat illustration slop). Only fetched for videos already scoring above 0.25, so it isn't downloading a thumbnail for every tile you scroll past.

### Two models, one score

```
z = bias + w_global · x + w_personal · x
```

`w_global` is shared and moves slowly. `w_personal` starts empty, learns at 10× the rate, and never leaves your machine. If you like one channel that everyone else flags, two clicks fix it for you without fighting the crowd. AdaGrad gives each feature its own step size, which matters because a rare bigram should move much further per observation than `channel_unverified`, which fires on nearly everything.

The bias starts at −2.2 — "assume not slop until the evidence adds up". That's the precision knob.

### Where labels come from

1. **YouTube's own disclosure.** When a creator *does* declare synthetic content, the watch page shows an "Altered or synthetic content" notice. The extension harvests these as free positives. This is the important one: it means the model learns what disclosed AI content looks like and generalises to the videos that *don't* disclose. It's how you escape the cold start without labelling hundreds of videos by hand.
2. **Your clicks.** "Not AI" is a negative, right-click "Mark as AI slop" is a positive.
3. **Implicit trust.** Subscribing to a channel allowlists it permanently.

Disclosure labels train the global model only — they're a fact about the video, not a statement about your taste. Your clicks train both.

## Not blocking good faceless creators

This is the constraint that shapes the UI, and it's worth being explicit about the trade-off. Every classifier has a precision/recall dial. Set it to catch all the slop and you will eat some good channels. So:

- **Collapse, don't delete.** Above `collapseAt` the tile becomes a bar naming its reasons, with an override. A false positive costs you one glance, not a lost video. Hard removal only above `hideAt`, which defaults high.
- **Reasons are always shown.** If it's flagging good videos for a stupid reason, you can see the stupid reason.
- **Trust is sticky.** One "Not AI" allowlists the channel outright — it stops being scored at all.
- **Subscriptions are never scored.**
- **`channel_unverified` is weighted at 0.15.** Being small and faceless is a weak hint, not evidence. The seeds put the weight on *templating*, which is what separates a slop farm from a one-person channel that just doesn't show their face.

## Running a shared server

**Not in this build.** The sync code was removed: a timer-driven POST to a
remote URL carrying collected data under a random client token is structurally
indistinguishable from a beacon, and antivirus heuristics flag it on sight.
Since the server doesn't exist yet, the feature cost a false-positive quarantine
and bought nothing. Ratings export to JSON from the options page instead.

If you do build the backend later, this is the contract worth implementing:

```
POST /api/labels
  { token: "<random uuid>", labels: [{ videoId, label, source }] }
→ { version: 12, weights: { "3": 0.91, "17": -0.4, ... } }
```

Design notes for whoever builds it:

- **Send video IDs, not feature vectors.** The server refetches public metadata itself. A feature vector for everything you saw is a fingerprint of your feed; a list of videos you deliberately clicked a button on isn't.
- **Don't federate-average the weights.** Per-user data is tiny and noisy, so averaging thousands of near-random models gives you mush. Collect `(videoId, label)` votes, build one global labelled dataset, retrain nightly with the same feature extractor, ship the weights.
- **Poisoning is the real threat.** A slop channel with a botnet wants its videos voted "not AI", and a rival wants a competitor buried. Minimum defences: require *k* independent tokens per video before it counts, drop videos where agreement is under ~70%, rate-limit per token per day, ignore tokens younger than a few days, and weight a token's votes by how well its past votes agreed with settled consensus.
- **Ship weights, not decisions.** Never let the server return "hide video X" — that's a censorship endpoint and a single point of abuse. Weights over public features are auditable.

## Honest limits

- **The audio is where the real evidence is.** An ElevenLabs voiceover is far more identifiable than any title pattern, and everything here is a proxy for it. Detecting it properly means decoding audio, and YouTube's player uses MSE with a blob source, so `createMediaElementSource` won't cleanly give you the samples. It's the obvious next stage and it's genuinely hard.
- **Selectors rot.** YouTube renames its custom elements. When flagging stops working, inspect a tile and add its wrapper tag to `ITEM_SELECTOR`.
- **Small numbers of labels means overfitting.** With 20 clicks the hashed features will latch onto whatever words happened to appear. The named features and the negative bias are what keep it sane until the counts grow.
- **This doesn't change your recommendations.** YouTube still counts the impression. Pair it with "Don't recommend channel" to actually retrain the feed.
- **Antivirus will second-guess you.** Unsigned extension archives get heavy scrutiny from Chrome's download scanner and Defender. Load the folder unpacked rather than downloading a zip; if you must zip it, zip it yourself locally.
- **Calibration is not accuracy.** The number in the UI is the model's confidence, not a measured hit rate. If you want a real one, hold out some of your labels and check.

## Files

| File | Job |
|---|---|
| `features.js` | Feature extraction, seed weights, human-readable reasons |
| `model.js` | Sparse logistic regression, AdaGrad, global + personal split |
| `content.js` | Tile parsing, scoring, collapse UI, label harvesting |
| `background.js` | Thumbnail analysis, context menu, label queue |
| `options.html/js` | Settings, thresholds, training stats |
| `hide.css` | Hiding and the collapse card |