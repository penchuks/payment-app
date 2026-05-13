require('dotenv').config()
const { ethers } = require('ethers')
const axios = require('axios')

const BASCO_ADDRESS = process.env.BASCO_ADDRESS
const PRIVATE_KEY = process.env.PRIVATE_KEY
const MORALIS_API_KEY = process.env.MORALIS_API_KEY
const RPC_URL = process.env.RPC_URL

// Top Base meme tokens on Mainnet
const MEME_TOKENS = {
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  BRETT: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  TOSHI: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B3',
}

const BASCO_ABI = [
  'function batchAirdrop(address[] calldata recipients, uint256[] calldata amounts) external',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]

async function getTopHolders(tokenAddress, tokenName) {
  console.log(`\n📊 Fetching top holders of ${tokenName}...`)
  try {
    const url = `https://deep-index.moralis.io/api/v2.2/erc20/${tokenAddress}/owners?chain=base&order=DESC&limit=50`
    const res = await axios.get(url, {
      headers: { 'X-API-Key': MORALIS_API_KEY }
    })
    if (res.data.result && res.data.result.length > 0) {
      console.log(`✅ Found ${res.data.result.length} holders of ${tokenName}`)
      return res.data.result.map(h => h.owner_address.toLowerCase())
    } else {
      console.log(`⚠️ No holders found for ${tokenName}`)
      return []
    }
  } catch (err) {
    console.error(`❌ Error fetching ${tokenName} holders:`, err.response?.data || err.message)
    return []
  }
}

async function main() {
  console.log('🚀 BASCO Airdrop Agent Starting...')
  console.log('=====================================')

  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  const basco = new ethers.Contract(BASCO_ADDRESS, BASCO_ABI, wallet)

  const totalSupply = await basco.totalSupply()
  const ownerBalance = await basco.balanceOf(wallet.address)
  console.log(`\n💰 Total Supply: ${ethers.formatEther(totalSupply)} BASCO`)
  console.log(`👛 Your Balance: ${ethers.formatEther(ownerBalance)} BASCO`)

  const allHolders = new Set()
  for (const [name, address] of Object.entries(MEME_TOKENS)) {
    const holders = await getTopHolders(address, name)
    holders.forEach(h => allHolders.add(h))
  }

  allHolders.delete(wallet.address.toLowerCase())

  const uniqueHolders = [...allHolders]
  console.log(`\n📋 Total unique holders to airdrop: ${uniqueHolders.length}`)

  if (uniqueHolders.length === 0) {
    console.log('❌ No holders found. Exiting.')
    return
  }

  const airdropTotal = totalSupply * 50n / 100n
  const amountPerHolder = airdropTotal / BigInt(uniqueHolders.length)

  console.log(`\n🪂 Airdrop Details:`)
  console.log(`   Total to airdrop: ${ethers.formatEther(airdropTotal)} BASCO (50%)`)
  console.log(`   Per holder: ${ethers.formatEther(amountPerHolder)} BASCO`)
  console.log(`   Recipients: ${uniqueHolders.length} addresses`)

  const BATCH_SIZE = 50
  let totalAirdropped = 0

  for (let i = 0; i < uniqueHolders.length; i += BATCH_SIZE) {
    const batch = uniqueHolders.slice(i, i + BATCH_SIZE)
    const amounts = batch.map(() => amountPerHolder)

    console.log(`\n📦 Sending batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(uniqueHolders.length/BATCH_SIZE)}...`)
    console.log(`   Addresses: ${batch.length}`)

    try {
      const tx = await basco.batchAirdrop(batch, amounts)
      console.log(`   TX Hash: ${tx.hash}`)
      await tx.wait()
      console.log(`   ✅ Batch confirmed!`)
      totalAirdropped += batch.length
    } catch (err) {
      console.error(`   ❌ Batch failed:`, err.message)
    }
  }

  console.log(`\n🎉 Airdrop Complete!`)
  console.log(`   Total recipients: ${totalAirdropped}`)
  console.log(`   View on Basescan: https://sepolia.basescan.org/address/${BASCO_ADDRESS}`)
}

main().catch(console.error)