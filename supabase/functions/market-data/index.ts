import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "https://ssb4107-cyber.github.io").split(",").map(value => value.trim());
const cache = new Map<string, { at: number; data: unknown }>();
const projectUrl = Deno.env.get("SUPABASE_URL") || "";
let projectKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
try {
  const configured = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default;
  if (typeof configured === "string" && configured) projectKey = configured;
} catch { /* Existing projects can continue using their legacy public key. */ }
Deno.serve(async req => {
  const origin = req.headers.get("Origin") || "";
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (origin && !allowed.includes(origin)) return reply(403, { error: "Origin denied" });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply(405, { error: "POST required" });
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply(401, { error: "Login required" });
  if (!projectUrl || !projectKey) return reply(503, { error: "Authentication not configured" });
  const supabase = createClient(projectUrl, projectKey, {
    global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: user, error: authError } = await supabase.auth.getUser();
  if (authError || !user.user) return reply(401, { error: "Login required" });
  try {
    const body = await req.json();
    const quote = body.action === "quote";
    const value = String(quote ? body.symbol || "" : body.query || "").trim().toUpperCase();
    if (!['quote', 'search'].includes(body.action) || !value || value.length > 60
        || quote && !/^[A-Z0-9.^:-]{1,24}$/.test(value)) return reply(400, { error: "Invalid request" });
    const { data: permitted, error } = await supabase.rpc("silver_market_allow");
    if (error || !permitted) return reply(429, { error: "Try again shortly" });
    const apiKey = Deno.env.get("FINNHUB_API_KEY");
    if (!apiKey) return reply(503, { error: "Market data not configured" });
    const cacheKey = `${body.action}:${value}`;
    const prior = cache.get(cacheKey);
    if (prior && Date.now() - prior.at < (quote ? 30000 : 600000)) return reply(200, prior.data);
    const url = new URL(`https://finnhub.io/api/v1/${quote ? "quote" : "search"}`);
    url.searchParams.set(quote ? "symbol" : "q", value);
    url.searchParams.set("token", apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return reply(502, { error: "Market data unavailable" });
    const result = await response.json();
    const data = quote ? { c: result.c, t: result.t }
      : { result: (Array.isArray(result.result) ? result.result : []).slice(0, 30).map((item: Record<string, unknown>) => ({ symbol: item.symbol, description: item.description, type: item.type })) };
    if (quote && (!Number.isFinite(Number(result.c)) || Number(result.c) <= 0)) return reply(502, { error: "Quote unavailable" });
    if (cache.size > 500) cache.clear();
    cache.set(cacheKey, { at: Date.now(), data });
    return reply(200, data);
  } catch { return reply(502, { error: "Market data unavailable" }); }
});
