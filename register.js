const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
require("dotenv").config();

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.ENTITY_SECRET
});

async function register() {
  const response = await client.getPublicKey();
  console.log("Registered successfully:", response.data);
}

register();
