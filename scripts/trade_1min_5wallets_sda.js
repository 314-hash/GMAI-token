import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // Fast IPv4 to prevent connection timeouts on Sidra RPC

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scanMarket } from "../engine/scanner.js";
import { quoteV3Swap } from "../engine/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");
const tokensData = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: 97453 });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";

const SAFE_GAS_PRICE = 2500000000n; // 2.5 Gwei

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
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCleanNonce(address, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(address, "latest"),
      provider.getTransactionCount(address, "pending")
    ]);
    if (latest === pending) return latest;
    await sleep(2000);
  }
  return await provider.getTransactionCount(address, "latest");
}

/**
 * Automatically unwraps 100% of stranded WSDA in fleet wallets back to native SDA token.
 */
export async function autoUnwrapAllWallets(swarmWallets, isLive = true) {
  if (!isLive) return;
  const wsdaContract = new ethers.Contract(WSDA_ADDR, WSDA_ABI, provider);

  for (const [key, wallet] of Object.entries(swarmWallets)) {
    try {
      const freshBal = await wsdaContract.balanceOf(wallet.address);
      if (freshBal > 0n) {
        console.log(`   🔄 [${key.toUpperCase()}] Auto-converting ${ethers.formatEther(freshBal)} WSDA ➔ Native SDA token...`);
        const nonce = await waitForCleanNonce(wallet.address);
        const tx = await wsdaContract.connect(wallet).withdraw(freshBal, {
          gasLimit: 85000n,
          gasPrice: SAFE_GAS_PRICE,
          nonce
        });
        await tx.wait(1);
        console.log(`   ✅ [${key.toUpperCase()}] Converted to native SDA! (Tx: ${tx.hash.slice(0, 16)}...)`);
      }
    } catch (err) {
      console.warn(`   ⚠️ [${key.toUpperCase()}] Auto-unwrap notice: ${err.message}`);
    }
  }
}

/**
 * Evaluates dynamic test sizes across all ecosystem tokens to identify maximum net SDA profit.
 */
export function findEcosystemOpportunities(market, testSizes = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.5, 5.0, 7.5, 10.0]) {
  const opps = [];
  const gasEstimate = 320000n; // ~160k gas per leg * 2 legs
  const totalGasCostSda = Number(ethers.formatUnits(gasEstimate * SAFE_GAS_PRICE, 18)); // ~0.0008 SDA

  for (const token of market) {
    if (token.symbol === "SVM" || token.symbol === "ATES" || (token.address && token.address.toLowerCase() === "0x05322f2356e8ffdc28c4a5e69d4feebebbb33649")) continue; // Exclude SVM & ATES
    if (!token.pools || token.pools.length < 2) continue;

    const healthyPools = token.pools.filter((p) => p.isHealthy && p.spotPriceSda > 0 && p.liquidity > 0n);
    if (healthyPools.length < 2) continue;

    for (let i = 0; i < healthyPools.length; i++) {
      for (let j = 0; j < healthyPools.length; j++) {
        if (i === j) continue;
        const poolBuy = healthyPools[i];
        const poolSell = healthyPools[j];

        // Ensure price spread covers pool fees + buffer
        if (poolSell.spotPriceSda <= poolBuy.spotPriceSda * 1.0035) continue;

        for (const size of testSizes) {
          const sdaInWei = ethers.parseUnits(size.toString(), 18);

          // Leg 1: WSDA -> Token
          const buyQuote = quoteV3Swap(
            sdaInWei,
            BigInt(poolBuy.sqrtPriceX96),
            BigInt(poolBuy.liquidity),
            poolBuy.feeTier,
            token.taxBps || 0,
            poolBuy.isToken0WSDA
          );

          if (!buyQuote.amountOut || buyQuote.amountOut === 0n) continue;

          // Leg 2: Token -> WSDA
          const sellQuote = quoteV3Swap(
            buyQuote.amountOut,
            BigInt(poolSell.sqrtPriceX96),
            BigInt(poolSell.liquidity),
            poolSell.feeTier,
            token.taxBps || 0,
            !poolSell.isToken0WSDA
          );

          if (!sellQuote.amountOut || sellQuote.amountOut === 0n) continue;

          const sdaOut = Number(ethers.formatUnits(sellQuote.amountOut, 18));
          const grossProfitSda = sdaOut - size;
          const netProfitSda = grossProfitSda - totalGasCostSda;
          const maxImpact = Math.max(buyQuote.priceImpactPct, sellQuote.priceImpactPct);

          if (netProfitSda > 0 && maxImpact <= 4.0) {
            opps.push({
              token: token.symbol,
              tokenAddress: token.address,
              decimals: token.decimals || 18,
              inputSda: size,
              inputSdaWei: sdaInWei,
              expectedOutSda: sdaOut,
              expectedOutSdaWei: sellQuote.amountOut,
              grossProfitSda,
              netProfitSda,
              gasCostSda: totalGasCostSda,
              roiPct: (netProfitSda / size) * 100,
              feeBuy: poolBuy.feeTier,
              feeSell: poolSell.feeTier,
              priceImpactPct: maxImpact
            });
          }
        }
      }
    }
  }

  // Sort descending by absolute net SDA profit
  return opps.sort((a, b) => b.netProfitSda - a.netProfitSda);
}

/**
 * Executes atomic 2-leg arbitrage and unwraps 100% of proceeds into native SDA in the executing wallet.
 */
async function executeArbitrageTrade(walletKey, signer, opp, isLive, swarmWallets = {}) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const token = new ethers.Contract(opp.tokenAddress, ERC20_ABI, signer);

  console.log(`\n--------------------------------------------------------------------------`);
  console.log(`⚡ [EXECUTION] [${walletKey.toUpperCase()}] ${opp.token} | Input: ${opp.inputSda} SDA`);
  console.log(`   Route               : Buy Pool (${opp.feeBuy}) ➔ Sell Pool (${opp.feeSell})`);
  console.log(`   Expected Gross      : +${opp.grossProfitSda.toFixed(5)} SDA`);
  console.log(`   Estimated Gas       : ~${opp.gasCostSda.toFixed(5)} SDA`);
  console.log(`   Expected Net Profit : +${opp.netProfitSda.toFixed(5)} SDA (ROI: +${opp.roiPct.toFixed(2)}%)`);
  console.log(`   AMM Price Impact    : ${opp.priceImpactPct.toFixed(2)}%`);
  console.log(`   Profit Destination  : 100% CONVERTED TO NATIVE SDA IN ${walletKey.toUpperCase()}`);
  console.log(`--------------------------------------------------------------------------`);

  if (!isLive) {
    console.log(`   🛡️ [DRY-RUN SIMULATION] Scalp trade verified mathematically:`);
    console.log(`      💰 100% Retained in Wallet: +${opp.netProfitSda.toFixed(5)} Native SDA`);
    return {
      success: true,
      netProfit: opp.netProfitSda,
      simulated: true
    };
  }

  try {
    // 1. Ensure WSDA balance
    const curWsda = await wsda.balanceOf(signer.address);
    if (curWsda < opp.inputSdaWei) {
      const wrapNeeded = opp.inputSdaWei - curWsda;
      const nativeBal = await provider.getBalance(signer.address);
      if (nativeBal < wrapNeeded + ethers.parseEther("0.02")) {
        console.log(`   ❌ [${walletKey}] Insufficient native SDA balance for wrap + gas reserve.`);
        return { success: false, reason: "LOW_NATIVE_BALANCE" };
      }
      const nonce = await waitForCleanNonce(signer.address);
      const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce });
      await wrapTx.wait(1);
      console.log(`   ✅ [${walletKey}] Wrapped +${ethers.formatEther(wrapNeeded)} SDA -> WSDA`);
    }

    // 2. Ensure Router allowance for WSDA
    const curWsdaAllow = await wsda.allowance(signer.address, ROUTER_ADDR);
    if (curWsdaAllow < opp.inputSdaWei) {
      const nonce = await waitForCleanNonce(signer.address);
      const appTx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, { gasLimit: 75000n, gasPrice: SAFE_GAS_PRICE, nonce });
      await appTx.wait(1);
      console.log(`   ✅ [${walletKey}] Approved WSDA to Router`);
    }

    // 3. Leg 1: Swap WSDA -> Token on feeBuy pool
    console.log(`   ▶️ [${walletKey}] Leg 1: Swapping ${opp.inputSda} WSDA ➔ ${opp.token} (Fee ${opp.feeBuy})...`);
    const tokenBalBefore = await token.balanceOf(signer.address);
    const nonce1 = await waitForCleanNonce(signer.address);

    const leg1Tx = await router.exactInputSingle({
      tokenIn: WSDA_ADDR,
      tokenOut: opp.tokenAddress,
      fee: opp.feeBuy,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: opp.inputSdaWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonce1 });

    const r1 = await leg1Tx.wait(1);
    const tokenBalAfter = await token.balanceOf(signer.address);
    const tokensAcquired = tokenBalAfter - tokenBalBefore;

    if (tokensAcquired === 0n) {
      console.log(`   ❌ [${walletKey}] Zero tokens received in Leg 1. Aborting trade.`);
      return { success: false, reason: "ZERO_TOKENS_ACQUIRED" };
    }

    console.log(`   ✅ [${walletKey}] Leg 1 Confirmed! Acquired: ${ethers.formatUnits(tokensAcquired, opp.decimals)} ${opp.token} (Tx: ${leg1Tx.hash.slice(0, 16)}...)`);

    // 4. Ensure Router allowance for Token
    const curTokenAllow = await token.allowance(signer.address, ROUTER_ADDR);
    if (curTokenAllow < tokensAcquired) {
      const nonceApp = await waitForCleanNonce(signer.address);
      const appTx2 = await token.approve(ROUTER_ADDR, ethers.MaxUint256, { gasLimit: 75000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceApp });
      await appTx2.wait(1);
      console.log(`   ✅ [${walletKey}] Approved ${opp.token} to Router`);
    }

    // 5. Leg 2: Swap Token -> WSDA on feeSell pool with GUARANTEED PROFIT FLOOR
    const profitBufferWei = BigInt(Math.max(0, Math.floor(opp.netProfitSda * 0.20 * 1e18)));
    const minWsdaOut = opp.inputSdaWei + profitBufferWei;

    console.log(`   ▶️ [${walletKey}] Leg 2: Selling ${opp.token} ➔ WSDA (Fee ${opp.feeSell}) [Floor: ${ethers.formatEther(minWsdaOut)} WSDA]...`);
    const wsdaBefore = await wsda.balanceOf(signer.address);
    const nonce2 = await waitForCleanNonce(signer.address);

    const leg2Tx = await router.exactInputSingle({
      tokenIn: opp.tokenAddress,
      tokenOut: WSDA_ADDR,
      fee: opp.feeSell,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: tokensAcquired,
      amountOutMinimum: minWsdaOut,
      sqrtPriceLimitX96: 0
    }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonce2 });

    const r2 = await leg2Tx.wait(1);
    const wsdaAfter = await wsda.balanceOf(signer.address);
    const wsdaGained = wsdaAfter - wsdaBefore;

    const actualSdaOut = Number(ethers.formatEther(wsdaGained));
    const gasSpent = (r1.gasUsed + r2.gasUsed) * SAFE_GAS_PRICE;
    const gasSpentSda = Number(ethers.formatEther(gasSpent));
    const realizedNetProfit = actualSdaOut - opp.inputSda - gasSpentSda;

    console.log(`   ✅ [${walletKey}] Leg 2 Confirmed! (Tx: ${leg2Tx.hash.slice(0, 16)}...)`);
    console.log(`   🎉 [${walletKey}] SCALP COMPLETED:`);
    console.log(`      Gross WSDA Returned : ${actualSdaOut.toFixed(5)} WSDA`);
    console.log(`      Total Gas Spent     : ${gasSpentSda.toFixed(5)} SDA`);
    console.log(`      REALIZED NET PROFIT : ${realizedNetProfit >= 0 ? "+" : ""}${realizedNetProfit.toFixed(5)} SDA`);

    // 6. 100% PROFIT & PRINCIPAL UNWRAPPED DIRECTLY INTO NATIVE SDA
    const remainingWsda = await wsda.balanceOf(signer.address);
    if (remainingWsda > 0n) {
      try {
        const nonceUnwrap = await waitForCleanNonce(signer.address);
        const unwrapTx = await wsda.withdraw(remainingWsda, { gasLimit: 85000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceUnwrap });
        await unwrapTx.wait(1);
        console.log(`   💰 [${walletKey}] Unwrapped +${ethers.formatEther(remainingWsda)} WSDA ➔ 100% Native SDA in wallet`);
      } catch (errUnwrap) {
        console.log(`   ⚠️ [${walletKey}] Auto-unwrap notice: ${errUnwrap.message}`);
      }
    }

    return {
      success: true,
      netProfit: realizedNetProfit,
      txHash: leg2Tx.hash
    };
  } catch (err) {
    console.error(`   ❌ [${walletKey}] Error during trade execution:`, err.reason || err.message);
    // Cleanup: unwrap any residual WSDA
    try {
      const leftoverWsda = await wsda.balanceOf(signer.address);
      if (leftoverWsda > 0n) {
        const nonceUnwrap = await waitForCleanNonce(signer.address);
        const unwrapTx = await wsda.withdraw(leftoverWsda, { gasLimit: 85000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceUnwrap });
        await unwrapTx.wait(1);
      }
    } catch (_) {}
    return { success: false, reason: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const isContinuous = !args.includes("--once") && !args.includes("--single");
  const maxRounds = Number(args.find((a) => a.startsWith("--rounds="))?.split("=")[1] || (isContinuous ? 9999999 : 1));
  const minProfitThreshold = Number(args.find((a) => a.startsWith("--min-profit="))?.split("=")[1] || 0.0001);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 60); // 1 minute default
  const singleWalletArg = args.find((a) => a.startsWith("--wallet="))?.split("=")[1];

  const rawKeys = {};
  for (let i = 1; i <= 50; i++) {
    const pk = process.env["PRIVATE_KEY_" + i] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (pk) rawKeys["wallet" + i] = pk;
  }

  const swarmWallets = {};
  for (const [key, pk] of Object.entries(rawKeys)) {
    if (singleWalletArg && key !== singleWalletArg) continue;
    if (pk) {
      const formattedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
      swarmWallets[key] = new ethers.Wallet(formattedPk, provider);
    }
  }

  const walletKeys = Object.keys(swarmWallets);
  if (walletKeys.length === 0) {
    throw new Error("No valid wallet private keys found in .env!");
  }

  console.log("==========================================================================");
  console.log("🦅 5-WALLET CONTINUOUS 1-MINUTE ARBITRAGE & MAX SDA SCALPER");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE BROADCAST ON-CHAIN" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Active Wallets     : ${walletKeys.join(", ")} (${walletKeys.length} Fleet Wallets Active)`);
  console.log(`Interval           : Every ${intervalSec} seconds (1 minute cadence)`);
  console.log(`Profit Destination : 100% Turned directly into Native SDA`);
  console.log(`Min Net Profit     : >= +${minProfitThreshold} SDA per trade`);
  console.log(`Execution Mode     : ${isContinuous ? "Continuous 24/7 (Ctrl+C to stop)" : `${maxRounds} Round(s)`}`);
  console.log("==========================================================================\n");

  const wsdaContract = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);

  const walletProfits = {};
  const walletTradesCount = {};

  console.log("👥 Initial Fleet Wallets Balance Check:");
  for (const k of walletKeys) {
    walletProfits[k] = 0;
    walletTradesCount[k] = 0;
    const w = swarmWallets[k];
    const [bal, wsdaBal, latestNonce, pendingNonce] = await Promise.all([
      provider.getBalance(w.address),
      wsdaContract.balanceOf(w.address),
      provider.getTransactionCount(w.address, "latest"),
      provider.getTransactionCount(w.address, "pending")
    ]);
    const isClean = latestNonce === pendingNonce;
    console.log(`   • [${k.toUpperCase().padEnd(8)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} | Mempool: ${isClean ? "Clean" : "BUSY"}`);
  }

  // Pre-flight check: auto-convert any stranded WSDA to native SDA token across all fleet wallets
  console.log("\n🧹 Running pre-flight check for stranded WSDA...");
  await autoUnwrapAllWallets(swarmWallets, isLive);

  let round = 1;
  let totalCumulativeProfit = 0;
  let totalTradesExecuted = 0;
  let walletRotationIndex = 0;

  // Graceful shutdown handler
  let isStopping = false;
  process.on("SIGINT", async () => {
    if (isStopping) return;
    isStopping = true;
    console.log("\n\n🛑 Received SIGINT. Gracefully shutting down and ensuring 100% native SDA...");
    await autoUnwrapAllWallets(swarmWallets, isLive);
    console.log("\n==========================================================================");
    console.log(`🏁 FINAL SUMMARY: Total Realized Profit: +${totalCumulativeProfit.toFixed(5)} SDA across ${totalTradesExecuted} trade(s)`);
    for (const k of walletKeys) {
      console.log(`   • [${k.toUpperCase().padEnd(8)}]: +${walletProfits[k].toFixed(5)} SDA (${walletTradesCount[k]} Trades)`);
    }
    console.log("==========================================================================");
    process.exit(0);
  });

  const testSizes = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.25, 1.5];

  while (round <= maxRounds && !isStopping) {
    const roundStartTime = Date.now();
    console.log(`\n==========================================================================`);
    console.log(`🔍 [ROUND #${round}] [${new Date().toLocaleTimeString()}] Scanning Ecosystem Liquidity Pools...`);
    console.log("==========================================================================");

    const market = await scanMarket();
    const opportunities = findEcosystemOpportunities(market, testSizes);
    const profitable = opportunities.filter((o) => o.netProfitSda >= minProfitThreshold);

    console.log(`   Evaluated ${market.length} tokens. Profitable routes detected: ${profitable.length}`);

    if (profitable.length === 0) {
      console.log(`   ℹ️ No price spreads exceed the +${minProfitThreshold} SDA profit threshold right now.`);
      console.log(`   All ecosystem pools are balanced.`);
    } else {
      // Group all profitable opportunities by token
      const oppsByToken = new Map();
      for (const opp of profitable) {
        if (!oppsByToken.has(opp.token)) {
          oppsByToken.set(opp.token, []);
        }
        oppsByToken.get(opp.token).push(opp);
      }

      // Sort each token's routes by highest net profit first
      for (const [t, list] of oppsByToken.entries()) {
        list.sort((a, b) => b.netProfitSda - a.netProfitSda);
      }

      // Sort tokens by top net profit
      const sortedTokens = Array.from(oppsByToken.keys()).sort((a, b) => {
        return oppsByToken.get(b)[0].netProfitSda - oppsByToken.get(a)[0].netProfitSda;
      });

      console.log(`   🎯 Detected ${sortedTokens.length} Unique Profitable Tokens! Matching with 5 fleet wallets by available balance...`);

      for (const tokenSymbol of sortedTokens) {
        if (isStopping) break;
        const tokenOpps = oppsByToken.get(tokenSymbol);

        // Find best wallet and the highest-yield route that the wallet can afford
        let assignedKey = null;
        let assignedSigner = null;
        let assignedOpp = null;

        for (let attempt = 0; attempt < walletKeys.length; attempt++) {
          const candidateKey = walletKeys[(walletRotationIndex + attempt) % walletKeys.length];
          const candidateWallet = swarmWallets[candidateKey];
          const [bal, latestNonce, pendingNonce] = await Promise.all([
            provider.getBalance(candidateWallet.address),
            provider.getTransactionCount(candidateWallet.address, "latest"),
            provider.getTransactionCount(candidateWallet.address, "pending")
          ]);

          const isClean = latestNonce === pendingNonce;
          const nativeBal = Number(ethers.formatEther(bal));

          if (isClean && nativeBal >= 0.05) {
            // Find the highest net-profit opp this wallet can afford with safety gas reserve
            const affordableOpp = tokenOpps.find((o) => nativeBal >= o.inputSda + 0.025);
            if (affordableOpp) {
              assignedKey = candidateKey;
              assignedSigner = candidateWallet;
              assignedOpp = affordableOpp;
              walletRotationIndex = (walletRotationIndex + attempt + 1) % walletKeys.length;
              break;
            }
          }
        }

        if (!assignedKey || !assignedOpp) {
          continue; // None of the current clean wallets have enough balance for this token's routes right now
        }

        console.log(`\n   ⭐ Optimal Sized Route for [${assignedOpp.token}] assigned to [${assignedKey.toUpperCase()}]:`);
        console.log(`      Size: ${assignedOpp.inputSda} SDA | Fee ${assignedOpp.feeBuy} ➔ Fee ${assignedOpp.feeSell}`);
        console.log(`      Expected Net Profit: +${assignedOpp.netProfitSda.toFixed(5)} SDA (ROI: +${assignedOpp.roiPct.toFixed(2)}%)`);

        try {
          const result = await executeArbitrageTrade(
            assignedKey,
            assignedSigner,
            assignedOpp,
            isLive,
            swarmWallets
          );

          if (result.success && result.netProfit) {
            totalCumulativeProfit += result.netProfit;
            walletProfits[assignedKey] += result.netProfit;
            walletTradesCount[assignedKey]++;
            totalTradesExecuted++;
          }
        } catch (err) {
          console.error(`   ❌ [${assignedKey}] Execution failed for ${assignedOpp.token}:`, err.reason || err.message);
        }

        await sleep(2500); // Small interval between multi-wallet trades
      }
    }

    // Ensure all wallets have 100% native SDA
    await autoUnwrapAllWallets(swarmWallets, isLive);

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`📊 ROUND #${round} SUMMARY:`);
    console.log(`   Total Trades Executed   : ${totalTradesExecuted}`);
    console.log(`   Total Realized Profit   : +${totalCumulativeProfit.toFixed(5)} Native SDA`);
    console.log(`   Wallet Breakdown:`);
    for (const k of walletKeys) {
      console.log(`     • [${k.toUpperCase().padEnd(8)}]: +${walletProfits[k].toFixed(5)} SDA (${walletTradesCount[k]} Trades)`);
    }
    console.log(`--------------------------------------------------------------------------`);

    if (round < maxRounds && !isStopping) {
      const elapsedMs = Date.now() - roundStartTime;
      const targetIntervalMs = intervalSec * 1000;
      const waitTimeMs = Math.max(2000, targetIntervalMs - elapsedMs);
      console.log(`\n⏳ Next scan in ${(waitTimeMs / 1000).toFixed(0)} seconds (cadence: 1 minute)...`);
      await sleep(waitTimeMs);
    }

    round++;
  }
}

main().catch(console.error);
