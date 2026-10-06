import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { calculateSpotPrice } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const token0Cache = new Map(); // poolAddress.toLowerCase() -> boolean isToken0WSDA

export async function scanMarket(customProvider = null) {
  const rawConfig = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));
  const { network, tokens } = rawConfig;

  const rpcUrl = process.env.RPC_URL || network.rpc || "https://rpc.sidrachain.com";
  const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: network.chainId || 97453 });
  const provider = customProvider || new ethers.JsonRpcProvider(rpcUrl, sidraNetwork, { staticNetwork: sidraNetwork });

  const wsdaAddr = (network.wsda || "0xE4095a910209D7BE03B55D02F40d4554B1666182").toLowerCase();

  // Flatten all pools to scan
  const poolTasks = [];
  for (const token of tokens) {
    if (!token.pools) continue;
    for (const [tierStr, poolAddress] of Object.entries(token.pools)) {
      if (!poolAddress || poolAddress === ethers.ZeroAddress) continue;
      poolTasks.push({
        tokenSymbol: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals || 18,
        taxBps: token.taxBps || 0,
        feeTier: Number(tierStr),
        poolAddress
      });
    }
  }

  // Scan in parallel batches of 12
  const CHUNK_SIZE = 12;
  const poolResults = new Map();

  for (let i = 0; i < poolTasks.length; i += CHUNK_SIZE) {
    const chunk = poolTasks.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (task) => {
        try {
          const poolContract = new ethers.Contract(task.poolAddress, POOL_ABI, provider);

          // Resolve isToken0WSDA from cache or on-chain
          const poolKey = task.poolAddress.toLowerCase();
          let isToken0WSDA = token0Cache.get(poolKey);

          if (isToken0WSDA === undefined) {
            try {
              const t0 = await poolContract.token0();
              isToken0WSDA = t0.toLowerCase() === wsdaAddr;
            } catch {
              // Fallback to lexicographic address comparison
              isToken0WSDA = wsdaAddr < task.tokenAddress.toLowerCase();
            }
            token0Cache.set(poolKey, isToken0WSDA);
          }

          const [slot0, liquidity] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity()
          ]);

          const sqrtPriceX96 = slot0[0];
          const liq = BigInt(liquidity);
          const spotPriceSda = calculateSpotPrice(sqrtPriceX96, isToken0WSDA, task.decimals);
          const isHealthy = liq > 0n && spotPriceSda > 0;

          poolResults.set(poolKey, {
            feeTier: task.feeTier,
            poolAddress: task.poolAddress,
            sqrtPriceX96: sqrtPriceX96.toString(),
            liquidity: liq,
            isToken0WSDA,
            spotPriceSda,
            isHealthy
          });
        } catch (err) {
          // If a pool has zero liquidity or reverts, mark inactive
          poolResults.set(task.poolAddress.toLowerCase(), {
            feeTier: task.feeTier,
            poolAddress: task.poolAddress,
            sqrtPriceX96: "0",
            liquidity: 0n,
            isToken0WSDA: false,
            spotPriceSda: 0,
            isHealthy: false
          });
        }
      })
    );
  }

  // Assemble token market overview
  const market = [];
  for (const token of tokens) {
    const tokenPools = [];
    if (token.pools) {
      for (const [tierStr, poolAddress] of Object.entries(token.pools)) {
        const res = poolResults.get(poolAddress.toLowerCase());
        if (res) {
          tokenPools.push(res);
        }
      }
    }

    market.push({
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      decimals: token.decimals || 18,
      taxBps: token.taxBps || 0,
      pools: tokenPools
    });
  }

  return market;
}
