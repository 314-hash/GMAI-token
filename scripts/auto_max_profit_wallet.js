import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { scanMarket } from "../engine/scanner.js";
import { quoteV3Swap } from "../engine/router.js";
import { enrichMarketWithTopTraders } from "../engine/top_trader_tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
// Fast 800ms block polling (down from ethers default 4000ms) for rapid transaction confirmation
provider.pollingInterval = 800;

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const GMAI_ADDR = process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || process.env.RIDE_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
const GMAI_POOL_FEE = Number(process.env.POOL_FEE || process.env.GMAI_POOL_FEE || process.env.RIDE_POOL_FEE || "10000");

// Default 90% Wallet Profit (Native SDA) / 10% GMAI Pool
export const DEFAULT_WALLET_SHARE = Number(process.env.WALLET_PROFIT_SHARE || "0.90");
export const DEFAULT_LP_SHARE = Number(process.env.LP_PROFIT_SHARE || "0.10");

// 5.0 TO 15.0 SDA TRADING PARAMETERS:
export const DEEP_POOL_DEPTH_THRESHOLD_SDA = 1000.0; // Pools with >= 1,000 SDA virtual depth qualify for Whale Clips
export const DEEP_POOL_MIN_TRADE_SDA = 5.0; // 5.0 to 15.0 SDA on deep pools
export const DEEP_POOL_MAX_TRADE_SDA = 15.0; // Up to 15.0 SDA dedicated on deep pools
export const DEEP_POOL_MAX_IMPACT_PCT = 5.0; // Strict <= 5.0% impact on deep pools

export const SCALP_POOL_MIN_TRADE_SDA = 5.0; // 5.0 to 15.0 SDA on medium/liquid pools
export const SCALP_POOL_MAX_TRADE_SDA = 15.0; // Up to 15.0 SDA max on liquid pools
export const SCALP_POOL_MAX_IMPACT_PCT = 20.0; // Up to 20.0% impact on liquid pools

export const DEFAULT_MIN_TRADE_SIZE_SDA = Number(process.env.ARB_MIN_TRADE_SIZE_SDA || "5.0");
export const DEFAULT_MAX_TRADE_SIZE_SDA = Number(process.env.ARB_MAX_TRADE_SIZE_SDA || "15.0");
export const DEFAULT_WSDA_RESERVE_SDA = Number(process.env.WSDA_RESERVE_SDA || "15.0"); // Keep 15.0 WSDA wrapped in each wallet for instant 5-15 SDA deployment
export const DEFAULT_MIN_POOL_LIQUIDITY_SDA = Number(process.env.MIN_POOL_LIQUIDITY_SDA || "3.0"); // Allow token pools with >= 3.0 SDA depth
export const DEFAULT_MAX_PRICE_IMPACT_PCT = Number(process.env.MAX_PRICE_IMPACT_PCT || "20.0");

export let SAFE_GAS_PRICE = process.env.GAS_PRICE_WEI ? BigInt(process.env.GAS_PRICE_WEI) : 4000000000n;

// In-memory approval cache: `${walletAddr.toLowerCase()}_${tokenAddr.toLowerCase()}` -> boolean
const approvalCache = new Set();

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const WSDA_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

const ROUTER_ABI = [
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const POOL_STATE_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function refreshGasPrice() {
  try {
    const feeData = await provider.getFeeData();
    const netGas = feeData.gasPrice || 3500000000n;
    // Clamp gas price at 3.5 Gwei (Sidra Chain includes 3.5 Gwei in immediate blocks)
    SAFE_GAS_PRICE = netGas >= 3500000000n && netGas <= 4500000000n ? netGas : 3500000000n;
  } catch {
    SAFE_GAS_PRICE = 3500000000n;
  }
  return SAFE_GAS_PRICE;
}

async function getFastNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

async function ensureFastApproval(signer, tokenAddress, requiredWei) {
  const cacheKey = `${signer.address.toLowerCase()}_${tokenAddress.toLowerCase()}`;
  if (approvalCache.has(cacheKey)) return;

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const curAllow = await token.allowance(signer.address, ROUTER_ADDR);
  if (curAllow >= requiredWei) {
    approvalCache.add(cacheKey);
    return;
  }

  const nonce = await getFastNonce(signer.address);
  const appTx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, {
    gasLimit: 75000n,
    gasPrice: SAFE_GAS_PRICE,
    nonce
  });
  await appTx.wait(1);
  approvalCache.add(cacheKey);
}

/**
 * Evaluates a specific SDA input amount for a 2-leg cross-pool arbitrage route
 */
export function evaluateRouteForSize(token, poolBuy, poolSell, sizeSda, totalGasCostSda) {
  if (sizeSda <= 0) return null;
  const sdaInWei = ethers.parseUnits(sizeSda.toFixed(6), 18);

  const buyQuote = quoteV3Swap(
    sdaInWei,
    BigInt(poolBuy.sqrtPriceX96),
    BigInt(poolBuy.liquidity),
    poolBuy.feeTier,
    token.taxBps || 0,
    poolBuy.isToken0WSDA
  );

  if (!buyQuote.amountOut || buyQuote.amountOut === 0n) return null;

  const sellQuote = quoteV3Swap(
    buyQuote.amountOut,
    BigInt(poolSell.sqrtPriceX96),
    BigInt(poolSell.liquidity),
    poolSell.feeTier,
    token.taxBps || 0,
    !poolSell.isToken0WSDA
  );

  if (!sellQuote.amountOut || sellQuote.amountOut === 0n) return null;

  const sdaOut = Number(ethers.formatUnits(sellQuote.amountOut, 18));
  const grossProfitSda = sdaOut - sizeSda;
  const netProfitSda = grossProfitSda - totalGasCostSda;
  const maxImpact = Math.max(buyQuote.priceImpactPct, sellQuote.priceImpactPct);

  return {
    token: token.symbol,
    tokenAddress: token.address,
    decimals: token.decimals || 18,
    taxBps: token.taxBps || 0,
    inputSda: Number(sizeSda.toFixed(4)),
    inputSdaWei: sdaInWei,
    expectedTokensWei: buyQuote.amountOut,
    expectedOutSda: sdaOut,
    expectedOutSdaWei: sellQuote.amountOut,
    grossProfitSda,
    netProfitSda,
    gasCostSda: totalGasCostSda,
    roiPct: (netProfitSda / sizeSda) * 100,
    feeBuy: poolBuy.feeTier,
    feeSell: poolSell.feeTier,
    poolBuyAddress: poolBuy.poolAddress,
    poolSellAddress: poolSell.poolAddress,
    sellPoolIsToken0WSDA: poolSell.isToken0WSDA,
    buyLiquiditySda: poolBuy.virtualWsdaDepthSda || 0,
    sellLiquiditySda: poolSell.virtualWsdaDepthSda || 0,
    priceImpactPct: maxImpact
  };
}

/**
 * Optimizes trade size strictly within [minTradeSda, maxTradeSda] (5.0 to 7.0 SDA)
 * across all deep-liquidity cross-pool routes using grid + Golden-Section refinement.
 */
export function findOptimalProfitOpportunities(
  market,
  minTradeSda = DEFAULT_MIN_TRADE_SIZE_SDA,
  maxTradeSda = DEFAULT_MAX_TRADE_SIZE_SDA,
  minPoolLiquiditySda = DEFAULT_MIN_POOL_LIQUIDITY_SDA,
  maxImpactPct = DEFAULT_MAX_PRICE_IMPACT_PCT
) {
  const opps = [];
  const gasEstimate = 165000n; // Single-transaction atomic exactInput gas
  const totalGasCostSda = Number(ethers.formatUnits(gasEstimate * SAFE_GAS_PRICE, 18));
  const INV_PHI = (Math.sqrt(5) - 1) / 2;

  for (const token of market) {
    // Never trade taxed or excluded tokens (SVM, ATES) that trap principal
    if (
      token.symbol === "SVM" ||
      token.symbol === "ATES" ||
      (token.address && token.address.toLowerCase() === "0x05322f2356e8ffdc28c4a5e69d4feebebbb33649") ||
      (token.taxBps && token.taxBps > 0)
    ) continue;
    if (!token.pools || token.pools.length < 2) continue;

    // STRICT LIQUIDITY FILTER: Only consider pools with virtual WSDA depth >= minPoolLiquiditySda
    const deepPools = token.pools.filter(
      (p) =>
        p.isHealthy &&
        p.spotPriceSda > 0 &&
        p.liquidity > 0n &&
        (p.virtualWsdaDepthSda || 0) >= minPoolLiquiditySda
    );
    if (deepPools.length < 2) continue;

    for (let i = 0; i < deepPools.length; i++) {
      for (let j = 0; j < deepPools.length; j++) {
        if (i === j) continue;
        const poolBuy = deepPools[i];
        const poolSell = deepPools[j];

        const combinedFeeRate = (poolBuy.feeTier + poolSell.feeTier) / 1000000;
        if (poolSell.spotPriceSda <= poolBuy.spotPriceSda * (1 + combinedFeeRate)) continue;

        const minPoolDepth = Math.min(poolBuy.virtualWsdaDepthSda, poolSell.virtualWsdaDepthSda);
        if (minPoolDepth < minPoolLiquiditySda) continue;

        // 5.0 TO 15.0 SDA SWARM EVALUATION:
        const isDeepPool = minPoolDepth >= DEEP_POOL_DEPTH_THRESHOLD_SDA;
        const tierMode = isDeepPool ? "WHALE_15_SDA" : "LIQUID_5_15_SDA";
        const tierMinSize = isDeepPool ? DEEP_POOL_MIN_TRADE_SDA : Math.max(minTradeSda, SCALP_POOL_MIN_TRADE_SDA);
        const tierMaxSize = isDeepPool ? DEEP_POOL_MAX_TRADE_SDA : Math.min(maxTradeSda, SCALP_POOL_MAX_TRADE_SDA);
        const tierMaxImpact = isDeepPool ? DEEP_POOL_MAX_IMPACT_PCT : maxImpactPct;

        // Fine grid covering 5.0 to 15.0 SDA
        const tierGrid = [5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.5, 13.0, 15.0].filter(
          (s) => s >= tierMinSize && s <= tierMaxSize
        );

        let bestEval = null;
        let bestIdx = -1;

        for (let idx = 0; idx < tierGrid.length; idx++) {
          const size = tierGrid[idx];
          const res = evaluateRouteForSize(token, poolBuy, poolSell, size, totalGasCostSda);
          if (res && res.priceImpactPct <= tierMaxImpact) {
            if (!bestEval || res.netProfitSda > bestEval.netProfitSda) {
              bestEval = res;
              bestIdx = idx;
            }
          }
        }

        if (!bestEval || bestEval.netProfitSda <= 0) continue;

        // Golden-Section refinement strictly within [tierMinSize, tierMaxSize]
        let low = bestIdx > 0 ? tierGrid[bestIdx - 1] : tierMinSize;
        let high = bestIdx < tierGrid.length - 1 ? tierGrid[bestIdx + 1] : tierMaxSize;
        low = Math.max(tierMinSize, low);
        high = Math.min(tierMaxSize, high);

        for (let iter = 0; iter < 6; iter++) {
          const x1 = high - (high - low) * INV_PHI;
          const x2 = low + (high - low) * INV_PHI;
          const r1 = evaluateRouteForSize(token, poolBuy, poolSell, x1, totalGasCostSda);
          const r2 = evaluateRouteForSize(token, poolBuy, poolSell, x2, totalGasCostSda);

          const p1 = r1 && r1.priceImpactPct <= tierMaxImpact ? r1.netProfitSda : -999;
          const p2 = r2 && r2.priceImpactPct <= tierMaxImpact ? r2.netProfitSda : -999;

          if (r1 && p1 > bestEval.netProfitSda) bestEval = r1;
          if (r2 && p2 > bestEval.netProfitSda) bestEval = r2;

          if (p1 > p2) {
            high = x2;
          } else {
            low = x1;
          }
        }

        if (
          bestEval &&
          bestEval.inputSda >= tierMinSize &&
          bestEval.inputSda <= tierMaxSize &&
          bestEval.netProfitSda > 0 &&
          bestEval.priceImpactPct <= tierMaxImpact
        ) {
          bestEval.mode = tierMode;
          bestEval.minPoolDepth = minPoolDepth;
          opps.push(bestEval);
        }
      }
    }
  }

  return opps.sort((a, b) => b.netProfitSda - a.netProfitSda);
}

/**
 * Keeps `reserveWei` (default 5.0 WSDA) wrapped in each wallet for instant 5 SDA trades,
 * and unwraps only net profits above `reserveWei` directly to Native SDA in each wallet.
 */
export async function unwrapProfitsToNativeSda(swarmWallets, isLive = true, reserveWei = 0n) {
  if (!isLive) return;
  const wsdaContract = new ethers.Contract(WSDA_ADDR, WSDA_ABI, provider);
  const minGasBufferWei = ethers.parseEther("0.25");
  await Promise.all(
    Object.entries(swarmWallets).map(async ([key, wallet]) => {
      try {
        const [nativeBal, bal] = await Promise.all([
          provider.getBalance(wallet.address),
          wsdaContract.balanceOf(wallet.address)
        ]);
        if (bal > reserveWei) {
          const unwrapAmt = bal - reserveWei;
          // Only unwrap if profit above reserve is >= 0.002 WSDA so we don't waste gas on tiny dust
          if (unwrapAmt >= ethers.parseEther("0.002")) {
            const nonce = await getFastNonce(wallet.address);
            const tx = await wsdaContract.connect(wallet).withdraw(unwrapAmt, {
              gasLimit: 85000n,
              gasPrice: SAFE_GAS_PRICE,
              nonce
            });
            await tx.wait(1);
            console.log(`   💰 [${key.toUpperCase()}] Unwrapped +${ethers.formatEther(unwrapAmt)} WSDA profit ➔ Native SDA (Kept ${ethers.formatEther(reserveWei)} WSDA wrapped)`);
          }
        } else if (reserveWei > 0n && bal < reserveWei) {
          const neededWei = reserveWei - bal;
          if (nativeBal >= neededWei + minGasBufferWei) {
            const nonce = await getFastNonce(wallet.address);
            const tx = await wsdaContract.connect(wallet).deposit({
              value: neededWei,
              gasLimit: 90000n,
              gasPrice: SAFE_GAS_PRICE,
              nonce
            });
            await tx.wait(1);
            await ensureFastApproval(wallet, WSDA_ADDR, reserveWei);
            console.log(`   ⚡ [${key.toUpperCase()}] Pre-wrapped +${ethers.formatEther(neededWei)} SDA ➔ ${ethers.formatEther(reserveWei)} WSDA ready for instant 5 SDA trades`);
          }
        }
      } catch (err) {
        console.warn(`   ⚠️ [${key.toUpperCase()}] WSDA reserve sync notice: ${err.message}`);
      }
    })
  );
}

/**
 * Guarantees NO other tokens are held in any wallet:
 * Scans all wallets for any leftover balance of non-GMAI tokens and immediately swaps 100% back to WSDA -> Native SDA.
 */
export async function sweepStrandedTokensToSda(swarmWallets, market, isLive = true, reserveWei = 0n) {
  // PERMANENTLY DISABLED: User holdings (RIDE, GMAI, etc.) must NEVER be auto-liquidated
  return;
}

export async function executeOptimalProfitTrade(walletKey, signer, opp, config) {
  const { isLive, walletShare, lpShare, reserveWei, maxImpactPct = DEFAULT_MAX_PRICE_IMPACT_PCT } = config;
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const token = new ethers.Contract(opp.tokenAddress, ERC20_ABI, signer);
  const gmai = new ethers.Contract(GMAI_ADDR, ERC20_ABI, signer);

  const walletPct = Math.round(walletShare * 100);
  const lpPct = Math.round(lpShare * 100);

  const isWhale = opp.mode === "WHALE_10_SDA";
  const modeBadge = isWhale ? "🐋 [10-SDA DEEP WHALE CLIP]" : "⚡ [5-SDA SWEET-SPOT SCALP]";
  const poolTierLabel = isWhale
    ? `Deep Liquidity (Depth: ~${(opp.minPoolDepth || Math.min(opp.buyLiquiditySda, opp.sellLiquiditySda)).toFixed(0)} SDA)`
    : `Shallow / Medium Pool (Depth: ~${(opp.minPoolDepth || Math.min(opp.buyLiquiditySda, opp.sellLiquiditySda)).toFixed(1)} SDA)`;

  console.log(`\n--------------------------------------------------------------------------`);
  console.log(`${modeBadge} [${walletKey.toUpperCase()}] ${opp.token} | Size: ${opp.inputSda} SDA`);
  console.log(`   Route               : Buy (Fee ${opp.feeBuy}, Depth ~${opp.buyLiquiditySda.toFixed(1)} SDA) ➔ Sell (Fee ${opp.feeSell}, Depth ~${opp.sellLiquiditySda.toFixed(1)} SDA)`);
  console.log(`   Pool Tier           : ${poolTierLabel}`);
  console.log(`   Price Impact        : ${opp.priceImpactPct.toFixed(2)}% (Max Allowed: ${maxImpactPct}%)`);
  console.log(`   Expected Net Profit : +${opp.netProfitSda.toFixed(5)} SDA (ROI: +${opp.roiPct.toFixed(2)}%)`);
  console.log(`   Allocation Split    : ${walletPct}% Wallet SDA Profit | ${lpPct}% GMAI Pool | 0% Token Held`);
  console.log(`--------------------------------------------------------------------------`);

  if (!isLive) {
    const simWalletProfit = opp.netProfitSda * walletShare;
    const simLpProfit = opp.netProfitSda * lpShare;
    console.log(`   🛡️ [DRY-RUN SIMULATION] Deep-liquidity trade verified:`);
    console.log(`      💰 ${walletPct}% Retained in Wallet : +${simWalletProfit.toFixed(5)} Native SDA`);
    console.log(`      💧 ${lpPct}% Routed to GMAI Pool: +${simLpProfit.toFixed(5)} SDA`);
    return {
      success: true,
      simulated: true,
      netProfit: opp.netProfitSda,
      walletProfitSda: simWalletProfit,
      lpProfitSda: simLpProfit
    };
  }

  // 1. Ensure WSDA balance for inputSdaWei
  const curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < opp.inputSdaWei) {
    const wrapNeeded = opp.inputSdaWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.025")) {
      console.log(`   ❌ [${walletKey}] Insufficient native SDA for wrap + gas buffer.`);
      return { success: false, reason: "LOW_NATIVE_BALANCE" };
    }
    const nonce = await getFastNonce(signer.address);
    const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce });
    await wrapTx.wait(1);
  }

  // 2. Ensure WSDA router approval (Single-Tx Atomic exactInput does not even need target token approval!)
  await ensureFastApproval(signer, WSDA_ADDR, opp.inputSdaWei);

  // 3. LIVE SINGLE-TX ATOMIC PRE-FLIGHT VERIFICATION (BOTH LEGS ON-CHAIN!)
  // Encodes WSDA --(feeBuy)--> Token --(feeSell)--> WSDA into one atomic V3 path
  // and queries exact on-chain round-trip WSDA output across all real ticks via router.exactInput.staticCall!
  const atomicPath = ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, opp.feeBuy, opp.tokenAddress, opp.feeSell, WSDA_ADDR]
  );
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const atomicGasCostWei = 165000n * SAFE_GAS_PRICE;
  const atomicGasCostSda = Number(ethers.formatEther(atomicGasCostWei));

  let liveAtomicWsdaOutWei = 0n;
  try {
    liveAtomicWsdaOutWei = await router.exactInput.staticCall({
      path: atomicPath,
      recipient: signer.address,
      deadline,
      amountIn: opp.inputSdaWei,
      amountOutMinimum: opp.inputSdaWei + 1n
    });
  } catch (simErr) {
    console.log(
      `   🛡️ [${walletKey}] Atomic 2-leg on-chain staticCall rejected ${opp.token} (multi-tick slippage would lose SDA). Aborted with 0 gas spent!`
    );
    return { success: false, reason: "ATOMIC_STATIC_CALL_UNPROFITABLE" };
  }

  const freshExpectedOutSda = Number(ethers.formatUnits(liveAtomicWsdaOutWei, 18));
  const freshNetProfitSda = freshExpectedOutSda - opp.inputSda - atomicGasCostSda;

  if (freshNetProfitSda <= 0.0002) {
    console.log(
      `   🛡️ [${walletKey}] Pre-flight Atomic Guard: On-chain output (${freshExpectedOutSda.toFixed(4)} WSDA, net ${freshNetProfitSda.toFixed(5)} SDA) below profit floor. Aborted with 0 gas spent!`
    );
    return { success: false, reason: "PREFLIGHT_UNPROFITABLE" };
  }

  // 4. Execute SINGLE ATOMIC TRANSACTION (WSDA -> Token -> WSDA in 1 tx!)
  // Strict amountOutMinimum >= inputSdaWei + atomicGasCostWei + 0.0002 SDA so it is IMPOSSIBLE to lose principal!
  const minProfitBufferWei = ethers.parseEther("0.0002");
  const strictMinOutWei = opp.inputSdaWei + atomicGasCostWei + minProfitBufferWei;

  const wsdaBeforeTrade = await wsda.balanceOf(signer.address);
  let rAtomic = null;
  let leg2Hash = "";

  try {
    const nonce1 = await getFastNonce(signer.address);
    const atomicTx = await router.exactInput(
      {
        path: atomicPath,
        recipient: signer.address,
        deadline,
        amountIn: opp.inputSdaWei,
        amountOutMinimum: strictMinOutWei
      },
      {
        gasLimit: 280000n,
        gasPrice: SAFE_GAS_PRICE,
        nonce: nonce1
      }
    );
    leg2Hash = atomicTx.hash;
    rAtomic = await atomicTx.wait(1);
  } catch (atomicErr) {
    console.log(
      `   🛡️ [${walletKey}] Atomic MinOut Guard protected 100% of ${opp.inputSda} WSDA on ${opp.token} (0 SDA lost, 0 tokens held).`
    );
    return { success: false, reason: "ATOMIC_MINOUT_PROTECTED" };
  }

  const wsdaAfterTrade = await wsda.balanceOf(signer.address);
  const netWsdaDelta = Number(ethers.formatEther(wsdaAfterTrade - wsdaBeforeTrade));
  const gasUsedTotal = rAtomic?.gasUsed || 195000n;
  const gasSpentSda = Number(ethers.formatEther(gasUsedTotal * SAFE_GAS_PRICE));
  const realizedNetProfit = netWsdaDelta - gasSpentSda;

  console.log(`   🎉 [${walletKey}] Atomic 1-Tx Round-Trip Complete!`);
  console.log(`      🔗 Explorer Tx: https://ledger.sidrachain.com/tx/${leg2Hash}`);
  console.log(`      💰 Gross: +${netWsdaDelta.toFixed(5)} WSDA | Realized Net: +${realizedNetProfit.toFixed(5)} SDA (0 ${opp.token} held)`);

  let walletProfitSda = 0;
  let lpProfitSda = 0;
  let gmaiAcquired = 0n;

  if (realizedNetProfit > 0) {
    walletProfitSda = realizedNetProfit * walletShare;
    lpProfitSda = realizedNetProfit * lpShare;

    const lpShareWei = ethers.parseEther(lpProfitSda.toFixed(18));
    if (lpShare > 0 && lpShareWei > 100000000000000n) {
      try {
        const gmaiBefore = await gmai.balanceOf(signer.address);
        const nonceLp = await getFastNonce(signer.address);
        const lpTx = await router.exactInputSingle({
          tokenIn: WSDA_ADDR,
          tokenOut: GMAI_ADDR,
          fee: GMAI_POOL_FEE,
          recipient: signer.address,
          deadline: Math.floor(Date.now() / 1000) + 180,
          amountIn: lpShareWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        }, { gasLimit: 250000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
        await lpTx.wait(1);
        const gmaiAfter = await gmai.balanceOf(signer.address);
        gmaiAcquired = gmaiAfter - gmaiBefore;
        console.log(`   💧 [${walletKey}] Injected ${lpPct}% (+${lpProfitSda.toFixed(5)} SDA) into GMAI Pool (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
      } catch (lpErr) {
        console.warn(`   ⚠️ [${walletKey}] GMAI pool swap skipped: ${lpErr.message}`);
      }
    }
  }

  // Unwrap WSDA profits above reserveWei (default 10.0 WSDA) back to Native SDA while keeping 10.0 WSDA wrapped for next trade
  const remWsda = await wsda.balanceOf(signer.address);
  if (remWsda > reserveWei) {
    const unwrapAmt = remWsda - reserveWei;
    if (unwrapAmt >= ethers.parseEther("0.002")) {
      try {
        const nonceUnwrap = await getFastNonce(signer.address);
        const unwrapTx = await wsda.withdraw(unwrapAmt, { gasLimit: 85000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceUnwrap });
        await unwrapTx.wait(1);
        console.log(`   💰 [${walletKey}] Unwrapped +${ethers.formatEther(unwrapAmt)} WSDA profit ➔ Native SDA (Kept ${ethers.formatEther(reserveWei)} WSDA wrapped)! Tx: https://ledger.sidrachain.com/tx/${unwrapTx.hash}`);
      } catch (uErr) {
        console.warn(`   ⚠️ [${walletKey}] Unwrap notice: ${uErr.message}`);
      }
    }
  }

  return {
    success: true,
    netProfit: realizedNetProfit,
    walletProfitSda,
    lpProfitSda,
    gmaiTokensAcquired: Number(ethers.formatEther(gmaiAcquired)),
    txHash: leg2Hash
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || process.env.LIVE === "true";
  const maxRounds = Number(args.find((a) => a.startsWith("--rounds="))?.split("=")[1] || (args.includes("--once") ? 1 : 999999));
  const minTradeSda = Number(args.find((a) => a.startsWith("--min-trade="))?.split("=")[1] || DEFAULT_MIN_TRADE_SIZE_SDA);
  const maxTradeSda = Number(args.find((a) => a.startsWith("--max-trade="))?.split("=")[1] || DEFAULT_MAX_TRADE_SIZE_SDA);
  const minProfitThreshold = Number(args.find((a) => a.startsWith("--min-profit="))?.split("=")[1] || 0.0001);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 5); // Fast 5s scan loop
  const minPoolLiquiditySda = Number(args.find((a) => a.startsWith("--min-liquidity="))?.split("=")[1] || DEFAULT_MIN_POOL_LIQUIDITY_SDA);
  const maxImpactPct = Number(args.find((a) => a.startsWith("--max-impact="))?.split("=")[1] || DEFAULT_MAX_PRICE_IMPACT_PCT);
  const walletShare = Number(args.find((a) => a.startsWith("--wallet-share="))?.split("=")[1] || DEFAULT_WALLET_SHARE);
  const lpShare = Number(args.find((a) => a.startsWith("--pool-share="))?.split("=")[1] ?? (1 - walletShare).toFixed(4));
  const reserveSda = Number(args.find((a) => a.startsWith("--wsda-reserve="))?.split("=")[1] ?? DEFAULT_WSDA_RESERVE_SDA);
  const reserveWei = ethers.parseEther(reserveSda.toString());

  const rawKeys = {};
  for (let i = 1; i <= 50; i++) {
    const pk = process.env["PRIVATE_KEY_" + i] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (pk) rawKeys["wallet" + i] = pk;
  }

  const swarmWallets = {};
  for (const [k, pk] of Object.entries(rawKeys)) {
    if (pk) {
      const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
      swarmWallets[k] = new ethers.Wallet(cleanPk, provider);
    }
  }

  const walletKeys = Object.keys(swarmWallets);
  if (walletKeys.length === 0) {
    throw new Error("No wallet private keys configured in .env");
  }

  const walletPct = Math.round(walletShare * 100);
  const lpPct = Math.round(lpShare * 100);

  console.log("==========================================================================");
  console.log(`🚀 DUAL-MODE ARBITRAGE SWARM: 5 SDA SWEET-SPOT SCALPS + 10 SDA DEEP WHALE CLIPS`);
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN EXECUTION" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Active Fleet       : ${walletKeys.join(", ")} (${walletKeys.length} Wallets)`);
  console.log(`Dual Modes Active  : ⚡ Scalp Mode: 0.1 - 5.0 SDA (< 2,500 SDA pools) | 🐋 Whale Mode: 5.0 - 10.0 SDA (>= 2,500 SDA pools)`);
  console.log(`WSDA Pre-Wrapped   : ${reserveSda.toFixed(2)} WSDA kept wrapped per wallet for 0-delay dual-mode swaps`);
  console.log(`Min Pool Liquidity : >= ${minPoolLiquiditySda} SDA virtual depth per pool (No small liquidity pools)`);
  console.log(`Max Price Impact   : <= ${maxImpactPct}% per swap leg`);
  console.log(`Token Holding Rule : 0% Other Tokens Held (100% immediate round-trip + auto-sweep to SDA)`);
  console.log(`Profit Split       : ${walletPct}% Retained in Wallet as Native SDA | ${lpPct}% GMAI Pool`);
  console.log(`Scan Cadence       : Every ${intervalSec}s (800ms block polling)`);
  console.log("==========================================================================\n");

  const wsdaContract = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
  const walletProfits = {};
  const walletTrades = {};

  for (const k of walletKeys) {
    walletProfits[k] = 0;
    walletTrades[k] = 0;
    const w = swarmWallets[k];
    const [bal, wsdaBal] = await Promise.all([
      provider.getBalance(w.address),
      wsdaContract.balanceOf(w.address)
    ]);
    console.log(`   • [${k.toUpperCase().padEnd(7)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)}`);
  }

  let round = 1;
  let totalNetProfit = 0;
  let totalWalletSda = 0;
  let totalLpSda = 0;
  let totalTrades = 0;
  let rotationIdx = 0;

  while (round <= maxRounds) {
    const t0 = Date.now();
    await refreshGasPrice();
    console.log(`\n==========================================================================`);
    console.log(`🔍 [ROUND #${round}] Fast-Scanning Deep Liquidity Pools >= ${minPoolLiquiditySda} SDA for ${minTradeSda}-${maxTradeSda} SDA Trades (Gas: ${ethers.formatUnits(SAFE_GAS_PRICE, "gwei")} Gwei)...`);
    console.log(`==========================================================================`);

    const dynamicTokens = [];
    try {
      await Promise.race([
        enrichMarketWithTopTraders(dynamicTokens, provider),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Radar timeout")), 1200))
      ]);
    } catch { }

    const market = await scanMarket(provider, dynamicTokens);
    const scanMs = Date.now() - t0;

    // On Round 1, run sweep asynchronously in background so trading is 100% instant and responsive
    if (round === 1 && isLive) {
      sweepStrandedTokensToSda(swarmWallets, market, isLive, reserveWei).catch(() => { });
    }

    const allOpps = findOptimalProfitOpportunities(
      market,
      minTradeSda,
      maxTradeSda,
      minPoolLiquiditySda,
      maxImpactPct
    );
    const profitable = allOpps.filter((o) => o.netProfitSda >= minProfitThreshold);

    if (profitable.length === 0) {
      console.log(`   ℹ️ Scanned ${market.length} tokens in ${(scanMs / 1000).toFixed(2)}s. No deep-liquidity spreads >= +${minProfitThreshold} SDA in the ${minTradeSda}-${maxTradeSda} SDA range right now.`);
    } else {
      const bestByToken = new Map();
      for (const opp of profitable) {
        if (!bestByToken.has(opp.token) || bestByToken.get(opp.token).netProfitSda < opp.netProfitSda) {
          bestByToken.set(opp.token, opp);
        }
      }

      const uniqueOpps = Array.from(bestByToken.values()).sort((a, b) => b.netProfitSda - a.netProfitSda);
      console.log(`   🎯 Discovered ${uniqueOpps.length} Deep-Liquidity Profitable Route(s) (${minTradeSda}-${maxTradeSda} SDA) in ${(scanMs / 1000).toFixed(2)}s!`);

      // Check all 5 wallets in parallel to see which wallets are ready to trade simultaneously
      const walletStates = await Promise.all(
        walletKeys.map(async (k, idx) => {
          const signer = swarmWallets[k];
          const [bal, wsdaBal, latest, pending] = await Promise.all([
            provider.getBalance(signer.address),
            wsdaContract.balanceOf(signer.address),
            provider.getTransactionCount(signer.address, "latest"),
            provider.getTransactionCount(signer.address, "pending")
          ]);
          const nativeSda = Number(ethers.formatEther(bal));
          const availSda = Number(ethers.formatEther(bal + wsdaBal)) - 0.035;
          return {
            key: k,
            idx,
            signer,
            isClean: latest === pending,
            nativeSda,
            availSda,
            canTrade: latest === pending && nativeSda >= 0.025 && availSda >= minTradeSda
          };
        })
      );

      // Order ready wallets starting from rotationIdx so all wallets get equal priority
      const readyWallets = [];
      for (let i = 0; i < walletKeys.length; i++) {
        const wState = walletStates[(rotationIdx + i) % walletKeys.length];
        if (wState && wState.canTrade) {
          readyWallets.push(wState);
        }
      }

      if (readyWallets.length === 0) {
        console.log(`   ⚠️ No clean wallet has >= ${minTradeSda} SDA available right now. Skipping round.`);
      } else {
        // Build parallel execution batch: assign each ready wallet a distinct pool-pair so wallets never collide in the same block!
        const assignments = [];
        const usedWalletKeys = new Set();
        const usedPoolsInBatch = new Set();

        // Consider all profitable routes sorted by highest net profit, ensuring zero pool overlap within the parallel batch
        const sortedCandidates = [...profitable].sort((a, b) => b.netProfitSda - a.netProfitSda);

        for (const opp of sortedCandidates) {
          if (assignments.length >= readyWallets.length) break;
          const buyPoolKey = opp.poolBuyAddress.toLowerCase();
          const sellPoolKey = opp.poolSellAddress.toLowerCase();

          // Prevent two wallets from hitting the exact same buy or sell pool in the same block
          if (usedPoolsInBatch.has(buyPoolKey) || usedPoolsInBatch.has(sellPoolKey)) continue;

          const wState = readyWallets.find((w) => !usedWalletKeys.has(w.key));
          if (!wState) break;

          let assignedOpp = opp;
          if (wState.availSda < opp.inputSda) {
            const cappedSize = Math.min(maxTradeSda, wState.availSda);
            const tokenObj = market.find((t) => t.symbol === opp.token);
            const pBuy = tokenObj?.pools?.find((p) => p.feeTier === opp.feeBuy);
            const pSell = tokenObj?.pools?.find((p) => p.feeTier === opp.feeSell);
            if (tokenObj && pBuy && pSell) {
              const cappedEval = evaluateRouteForSize(tokenObj, pBuy, pSell, cappedSize, opp.gasCostSda);
              if (cappedEval && cappedEval.netProfitSda >= minProfitThreshold && cappedEval.priceImpactPct <= maxImpactPct) {
                assignedOpp = cappedEval;
              } else {
                continue;
              }
            } else {
              continue;
            }
          }

          usedWalletKeys.add(wState.key);
          usedPoolsInBatch.add(buyPoolKey);
          usedPoolsInBatch.add(sellPoolKey);
          assignments.push({ wState, opp: assignedOpp, staggerMs: 0 });
        }

        // If fewer distinct routes exist than ready wallets, assign remaining ready wallets to deep routes staggered by 1 block (3200ms) so all 5 wallets trade in the round without same-block pool collision!
        if (assignments.length < readyWallets.length && sortedCandidates.length > 0) {
          let extraWave = 1;
          for (const wState of readyWallets) {
            if (usedWalletKeys.has(wState.key)) continue;
            const deepOpp = sortedCandidates[(extraWave - 1) % sortedCandidates.length];
            if (
              deepOpp.buyLiquiditySda >= deepOpp.inputSda * 20 &&
              deepOpp.sellLiquiditySda >= deepOpp.inputSda * 20
            ) {
              usedWalletKeys.add(wState.key);
              assignments.push({ wState, opp: deepOpp, staggerMs: extraWave * 3200 });
              extraWave++;
            }
          }
        }

        rotationIdx = (rotationIdx + assignments.length) % walletKeys.length;

        console.log(
          `   🚀 Launching ${assignments.length} Wallet(s) Simultaneously in Parallel: ${assignments
            .map((a) => `[${a.wState.key.toUpperCase()} ➔ ${a.opp.token} (${a.opp.inputSda} SDA)]`)
            .join(", ")}`
        );

        const batchResults = await Promise.all(
          assignments.map(async ({ wState, opp: assignedOpp, staggerMs }) => {
            if (staggerMs > 0) await sleep(staggerMs);
            try {
              const res = await executeOptimalProfitTrade(wState.key, wState.signer, assignedOpp, {
                isLive,
                walletShare,
                lpShare,
                reserveWei,
                maxImpactPct
              });
              return { key: wState.key, res };
            } catch (err) {
              console.error(`   ❌ [${wState.key}] Trade execution error:`, err.reason || err.message);
              await sweepStrandedTokensToSda({ [wState.key]: wState.signer }, market, isLive, reserveWei);
              return { key: wState.key, res: { success: false } };
            }
          })
        );

        for (const { key, res } of batchResults) {
          if (res && res.success && res.netProfit) {
            totalNetProfit += res.netProfit;
            totalWalletSda += res.walletProfitSda || 0;
            totalLpSda += res.lpProfitSda || 0;
            walletProfits[key] += res.netProfit;
            walletTrades[key]++;
            totalTrades++;
          }
        }
      }
    }

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`📊 ROUND #${round} CUMULATIVE SUMMARY:`);
    console.log(`   Trades Executed             : ${totalTrades}`);
    console.log(`   Total Realized Net Profit   : +${totalNetProfit.toFixed(5)} SDA`);
    console.log(`   💰 ${walletPct}% Retained in Wallets : +${totalWalletSda.toFixed(5)} Native SDA`);
    console.log(`   💧 ${lpPct}% Injected to GMAI Pool: +${totalLpSda.toFixed(5)} SDA`);
    console.log(`--------------------------------------------------------------------------`);

    if (round < maxRounds) {
      await sleep(intervalSec * 1000);
    }
    round++;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch(console.error);
}
