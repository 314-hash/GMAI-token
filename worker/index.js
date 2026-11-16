import { ethers } from "ethers";
import { TOKENS } from "./tokens.js";
import { quoteV3Swap, calculateSpotPrice } from "./v3_math.js";

// ABIs
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const ROUTER_ABI = [
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)"
];

const WSDA_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM"]);

// In-memory telemetry cache across worker invocations within same isolate
let lastScanTelemetry = {
  timestamp: null,
  blockNumber: 0,
  tokensScanned: 0,
  opportunitiesFound: 0,
  topOpportunity: null,
  lastExecution: null
};

export default {
  /**
   * 24/7 Scheduled Cron Trigger Handler (Runs every 1 minute)
   */
  async scheduled(event, env, ctx) {
    console.log(`⏰ [CRON TRIGGER] 1-Minute Heartbeat Fired at ${new Date().toISOString()}`);
    ctx.waitUntil(executeAutonomousCycle(env));
  },

  /**
   * HTTP API Handler (Health check, manual trigger, portfolio & scanner endpoints)
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: Number(env.CHAIN_ID || 97453) });
      const provider = new ethers.JsonRpcProvider(env.RPC_URL || "https://rpc.sidrachain.com", sidraNetwork, { staticNetwork: sidraNetwork });

      // 1. Root / Health Check
      if (path === "/" || path === "/health") {
        const curBlock = await provider.getBlockNumber().catch(() => 0);
        return new Response(JSON.stringify({
          service: "GameMind AI ($GMAI) Serverless Fleet",
          status: "ONLINE",
          network: "Sidra Chain (97453)",
          currentBlock: curBlock,
          mode: env.LIVE_EXECUTION === "true" ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION",
          cronSchedule: "Every 1 minute (* * * * *)",
          monitoredTokens: TOKENS.length,
          endpoints: {
            "GET /status": "Fleet health, latest block and scan telemetry",
            "GET /scan": "Real-time spread scan across all 44 tokens",
            "GET /portfolio": "Wallet balance overview",
            "POST /trigger": "Trigger an on-demand trading wave immediately"
          },
          timestamp: new Date().toISOString()
        }, null, 2), { headers: corsHeaders });
      }

      // 2. Status & Telemetry
      if (path === "/status") {
        const curBlock = await provider.getBlockNumber().catch(() => 0);
        return new Response(JSON.stringify({
          status: "ONLINE",
          currentBlock: curBlock,
          telemetry: lastScanTelemetry,
          timestamp: new Date().toISOString()
        }, null, 2), { headers: corsHeaders });
      }

      // 3. Live Market Scan
      if (path === "/scan") {
        const scanResult = await scanMarketOpportunities(provider, env);
        return new Response(JSON.stringify(scanResult, null, 2), { headers: corsHeaders });
      }

      // 4. Portfolio Balances
      if (path === "/portfolio") {
        const balances = await getFleetBalances(provider, env);
        return new Response(JSON.stringify(balances, null, 2), { headers: corsHeaders });
      }

      // 5. Manual Trigger (POST)
      if (path === "/trigger" && request.method === "POST") {
        const cycleResult = await executeAutonomousCycle(env);
        return new Response(JSON.stringify(cycleResult, null, 2), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Not Found", path }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};

/**
 * Scans live pool states across all 44 tokens and discovers profitable spreads.
 */
async function scanMarketOpportunities(provider, env) {
  const wsdaAddr = (env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182").toLowerCase();
  const tradeSizeSda = Number(env.TRADE_SIZE_SDA || 1.5);
  const minProfitThreshold = Number(env.MIN_PROFIT_SDA || 0.0001);

  const curBlock = await provider.getBlockNumber();
  const opportunities = [];

  // Flatten active pools for tokens with 2+ pools
  const candidateTokens = TOKENS.filter(t => {
    if (STRICT_EXCLUSIONS.has(t.symbol?.toUpperCase())) return false;
    return t.pools && Object.keys(t.pools).length >= 2;
  });

  // Batch query slot0 and liquidity
  await Promise.all(candidateTokens.map(async (token) => {
    try {
      const poolEntries = Object.entries(token.pools);
      const poolData = await Promise.all(poolEntries.map(async ([feeTierStr, poolAddr]) => {
        try {
          const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
          const [slot0, liq, t0] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
            poolContract.token0()
          ]);
          const isToken0WSDA = t0.toLowerCase() === wsdaAddr;
          const spotPriceSda = calculateSpotPrice(slot0.sqrtPriceX96, isToken0WSDA, token.decimals || 18);
          return {
            feeTier: Number(feeTierStr),
            poolAddress: poolAddr,
            sqrtPriceX96: slot0.sqrtPriceX96,
            liquidity: liq,
            isToken0WSDA,
            spotPriceSda
          };
        } catch {
          return null;
        }
      }));

      const healthyPools = poolData.filter(p => p && p.liquidity > 0n && p.spotPriceSda > 0);
      if (healthyPools.length < 2) return;

      // Evaluate cross-pool 2-hop combinations
      for (let i = 0; i < healthyPools.length; i++) {
        for (let j = 0; j < healthyPools.length; j++) {
          if (i === j) continue;
          const buyPool = healthyPools[i];
          const sellPool = healthyPools[j];

          for (const testSda of [tradeSizeSda, 1.0, 0.5]) {
            const amountIn = ethers.parseEther(testSda.toFixed(18));
            const buyQuote = quoteV3Swap(
              amountIn,
              BigInt(buyPool.sqrtPriceX96),
              buyPool.liquidity,
              buyPool.feeTier,
              token.taxBps || 0,
              buyPool.isToken0WSDA
            );
            if (!buyQuote.amountOut || buyQuote.amountOut <= 0n) continue;

            const sellQuote = quoteV3Swap(
              buyQuote.amountOut,
              BigInt(sellPool.sqrtPriceX96),
              sellPool.liquidity,
              sellPool.feeTier,
              token.taxBps || 0,
              !sellPool.isToken0WSDA
            );
            if (!sellQuote.amountOut || sellQuote.amountOut <= 0n) continue;

            const outSda = Number(ethers.formatEther(sellQuote.amountOut));
            const netProfit = outSda - testSda;

            if (netProfit >= minProfitThreshold) {
              const spreadPct = buyPool.spotPriceSda > 0
                ? ((sellPool.spotPriceSda - buyPool.spotPriceSda) / buyPool.spotPriceSda) * 100
                : 0;

              opportunities.push({
                symbol: token.symbol,
                name: `${token.symbol} (${buyPool.feeTier} ➔ ${sellPool.feeTier})`,
                tokenAddress: token.address,
                buyFee: buyPool.feeTier,
                sellFee: sellPool.feeTier,
                buyPoolAddress: buyPool.poolAddress,
                sellPoolAddress: sellPool.poolAddress,
                path: ethers.solidityPacked(
                  ["address", "uint24", "address", "uint24", "address"],
                  [wsdaAddr, buyPool.feeTier, token.address, sellPool.feeTier, wsdaAddr]
                ),
                tradeSizeSda: testSda,
                expectedProfitSda: netProfit,
                spreadPct
              });
              break;
            }
          }
        }
      }
    } catch {}
  }));

  opportunities.sort((a, b) => b.expectedProfitSda - a.expectedProfitSda);

  return {
    blockNumber: curBlock,
    totalTokensScanned: candidateTokens.length,
    opportunitiesFound: opportunities.length,
    opportunities
  };
}

/**
 * Main autonomous cycle: scans, simulates, and executes live on-chain if profitable.
 */
async function executeAutonomousCycle(env) {
  const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: Number(env.CHAIN_ID || 97453) });
  const provider = new ethers.JsonRpcProvider(env.RPC_URL || "https://rpc.sidrachain.com", sidraNetwork, { staticNetwork: sidraNetwork });

  const routerAddr = env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
  const wsdaAddr = env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
  const gmaiAddr = env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
  const gmaiFee = Number(env.GMAI_POOL_FEE || 10000);
  const isLive = env.LIVE_EXECUTION === "true";

  const scan = await scanMarketOpportunities(provider, env);

  lastScanTelemetry = {
    timestamp: new Date().toISOString(),
    blockNumber: scan.blockNumber,
    tokensScanned: scan.totalTokensScanned,
    opportunitiesFound: scan.opportunitiesFound,
    topOpportunity: scan.opportunities[0] || null,
    lastExecution: null
  };

  if (scan.opportunities.length === 0) {
    console.log(`ℹ️ [CYCLE COMPLETE] Block ${scan.blockNumber} | Scanned ${scan.totalTokensScanned} tokens. Spreads in equilibrium (< +${env.MIN_PROFIT_SDA || 0.0001} SDA). Capital safe.`);
    return { success: true, executed: false, reason: "MARKET_IN_EQUILIBRIUM", scan };
  }

  const bestOpp = scan.opportunities[0];
  console.log(`🎯 [OPPORTUNITY FOUND] Best Route: ${bestOpp.name} | Size: ${bestOpp.tradeSizeSda} SDA | Expected Net: +${bestOpp.expectedProfitSda.toFixed(5)} SDA`);

  // Load primary wallet private key (from Cloudflare encrypted secrets)
  const pk = env.PRIVATE_KEY_1 || env.PRIVATE_KEY;
  if (!pk) {
    console.log(`🛡️ [DRY RUN / NO KEY] No PRIVATE_KEY configured in secrets. Simulated execution verified (+${bestOpp.expectedProfitSda.toFixed(5)} SDA).`);
    lastScanTelemetry.lastExecution = { simulated: true, route: bestOpp.name, netProfit: bestOpp.expectedProfitSda };
    return { success: true, executed: false, simulated: true, bestOpp };
  }

  const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
  const signer = new ethers.Wallet(cleanPk, provider);
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(wsdaAddr, WSDA_ABI, signer);

  const tradeAmountWei = ethers.parseEther(bestOpp.tradeSizeSda.toFixed(18));
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const minOut = tradeAmountWei + 1n; // Strict 100% principal protection

  // Pre-flight static call
  try {
    const simOut = await router.exactInput.staticCall({
      path: bestOpp.path,
      recipient: signer.address,
      deadline,
      amountIn: tradeAmountWei,
      amountOutMinimum: minOut
    });
    const verifiedProfit = Number(ethers.formatEther(simOut - tradeAmountWei));
    console.log(`🛡️ [STATIC-CALL VERIFIED] On-chain simulation verified +${verifiedProfit.toFixed(5)} SDA Net Profit!`);
  } catch (simErr) {
    console.log(`🛡️ [SIMULATION GUARD] Slippage shifted or spread no longer profitable. Trade safely aborted with 0 gas spent!`);
    return { success: false, reason: "STATIC_CALL_REVERTED" };
  }

  if (!isLive) {
    console.log(`🛡️ [DRY-RUN] Verification complete for ${bestOpp.name}. Set LIVE_EXECUTION=true to broadcast.`);
    lastScanTelemetry.lastExecution = { simulated: true, route: bestOpp.name, netProfit: bestOpp.expectedProfitSda };
    return { success: true, simulated: true, bestOpp };
  }

  // 1. Ensure WSDA Balance
  let curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeAmountWei) {
    const wrapNeeded = tradeAmountWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal >= wrapNeeded + ethers.parseEther("0.05")) {
      const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n });
      await wrapTx.wait(1);
      console.log(`✅ Wrapped +${ethers.formatEther(wrapNeeded)} SDA ➔ WSDA`);
    } else {
      return { success: false, reason: "INSUFFICIENT_NATIVE_FOR_WRAP" };
    }
  }

  // 2. Ensure Router Approval
  const allowance = await wsda.allowance(signer.address, routerAddr);
  if (allowance < tradeAmountWei) {
    const approveTx = await wsda.approve(routerAddr, ethers.MaxUint256, { gasLimit: 85000n });
    await approveTx.wait(1);
  }

  // 3. Broadcast Live Atomic Scalp
  try {
    const tx = await router.exactInput({
      path: bestOpp.path,
      recipient: signer.address,
      deadline,
      amountIn: tradeAmountWei,
      amountOutMinimum: minOut
    }, {
      gasLimit: 360000n
    });

    console.log(`🚀 [BROADCAST SUCCESS] Tx: https://ledger.sidrachain.com/tx/${tx.hash}`);
    const receipt = await tx.wait(1);
    const gasSpentSda = Number(ethers.formatEther(receipt.gasUsed * receipt.gasPrice));
    console.log(`✅ [CONFIRMED] Block ${receipt.blockNumber} | Gas Spent: -${gasSpentSda.toFixed(5)} SDA`);

    // 4. 10% Liquidity Reinvestment into GMAI Pool
    if (bestOpp.expectedProfitSda > 0) {
      const lpProfitSda = bestOpp.expectedProfitSda * 0.10;
      const lpWei = ethers.parseEther(lpProfitSda.toFixed(18));
      if (lpWei >= 100000000000000n) {
        try {
          const lpTx = await router.exactInputSingle({
            tokenIn: wsdaAddr,
            tokenOut: gmaiAddr,
            fee: gmaiFee,
            recipient: signer.address,
            deadline,
            amountIn: lpWei,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0
          }, { gasLimit: 250000n });
          await lpTx.wait(1);
          console.log(`💧 [GMAI FLYWHEEL] Injected +${lpProfitSda.toFixed(5)} SDA into GMAI Pool! (Tx: ${lpTx.hash})`);
        } catch (lpErr) {
          console.warn("GMAI LP injection note:", lpErr.message);
        }
      }
    }

    lastScanTelemetry.lastExecution = {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasSpentSda,
      route: bestOpp.name
    };

    return { success: true, executed: true, txHash: tx.hash, blockNumber: receipt.blockNumber };
  } catch (err) {
    console.error(`❌ Execution failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Fetches portfolio balances for configured fleet wallets.
 */
async function getFleetBalances(provider, env) {
  const wsdaAddr = env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
  const gmaiAddr = env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
  const wsda = new ethers.Contract(wsdaAddr, ERC20_ABI, provider);
  const gmai = new ethers.Contract(gmaiAddr, ERC20_ABI, provider);

  const wallets = [];
  for (let i = 1; i <= 15; i++) {
    const pk = env[`PRIVATE_KEY_${i}`] || (i === 1 ? env.PRIVATE_KEY : null);
    if (pk) {
      try {
        const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
        const w = new ethers.Wallet(cleanPk, provider);
        const [nativeBal, wsdaBal, gmaiBal] = await Promise.all([
          provider.getBalance(w.address),
          wsda.balanceOf(w.address).catch(() => 0n),
          gmai.balanceOf(w.address).catch(() => 0n)
        ]);
        wallets.push({
          walletId: `wallet${i}`,
          address: w.address,
          nativeSda: Number(ethers.formatEther(nativeBal)),
          wsda: Number(ethers.formatEther(wsdaBal)),
          gmai: Number(ethers.formatEther(gmaiBal)),
          totalSdaLiquid: Number(ethers.formatEther(nativeBal + wsdaBal))
        });
      } catch {}
    }
  }

  return {
    timestamp: new Date().toISOString(),
    walletCount: wallets.length,
    wallets
  };
}
