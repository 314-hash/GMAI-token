import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // Guarantee fast IPv4 connections and prevent ETIMEDOUT

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import { scanMarket } from "./scanner.js";
import { quoteV3Swap } from "./router.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");

/* ============================================================
   CONSTANTS & NETWORK DEFINITION
============================================================ */
export const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
export const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
export const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });

export const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
export const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
export const GMAI_ADDR = process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || process.env.RIDE_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
export const GMAI_POOL_ADDR = process.env.POOL_ADDRESS || process.env.RIDE_POOL_ADDRESS || "0x64F21bC91D11531D88A16075d5E961d33f10B6eA";
export const GMAI_POOL_FEE = Number(process.env.POOL_FEE || process.env.RIDE_POOL_FEE || "10000");

export const SAFE_GAS_PRICE = 2500000000n; // 2.5 Gwei

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

export const WSDA_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

export const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getLatestNonce(provider, address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

export async function waitForCleanNonce(provider, address, timeoutMs = 45000) {
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
 * Evaluates dynamic size spectrum across 42 tokens to find spatial cross-pool arbitrage opportunities
 */
export function findTokenOpportunities(market, testSizes = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]) {
  const opps = [];
  const gasEstimate = 320000n; // ~160k gas per leg * 2 legs
  const totalGasCostSda = Number(ethers.formatUnits(gasEstimate * SAFE_GAS_PRICE, 18)); // ~0.0008 SDA

  for (const token of market) {
    // Exclude SVM from cross-pool DEX arb because of 5% sell tax
    if (token.symbol === "SVM") continue;
    if (!token.pools || token.pools.length < 2) continue;

    const healthyPools = token.pools.filter((p) => p.isHealthy && p.spotPriceSda > 0 && p.liquidity > 0n);
    if (healthyPools.length < 2) continue;

    for (let i = 0; i < healthyPools.length; i++) {
      for (let j = 0; j < healthyPools.length; j++) {
        if (i === j) continue;
        const poolBuy = healthyPools[i];
        const poolSell = healthyPools[j];

        // Only evaluate if spot price spread is positive after fees
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
              inputSdaWei: sdaInWei.toString(),
              expectedOutSda: sdaOut,
              expectedOutSdaWei: sellQuote.amountOut.toString(),
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

  // Sort by net profit descending (highest absolute profit in SDA first)
  return opps.sort((a, b) => b.netProfitSda - a.netProfitSda);
}

/* ============================================================
   ARBITRAGE + 40% GMAI LIQUIDITY ENGINE CLASS
============================================================ */
export class ArbitrageGmaiEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this.provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
    this.isLive = options.isLive || false;
    this.minProfitThreshold = Number(options.minProfitThreshold || 0.0005); // min +0.0005 SDA net
    this.intervalSec = Number(options.intervalSec || 15);
    this.maxRounds = Number(options.maxRounds || 0); // 0 = continuous
    this.unwrapWsda = options.unwrapWsda !== false; // Default true: auto-unwrap 60% profit to native SDA
    this.gmaiProfitRatio = Number(options.gmaiProfitRatio || 0.40); // 40% of profit to GMAI liquidity

    this.isRunning = false;
    this.isExecutingScan = false;
    this.isTerminating = false;

    this.stats = {
      roundsScanned: 0,
      totalOpportunitiesFound: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      grossProfitSda: 0,
      totalGasSpentSda: 0,
      netProfitSda: 0,
      accumulatedNativeSda: 0, // 60% banked
      gmaiLiquidityInjectedSda: 0, // 40% routed to GMAI pool
      gmaiTokensAcquired: 0,
      lastScanTime: null,
      walletStats: {}
    };

    this.activeOpportunities = [];
    this.wallets = {};
    this.initWallets();
  }

  initWallets() {
    const rawKeys = {
      wallet1: process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY,
      wallet2: process.env.PRIVATE_KEY_2,
      wallet3: process.env.PRIVATE_KEY_3,
      wallet4: process.env.PRIVATE_KEY_4,
      wallet5: process.env.PRIVATE_KEY_5
    };

    for (const [key, pk] of Object.entries(rawKeys)) {
      if (pk) {
        const formattedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
        const wallet = new ethers.Wallet(formattedPk, this.provider);
        this.wallets[key] = wallet;
        this.stats.walletStats[key] = {
          address: wallet.address,
          trades: 0,
          netProfitSda: 0,
          gmaiInjectedSda: 0
        };
      }
    }
  }

  log(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta
    };
    this.emit("log", entry);
    const prefix = level === "error" ? "❌" : (level === "warn" ? "⚠️" : (level === "success" ? "🎉" : "ℹ️"));
    console.log(`[${entry.timestamp.slice(11, 19)}] ${prefix} ${message}`);
  }

  async getWalletsOverview() {
    const wsdaContract = new ethers.Contract(WSDA_ADDR, ERC20_ABI, this.provider);
    const gmaiContract = new ethers.Contract(GMAI_ADDR, ERC20_ABI, this.provider);

    const overview = [];
    for (const [key, wallet] of Object.entries(this.wallets)) {
      try {
        const [nativeBal, wsdaBal, gmaiBal, latestNonce, pendingNonce] = await Promise.all([
          this.provider.getBalance(wallet.address),
          wsdaContract.balanceOf(wallet.address),
          gmaiContract.balanceOf(wallet.address),
          this.provider.getTransactionCount(wallet.address, "latest"),
          this.provider.getTransactionCount(wallet.address, "pending")
        ]);

        overview.push({
          key,
          address: wallet.address,
          nativeSda: Number(ethers.formatEther(nativeBal)),
          wsda: Number(ethers.formatEther(wsdaBal)),
          gmai: Number(ethers.formatEther(gmaiBal)),
          nonce: latestNonce,
          isClean: latestNonce === pendingNonce
        });
      } catch (err) {
        overview.push({
          key,
          address: wallet.address,
          error: err.message
        });
      }
    }
    return overview;
  }

  /**
   * Executes Leg 1 (WSDA -> Token), Leg 2 (Token -> WSDA),
   * and immediately routes 40% of net profit into GMAI Liquidity pool.
   */
  async executeTrade(walletKey, signer, opp) {
    const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const token = new ethers.Contract(opp.tokenAddress, ERC20_ABI, signer);
    const gmai = new ethers.Contract(GMAI_ADDR, ERC20_ABI, signer);

    this.log("info", `[${walletKey.toUpperCase()}] Initiating Arb: ${opp.token} (${opp.inputSda} SDA) | Buy Fee ${opp.feeBuy} ➔ Sell Fee ${opp.feeSell}`);

    if (!this.isLive) {
      this.log("info", `[DRY-RUN] ${opp.token} profit calculated mathematically: +${opp.netProfitSda.toFixed(5)} SDA`);
      const simSdaAcc = opp.netProfitSda * (1 - this.gmaiProfitRatio);
      const simGmaiLp = opp.netProfitSda * this.gmaiProfitRatio;
      return {
        success: true,
        simulated: true,
        netProfitSda: opp.netProfitSda,
        sdaAccumulated: simSdaAcc,
        gmaiInjectedSda: simGmaiLp
      };
    }

    const inputSdaWei = typeof opp.inputSdaWei === "bigint" ? opp.inputSdaWei : BigInt(opp.inputSdaWei);

    // 1. Ensure WSDA balance
    const curWsda = await wsda.balanceOf(signer.address);
    if (curWsda < inputSdaWei) {
      const wrapNeeded = inputSdaWei - curWsda;
      const nativeBal = await this.provider.getBalance(signer.address);
      if (nativeBal < wrapNeeded + ethers.parseEther("0.02")) {
        this.log("warn", `[${walletKey}] Insufficient native SDA balance for wrap + gas reserve.`);
        return { success: false, reason: "LOW_NATIVE_BALANCE" };
      }
      const nonce = await waitForCleanNonce(this.provider, signer.address);
      const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce });
      await wrapTx.wait(1);
      this.log("success", `[${walletKey}] Wrapped +${ethers.formatEther(wrapNeeded)} SDA -> WSDA`);
    }

    // 2. Ensure Router allowance for WSDA
    const curWsdaAllow = await wsda.allowance(signer.address, ROUTER_ADDR);
    if (curWsdaAllow < inputSdaWei) {
      const nonce = await waitForCleanNonce(this.provider, signer.address);
      const appTx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, { gasLimit: 75000n, gasPrice: SAFE_GAS_PRICE, nonce });
      await appTx.wait(1);
      this.log("success", `[${walletKey}] Approved WSDA to Router`);
    }

    // 3. Leg 1: Swap WSDA -> Token on feeBuy pool
    this.log("info", `[${walletKey}] Leg 1: Swapping ${opp.inputSda} WSDA -> ${opp.token} (Fee ${opp.feeBuy})...`);
    const tokenBalBefore = await token.balanceOf(signer.address);
    const nonce1 = await waitForCleanNonce(this.provider, signer.address);

    const leg1Tx = await router.exactInputSingle({
      tokenIn: WSDA_ADDR,
      tokenOut: opp.tokenAddress,
      fee: opp.feeBuy,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: inputSdaWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonce1 });

    const r1 = await leg1Tx.wait(1);
    const tokenBalAfter = await token.balanceOf(signer.address);
    const tokensAcquired = tokenBalAfter - tokenBalBefore;

    if (tokensAcquired === 0n) {
      this.log("error", `[${walletKey}] Zero tokens received in Leg 1. Aborting trade.`);
      return { success: false, reason: "ZERO_TOKENS_ACQUIRED" };
    }

    this.log("success", `[${walletKey}] Leg 1 Confirmed! Acquired ${ethers.formatUnits(tokensAcquired, opp.decimals)} ${opp.token} (Tx: ${leg1Tx.hash.slice(0, 16)}...)`);

    // 4. Ensure Router allowance for Token
    const curTokenAllow = await token.allowance(signer.address, ROUTER_ADDR);
    if (curTokenAllow < tokensAcquired) {
      const nonceApp = await waitForCleanNonce(this.provider, signer.address);
      const appTx2 = await token.approve(ROUTER_ADDR, ethers.MaxUint256, { gasLimit: 75000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceApp });
      await appTx2.wait(1);
    }

    // 5. Leg 2: Swap Token -> WSDA on feeSell pool with STRICT PRINCIPAL & PROFIT PROTECTION
    const profitBufferWei = BigInt(Math.max(0, Math.floor(opp.netProfitSda * 0.25 * 1e18)));
    const minWsdaOut = inputSdaWei + profitBufferWei;

    this.log("info", `[${walletKey}] Leg 2: Selling ${opp.token} -> WSDA (Fee ${opp.feeSell}) [Floor: ${ethers.formatEther(minWsdaOut)} WSDA]...`);
    const wsdaBefore = await wsda.balanceOf(signer.address);
    const nonce2 = await waitForCleanNonce(this.provider, signer.address);

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

    this.log("success", `[${walletKey}] Leg 2 Confirmed! Gross Out: ${actualSdaOut.toFixed(5)} WSDA | Realized Net: +${realizedNetProfit.toFixed(5)} SDA`);

    // 6. ALLOCATE 40% OF NET PROFIT TO GMAI LIQUIDITY
    let sdaBanked = realizedNetProfit;
    let sdaToGmaiLp = 0;
    let gmaiAcquired = 0n;

    if (realizedNetProfit > 0) {
      sdaToGmaiLp = realizedNetProfit * this.gmaiProfitRatio;
      sdaBanked = realizedNetProfit * (1 - this.gmaiProfitRatio);

      const sdaGmaiWei = ethers.parseEther(sdaToGmaiLp.toFixed(18));
      if (sdaGmaiWei > 100000000000000n) { // > 0.0001 SDA
        try {
          this.log("info", `[${walletKey}] 🚀 ROUTING 40% PROFIT (+${sdaToGmaiLp.toFixed(5)} SDA) TO GMAI LIQUIDITY...`);
          const gmaiBalBefore = await gmai.balanceOf(signer.address);
          const nonceLp = await waitForCleanNonce(this.provider, signer.address);

          const lpTx = await router.exactInputSingle({
            tokenIn: WSDA_ADDR,
            tokenOut: GMAI_ADDR,
            fee: GMAI_POOL_FEE,
            recipient: signer.address,
            deadline: Math.floor(Date.now() / 1000) + 300,
            amountIn: sdaGmaiWei,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0
          }, { gasLimit: 250000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });

          const rLp = await lpTx.wait(1);
          const gmaiBalAfter = await gmai.balanceOf(signer.address);
          gmaiAcquired = gmaiBalAfter - gmaiBalBefore;

          this.log("success", `[${walletKey}] 💧 GMAI LIQUIDITY BOOSTED: Injected ${sdaToGmaiLp.toFixed(5)} WSDA into Pool | Acquired +${ethers.formatEther(gmaiAcquired)} GMAI (Tx: ${lpTx.hash.slice(0, 16)}...)`);
        } catch (errLp) {
          this.log("error", `[${walletKey}] Failed routing 40% profit to GMAI LP: ${errLp.message}`);
        }
      }
    }

    // 7. Auto-unwrap the 60% banked profit + principal to native SDA for bankable liquidity
    if (this.unwrapWsda) {
      try {
        const wsdaBalToUnwrap = await wsda.balanceOf(signer.address);
        if (wsdaBalToUnwrap > 0n) {
          const nonceUnwrap = await waitForCleanNonce(this.provider, signer.address);
          const unwrapTx = await wsda.withdraw(wsdaBalToUnwrap, { gasLimit: 85000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceUnwrap });
          await unwrapTx.wait(1);
          this.log("success", `[${walletKey}] 💰 Banked ${ethers.formatEther(wsdaBalToUnwrap)} WSDA -> Native SDA in Wallet!`);
        }
      } catch (errUnwrap) {
        this.log("warn", `[${walletKey}] Auto-unwrap notice: ${errUnwrap.message}`);
      }
    }

    return {
      success: true,
      netProfitSda: realizedNetProfit,
      sdaAccumulated: sdaBanked,
      gmaiInjectedSda: sdaToGmaiLp,
      gmaiTokensAcquired: Number(ethers.formatEther(gmaiAcquired)),
      txHash: leg2Tx.hash
    };
  }

  /**
   * Scans 42 tokens, finds all arbitrage opportunities, and executes the best route per token
   */
  async runScanRound(roundNumber) {
    if (this.isExecutingScan) return;
    this.isExecutingScan = true;

    this.log("info", `🔍 [ROUND #${roundNumber}] Scanning 42 Ecosystem Contracts across fee tiers (500, 3000, 10000)...`);
    const t0 = Date.now();

    try {
      const market = await scanMarket(this.provider);
      const scanElapsed = Date.now() - t0;
      this.stats.lastScanTime = new Date().toISOString();

      const testSizes = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.25, 1.5];
      const opportunities = findTokenOpportunities(market, testSizes);
      const profitable = opportunities.filter((o) => o.netProfitSda >= this.minProfitThreshold);

      this.activeOpportunities = profitable;
      this.stats.totalOpportunitiesFound += profitable.length;
      this.emit("opportunities", profitable);

      this.log("info", `Scan finished in ${(scanElapsed / 1000).toFixed(1)}s. Found ${profitable.length} profitable arbitrage route(s) >= +${this.minProfitThreshold} SDA.`);

      if (profitable.length === 0) {
        this.log("info", `All ecosystem pools balanced within gas thresholds.`);
        this.isExecutingScan = false;
        return;
      }

      // Group profitable opportunities by token
      const oppsByToken = new Map();
      for (const opp of profitable) {
        if (!oppsByToken.has(opp.token)) {
          oppsByToken.set(opp.token, []);
        }
        oppsByToken.get(opp.token).push(opp);
      }

      // Sort tokens by their peak profit opportunity
      const tokenList = Array.from(oppsByToken.keys()).sort((a, b) => {
        const maxA = Math.max(...oppsByToken.get(a).map((o) => o.netProfitSda));
        const maxB = Math.max(...oppsByToken.get(b).map((o) => o.netProfitSda));
        return maxB - maxA;
      });

      this.log("info", `🎯 Distributing optimal routes for ${tokenList.length} unique token(s) across fleet wallets...`);

      const walletKeys = Object.keys(this.wallets);
      let walletRotationIndex = 0;

      for (const tokenSymbol of tokenList) {
        if (this.isTerminating) break;

        const tokenOpps = oppsByToken.get(tokenSymbol);

        // Find a clean wallet and pick the best opportunity it can afford
        let selectedKey = null;
        let selectedSigner = null;
        let selectedOpp = null;

        for (let attempt = 0; attempt < walletKeys.length; attempt++) {
          const candidateKey = walletKeys[(walletRotationIndex + attempt) % walletKeys.length];
          const candidateWallet = this.wallets[candidateKey];
          const [bal, latestNonce, pendingNonce] = await Promise.all([
            this.provider.getBalance(candidateWallet.address),
            this.provider.getTransactionCount(candidateWallet.address, "latest"),
            this.provider.getTransactionCount(candidateWallet.address, "pending")
          ]);

          const nativeBal = Number(ethers.formatEther(bal));
          const maxAffordable = Math.max(0, nativeBal - 0.03); // Leave 0.03 SDA for gas reserve

          // Filter opportunities this wallet can afford
          const affordableOpps = tokenOpps.filter((o) => o.inputSda <= maxAffordable && o.netProfitSda >= this.minProfitThreshold);

          if (latestNonce === pendingNonce && affordableOpps.length > 0) {
            // Pick highest net profit among affordable sizes
            affordableOpps.sort((a, b) => b.netProfitSda - a.netProfitSda);
            selectedOpp = affordableOpps[0];
            selectedKey = candidateKey;
            selectedSigner = candidateWallet;
            walletRotationIndex = (walletRotationIndex + attempt + 1) % walletKeys.length;
            break;
          }
        }

        if (!selectedKey || !selectedOpp) {
          this.log("warn", `No available wallet has sufficient funds for any profitable size on ${tokenSymbol}. Skipping.`);
          continue;
        }

        try {
          const res = await this.executeTrade(selectedKey, selectedSigner, selectedOpp);
          if (res.success) {
            this.stats.tradesExecuted++;
            this.stats.netProfitSda += res.netProfitSda;
            this.stats.accumulatedNativeSda += res.sdaAccumulated || 0;
            this.stats.gmaiLiquidityInjectedSda += res.gmaiInjectedSda || 0;
            this.stats.gmaiTokensAcquired += res.gmaiTokensAcquired || 0;

            if (this.stats.walletStats[selectedKey]) {
              this.stats.walletStats[selectedKey].trades++;
              this.stats.walletStats[selectedKey].netProfitSda += res.netProfitSda;
              this.stats.walletStats[selectedKey].gmaiInjectedSda += res.gmaiInjectedSda || 0;
            }

            this.emit("trade_executed", {
              token: selectedOpp.token,
              wallet: selectedKey,
              res
            });
          } else {
            this.stats.tradesFailed++;
          }
        } catch (err) {
          this.stats.tradesFailed++;
          this.log("error", `[${selectedKey}] Execution error on ${selectedOpp.token}: ${err.reason || err.message}`);
        }

        await sleep(3000);
      }
    } catch (errScan) {
      this.log("error", `Market scan round error: ${errScan.message}`);
    } finally {
      this.isExecutingScan = false;
      this.stats.roundsScanned++;
      this.emit("stats", this.getStats());
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isTerminating = false;

    this.log("info", `🚀 Starting 42-Token Arbitrage & GMAI LP Engine [Mode: ${this.isLive ? "LIVE BROADCAST" : "DRY-RUN SIMULATION"}]`);
    this.log("info", `💧 Profit Distribution: 60% Banked Native SDA | 40% Routed to GMAI Liquidity Pool`);

    let round = 1;
    while (this.isRunning && !this.isTerminating) {
      await this.runScanRound(round);

      if (this.maxRounds > 0 && round >= this.maxRounds) {
        this.log("info", `🏁 Reached max configured rounds (${this.maxRounds}). Engine finished.`);
        break;
      }

      this.log("info", `⏳ Next scan round in ${this.intervalSec} seconds...`);
      for (let s = 0; s < this.intervalSec; s++) {
        if (!this.isRunning || this.isTerminating) break;
        await sleep(1000);
      }
      round++;
    }

    this.isRunning = false;
    this.isTerminating = false;
    this.log("info", `🛑 Arbitrage engine stopped.`);
  }

  stop() {
    this.log("info", `Signaling graceful stop for arbitrage engine...`);
    this.isTerminating = true;
    this.isRunning = false;
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      isExecutingScan: this.isExecutingScan,
      isLive: this.isLive,
      minProfitThreshold: this.minProfitThreshold,
      intervalSec: this.intervalSec,
      gmaiProfitRatio: this.gmaiProfitRatio,
      ...this.stats
    };
  }
}
