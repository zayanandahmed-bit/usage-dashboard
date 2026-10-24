// Supabase Edge Function behind the DaysBack usage dashboard.
//
//   GET  /functions/v1/daysback-usage              -> { ready: boolean }
//   POST /functions/v1/daysback-usage  { range }   -> usage report (needs x-passcode)
//
// Anthropic keeps an exact record of every token your account uses. This reads
// it with an Admin API key that lives only here, as the ANTHROPIC_ADMIN_KEY
// secret, and hands the dashboard a ready-to-draw summary. The dashboard page is
// public, so access is gated by USAGE_PASSCODE and a list of allowed origins.
import { floorTo, monthView, rebucket, RANGES, summarise } from "./core.js";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://zayanandahmed-bit.github.io,http://localhost:8765,http://127.0.0.1:8765").split(",").map((s) => s.trim());

const API = "https://api.anthropic.com/v1/organizations";
const HEADERS = () => ({
  "x-api-key": Deno.env.get("ANTHROPIC_ADMIN_KEY") ?? "",
  "anthropic-version": "2023-06-01",
  "user-agent": "DaysBackUsageDashboard/1.0",
});

// Anthropic asks for at most one poll a minute; the dashboard refreshes every
// minute, so a short cache also protects that limit if several tabs are open.
const CACHE_MS = 45_000;
const cache = new Map<string, { at: number; body: unknown }>();
let keyNames: { at: number; map: Record<string, string> } = { at: 0, map: {} };

async function same(a: string, b: string) {
  // Compare hashes, not strings, so timing doesn't reveal how much matched.
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}

class UpstreamError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: HEADERS() });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new UpstreamError(r.status, text.slice(0, 300));
  }
  return r.json();
}

// Follow Anthropic's pagination until it says there is no more.
async function fetchUsage(start: Date, end: Date, bucket: string, limit: number) {
  const out: unknown[] = [];
  let page: string | null = null;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams();
    q.set("starting_at", start.toISOString());
    q.set("ending_at", end.toISOString());
    q.set("bucket_width", bucket);
    q.set("limit", String(limit));
    q.append("group_by[]", "model");
    q.append("group_by[]", "api_key_id");
    if (page) q.set("page", page);
    const d = await getJson(`${API}/usage_report/messages?${q}`);
    out.push(...(d.data ?? []));
    if (!d.has_more || !d.next_page) break;
    page = d.next_page;
  }
  return out;
}

async function loadKeyNames() {
  if (Date.now() - keyNames.at < 10 * 60_000) return keyNames.map;
  const map: Record<string, string> = {};
  try {
    const d = await getJson(`${API}/api_keys?limit=100`);
    for (const k of d.data ?? []) map[k.id] = k.name;
  } catch { /* names are a nicety; ids still show */ }
  keyNames = { at: Date.now(), map };
  return map;
}

async function report(range: string) {
  const cfg = RANGES[range as keyof typeof RANGES];
  const now = new Date();
  const end = new Date(floorTo(now, cfg.bucket).getTime() + (cfg.bucket === "1m" ? 60_000 : cfg.bucket === "1h" ? 3_600_000 : 86_400_000));
  const stepMs = cfg.bucket === "1m" ? 60_000 : cfg.bucket === "1h" ? 3_600_000 : 86_400_000;
  const start = new Date(end.getTime() - cfg.limit * stepMs);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [buckets, monthBuckets, names] = await Promise.all([
    fetchUsage(start, end, cfg.bucket, cfg.limit),
    fetchUsage(monthStart, new Date(floorTo(now, "1d").getTime() + 86_400_000), "1d", 31),
    loadKeyNames(),
  ]);

  const s = summarise(buckets as never[], names);
  s.series = rebucket(s.series, cfg.merge);
  const m = summarise(monthBuckets as never[], names);

  // Tokens per minute over the last 5 finished minutes, for the "right now" tile.
  let perMinute: number | null = null;
  if (cfg.bucket === "1m") {
    const recent = (buckets as never[]).slice(-6, -1) as { results?: unknown[] }[];
    const sum = summarise(recent as never[]);
    perMinute = recent.length ? sum.totals.allTokens / recent.length : null;
  }

  return {
    ready: true,
    range,
    bucket: cfg.bucket,
    mergedMinutes: cfg.bucket === "1m" ? cfg.merge : null,
    generatedAt: now.toISOString(),
    ...s,
    month: { ...monthView(monthBuckets as never[], now), models: m.models },
    perMinute,
    note: "Anthropic's numbers arrive up to about 5 minutes after each request.",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-passcode",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) cors["Access-Control-Allow-Origin"] = origin;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed." }, 403);

  const passcode = Deno.env.get("USAGE_PASSCODE") ?? "";
  const adminKey = Deno.env.get("ANTHROPIC_ADMIN_KEY") ?? "";

  if (req.method === "GET") return json({ ready: !!passcode && !!adminKey, passcodeSet: !!passcode, adminKeySet: !!adminKey });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  if (!passcode) return json({ error: "Not set up: USAGE_PASSCODE is missing." }, 500);
  if (!(await same(req.headers.get("x-passcode") ?? "", passcode))) return json({ error: "Wrong passcode." }, 401);
  if (!adminKey) {
    return json({ error: "no_admin_key", detail: "Add the ANTHROPIC_ADMIN_KEY secret in Supabase > Edge Functions > Secrets." }, 503);
  }

  let range = "24h";
  try {
    const body = await req.json();
    if (typeof body?.range === "string" && body.range in RANGES) range = body.range;
  } catch { /* default range */ }

  const hit = cache.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body);

  try {
    const body = await report(range);
    cache.set(range, { at: Date.now(), body });
    return json(body);
  } catch (e) {
    if (e instanceof UpstreamError) {
      if (e.status === 401 || e.status === 403) {
        return json({ error: "admin_key_rejected", detail: "Anthropic didn't accept the admin key. It must be an Admin API key (starts sk-ant-admin) from an organization account." }, 502);
      }
      if (e.status === 429) return json({ error: "rate_limited", detail: "Anthropic asked us to slow down. Try again in a minute." }, 429);
      return json({ error: "upstream", detail: `Anthropic returned ${e.status}.` }, 502);
    }
    return json({ error: "upstream", detail: "Couldn't reach Anthropic." }, 502);
  }
});
