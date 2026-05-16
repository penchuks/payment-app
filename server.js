const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;
const WALLET_SET_ID = "b57b1e16-157d-591a-a2e0-afe23e2d3f43";
const DEFAULT_WALLET_ID = "63550111-2a20-5951-a107-053789cbdbfd";
const TOKEN_ID = "5797fbd6-3795-519d-84ca-ec4c5f80c3b1";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Cache ─────────────────────────────────────────────────────────────────────
let priceCache = {};
let historyCache = {};
let ipoCache = { data: null, ts: 0 };
let sentimentCache = { data: null, ts: 0 };
const PRICE_TTL   = 5  * 60 * 1000;
const HISTORY_TTL = 60 * 60 * 1000;
const IPO_TTL     = 12 * 60 * 60 * 1000;
const SENT_TTL    = 10 * 60 * 1000;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = {};
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < windowMs);
  if (rateLimitMap[ip].length >= max) return false;
  rateLimitMap[ip].push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimitMap).forEach(ip => {
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
    if (!rateLimitMap[ip].length) delete rateLimitMap[ip];
  });
}, 5 * 60 * 1000);

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtC4XwUTcAAEj+3vHXNl+
VCKS4F0XCfC6xlsahuqEXgAwzzQvS5ocm7Lvm5YmzM9enBaP4Po6KZbF7SDtzVB3
yYKigEXH3f3Af/oVRrpzfkMrp7pup/Iub6Bohmi/7Ehm3aW07VztDtBAkmXgug+a
6ZOeQuJkxTYjtm/cxOwX2a1ZcvOP1qhQfS3u92cly92lWgd8quB+jZbba/udE5wt
DqT74q1EOYUyzJzbeJWsfbVE93h4CDPjyZiXj2pTwPhUBlMA801p1M8mW4+taj3f
UH456bRGCjURCIEwxyCUY8Xubssr5kJaWTDhDU+8Wy8e46qoxY+/nu7pVrrS9tfx
8d17X6deXKirGKm6bohb+VOAncWnj3x0Otjia7J/5TXKmMlqZrzGVySs/lLYBWUA
2lNfHqgdnH6R5WBd/KbgVMEMnCPgdASJIfQ9GITIIBo4o9UGr+CmRJlYmejZrgka
IqpAYDsAOdluQVPnFtIUk1hMl7Ed5PvihVr9VUhms5+IGdxsKiovk8L1gLcBXV3u
z+RYVllcIIgDftD/mS2MsH74q7TBAx1eu5dvhG5nBL4Q6GC8rgJ/OQDUzjQOMuRW
1AX0urxFw3XU8htZTzOYj1VOUFKllt94VW2DhISrJScZc0OXLp1Nho43w1WrJjyx
ngR8ws0d+l2A+TVSoGmOo9kCAwEAAQ==
-----END PUBLIC KEY-----`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateCiphertext() {
  return crypto.publicEncrypt(
    { key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(entitySecret, "hex")
  ).toString("base64");
}

function circleGet(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: "api.circle.com", path, headers: { "Authorization": "Bearer " + apiKey } }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

function circlePost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: "api.circle.com", path, method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => { let r = ""; res.on("data", c => r += c); res.on("end", () => resolve(JSON.parse(r))); });
    req.on("error", reject); req.write(data); req.end();
  });
}

function avGet(params) {
  return new Promise(resolve => {
    const qs = new URLSearchParams({ ...params, apikey: process.env.ALPHA_VANTAGE_KEY }).toString();
    https.get({ hostname: "www.alphavantage.co", path: "/query?" + qs }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    }).on("error", () => resolve({}));
  });
}

function fetchSinglePrice(symbol) {
  return avGet({ function: "GLOBAL_QUOTE", symbol }).then(p => {
    const q = p["Global Quote"] || {};
    const price = parseFloat(q["05. price"] || 0);
    if (!price) return null;
    return { symbol, price, change: q["09. change"] || "0", change_percent: q["10. change percent"] || "0%", previous_close: parseFloat(q["08. previous close"] || 0), volume: q["06. volume"] || "0" };
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
  });
}

function serveFile(res, filename, contentType) {
  try { res.setHeader("Content-Type", contentType); res.end(fs.readFileSync(filename)); }
  catch(e) { res.statusCode = 404; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: "Not found" })); }
}

function json(res, data, status) {
  res.statusCode = status || 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

async function verifyToken(req) {
  const h = req.headers["authorization"];
  if (!h || !h.startsWith("Bearer ")) return null;
  try {
    const result = await supabase.auth.getUser(h.split(" ")[1]);
    return result.error ? null : result.data.user;
  } catch(e) { return null; }
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.statusCode = 200; res.end(); return; }
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!rateLimit(ip, 100, 60000)) { res.statusCode = 429; res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({error:"Too many requests"})); return; }
  const urlObj = new URL(req.url, "http://" + req.headers.host);
  const path = urlObj.pathname;
  console.log(req.method + " " + path);
  handleRequest(path, req, res, urlObj).catch(err => { console.error("Error:", err.message); json(res, { error: err.message }, 500); });
});

async function handleRequest(path, req, res, urlObj) {

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (path === "/api/signup" && req.method === "POST") {
    const body = await readBody(req);
    const { email, password, full_name, username } = body;
    if (!email || !password || !full_name) return json(res, { error: "Email, password and full name required" }, 400);
    if (password.length < 8) return json(res, { error: "Password must be at least 8 characters" }, 400);
    const result = await supabase.auth.admin.createUser({ email, password, user_metadata: { full_name }, email_confirm: true });
    if (result.error) return json(res, { error: result.error.message }, 400);
    const userId = result.data.user.id;
    let walletAddress = null, walletId = null;
    try {
      const wr = await circlePost("/v1/w3s/developer/wallets", { idempotencyKey: crypto.randomUUID(), blockchains: ["ETH-SEPOLIA"], count: 1, walletSetId: WALLET_SET_ID, entitySecretCiphertext: generateCiphertext() });
      walletAddress = wr.data?.wallets?.[0]?.address || null;
      walletId = wr.data?.wallets?.[0]?.id || null;
    } catch(e) { console.error("Wallet error:", e.message); }
    await supabase.from("users").insert({ id: userId, email, full_name, username: username || null, wallet_address: walletAddress, wallet_id: walletId });
    return json(res, { success: true, user: { id: userId, email, full_name, username, wallet_address: walletAddress, wallet_id: walletId } });

  } else if (path === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const { email, password } = body;
    if (!email || !password) return json(res, { error: "Email and password required" }, 400);
    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) return json(res, { error: result.error.message }, 401);
    const ur = await supabase.from("users").select("wallet_address,wallet_id,full_name,username").eq("id", result.data.user.id).single();
    return json(res, { success: true, session: result.data.session, user: { id: result.data.user.id, email: result.data.user.email, full_name: ur.data?.full_name || result.data.user.user_metadata?.full_name, username: ur.data?.username, wallet_address: ur.data?.wallet_address, wallet_id: ur.data?.wallet_id } });

  } else if (path === "/api/auth/google" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: body.redirect_url || "https://trada-phi.vercel.app/portfolio" } });
    if (result.error) return json(res, { error: result.error.message }, 400);
    return json(res, { url: result.data.url });

  } else if (path === "/api/auth/session" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.auth.getUser(body.access_token);
    if (result.error) return json(res, { error: result.error.message }, 401);
    const userId = result.data.user.id;
    const email = result.data.user.email;
    const full_name = result.data.user.user_metadata?.full_name || result.data.user.user_metadata?.name || email;
    let ur = await supabase.from("users").select("*").eq("id", userId).single();
    if (!ur.data) {
      let walletAddress = null, walletId = null;
      try {
        const wr = await circlePost("/v1/w3s/developer/wallets", { idempotencyKey: crypto.randomUUID(), blockchains: ["ETH-SEPOLIA"], count: 1, walletSetId: WALLET_SET_ID, entitySecretCiphertext: generateCiphertext() });
        walletAddress = wr.data?.wallets?.[0]?.address || null;
        walletId = wr.data?.wallets?.[0]?.id || null;
      } catch(e) {}
      await supabase.from("users").insert({ id: userId, email, full_name, wallet_address: walletAddress, wallet_id: walletId });
      return json(res, { user: { id: userId, email, full_name, wallet_address: walletAddress, wallet_id: walletId } });
    }
    return json(res, { user: { id: userId, email, full_name: ur.data.full_name || full_name, username: ur.data.username, wallet_address: ur.data.wallet_address, wallet_id: ur.data.wallet_id } });

  // ── Lookup user ───────────────────────────────────────────────────────────
  } else if (path === "/api/lookup" && req.method === "GET") {
    const q = urlObj.searchParams.get("q");
    if (!q) return json(res, { error: "Query required" }, 400);
    let result;
    if (q.startsWith("0x")) {
      result = await supabase.from("users").select("id,full_name,username,wallet_address").eq("wallet_address", q).single();
    } else {
      result = await supabase.from("users").select("id,full_name,username,wallet_address").eq("username", q.replace("@","")).single();
    }
    if (result.error || !result.data) return json(res, { error: "User not found" }, 404);
    return json(res, { user: { id: result.data.id, full_name: result.data.full_name, username: result.data.username, wallet_address: result.data.wallet_address } });

  // ── Wallet ────────────────────────────────────────────────────────────────
  } else if (path === "/api/balance" && req.method === "GET") {
    const wallet_id = urlObj.searchParams.get("wallet_id") || DEFAULT_WALLET_ID;
    const data = await circleGet("/v1/w3s/wallets/" + wallet_id + "/balances");
    return json(res, data.data);

  } else if (path === "/api/transactions" && req.method === "GET") {
    const wallet_id = urlObj.searchParams.get("wallet_id") || DEFAULT_WALLET_ID;
    const data = await circleGet("/v1/w3s/wallets/" + wallet_id + "/transactions?pageSize=10");
    return json(res, data.data || {});

  } else if (path === "/api/send" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    const result = await circlePost("/v1/w3s/developer/transactions/transfer", { idempotencyKey: crypto.randomUUID(), walletId: body.wallet_id || DEFAULT_WALLET_ID, entitySecretCiphertext: generateCiphertext(), amounts: [body.amount], destinationAddress: body.recipient, tokenId: TOKEN_ID, feeLevel: "MEDIUM" });
    return json(res, result.data || result);

  // ── Invest ────────────────────────────────────────────────────────────────
  } else if (path === "/api/invest" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    const { user_id, wallet_id, company_name, company_icon, amount_usdc, shares, symbol } = body;
    if (!user_id || !amount_usdc) return json(res, { error: "Missing required fields" }, 400);
    if (authUser.id !== user_id) return json(res, { error: "Forbidden" }, 403);
    if (parseFloat(amount_usdc) < 1) return json(res, { error: "Minimum investment is $1" }, 400);
    const transfer = await circlePost("/v1/w3s/developer/transactions/transfer", { idempotencyKey: crypto.randomUUID(), walletId: wallet_id || DEFAULT_WALLET_ID, entitySecretCiphertext: generateCiphertext(), amounts: [amount_usdc.toString()], destinationAddress: "0xc06ff0029c313762060b1d461b3ea9aec1f87d4f", tokenId: TOKEN_ID, feeLevel: "MEDIUM" });
    if (transfer.code && transfer.code !== 200) return json(res, { error: transfer.message || "Transfer failed" }, 400);
    const txId = transfer.data?.id || crypto.randomUUID();
    await supabase.from("investments").insert({ user_id, company_name, company_icon, amount_usdc: parseFloat(amount_usdc), shares: parseFloat(shares), tx_id: txId, status: "confirmed", symbol: symbol || null });
    return json(res, { success: true, tx_id: txId, state: transfer.data?.state || "INITIATED" });

  } else if (path === "/api/invest/save" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    if (authUser.id !== body.user_id) return json(res, { error: "Forbidden" }, 403);
    const result = await supabase.from("investments").insert({ user_id: body.user_id, company_name: body.company_name, company_icon: body.company_icon, amount_usdc: parseFloat(body.amount_usdc), shares: parseFloat(body.shares), tx_id: body.tx_id, status: "confirmed", symbol: body.symbol || null });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  // ── Sell ──────────────────────────────────────────────────────────────────
  } else if (path === "/api/sell" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    const { user_id, investment_id, amount_usdc, wallet_address, shares, symbol } = body;
    if (!user_id || !amount_usdc || !wallet_address) return json(res, { error: "Missing required fields" }, 400);
    if (authUser.id !== user_id) return json(res, { error: "Forbidden" }, 403);
    const invResult = await supabase.from("investments").select("*").eq("id", investment_id).eq("user_id", user_id).single();
    if (invResult.error) return json(res, { error: "Investment not found" }, 404);
    const originalAmount = parseFloat(invResult.data.amount_usdc);
    const sellAmount = parseFloat(amount_usdc);
    const remaining = originalAmount - sellAmount;
    let actualPayout = sellAmount;
    if (symbol && shares) {
      try {
        const cached = priceCache[symbol];
        const price = (cached && (Date.now() - cached.ts) < PRICE_TTL) ? cached.price : (await fetchSinglePrice(symbol))?.price;
        if (price > 0) actualPayout = parseFloat(shares) * price;
      } catch(e) {}
    }
    const transfer = await circlePost("/v1/w3s/developer/transactions/transfer", { idempotencyKey: crypto.randomUUID(), walletId: DEFAULT_WALLET_ID, entitySecretCiphertext: generateCiphertext(), amounts: [actualPayout.toFixed(2)], destinationAddress: wallet_address, tokenId: TOKEN_ID, feeLevel: "MEDIUM" });
    if (transfer.code && transfer.code !== 200) return json(res, { error: transfer.message || "Transfer failed" }, 400);
    const txId = transfer.data?.id || crypto.randomUUID();
    if (remaining <= 0.01) {
      await supabase.from("investments").update({ status: "sold", tx_id: txId }).eq("id", investment_id);
    } else {
      const newShares = parseFloat(invResult.data.shares) * (remaining / originalAmount);
      await supabase.from("investments").update({ amount_usdc: remaining, shares: newShares, tx_id: txId }).eq("id", investment_id);
    }
    return json(res, { success: true, tx_id: txId, payout: actualPayout, remaining });

  // ── Gift/Send Shares ──────────────────────────────────────────────────────
  } else if (path === "/api/gift" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    const { user_id, investment_id, recipient_id, shares_to_gift, company_name, company_icon, symbol } = body;
    if (!user_id || !recipient_id || !shares_to_gift) return json(res, { error: "Missing required fields" }, 400);
    if (authUser.id !== user_id) return json(res, { error: "Forbidden" }, 403);
    if (recipient_id === user_id) return json(res, { error: "You cannot send shares to yourself" }, 400);
    const invResult = await supabase.from("investments").select("*").eq("id", investment_id).eq("user_id", user_id).single();
    if (invResult.error) return json(res, { error: "Investment not found" }, 404);
    const totalShares = parseFloat(invResult.data.shares);
    const giftShares = parseFloat(shares_to_gift);
    if (giftShares <= 0 || giftShares > totalShares) return json(res, { error: "Invalid share amount" }, 400);
    const shareRatio = giftShares / totalShares;
    const giftUsdc = parseFloat(invResult.data.amount_usdc) * shareRatio;
    const remainingShares = totalShares - giftShares;
    const remainingUsdc = parseFloat(invResult.data.amount_usdc) - giftUsdc;
    if (remainingShares <= 0.0001) {
      await supabase.from("investments").update({ status: "gifted" }).eq("id", investment_id);
    } else {
      await supabase.from("investments").update({ shares: remainingShares, amount_usdc: remainingUsdc }).eq("id", investment_id);
    }
    await supabase.from("investments").insert({ user_id: recipient_id, company_name, company_icon, amount_usdc: giftUsdc, shares: giftShares, tx_id: "gift-" + crypto.randomUUID(), status: "confirmed", symbol: symbol || null });
    const recipientResult = await supabase.from("users").select("full_name,username").eq("id", recipient_id).single();
    const recipientName = recipientResult.data?.full_name || recipientResult.data?.username || "recipient";
    return json(res, { success: true, recipient_name: recipientName, shares_gifted: giftShares, usdc_value: giftUsdc });

  // ── Portfolio ─────────────────────────────────────────────────────────────
  } else if (path === "/api/portfolio" && req.method === "GET") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const user_id = urlObj.searchParams.get("user_id");
    if (!user_id || authUser.id !== user_id) return json(res, { error: "Forbidden" }, 403);
    const result = await supabase.from("investments").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (result.error) return json(res, { error: result.error.message }, 500);
    const total = result.data.filter(i => i.status === "confirmed").reduce((sum, inv) => sum + parseFloat(inv.amount_usdc), 0);
    return json(res, { investments: result.data, total_invested: total.toFixed(2) });

  // ── Watchlist ─────────────────────────────────────────────────────────────
  } else if (path === "/api/watchlist" && req.method === "GET") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const user_id = urlObj.searchParams.get("user_id");
    if (!user_id || authUser.id !== user_id) return json(res, { error: "Forbidden" }, 403);
    const result = await supabase.from("watchlist").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { watchlist: result.data });

  } else if (path === "/api/watchlist/add" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    if (authUser.id !== body.user_id) return json(res, { error: "Forbidden" }, 403);
    const result = await supabase.from("watchlist").upsert({ user_id: body.user_id, company_id: body.company_id, company_name: body.company_name, company_icon: body.company_icon, company_sector: body.company_sector }, { onConflict: "user_id,company_id" });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  } else if (path === "/api/watchlist/remove" && req.method === "POST") {
    const authUser = await verifyToken(req);
    if (!authUser) return json(res, { error: "Unauthorized" }, 401);
    const body = await readBody(req);
    if (authUser.id !== body.user_id) return json(res, { error: "Forbidden" }, 403);
    const result = await supabase.from("watchlist").delete().eq("user_id", body.user_id).eq("company_id", body.company_id);
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  // ── Prices ────────────────────────────────────────────────────────────────
  } else if (path === "/api/prices" && req.method === "GET") {
    const symbols = (urlObj.searchParams.get("symbols") || "CRCL,JMIA,PYPL,COIN,HOOD,MSFT,AAPL,TSLA,NVDA,META,GOOGL,AMZN").split(",");
    const now = Date.now();
    const stale = symbols.filter(s => !priceCache[s] || (now - priceCache[s].ts) >= PRICE_TTL);
    for (const symbol of stale.slice(0, 5)) {
      try { const data = await fetchSinglePrice(symbol); if (data) priceCache[symbol] = { ...data, ts: now }; } catch(e) {}
      if (stale.indexOf(symbol) < stale.length - 1) await new Promise(r => setTimeout(r, 300));
    }
    const result = {};
    symbols.forEach(s => { if (priceCache[s]) result[s] = priceCache[s]; });
    return json(res, { prices: result, timestamp: now });

  } else if (path === "/api/price" && req.method === "GET") {
    const symbol = urlObj.searchParams.get("symbol") || "CRCL";
    const now = Date.now();
    if (priceCache[symbol] && (now - priceCache[symbol].ts) < PRICE_TTL) return json(res, priceCache[symbol]);
    const data = await fetchSinglePrice(symbol);
    if (data) { priceCache[symbol] = { ...data, ts: now }; return json(res, data); }
    return json(res, { symbol, price: 0, change: "0", change_percent: "0%" });

  } else if (path === "/api/history" && req.method === "GET") {
    const symbol = urlObj.searchParams.get("symbol") || "CRCL";
    const now = Date.now();
    if (historyCache[symbol] && (now - historyCache[symbol].ts) < HISTORY_TTL) return json(res, { symbol, prices: historyCache[symbol].data, cached: true });
    const parsed = await avGet({ function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" });
    const series = parsed["Time Series (Daily)"] || {};
    const dates = Object.keys(series).sort();
    const prices = { "1D": dates.slice(-2).map(d => parseFloat(series[d]["4. close"])), "1M": dates.slice(-22).map(d => parseFloat(series[d]["4. close"])), "6M": dates.slice(-126).map(d => parseFloat(series[d]["4. close"])), "12M": dates.slice(-252).map(d => parseFloat(series[d]["4. close"])), dates: { "1D": dates.slice(-2), "1M": dates.slice(-22), "6M": dates.slice(-126), "12M": dates.slice(-252) } };
    historyCache[symbol] = { data: prices, ts: now };
    return json(res, { symbol, prices });

  } else if (path === "/api/sentiment" && req.method === "GET") {
    const now = Date.now();
    if (sentimentCache.data && (now - sentimentCache.ts) < SENT_TTL) return json(res, sentimentCache.data);
    return new Promise(resolve => {
      https.get({ hostname: "api.alternative.me", path: "/fng/?limit=1" }, r => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => {
          try { const p = JSON.parse(d); const data = { value: parseInt(p.data[0].value), label: p.data[0].value_classification }; sentimentCache = { data, ts: Date.now() }; resolve(json(res, data)); }
          catch(e) { resolve(json(res, sentimentCache.data || { value: 65, label: "Greed" })); }
        });
      }).on("error", () => resolve(json(res, sentimentCache.data || { value: 65, label: "Greed" })));
    });

  } else if (path === "/api/ipos" && req.method === "GET") {
    const now = Date.now();
    if (ipoCache.data && (now - ipoCache.ts) < IPO_TTL) return json(res, { ipos: ipoCache.data, cached: true });
    return new Promise(resolve => {
      https.get({ hostname: "www.alphavantage.co", path: "/query?function=IPO_CALENDAR&apikey=" + process.env.ALPHA_VANTAGE_KEY }, r => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => {
          const lines = d.trim().split("\n");
          const headers = lines[0].split(",");
          const rows = lines.slice(1).filter(l => l.trim()).map(line => { const vals = line.split(","); const obj = {}; headers.forEach((h, i) => { obj[h.trim()] = vals[i] ? vals[i].trim() : ""; }); return obj; });
          ipoCache = { data: rows, ts: Date.now() };
          resolve(json(res, { ipos: rows }));
        });
      }).on("error", () => resolve(json(res, { ipos: ipoCache.data || [] })));
    });

  } else if (path === "/auth" && req.method === "GET") { serveFile(res, "auth.html", "text/html");
  } else if (path === "/invest" && req.method === "GET") { serveFile(res, "invest.html", "text/html");
  } else if (path === "/portfolio" && req.method === "GET") { serveFile(res, "portfolio.html", "text/html");
  } else if (path === "/" && req.method === "GET") { serveFile(res, "index.html", "text/html");
  } else { json(res, { error: "Not found" }, 404); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Payment server running on port " + PORT));