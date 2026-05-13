const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;
const WALLET_ID = "63550111-2a20-5951-a107-053789cbdbfd";
const TOKEN_ID = "5797fbd6-3795-519d-84ca-ec4c5f80c3b1";

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

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/api/balance" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    const data = await circleGet(`/v1/w3s/wallets/${WALLET_ID}/balances`);
    res.end(JSON.stringify(data.data));

  } else if (req.url === "/api/transactions" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    const data = await circleGet(`/v1/w3s/wallets/${WALLET_ID}/transactions?pageSize=10`);
    res.end(JSON.stringify(data.data || {}));

  } else if (req.url === "/api/send" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      const { amount, recipient } = JSON.parse(body);
      const result = await circlePost("/v1/w3s/developer/transactions/transfer", {
        idempotencyKey: crypto.randomUUID(),
        walletId: WALLET_ID,
        entitySecretCiphertext: generateCiphertext(),
        amounts: [amount],
        destinationAddress: recipient,
        tokenId: TOKEN_ID,
        feeLevel: "MEDIUM"
      });
      res.end(JSON.stringify(result.data || result));
    });

  } else if (req.url === "/circle-logo.png" && req.method === "GET") {
    try {
      res.setHeader("Content-Type", "image/png");
      res.end(fs.readFileSync("circle-logo.png"));
    } catch {
      res.statusCode = 404;
      res.end();
    }

  } else if (req.url === "/" && req.method === "GET") {
    res.setHeader("Content-Type", "text/html");
    res.end(fs.readFileSync("index.html"));

  } else {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(3000, () => console.log("Payment server running at http://localhost:3000"));