const crypto = require("crypto");
require("dotenv").config();

const entitySecret = process.env.ENTITY_SECRET;

const publicKey = `-----BEGIN PUBLIC KEY-----
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
    '
-----END PUBLIC KEY-----`;

const ciphertext = crypto.publicEncrypt(
  {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  },
  Buffer.from(entitySecret, "hex")
);

console.log("Ciphertext:", ciphertext.toString("base64"));
