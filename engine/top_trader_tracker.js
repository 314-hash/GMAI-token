import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");

// Default Top Traders / Whales on Sidra Chain DEX & Pinetswap
export const DEFAULT_TOP_TRADERS = [
  "0x343bb634cc5eaf5086134928e44215018100d521",
  "0xa577c93dfa57e9c5cf782993b875c1e9329333b9",
  "0x55534033242cda55fbb716f75b227b8ecba16062",
  "0xfd4078ccc44a02a39f7dffd1a58789aec358d81c",
  "0x1563E0aFe339F2e612eB5760438cf38A31f9076C",
  "0xA231c5304671C618b76c6c592D66C4C3455246Fe",
  "0x973aC158095d3F37ff7511ea6E3845946a4d1f27",
  "0x32aC73F0a558597DEBFA0F5C7Cae59B2bA41793D",
  "0x4b711e0D7DEa94483a9d997fE76f0d11E81f8B46",
  "0xd3149edb82405c88a57b35d555c14eb5916bdf07",
  "0x1c3a5dcc54f31901796484bd1403cae63a8067ee",
  "0x328648e1fc7004230adc3a3e0aa3fe165c4bd4a4",
  "0x9b6ce7e4ecaf624b4e5fc6fd91c4f86771354573"
];

// Router address and swap topic
const ROUTER_ADDR = (process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb").toLowerCase();
const WSDA_ADDR = (process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182").toLowerCase();

// Swap event signature: Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");

// Cache of seen transactions and known tokens
const seenTxHashes = new Set();
let lastScannedBlock = 0;

/**
 * Returns the list of tracked top trader addresses.
 * Can be configured via process.env.TOP_TRADERS (comma-separated).
 */
export function getTopTradersList() {
  if (process.env.TOP_TRADERS) {
    return process.env.TOP_TRADERS.split(",")
      .map((addr) => addr.trim())
      .filter((addr) => ethers.isAddress(addr));
  }
  return DEFAULT_TOP_TRADERS;
}

/**
 * Fetches recent activity for top traders across the network.
 */
export async function fetchTopTraderActivity(provider, traders = null) {
  const tracked = traders || getTopTradersList();
  const trackedLower = new Set(tracked.map((t) => t.toLowerCase()));
  const activities = [];

  if (!provider) return activities;

  try {
    const currentBlock = await provider.getBlockNumber();
    if (lastScannedBlock === 0) {
      lastScannedBlock = Math.max(0, currentBlock - 15);
    }

    const fromBlock = Math.max(lastScannedBlock, currentBlock - 20);
    const toBlock = currentBlock;
    lastScannedBlock = currentBlock;

    if (fromBlock > toBlock) return activities;

    // Check recent blocks for transactions from or to top traders
    const filter = {
      fromBlock,
      toBlock,
      topics: [SWAP_TOPIC]
    };

    let logs = [];
    try {
      logs = await provider.getLogs(filter);
    } catch {
      // Fallback if log range is limited
      logs = [];
    }

    for (const log of logs) {
      const isNew = !seenTxHashes.has(log.transactionHash);
      if (isNew) seenTxHashes.add(log.transactionHash);

      try {
        const tx = await provider.getTransaction(log.transactionHash);
        if (!tx) continue;

        const senderLower = (tx.from || "").toLowerCase();
        if (trackedLower.has(senderLower)) {
          activities.push({
            trader: tx.from,
            action: "SWAP",
            poolAddress: log.address,
            tokenAddress: log.address, // pool proxy reference
            feeTier: 3000,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            isNew
          });
        }
      } catch {
        // Non-blocking log processing
      }
    }
  } catch (err) {
    // Non-blocking
  }

  return activities;
}

/**
 * Enriches market tokens dynamically from top trader radar signals.
 */
export async function enrichMarketWithTopTraders(marketTokens = [], provider = null) {
  const activities = await fetchTopTraderActivity(provider);
  const newTokensDiscovered = [];

  // Read existing configured tokens to avoid duplicates
  let existingAddresses = new Set();
  try {
    const rawConfig = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));
    if (rawConfig.tokens) {
      for (const t of rawConfig.tokens) {
        if (t.address) existingAddresses.add(t.address.toLowerCase());
      }
    }
  } catch {
    // Non-blocking
  }

  for (const act of activities) {
    if (act.tokenAddress && !existingAddresses.has(act.tokenAddress.toLowerCase())) {
      // Potential new token discovered from top trader activity
      try {
        const erc20 = new ethers.Contract(act.tokenAddress, [
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
          "function name() view returns (string)"
        ], provider);

        const [symbol, decimals, name] = await Promise.all([
          erc20.symbol().catch(() => "UNKNOWN"),
          erc20.decimals().catch(() => 18),
          erc20.name().catch(() => "Unknown Token")
        ]);

        const discoveredToken = {
          symbol,
          name,
          address: act.tokenAddress,
          decimals: Number(decimals),
          taxBps: 0,
          pools: {
            "3000": act.poolAddress
          }
        };

        existingAddresses.add(act.tokenAddress.toLowerCase());
        newTokensDiscovered.push(discoveredToken);
        marketTokens.push(discoveredToken);
      } catch {
        // Not a standard ERC20 or unreadable
      }
    }
  }

  return {
    activities,
    newTokensDiscovered
  };
}
