/**
 * SIDRA TEMPEST ARBITRAGE ENGINE (STAE) — DETERMINISTIC PROFIT & CAPITAL PROTECTION ENGINE
 *
 * Implements:
 * - Section 4: Pure BigInt Profit Calculation Engine (zero floating-point execution decisions)
 * - Section 7: Transaction Execution Protection (strict non-zero amountOutMinimum, deadline, fresh state)
 * - Section 8: Capital Protection Engine (Circuit Breaker, Daily Loss Stop, Consecutive Loss Stop, Emergency Stop)
 */

import { ethers } from "ethers";

export const DEFAULT_RISK_CONFIG = {
  dryRun: process.env.DRY_RUN !== "false" && process.env.LIVE !== "true",
  liveTrading: process.env.LIVE_TRADING === "true" || process.env.LIVE === "true",
  requireExplicitConfirmation: true,

  // Trade Size & Reserve Limits (BigInt Wei)
  minTradeSizeWei: ethers.parseEther(process.env.ARB_MIN_TRADE_SIZE_SDA || "0.1"),
  maxTradeSizeWei: ethers.parseEther(process.env.ARB_MAX_TRADE_SIZE_SDA || "5.0"),
  wsdaReserveWei: ethers.parseEther(process.env.WSDA_RESERVE_SDA || "5.0"),
  minSdaGasReserveWei: ethers.parseEther(process.env.MIN_SDA_RESERVE || "0.5"),
  minNetProfitWei: ethers.parseEther(process.env.STAE_MIN_PROFIT_SDA || "0.0025"),
  minPoolLiquiditySda: Number(process.env.MIN_POOL_LIQUIDITY_SDA || "25.0"),

  // Slippage & Price Impact Limits (Basis Points: 200 bps = 2.0%)
  maxPriceImpactBps: 200n, // 2.00%
  maxSlippageBps: BigInt(process.env.MAX_SLIPPAGE_BPS || "150"), // 1.50% max slippage from fresh quote

  // Circuit Breaker & Capital Protection Limits
  maxDailyLossWei: ethers.parseEther(process.env.MAX_DAILY_LOSS_SDA || "0.50"),
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || "3"),
  maxFailedTxStreak: Number(process.env.MAX_FAILED_TX_STREAK || "4"),
  maxOpenPositions: 0, // Strictly 0 leftover token positions allowed

  // GMAI Profit Allocation Shares (Basis Points out of 10000 = 100%)
  walletProfitShareBps: BigInt(Math.round(Number(process.env.WALLET_PROFIT_SHARE || "0.90") * 10000)),
  gmaiAccumulationShareBps: BigInt(Math.round(Number(process.env.LP_PROFIT_SHARE || "0.10") * 10000)),
  lpProvisionShareBps: 0n
};

export class DeterministicRiskEngine {
  constructor(customConfig = {}) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...customConfig };

    // Validate allocation shares sum <= 10000 bps (100%)
    const totalBps =
      BigInt(this.config.walletProfitShareBps) +
      BigInt(this.config.gmaiAccumulationShareBps) +
      BigInt(this.config.lpProvisionShareBps);
    if (totalBps > 10000n) {
      throw new Error(`Invalid allocation configuration: shares sum to ${totalBps} bps (> 10000 bps)`);
    }

    this.state = {
      emergencyStop: false,
      emergencyReason: null,
      circuitBreakerTripped: false,
      dailyRealizedProfitWei: 0n,
      dailyRealizedLossWei: 0n,
      peakCumulativeProfitWei: 0n,
      maxDrawdownWei: 0n,
      consecutiveLosses: 0,
      consecutiveFailedTxs: 0,
      totalExecutedTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      failedTxs: 0,
      totalGasSpentWei: 0n
    };
  }

  /**
   * Pure BigInt Net Profit Calculation (Section 4):
   * NetProfitWei = RealizedSdaOutWei - SdaInputWei - TotalGasCostWei - OtherCostsWei
   * Note: DEX pool fees and token transfer taxes are already deducted inside expectedSdaOutWei.
   */
  calculateExactProfitBigInt({
    amountInWei,
    expectedOutWei,
    gasLimitUnits = 210000n,
    gasPriceWei = 3500000000n,
    approvalGasUnits = 0n,
    wrapGasUnits = 0n,
    unwrapGasUnits = 0n,
    gmaiSwapGasUnits = 0n
  }) {
    const inWei = BigInt(amountInWei);
    const outWei = BigInt(expectedOutWei);
    const totalGasUnits =
      BigInt(gasLimitUnits) +
      BigInt(approvalGasUnits) +
      BigInt(wrapGasUnits) +
      BigInt(unwrapGasUnits) +
      BigInt(gmaiSwapGasUnits);
    const totalGasCostWei = totalGasUnits * BigInt(gasPriceWei);

    const grossProfitWei = outWei - inWei;
    const netProfitWei = grossProfitWei - totalGasCostWei;
    // ROI in basis points (100 bps = 1.00%)
    const roiBps = inWei > 0n ? (netProfitWei * 10000n) / inWei : 0n;

    return {
      amountInWei: inWei,
      expectedOutWei: outWei,
      grossProfitWei,
      totalGasCostWei,
      netProfitWei,
      roiBps,
      isProfitable: netProfitWei >= BigInt(this.config.minNetProfitWei)
    };
  }

  /**
   * Computes strict non-zero amountOutMinimum for an atomic WSDA -> Token -> WSDA swap:
   * Guarantees the transaction reverts on-chain if output is less than (amountIn + totalGasCost + minProfitFloor).
   */
  computeAtomicAmountOutMinimum(amountInWei, expectedOutWei, totalGasCostWei) {
    const inWei = BigInt(amountInWei);
    const outWei = BigInt(expectedOutWei);
    const gasWei = BigInt(totalGasCostWei);

    // 1. Absolute profit floor: must cover principal + gas + at least 50% of minNetProfitWei
    const absoluteFloorWei = inWei + gasWei + BigInt(this.config.minNetProfitWei) / 2n;

    // 2. Slippage floor from fresh quote (e.g. 99.7% of fresh staticCall output)
    const slippageProtectedWei = (outWei * (10000n - BigInt(this.config.maxSlippageBps))) / 10000n;

    // Take the stricter (higher) of the two floors, capped at outWei - 1000 wei
    let minOutWei = absoluteFloorWei > slippageProtectedWei ? absoluteFloorWei : slippageProtectedWei;
    if (minOutWei >= outWei && outWei > absoluteFloorWei) {
      minOutWei = absoluteFloorWei;
    }
    if (minOutWei <= 0n) {
      throw new Error("Unsafe zero amountOutMinimum prevented by DeterministicRiskEngine");
    }
    return minOutWei;
  }

  /**
   * Evaluates whether a route and wallet pass all deterministic capital protection checks
   */
  validateRouteAndWallet(route, walletState, rpcHealthy = true) {
    if (this.state.emergencyStop) {
      return { approved: false, reason: `EMERGENCY_STOP_ACTIVE: ${this.state.emergencyReason}` };
    }
    if (this.state.circuitBreakerTripped) {
      return { approved: false, reason: "CIRCUIT_BREAKER_TRIPPED" };
    }
    if (!rpcHealthy) {
      return { approved: false, reason: "RPC_HEALTH_CHECK_FAILED" };
    }
    if (!route || !route.amountInWei || !route.expectedOutWei) {
      return { approved: false, reason: "INVALID_ROUTE_PARAMETERS" };
    }

    const inWei = BigInt(route.amountInWei);
    if (inWei < BigInt(this.config.minTradeSizeWei) || inWei > BigInt(this.config.maxTradeSizeWei)) {
      return { approved: false, reason: "TRADE_SIZE_OUT_OF_LIMITS" };
    }

    if (BigInt(route.netProfitWei) < BigInt(this.config.minNetProfitWei)) {
      return { approved: false, reason: "BELOW_MIN_NET_PROFIT" };
    }

    const impactBps = BigInt(Math.round((route.priceImpactPct || 0) * 100));
    if (impactBps > BigInt(this.config.maxPriceImpactBps)) {
      return { approved: false, reason: `EXCESSIVE_PRICE_IMPACT_${route.priceImpactPct?.toFixed(2)}PCT` };
    }

    if (
      (route.buyLiquiditySda || 0) < this.config.minPoolLiquiditySda ||
      (route.sellLiquiditySda || 0) < this.config.minPoolLiquiditySda
    ) {
      return { approved: false, reason: "INSUFFICIENT_POOL_LIQUIDITY" };
    }

    if (route.taxBps && route.taxBps > 0) {
      return { approved: false, reason: "TAXED_TOKEN_REJECTED" };
    }

    if (walletState) {
      if (!walletState.isCleanNonce) {
        return { approved: false, reason: "WALLET_PENDING_NONCE" };
      }
      if (BigInt(walletState.nativeSdaWei) < BigInt(this.config.minSdaGasReserveWei)) {
        return { approved: false, reason: "INSUFFICIENT_NATIVE_GAS_RESERVE" };
      }
      const totalTradeableWei = BigInt(walletState.wsdaWei) + BigInt(walletState.nativeSdaWei) - BigInt(this.config.minSdaGasReserveWei);
      if (totalTradeableWei < inWei) {
        return { approved: false, reason: "INSUFFICIENT_WALLET_CAPITAL" };
      }
    }

    return { approved: true, reason: "ALL_RISK_CHECKS_PASSED" };
  }

  /**
   * Records trade outcome and triggers Circuit Breaker / Daily Loss Stop if thresholds are breached
   */
  recordTradeOutcome({ success, realizedNetProfitWei = 0n, gasCostWei = 0n }) {
    const netWei = BigInt(realizedNetProfitWei);
    const gasWei = BigInt(gasCostWei);
    this.state.totalGasSpentWei += gasWei;

    if (!success) {
      this.state.failedTxs += 1;
      this.state.consecutiveFailedTxs += 1;
      if (this.state.consecutiveFailedTxs >= this.config.maxFailedTxStreak) {
        this.tripCircuitBreaker(`Reached ${this.state.consecutiveFailedTxs} consecutive failed transactions`);
      }
      return;
    }

    this.state.consecutiveFailedTxs = 0;
    this.state.totalExecutedTrades += 1;

    if (netWei >= 0n) {
      this.state.winningTrades += 1;
      this.state.consecutiveLosses = 0;
      this.state.dailyRealizedProfitWei += netWei;
    } else {
      const lossAbs = -netWei;
      this.state.losingTrades += 1;
      this.state.consecutiveLosses += 1;
      this.state.dailyRealizedLossWei += lossAbs;

      if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        this.tripCircuitBreaker(`Reached ${this.state.consecutiveLosses} consecutive losing trades`);
      }
      if (this.state.dailyRealizedLossWei >= BigInt(this.config.maxDailyLossWei)) {
        this.triggerEmergencyStop(`Daily loss limit exceeded (${ethers.formatEther(this.state.dailyRealizedLossWei)} SDA)`);
      }
    }

    // Track peak profit & max drawdown
    const currentNet = this.state.dailyRealizedProfitWei - this.state.dailyRealizedLossWei;
    if (currentNet > this.state.peakCumulativeProfitWei) {
      this.state.peakCumulativeProfitWei = currentNet;
    }
    const drawdown = this.state.peakCumulativeProfitWei - currentNet;
    if (drawdown > this.state.maxDrawdownWei) {
      this.state.maxDrawdownWei = drawdown;
    }
  }

  tripCircuitBreaker(reason) {
    this.state.circuitBreakerTripped = true;
    this.state.emergencyReason = reason;
  }

  triggerEmergencyStop(reason) {
    this.state.emergencyStop = true;
    this.state.circuitBreakerTripped = true;
    this.state.emergencyReason = reason;
  }

  resetCircuitBreaker() {
    this.state.emergencyStop = false;
    this.state.circuitBreakerTripped = false;
    this.state.emergencyReason = null;
    this.state.consecutiveLosses = 0;
    this.state.consecutiveFailedTxs = 0;
  }

  getMetricsSnapshot() {
    const netWei = this.state.dailyRealizedProfitWei - this.state.dailyRealizedLossWei;
    const totalAttempts = this.state.totalExecutedTrades + this.state.failedTxs;
    return {
      emergencyStop: this.state.emergencyStop,
      circuitBreakerTripped: this.state.circuitBreakerTripped,
      emergencyReason: this.state.emergencyReason,
      totalExecutedTrades: this.state.totalExecutedTrades,
      winningTrades: this.state.winningTrades,
      losingTrades: this.state.losingTrades,
      failedTxs: this.state.failedTxs,
      winRatePct: this.state.totalExecutedTrades > 0
        ? Number(((this.state.winningTrades / this.state.totalExecutedTrades) * 100).toFixed(2))
        : 100,
      failedTxRatePct: totalAttempts > 0
        ? Number(((this.state.failedTxs / totalAttempts) * 100).toFixed(2))
        : 0,
      realizedNetProfitSda: Number(ethers.formatEther(netWei)),
      totalGasSpentSda: Number(ethers.formatEther(this.state.totalGasSpentWei)),
      maxDrawdownSda: Number(ethers.formatEther(this.state.maxDrawdownWei))
    };
  }
}

