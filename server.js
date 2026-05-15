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

function generateCiphertext() {
  return crypto.publicEncrypt(
    { key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(entitySecret, "hex")
  ).toString("base64");
}

function circleGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.circle.com",
      path: path,
      headers: { "Authorization": "Bearer " + apiKey }
    };
    https.get(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

function circlePost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.circle.com",
      path: path,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let response = "";
      res.on("data", c => response += c);
      res.on("end", () => resolve(JSON.parse(response)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

function serveFile(res, filename, contentType) {
  try {
    res.setHeader("Content-Type", contentType);
    res.end(fs.readFileSync(filename));
  } catch(e) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "File not found" }));
  }
}

function json(res, data, status) {
  res.statusCode = status || 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const urlObj = new URL(req.url, "http://" + req.headers.host);
  const path = urlObj.pathname;

  console.log(req.method + " " + path);

  handleRequest(path, req, res, urlObj).catch(function(err) {
    console.error("Error:", err.message);
    json(res, { error: err.message }, 500);
  });
});

async function handleRequest(path, req, res, urlObj) {

  // ── Auth ──────────────────────────────────────────────────────────────────

  if (path === "/api/signup" && req.method === "POST") {
    const body = await readBody(req);
    const { email, password, full_name } = body;

    if (!email || !password || !full_name) {
      return json(res, { error: "Email, password and full name are required" }, 400);
    }

    const result = await supabase.auth.admin.createUser({
      email, password,
      user_metadata: { full_name },
      email_confirm: true
    });

    if (result.error) return json(res, { error: result.error.message }, 400);

    const userId = result.data.user.id;

    // Create Circle wallet for user
    let walletAddress = null;
    let walletId = null;
    try {
      const walletResult = await circlePost("/v1/w3s/developer/wallets", {
        idempotencyKey: crypto.randomUUID(),
        blockchains: ["ETH-SEPOLIA"],
        count: 1,
        walletSetId: WALLET_SET_ID,
        entitySecretCiphertext: generateCiphertext()
      });
      walletAddress = walletResult.data?.wallets?.[0]?.address || null;
      walletId = walletResult.data?.wallets?.[0]?.id || null;
      console.log("Created wallet for user:", walletAddress);
    } catch(err) {
      console.error("Wallet creation failed:", err.message);
    }

    // Save user to DB
    await supabase.from("users").insert({
      id: userId,
      email,
      full_name,
      wallet_address: walletAddress,
      wallet_id: walletId
    });

    return json(res, {
      success: true,
      user: { id: userId, email, full_name, wallet_address: walletAddress, wallet_id: walletId }
    });

    } else if (path === "/api/auth/google" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: body.redirect_url || 'https://trada-phi.vercel.app/portfolio'
      }
    });
    if (result.error) return json(res, { error: result.error.message }, 400);
    return json(res, { url: result.data.url });

  } else if (path === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const { email, password } = body;

    if (!email || !password) return json(res, { error: "Email and password required" }, 400);

    const result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error) return json(res, { error: result.error.message }, 401);

    // Get user wallet info from DB
    const userRecord = await supabase.from("users").select("wallet_address, wallet_id, full_name").eq("id", result.data.user.id).single();

    return json(res, {
      success: true,
      session: result.data.session,
      user: {
        id: result.data.user.id,
        email: result.data.user.email,
        full_name: userRecord.data?.full_name || result.data.user.user_metadata?.full_name,
        wallet_address: userRecord.data?.wallet_address,
        wallet_id: userRecord.data?.wallet_id
      }
    });

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
    const body = await readBody(req);
    const wallet_id = body.wallet_id || DEFAULT_WALLET_ID;

    const result = await circlePost("/v1/w3s/developer/transactions/transfer", {
      idempotencyKey: crypto.randomUUID(),
      walletId: wallet_id,
      entitySecretCiphertext: generateCiphertext(),
      amounts: [body.amount],
      destinationAddress: body.recipient,
      tokenId: TOKEN_ID,
      feeLevel: "MEDIUM"
    });
    return json(res, result.data || result);

  // ── Invest ────────────────────────────────────────────────────────────────

  } else if (path === "/api/invest" && req.method === "POST") {
    const body = await readBody(req);
    const { user_id, wallet_id, company_name, company_icon, amount_usdc, shares, sector } = body;

    if (!user_id || !amount_usdc) return json(res, { error: "Missing required fields" }, 400);

    const sourceWalletId = wallet_id || DEFAULT_WALLET_ID;

    // Transfer USDC via Circle API to master wallet
    const transfer = await circlePost("/v1/w3s/developer/transactions/transfer", {
      idempotencyKey: crypto.randomUUID(),
      walletId: sourceWalletId,
      entitySecretCiphertext: generateCiphertext(),
      amounts: [amount_usdc.toString()],
      destinationAddress: "0xc06ff0029c313762060b1d461b3ea9aec1f87d4f",
      tokenId: TOKEN_ID,
      feeLevel: "MEDIUM"
    });

    if (transfer.code && transfer.code !== 200) {
      return json(res, { error: transfer.message || "Transfer failed" }, 400);
    }

    const txId = transfer.data?.id || crypto.randomUUID();

    // Save investment to DB
    await supabase.from("investments").insert({
      user_id,
      company_name,
      company_icon,
      amount_usdc: parseFloat(amount_usdc),
      shares: parseFloat(shares),
      tx_id: txId,
      status: "confirmed"
    });

    return json(res, {
      success: true,
      tx_id: txId,
      state: transfer.data?.state || "INITIATED"
    });

  } else if (path === "/api/invest/save" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.from("investments").insert({
      user_id: body.user_id,
      company_name: body.company_name,
      company_icon: body.company_icon,
      amount_usdc: parseFloat(body.amount_usdc),
      shares: parseFloat(body.shares),
      tx_id: body.tx_id,
      status: "confirmed"
    });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  // ── Portfolio ─────────────────────────────────────────────────────────────

  } else if (path === "/api/portfolio" && req.method === "GET") {
    const user_id = urlObj.searchParams.get("user_id");
    if (!user_id) return json(res, { error: "user_id required" }, 400);
    const result = await supabase.from("investments").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (result.error) return json(res, { error: result.error.message }, 500);
    const total = result.data.reduce((sum, inv) => sum + parseFloat(inv.amount_usdc), 0);
    return json(res, { investments: result.data, total_invested: total.toFixed(2) });

  // ── Watchlist ─────────────────────────────────────────────────────────────

  } else if (path === "/api/watchlist" && req.method === "GET") {
    const user_id = urlObj.searchParams.get("user_id");
    if (!user_id) return json(res, { error: "user_id required" }, 400);
    const result = await supabase.from("watchlist").select("*").eq("user_id", user_id).order("created_at", { ascending: false });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { watchlist: result.data });

  } else if (path === "/api/watchlist/add" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.from("watchlist").upsert({
      user_id: body.user_id,
      company_id: body.company_id,
      company_name: body.company_name,
      company_icon: body.company_icon,
      company_sector: body.company_sector
    }, { onConflict: "user_id,company_id" });
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  } else if (path === "/api/watchlist/remove" && req.method === "POST") {
    const body = await readBody(req);
    const result = await supabase.from("watchlist").delete().eq("user_id", body.user_id).eq("company_id", body.company_id);
    if (result.error) return json(res, { error: result.error.message }, 500);
    return json(res, { success: true });

  // ── IPOs ──────────────────────────────────────────────────────────────────

  } else if (path === "/api/ipos" && req.method === "GET") {
    return new Promise((resolve) => {
      https.get("https://www.alphavantage.co/query?function=IPO_CALENDAR&apikey=" + process.env.ALPHA_VANTAGE_KEY, (r) => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => {
          const lines = d.trim().split("\n");
          const headers = lines[0].split(",");
          const rows = lines.slice(1).filter(line => line.trim()).map(line => {
            const values = line.split(",");
            const obj = {};
            headers.forEach((h, i) => { obj[h.trim()] = values[i] ? values[i].trim() : ""; });
            return obj;
          });
          resolve(json(res, { ipos: rows }));
        });
      }).on("error", () => resolve(json(res, { ipos: [] })));
    });

  // ── Static files ──────────────────────────────────────────────────────────

  } else if (path === "/auth" && req.method === "GET") {
    serveFile(res, "auth.html", "text/html");
  } else if (path === "/invest" && req.method === "GET") {
    serveFile(res, "invest.html", "text/html");
  } else if (path === "/portfolio" && req.method === "GET") {
    serveFile(res, "portfolio.html", "text/html");
  } else if (path === "/" && req.method === "GET") {
    serveFile(res, "index.html", "text/html");
  } else {
    json(res, { error: "Not found" }, 404);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log("Payment server running on port " + PORT);
});
