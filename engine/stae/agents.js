/**
 * SIDRA TEMPEST ARBITRAGE ENGINE (STAE) — 9 SPECIALIZED AI TRADING INTELLIGENCE AGENTS
 *
 * Agents:
 * 1. MARKET SCOUT        — Discovers verified V3 pools, cross-pool & multi-hop price differences
 * 2. ROUTE OPTIMIZER     — Evaluates trade sizes via BigInt math & Golden-Section risk-adjusted ranking
 * 3. LIQUIDITY ANALYST   — Evaluates virtual WSDA pool depth, concentration & price impact
 * 4. GAS ANALYST         — Queries dual RPCs, estimates atomic single-tx vs dual-leg gas
 * 5. RISK MANAGER        — Enforces deterministic capital protection policy (Final Authority)
 * 6. SECURITY ANALYST    — Runs T3MP3ST adapter checks on contracts, RPCs & configuration
 * 7. EXECUTION MONITOR   — Verifies staticCall quotes, atomic exactInput paths & receipts
 * 8. ACCOUNTING AGENT    — Reconciles pre/post wallet SDA, WSDA & GMAI balances in BigInt
 * 9. REPORTING AGENT     — Generates transparent telemetry, P&L & audit logs
 */

import { ethers } from "ethers";
import { quoteV3Swap } from "../router.js";

const WSDA_ADDR = "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const EXCLUDED_SYMBOLS = new Set(["SVM", "ATES"]);
const EXCLUDED_ADDRESSES = new Set([
  "0xfb1267fb3b9bdbce3a1c30a9b0a1454e14e81acb", // SVM (5% tax)
  "0x05322f2356e8ffdc28c4a5e69d4feebebbb33649"  // ATES (pool rejection risk)
]);

export class StaeAgentSwarm {
  constructor({ riskEngine, securityAdapter, ledger, primaryProvider, secondaryProvider }) {
    this.riskEngine = riskEngine;
    this.securityAdapter = securityAdapter;
    this.ledger = ledger;
    this.primaryProvider = primaryProvider;
    this.secondaryProvider = secondaryProvider;
  }

  /**
   * 1. MARKET SCOUT & 3. LIQUIDITY ANALYST:
   * Filters verified healthy pools with deep virtual WSDA liquidity and zero token tax.
   */
  discoverHealthyPools(market, minPoolLiquiditySda = 25.0) {
    const eligibleTokens = [];
    for (const token of market || []) {
      if (!token.address) continue;
      if (EXCLUDED_SYMBOLS.has(token.symbol) || EXCLUDED_ADDRESSES.has(token.address.toLowerCase())) {
        continue;
      }
      if (token.taxBps && token.taxBps > 0) continue;

      const deepPools = (token.pools || []).filter(
        (p) =>
          p.isHealthy &&
          p.spotPriceSda > 0 &&
          BigInt(p.liquidity || 0n) > 0n &&
          (p.virtualWsdaDepthSda || 0) >= minPoolLiquiditySda
      );

      if (deepPools.length >= 2) {
        eligibleTokens.push({
          ...token,
          deepPools
        });
      }
    }
    return eligibleTokens;
  }

  /**
   * 4. GAS ANALYST:
   * Queries network fee data and uses Sidra Chain's optimal 3.5 Gwei inclusion tier (~195,000 gas for 1-tx atomic exactInput).
   */
  async estimateOptimalGasPrice() {
    try {
      const feeData = await this.primaryProvider.getFeeData();
      const baseGas = feeData.gasPrice || 3500000000n;
      // Sidra Chain includes 3.5 Gwei transactions in the immediate block; clamp between 3.5 and 4.5 Gwei to prevent overpaying
      if (baseGas < 3500000000n) return 3500000000n;
      if (baseGas > 4500000000n) return 3500000000n;
      return baseGas;
    } catch {
      return 3500000000n;
    }
  }

  /**
   * 2. ROUTE OPTIMIZER:
   * Evaluates atomic cross-pool routes (WSDA --feeBuy--> Token --feeSell--> WSDA) using pure BigInt swap math
   * and ranks by Risk-Adjusted Expected Return.
   */
  discoverAndOptimizeAtomicRoutes(market, gasPriceWei = 3500000000n) {
    const minTradeSda = Number(ethers.formatEther(this.riskEngine.config.minTradeSizeWei));
    const maxTradeSda = Number(ethers.formatEther(this.riskEngine.config.maxTradeSizeWei));
    const minPoolLiquiditySda = this.riskEngine.config.minPoolLiquiditySda;
    const maxImpactPct = Number(this.riskEngine.config.maxPriceImpactBps) / 100;

    const eligibleTokens = this.discoverHealthyPools(market, minPoolLiquiditySda);
    const candidateRoutes = [];

    // Build size grid inside [minTradeSda, maxTradeSda]
    const testSizesSda = [];
    if (Math.abs(maxTradeSda - minTradeSda) < 0.001) {
      testSizesSda.push(minTradeSda);
    } else {
      const steps = 6;
      for (let s = 0; s <= steps; s++) {
        testSizesSda.push(Number((minTradeSda + ((maxTradeSda - minTradeSda) * s) / steps).toFixed(4)));
      }
    }

    for (const token of eligibleTokens) {
      const pools = token.deepPools;
      for (let i = 0; i < pools.length; i++) {
        for (let j = 0; j < pools.length; j++) {
          if (i === j) continue;
          const poolBuy = pools[i];
          const poolSell = pools[j];

          const combinedFeeRate = (poolBuy.feeTier + poolSell.feeTier) / 1000000;
          if (poolSell.spotPriceSda <= poolBuy.spotPriceSda * (1 + combinedFeeRate)) continue;

          let bestForPair = null;

          for (const sizeSda of testSizesSda) {
            const evalRes = this.evaluateAtomicCrossPoolRoute(token, poolBuy, poolSell, sizeSda, gasPriceWei);
            if (!evalRes) continue;
            if (evalRes.priceImpactPct > maxImpactPct) continue;
            if (evalRes.netProfitWei < this.riskEngine.config.minNetProfitWei) continue;

            if (!bestForPair || evalRes.riskAdjustedScore > bestForPair.riskAdjustedScore) {
              bestForPair = evalRes;
            }
          }

          if (bestForPair) {
            candidateRoutes.push(bestForPair);
          }
        }
      }
    }

    // Rank by Risk-Adjusted Expected Return (descending)
    return candidateRoutes.sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);
  }

  /**
   * Evaluates a single atomic cross-pool route:
   * Path: WSDA --(feeBuy)--> Token --(feeSell)--> WSDA executed via Router.exactInput in 1 atomic tx!
   */
  evaluateAtomicCrossPoolRoute(token, poolBuy, poolSell, sizeSda, gasPriceWei) {
    const amountInWei = ethers.parseUnits(sizeSda.toFixed(6), 18);

    const buyQuote = quoteV3Swap(
      amountInWei,
      BigInt(poolBuy.sqrtPriceX96),
      BigInt(poolBuy.liquidity),
      poolBuy.feeTier,
      token.taxBps || 0,
      poolBuy.isToken0WSDA
    );

    if (!buyQuote.amountOut || buyQuote.amountOut <= 0n) return null;

    const sellQuote = quoteV3Swap(
      buyQuote.amountOut,
      BigInt(poolSell.sqrtPriceX96),
      BigInt(poolSell.liquidity),
      poolSell.feeTier,
      token.taxBps || 0,
      !poolSell.isToken0WSDA
    );

    if (!sellQuote.amountOut || sellQuote.amountOut <= 0n) return null;

    // Atomic single-transaction Router.exactInput uses ~195,000 gas total (1 tx instead of 2!)
    const profitCalc = this.riskEngine.calculateExactProfitBigInt({
      amountInWei,
      expectedOutWei: sellQuote.amountOut,
      gasLimitUnits: 195000n,
      gasPriceWei
    });

    const maxImpactPct = Math.max(buyQuote.priceImpactPct, sellQuote.priceImpactPct);
    const minPoolDepth = Math.min(poolBuy.virtualWsdaDepthSda || 0, poolSell.virtualWsdaDepthSda || 0);
    const netProfitSda = Number(ethers.formatEther(profitCalc.netProfitWei));

    // Risk-Adjusted Score: rewards high net profit and deep liquidity, penalizes price impact
    const liquidityConfidence = Math.min(1.5, Math.log10(Math.max(10, minPoolDepth)) / 2.5);
    const impactPenalty = 1 + maxImpactPct * 0.65;
    const riskAdjustedScore = (netProfitSda * liquidityConfidence) / impactPenalty;

    // Encode V3 multi-hop atomic path: WSDA -> feeBuy -> Token -> feeSell -> WSDA
    const atomicPathBytes = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [WSDA_ADDR, poolBuy.feeTier, token.address, poolSell.feeTier, WSDA_ADDR]
    );

    return {
      opportunityId: `STAE-${token.symbol}-${poolBuy.feeTier}-${poolSell.feeTier}-${Date.now()}`,
      strategyType: "CROSS_POOL_ATOMIC_EXACT_INPUT",
      isAtomic: true,
      token: token.symbol,
      tokenAddress: token.address,
      decimals: token.decimals || 18,
      taxBps: token.taxBps || 0,
      feeBuy: poolBuy.feeTier,
      feeSell: poolSell.feeTier,
      poolBuyAddress: poolBuy.poolAddress,
      poolSellAddress: poolSell.poolAddress,
      buyLiquiditySda: poolBuy.virtualWsdaDepthSda || 0,
      sellLiquiditySda: poolSell.virtualWsdaDepthSda || 0,
      inputSda: sizeSda,
      amountInWei,
      expectedMidTokensWei: buyQuote.amountOut,
      expectedOutWei: sellQuote.amountOut,
      expectedOutSda: Number(ethers.formatEther(sellQuote.amountOut)),
      grossProfitWei: profitCalc.grossProfitWei,
      totalGasCostWei: profitCalc.totalGasCostWei,
      gasCostSda: Number(ethers.formatEther(profitCalc.totalGasCostWei)),
      netProfitWei: profitCalc.netProfitWei,
      netProfitSda,
      roiPct: Number(profitCalc.roiBps) / 100,
      priceImpactPct: maxImpactPct,
      riskAdjustedScore,
      atomicPathBytes
    };
  }
}
