// Pure logic for the usage dashboard: prices, parsing Anthropic's usage report,
// and turning it into the numbers the dashboard draws. No network, no Deno
// APIs, so it can be tested with plain Node.

// $ per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// (Haiku 5.5 is priced for prompts up to 100k tokens, which a clinic chat never reaches.)
export const PRICES = {
  "claude-haiku-5-5": { label: "Haiku 5.5", in: 0.10, w5: 0.125, w1: 0.20, read: 0.01, out: 0.50 },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", in: 2.0, w5: 2.5, w1: 4.0, read: 0.10, out: 10.0 },
  "claude-sonnet-5": { label: "Sonnet 5", in: 2.0, w5: 2.5, w1: 4.0, read: 0.20, out: 10.0 },
  "claude-haiku-4-5": { label: "Haiku 4.5", in: 1.0, w5: 1.25, w1: 2.0, read: 0.10, out: 5.0 },
};

// Longest key that the model id starts with, so dated ids like
// "claude-haiku-5-5-20261001" still find "claude-haiku-5-5".
export function priceFor(model) {
  let best = null;
  for (const key of Object.keys(PRICES)) {
    if (model === key || String(model).startsWith(key + "-")) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? PRICES[best] : null;
}

export function prettyModel(model) {
  const p = priceFor(model);
  return p ? p.label : String(model || "unknown");
}

const empty = () => ({ uncached: 0, w5: 0, w1: 0, read: 0, out: 0 });

// One row of Anthropic's report -> our five token counters.
// cache_creation is an object ({ephemeral_5m_input_tokens, ephemeral_1h_input_tokens});
// older shapes had a flat cache_creation_input_tokens, counted as 5-minute writes.
export function tokensOf(r) {
  const cc = r.cache_creation;
  let w5 = 0, w1 = 0;
  if (cc && typeof cc === "object") {
    w5 = Number(cc.ephemeral_5m_input_tokens) || 0;
    w1 = Number(cc.ephemeral_1h_input_tokens) || 0;
  } else {
    w5 = Number(r.cache_creation_input_tokens) || Number(cc) || 0;
  }
  return {
    uncached: Number(r.uncached_input_tokens) || 0,
    w5, w1,
    read: Number(r.cache_read_input_tokens) || 0,
    out: Number(r.output_tokens) || 0,
  };
}

const add = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; return a; };

// Dollars for a token set on a model; null when the model has no known price.
export function costOf(t, model) {
  const p = priceFor(model);
  if (!p) return null;
  return (t.uncached * p.in + t.w5 * p.w5 + t.w1 * p.w1 + t.read * p.read + t.out * p.out) / 1e6;
}

// What caching saved: every cache read would otherwise have cost the full input
// price, minus the extra paid to write the cache in the first place.
export function cacheSaving(t, model) {
  const p = priceFor(model);
  if (!p) return null;
  return (t.read * (p.in - p.read) - t.w5 * (p.w5 - p.in) - t.w1 * (p.w1 - p.in)) / 1e6;
}

// Merge consecutive buckets into bigger ones (e.g. 1-minute -> 5-minute) so a
// 6-hour view has 72 readable columns instead of 360 slivers.
export function rebucket(buckets, size) {
  if (size <= 1) return buckets;
  const out = [];
  for (let i = 0; i < buckets.length; i += size) {
    const group = buckets.slice(i, i + size);
    const merged = { t: group[0].t, tokens: empty(), cost: 0, byModel: {} };
    for (const b of group) {
      add(merged.tokens, b.tokens);
      merged.cost += b.cost;
      for (const [m, v] of Object.entries(b.byModel)) {
        merged.byModel[m] = merged.byModel[m] || { tokens: empty(), cost: 0 };
        add(merged.byModel[m].tokens, v.tokens);
        merged.byModel[m].cost += v.cost;
      }
    }
    out.push(merged);
  }
  return out;
}

// Anthropic buckets -> series + totals. `keyNames` maps api_key_id -> name.
export function summarise(apiBuckets, keyNames = {}) {
  const series = [];
  const totals = { tokens: empty(), cost: 0, unpricedTokens: 0 };
  const byModel = {};
  const byKey = {};

  for (const bucket of apiBuckets) {
    const point = { t: bucket.starting_at, tokens: empty(), cost: 0, byModel: {} };
    for (const r of bucket.results || []) {
      const model = r.model || "unknown";
      const t = tokensOf(r);
      const c = costOf(t, model);
      add(point.tokens, t);
      point.cost += c || 0;
      point.byModel[model] = point.byModel[model] || { tokens: empty(), cost: 0 };
      add(point.byModel[model].tokens, t);
      point.byModel[model].cost += c || 0;

      add(totals.tokens, t);
      totals.cost += c || 0;
      if (c === null) totals.unpricedTokens += t.uncached + t.w5 + t.w1 + t.read + t.out;

      byModel[model] = byModel[model] || { model, name: prettyModel(model), priced: c !== null, tokens: empty(), cost: 0, saving: 0 };
      add(byModel[model].tokens, t);
      byModel[model].cost += c || 0;
      byModel[model].saving += cacheSaving(t, model) || 0;

      const keyId = r.api_key_id || "none";
      byKey[keyId] = byKey[keyId] || { id: keyId, name: keyId === "none" ? "Console / playground" : (keyNames[keyId] || keyId), tokens: empty(), cost: 0 };
      add(byKey[keyId].tokens, t);
      byKey[keyId].cost += c || 0;
    }
    series.push(point);
  }

  const t = totals.tokens;
  const input = t.uncached + t.w5 + t.w1 + t.read;
  const saving = Object.values(byModel).reduce((s, m) => s + m.saving, 0);
  return {
    series,
    totals: {
      ...totals,
      inputTokens: input,
      allTokens: input + t.out,
      cacheHitRate: input ? t.read / input : null,   // share of input tokens served from cache
      cacheSaving: saving,
    },
    models: Object.values(byModel).sort((a, b) => b.cost - a.cost),
    keys: Object.values(byKey).sort((a, b) => b.cost - a.cost),
  };
}

// Month-to-date plus a straight-line projection from the days elapsed so far.
export function monthView(dailyBuckets, now = new Date()) {
  const s = summarise(dailyBuckets);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const elapsed = Math.max(1, now.getUTCDate() - 1 + (now.getUTCHours() + now.getUTCMinutes() / 60) / 24);
  return {
    cost: s.totals.cost,
    tokens: s.totals.allTokens,
    projectedCost: (s.totals.cost / elapsed) * daysInMonth,
    daysElapsed: Math.round(elapsed * 10) / 10,
    daysInMonth,
  };
}

// The ranges the dashboard offers: how far back, how Anthropic buckets it,
// and how many of those buckets to merge for display.
export const RANGES = {
  "1h": { minutes: 60, bucket: "1m", merge: 1, limit: 60 },
  "6h": { minutes: 360, bucket: "1m", merge: 5, limit: 360 },
  "24h": { minutes: 1440, bucket: "1h", merge: 1, limit: 24 },
  "7d": { minutes: 10080, bucket: "1h", merge: 1, limit: 168 },
  "30d": { minutes: 43200, bucket: "1d", merge: 1, limit: 30 },
};

// Floor a Date to the start of its bucket so the first bucket is whole.
export function floorTo(date, bucket) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  if (bucket === "1h") d.setUTCMinutes(0);
  if (bucket === "1d") { d.setUTCMinutes(0); d.setUTCHours(0); }
  return d;
}
