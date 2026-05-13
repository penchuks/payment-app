const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");
require("dotenv").config();

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.ENTITY_SECRET
});

async function createWallet() {
  // First create a wallet set
  const walletSet = await client.createWalletSet({
    name: "My First Wallet Set"
  });
  
  console.log("Wallet set created:", walletSet.data);

  // Then create a wallet inside it
  const wallet = await client.createWallets({
    blockchains: ["ETH-SEPOLIA"], // testnet for now
    count: 1,
    walletSetId: walletSet.data.walletSet.id
  });

  console.log("Wallet created:", wallet.data);
}

createWallet();
