// model.js — sparse online logistic regression.
//
// Why this and not a neural net: the model has to train inside a browser tab
// on a handful of labels, update the instant you click a button, and be able
// to explain itself. A linear model over good features does all three. A deep
// model would need thousands of labels before it beat the seeded heuristics.
//
// The score is the sum of two models:
//
//   z = bias + w_global · x + w_personal · x
//
// w_global is shipped/downloaded and shared by everyone. w_personal is trained
// only on your own clicks, with a much higher learning rate, and never leaves
// your machine. So the crowd sets the baseline and you override it — if you
// like one channel everyone else flags, your copy learns that in two clicks
// without fighting the global model.

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

class SparseLogReg {
  constructor(opts = {}) {
    this.w = opts.w || {};       // weights
    this.g = opts.g || {};       // AdaGrad accumulated squared gradients
    this.lr = opts.lr ?? 0.5;
    this.l2 = opts.l2 ?? 1e-6;
    this.n = opts.n || 0;        // examples seen
  }

  dot(x) {
    let z = 0;
    for (const k in x) {
      const w = this.w[k];
      if (w) z += w * x[k];
    }
    return z;
  }

  /**
   * One SGD step. AdaGrad gives each feature its own step size, which matters
   * a lot here: a rare hashed bigram should move further per observation than
   * `channel_unverified`, which fires on nearly everything.
   */
  update(x, y, sampleWeight = 1) {
    const p = sigmoid(this.dot(x));
    const err = (p - y) * sampleWeight;

    for (const k in x) {
      const grad = err * x[k] + this.l2 * (this.w[k] || 0);
      this.g[k] = (this.g[k] || 0) + grad * grad;
      const step = this.lr / Math.sqrt(this.g[k] + 1e-8);
      this.w[k] = (this.w[k] || 0) - step * grad;
      if (Math.abs(this.w[k]) < 1e-5) delete this.w[k]; // keep it sparse
    }
    this.n++;
    return p;
  }

  toJSON() {
    return { w: this.w, g: this.g, lr: this.lr, l2: this.l2, n: this.n };
  }

  static fromJSON(j, fallback = {}) {
    return new SparseLogReg(j || fallback);
  }
}

class SlopClassifier {
  constructor({ global, personal, bias = -2.2 } = {}) {
    // Global: seeded from hand-tuned priors, later replaced by downloaded
    // weights. Low learning rate — your clicks nudge it, they don't own it.
    this.global = SparseLogReg.fromJSON(global, {
      w: (self.YFF_FEATURES || {}).seedWeights?.() || {},
      lr: 0.08,
    });
    // Personal: starts empty, learns fast, stays local.
    this.personal = SparseLogReg.fromJSON(personal, { w: {}, lr: 0.9 });
    // Negative bias = "assume not slop". This is the precision knob: the
    // evidence has to add up before anything gets flagged.
    this.bias = bias;
  }

  /**
   * @returns {{p:number, z:number, reasons:string[]}}
   */
  predict(x, named) {
    const z = this.bias + this.global.dot(x) + this.personal.dot(x);
    const p = sigmoid(z);

    // Attribute the score to named features so the UI can say why.
    const F = self.YFF_FEATURES;
    const contributions = [];
    if (named && F) {
      for (const key in named) {
        // Features with no written explanation (raw view counts, duration,
        // "unverified") are real inputs but useless as reasons — showing a
        // bare feature name to a user is worse than showing nothing.
        const text = F.REASON_TEXT[key];
        if (!text) continue;
        const i = F.NAMED_INDEX[key];
        const w = (this.global.w[i] || 0) + (this.personal.w[i] || 0);
        const c = w * named[key];
        if (c > 0.12) contributions.push([c, text]);
      }
      contributions.sort((a, b) => b[0] - a[0]);
    }

    return { p, z, reasons: contributions.slice(0, 3).map((c) => c[1]) };
  }

  /**
   * @param y 1 = slop, 0 = fine
   * @param source 'user' | 'disclosure' — YouTube's own synthetic-content
   *        label is trustworthy but only trains the global model, since it
   *        isn't a statement about your taste.
   */
  learn(x, y, source = 'user') {
    if (source === 'user') {
      this.personal.update(x, y, 1);
      this.global.update(x, y, 0.25);
    } else {
      this.global.update(x, y, 1);
    }
  }

  toJSON() {
    return {
      global: this.global.toJSON(),
      personal: this.personal.toJSON(),
      bias: this.bias,
    };
  }
}

const YFF_MODEL = { SparseLogReg, SlopClassifier, sigmoid };
if (typeof module !== 'undefined') module.exports = YFF_MODEL;
if (typeof self !== 'undefined') self.YFF_MODEL = YFF_MODEL;