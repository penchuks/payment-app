const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
if (process.env.NODE_ENV !== 'production') {
  require("dotenv").config();
}

const { createClient } = require("@supabase/supabase-js");

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;
const WALLET_ID = "63550111-2a20-5951-a107-053789cbdbfd";
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateCiphertext() {
  return crypto.publicEncrypt(
    { key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(entitySecret, "hex")
  ).toString("base64");
}

function circleGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.circle.com", path,
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
      hostname: "api.circle.com", path, method: "POST",
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
  } catch {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "File not found" }));
  }
}

function json(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {

    // ── Auth routes ────────────────────────────────────────────────────────

    if (path === "/api/signup" && req.method === "POST") {
      const { email, password, full_name } = await readBody(req);

      if (!email || !password || !full_name) {
        return json(res, { error: "Email, password and full name are required" }, 400);
      }
      if (password.length < 8) {
        return json(res, { error: "Password must be at least 8 characters" }, 400);
      }

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        user_metadata: { full_name },
        email_confirm: true
      });

      if (error) return json(res, { error: error.message }, 400);

      await supabase.from("users").insert({
        id: data.user.id,
        email,
        full_name
      });

      return json(res, { success: true, user: { id: data.user.id, email, full_name } });

    } else if (path === "/api/login" && req.method === "POST") {
      const { email, password } = await readBody(req);

      if (!email || !password) {
        return json(res, { error: "Email and password are required" }, 400);
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) return json(res, { error: error.message }, 401);

      return json(res, {
        success: true,
        session: data.session,
        user: {
          id: data.user.id,
          email: data.user.email,
          full_name: data.user.user_metadata?.full_name
        }
      });

    } else if (path === "/api/logout" && req.method === "POST") {
      const { token } = await readBody(req);
      await supabase.auth.admin.signOut(token);
      return json(res, { success: true });

    // ── Portfolio routes ───────────────────────────────────────────────────

    } else if (path === "/api/portfolio" && req.method === "GET") {
      const user_id = url.searchParams.get("user_id");
      if (!user_id) return json(res, { error: "user_id required" }, 400);

      const { data, error } = await supabase
        .from("investments")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", { ascending: false });

      if (error) return json(res, { error: error.message }, 500);

      const total = data.reduce((sum, inv) => sum + parseFloat(inv.amount_usdc), 0);
      return json(res, { investments: data, total_invested: total.toFixed(2) });

    } else if (path === "/api/invest/save" && req.method === "POST") {
      const { user_id, company_name, company_icon, amount_usdc, shares, tx_id } = await readBody(req);

      if (!user_id || !company_name || !amount_usdc) {
        return json(res, { error: "Missing required fields" }, 400);
      }

      const { error } = await supabase.from("investments").insert({
        user_id, company_name, company_icon,
        amount_usdc: parseFloat(amount_usdc),
        shares: parseFloat(shares),
        tx_id,
        status: "confirmed"
      });

      if (error) return json(res, { error: error.message }, 500);
      return json(res, { success: true });

    // ── Circle / Wallet routes ─────────────────────────────────────────────

    } else if (path === "/api/balance" && req.method === "GET") {
      const data = await circleGet(`/v1/w3s/wallets/${WALLET_ID}/balances`);
      return json(res, data.data);

    } else if (path === "/api/transactions" && req.method === "GET") {
      const data = await circleGet(`/v1/w3s/wallets/${WALLET_ID}/transactions?pageSize=10`);
      return json(res, data.data || {});

    } else if (path === "/api/send" && req.method === "POST") {
      const { amount, recipient } = await readBody(req);

      if (!amount || !recipient) {
        return json(res, { error: "Amount and recipient are required" }, 400);
      }

      const result = await circlePost("/v1/w3s/developer/transactions/transfer", {
        idempotencyKey: crypto.randomUUID(),
        walletId: WALLET_ID,
        entitySecretCiphertext: generateCiphertext(),
        amounts: [amount],
        destinationAddress: recipient,
        tokenId: TOKEN_ID,
        feeLevel: "MEDIUM"
      });

      return json(res, result.data || result);

    // ── Static files ───────────────────────────────────────────────────────

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

  } catch (err) {
    console.error("Server error:", err);
    json(res, { error: "Internal server error" }, 500);
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Payment server running on port ${process.env.PORT || 3000}`);
});