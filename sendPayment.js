const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;

const publicKey = '-----BEGIN PUBLIC KEY-----\n' +
    'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtC4XwUTcAAEj+3vHXNl+\n' +
    'VCKS4F0XCfC6xlsahuqEXgAwzzQvS5ocm7Lvm5YmzM9enBaP4Po6KZbF7SDtzVB3\n' +
    'yYKigEXH3f3Af/oVRrpzfkMrp7pup/Iub6Bohmi/7Ehm3aW07VztDtBAkmXgug+a\n' +
    '6ZOeQuJkxTYjtm/cxOwX2a1ZcvOP1qhQfS3u92cly92lWgd8quB+jZbba/udE5wt\n' +
    'DqT74q1EOYUyzJzbeJWsfbVE93h4CDPjyZiXj2pTwPhUBlMA801p1M8mW4+taj3f\n' +
    'UH456bRGCjURCIEwxyCUY8Xubssr5kJaWTDhDU+8Wy8e46qoxY+/nu7pVrrS9tfx\n' +
    '8d17X6deXKirGKm6bohb+VOAncWnj3x0Otjia7J/5TXKmMlqZrzGVySs/lLYBWUA\n' +
    '2lNfHqgdnH6R5WBd/KbgVMEMnCPgdASJIfQ9GITIIBo4o9UGr+CmRJlYmejZrgka\n' +
    'IqpAYDsAOdluQVPnFtIUk1hMl7Ed5PvihVr9VUhms5+IGdxsKiovk8L1gLcBXV3u\n' +
    'z+RYVllcIIgDftD/mS2MsH74q7TBAx1eu5dvhG5nBL4Q6GC8rgJ/OQDUzjQOMuRW\n' +
    '1AX0urxFw3XU8htZTzOYj1VOUFKllt94VW2DhISrJScZc0OXLp1Nho43w1WrJjyx\n' +
    'ngR8ws0d+l2A+TVSoGmOo9kCAwEAAQ==\n' +
    '-----END PUBLIC KEY-----';

function generateCiphertext() {
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(entitySecret, "hex")
  ).toString("base64");
}

function circleRequest(path, body) {
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
      res.on("data", (chunk) => response += chunk);
      res.on("end", () => resolve(JSON.parse(response)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendPayment() {
  const ciphertext = generateCiphertext();
  console.log("Sending 1 USDC...");

  const result = await circleRequest("/v1/w3s/developer/transactions/transfer", {
    idempotencyKey: crypto.randomUUID(),
    walletId: "63550111-2a20-5951-a107-053789cbdbfd",
    entitySecretCiphertext: ciphertext,
    amounts: ["1"],
    destinationAddress: "0x1901CCeAE792B8318EDFf4eF1689899919bC8c85",
    tokenId: "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
    feeLevel: "MEDIUM"
  });

  console.log(JSON.stringify(result, null, 2));
}

sendPayment();
