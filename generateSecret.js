const { generateEntitySecret } = require("@circle-fin/developer-controlled-wallets");

const secret = generateEntitySecret();
console.log("Your entity secret:", secret);