const https = require("https");
require("dotenv").config();

const apiKey = process.env.CIRCLE_API_KEY;
const walletId = "63550111-2a20-5951-a107-053789cbdbfd";

const options = {
  hostname: "api.circle.com",
  path: `/v1/w3s/wallets/${walletId}/balances`,
  headers: {
    "Authorization": "Bearer " + apiKey
  }
};

https.get(options, (res) => {
  let data = "";
  res.on("data", (chunk) => data += chunk);
  res.on("end", () => console.log(JSON.stringify(JSON.parse(data), null, 2)));
});
