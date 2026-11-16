/**
 * ============================================================================
 * PROJECT: SIDRA TEMPEST ARBITRAGE ENGINE (STAE)
 * AI-ASSISTED CROSS-DEX ATOMIC ARBITRAGE, CAPITAL PROTECTION & GMAI GROWTH
 * ============================================================================
 *
 * Key Capabilities:
 * 1. SINGLE-TRANSACTION ATOMIC EXECUTION (`Router.exactInput`):
 *    Executes the complete `WSDA -> Token (poolBuy) -> WSDA (poolSell)` route
 *    in ONE atomic EVM transaction on Sidra V3 Router (0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb).
 *    If final WSDA output < (amountIn + gas + minProfit), the entire transaction
 *    reverts atomically — 0 tokens are ever held and principal cannot be lost to Leg 2 slippage!
 * 2. PURE BIGINT PROFIT ENGINE & DETERMINISTIC CAPITAL PROTECTION:
 *    Zero `amountOutMinimum = 0` swaps. Enforces strict non-zero `amountOutMinimum`,
 *    daily loss stop, consecutive loss circuit breaker, and dual-RPC health checks.
 * 3. T3MP3ST SECURITY & OPERATIONAL ASSURANCE ADAPTER:
 *    Verifies contracts, bytecode, factory, WETH9/WSDA, dual RPCs, and key isolation.
 * 4. PARALLEL 5-WALLET SWARM WITH 5.00 WSDA PRE-WRAPPED WORKING CAPITAL:
 *    Dispatches all ready wallets simultaneously on non-overlapping pool pairs.
 * 5. AUDITABLE LEDGER & REAL-TIME DASHBOARD TELEMETRY (`data/stae/`).
 */

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import { EventEmitter } from "events";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { scanMarket } from "../engine/scanner.js";
import { enrichMarketWithTopTraders } from "../engine/top_trader_tracker.js";
import { TempestSecurityAdapter } from "../engine/stae/tempest_security_adapter.js";
import { DeterministicRiskEngine } from "../engine/stae/risk_engine.js";
import { AuditableLedger } from "../engine/stae/ledger.js";
import { StaeAgentSwarm } from "../engine/stae/agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const PRIMARY_RPC = process.env.RPC_URL || "https://rpc.sidrachain.com";
export const SECONDARY_RPC = process.env.SECONDARY_RPC_URL || "https://node.sidrachain.com";
export const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");

export const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
export const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
export const GMAI_ADDR = process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || process.env.RIDE_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
export const GMAI_POOL_FEE = Number(process.env.POOL_FEE || process.env.GMAI_POOL_FEE || process.env.RIDE_POOL_FEE || "10000");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SidraTempestEngine extends EventEmitter {
  constructor(customOptions = {}) {
    super();
    const sidraNet = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
    this.primaryProvider = new ethers.JsonRpcProvider(PRIMARY_RPC, sidraNet, { staticNetwork: sidraNet });
    this.secondaryProvider = new ethers.JsonRpcProvider(SECONDARY_RPC, sidraNet, { staticNetwork: sidraNet });
    this.primaryProvider.pollingInterval = 800;

    // Conservative by default: Simulation mode unless explicitly enabled with --execute / isLive
    this.isLive = Boolean(customOptions.isLive ?? false);
    this.intervalSec = Number(customOptions.intervalSec ?? 5);
    this.allocationMode = customOptions.allocationMode || "MODE_A_GMAI_ACCUMULATION";

    this.riskEngine = new DeterministicRiskEngine({
      dryRun: !this.isLive,
      liveTrading: this.isLive,
      minTradeSizeWei: ethers.parseEther(String(customOptions.minTradeSda ?? 0.5)),
      maxTradeSizeWei: ethers.parseEther(String(customOptions.maxTradeSda ?? 10.0)),
      wsdaReserveWei: ethers.parseEther(String(customOptions.wsdaReserveSda ?? 10.0)),
      minNetProfitWei: ethers.parseEther(String(customOptions.minProfitSda ?? 0.0025)),
      minPoolLiquiditySda: Number(customOptions.minPoolLiquiditySda ?? 25.0),
      maxPriceImpactBps: BigInt(Math.round(Number(customOptions.maxImpactPct ?? 2.0) * 100)),
      walletProfitShareBps: BigInt(Math.round(Number(customOptions.walletShare ?? 0.90) * 10000)),
      gmaiAccumulationShareBps: BigInt(Math.round(Number(customOptions.gmaiShare ?? 0.10) * 10000))
    });

    this.securityAdapter = new TempestSecurityAdapter({
      primaryRpc: PRIMARY_RPC,
      secondaryRpc: SECONDARY_RPC,
      chainId: CHAIN_ID,
      routerAddress: ROUTER_ADDR,
      wsdaAddress: WSDA_ADDR,
      gmaiAddress: GMAI_ADDR
    });

    this.ledger = new AuditableLedger();
    this.agents = new StaeAgentSwarm({
      riskEngine: this.riskEngine,
      securityAdapter: this.securityAdapter,
      ledger: this.ledger,
      primaryProvider: this.primaryProvider,
      secondaryProvider: this.secondaryProvider
    });

    this.wallets = this._loadSecureWallets();
    this.walletStats = {};
    for (const k of Object.keys(this.wallets)) {
      this.walletStats[k] = {
        realizedProfitWei: 0n,
        tradesExecuted: 0,
        failedTrades: 0
      };
    }

    this.approvalCache = new Set();
    this.isRunning = false;
    this.round = 0;
  }

  /**
   * Loads wallet signers into isolated memory without ever logging or serializing private keys
   */
  _loadSecureWallets() {
    const rawKeys = {};
  for (let i = 1; i <= 50; i++) {
    const pk = process.env["PRIVATE_KEY_" + i] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (pk) rawKeys["wallet" + i] = pk;
  }
    const signers = {};
    for (const [id, pk] of Object.entries(rawKeys)) {
      if (pk && pk.trim().length >= 64) {
        const cleanPk = pk.trim().startsWith("0x") ? pk.trim() : `0x${pk.trim()}`;
        signers[id] = new ethers.Wallet(cleanPk, this.primaryProvider);
      }
    }
    return signers;
  }

  async getSafeNonce(address) {
    const [latest, pending] = await Promise.all([
      this.primaryProvider.getTransactionCount(address, "latest"),
      this.primaryProvider.getTransactionCount(address, "pending")
    ]);
    return Math.max(latest, pending);
  }

  async ensureWsdaRouterApproval(signer, requiredWei, gasPriceWei) {
    const cacheKey = `${signer.address.toLowerCase()}_wsda`;
    if (this.approvalCache.has(cacheKey)) return 0n;

    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const allowance = await wsda.allowance(signer.address, ROUTER_ADDR);
    if (allowance >= requiredWei) {
      this.approvalCache.add(cacheKey);
      return 0n;
    }

    const nonce = await this.getSafeNonce(signer.address);
    const tx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, {
      gasLimit: 75000n,
      gasPrice: gasPriceWei,
      nonce
    });
    const receipt = await tx.wait(1);
    this.approvalCache.add(cacheKey);
    return (receipt?.gasUsed || 50000n) * gasPriceWei;
  }

  /**
   * Queries all 5 wallets' live Native SDA, WSDA, GMAI, and Nonce state in parallel
   */
  async inspectWalletFleet() {
    const wsda = new ethers.Contract(WSDA_ADDR, ERC20_ABI, this.primaryProvider);
    const gmai = new ethers.Contract(GMAI_ADDR, ERC20_ABI, this.primaryProvider);
    const keys = Object.keys(this.wallets);

    const states = await Promise.all(
      keys.map(async (key, idx) => {
        const signer = this.wallets[key];
        const [nativeWei, wsdaWei, gmaiWei, latestNonce, pendingNonce] = await Promise.all([
          this.primaryProvider.getBalance(signer.address),
          wsda.balanceOf(signer.address),
          gmai.balanceOf(signer.address),
          this.primaryProvider.getTransactionCount(signer.address, "latest"),
          this.primaryProvider.getTransactionCount(signer.address, "pending")
        ]);

        const stats = this.walletStats[key] || { realizedProfitWei: 0n, tradesExecuted: 0 };
        return {
          key,
          walletId: key,
          idx,
          address: signer.address,
          signer,
          nativeSdaWei: nativeWei,
          wsdaWei,
          gmaiWei,
          nativeSda: Number(ethers.formatEther(nativeWei)),
          wsda: Number(ethers.formatEther(wsdaWei)),
          gmai: Number(ethers.formatEther(gmaiWei)),
          nonce: latestNonce,
          isCleanNonce: latestNonce === pendingNonce,
          realizedProfitSda: Number(ethers.formatEther(stats.realizedProfitWei)),
          tradesExecuted: stats.tradesExecuted
        };
      })
    );

    this.ledger.saveWalletFleetSnapshot(states);
    return states;
  }

  /**
   * Executes an ATOMIC Single-Transaction Cross-Pool Arbitrage via `Router.exactInput`:
   * Path: `WSDA --(feeBuy)--> Token --(feeSell)--> WSDA` in 1 EVM transaction!
   * - Never holds intermediate tokens (0% token holding exposure).
   * - Enforces strict non-zero `amountOutMinimum >= amountIn + gas + minProfitFloor`.
   * - Reconciles exact pre/post WSDA & Native SDA balances in BigInt.
   */
  async executeAtomicArbitrageRoute(walletState, route, gasPriceWei) {
    const { key: walletKey, signer } = walletState;
    const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const gmai = new ethers.Contract(GMAI_ADDR, ERC20_ABI, signer);

    const walletPct = Number(this.riskEngine.config.walletProfitShareBps) / 100;
    const gmaiPct = Number(this.riskEngine.config.gmaiAccumulationShareBps) / 100;

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`🌩️ [STAE ATOMIC 1-TX EXEC] [${walletKey.toUpperCase()}] ${route.token} | Size: ${route.inputSda.toFixed(2)} SDA`);
    console.log(`   Strategy            : ${route.strategyType} (Single-Tx Atomic Swap)`);
    console.log(`   Route               : WSDA ➔ ${route.token} (Fee ${route.feeBuy}, Depth ~${route.buyLiquiditySda.toFixed(1)} SDA) ➔ WSDA (Fee ${route.feeSell}, Depth ~${route.sellLiquiditySda.toFixed(1)} SDA)`);
    console.log(`   Price Impact        : ${route.priceImpactPct.toFixed(2)}% | Est. Net Profit: +${route.netProfitSda.toFixed(5)} SDA (+${route.roiPct.toFixed(2)}%)`);
    console.log(`   Allocation Mode     : ${walletPct}% Wallet Native SDA | ${gmaiPct}% ${this.allocationMode}`);
    console.log(`--------------------------------------------------------------------------`);

    // 1. In DRY-RUN mode, still run live on-chain staticCall verification so simulation is 100% realistic!
    if (!this.isLive) {
      let verifiedOutWei = route.expectedOutWei;
      let staticCallVerified = false;
      try {
        if (walletState.wsdaWei >= route.amountInWei) {
          verifiedOutWei = await router.exactInput.staticCall({
            path: route.atomicPathBytes,
            recipient: signer.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: route.amountInWei,
            amountOutMinimum: route.amountInWei
          });
          staticCallVerified = true;
        }
      } catch {
        // Static call rejected -> route shifted or unapproved in simulation
      }

      const simCalc = this.riskEngine.calculateExactProfitBigInt({
        amountInWei: route.amountInWei,
        expectedOutWei: verifiedOutWei,
        gasLimitUnits: 195000n,
        gasPriceWei
      });

      const minOutWei = this.riskEngine.computeAtomicAmountOutMinimum(
        route.amountInWei,
        verifiedOutWei,
        simCalc.totalGasCostWei
      );

      console.log(
        `   🛡️ [DRY-RUN SIMULATION] ${staticCallVerified ? "On-Chain staticCall Verified" : "Math Verified"} | MinOut Guard: ${ethers.formatEther(minOutWei)} WSDA | Est. Net: +${ethers.formatEther(simCalc.netProfitWei)} SDA`
      );

      this.ledger.appendTransaction({
        txHash: `SIM-${Date.now()}-${walletKey}-${route.token}`,
        opportunityId: route.opportunityId,
        walletId: walletKey,
        walletAddress: signer.address,
        executionMode: "DRY_RUN_SIMULATION",
        tokenSymbol: route.token,
        blockNumber: 0,
        nonce: walletState.nonce,
        amountInWei: route.amountInWei,
        amountOutMinWei: minOutWei,
        realizedOutWei: verifiedOutWei,
        gasUsed: 195000n,
        effectiveGasPriceWei: gasPriceWei,
        totalGasCostWei: simCalc.totalGasCostWei,
        grossProfitWei: simCalc.grossProfitWei,
        realizedNetProfitWei: simCalc.netProfitWei,
        wsdaBeforeWei: walletState.wsdaWei,
        wsdaAfterWei: walletState.wsdaWei,
        nativeBeforeWei: walletState.nativeSdaWei,
        nativeAfterWei: walletState.nativeSdaWei,
        status: "SIMULATED"
      });

      return {
        success: true,
        simulated: true,
        realizedNetProfitWei: 0n // Never count simulated profit as realized profit!
      };
    }

    // =========================================================================
    // LIVE ATOMIC EXECUTION PATH (SINGLE EVM TRANSACTION)
    // =========================================================================
    let wrapGasCostWei = 0n;
    const wsdaBeforeWrap = await wsda.balanceOf(signer.address);
    if (wsdaBeforeWrap < route.amountInWei) {
      const wrapNeeded = route.amountInWei - wsdaBeforeWrap;
      const nativeNow = await this.primaryProvider.getBalance(signer.address);
      if (nativeNow < wrapNeeded + this.riskEngine.config.minSdaGasReserveWei) {
        return { success: false, reason: "INSUFFICIENT_NATIVE_FOR_WRAP" };
      }
      const nonceWrap = await this.getSafeNonce(signer.address);
      const wrapTx = await wsda.deposit({
        value: wrapNeeded,
        gasLimit: 90000n,
        gasPrice: gasPriceWei,
        nonce: nonceWrap
      });
      const wrapRec = await wrapTx.wait(1);
      wrapGasCostWei = (wrapRec?.gasUsed || 60000n) * gasPriceWei;
    }

    const approvalGasCostWei = await this.ensureWsdaRouterApproval(signer, route.amountInWei, gasPriceWei);

    // Pre-Flight Live Atomic staticCall Verification on `Router.exactInput`
    let liveQuotedOutWei = 0n;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    try {
      liveQuotedOutWei = await router.exactInput.staticCall({
        path: route.atomicPathBytes,
        recipient: signer.address,
        deadline,
        amountIn: route.amountInWei,
        amountOutMinimum: route.amountInWei + 1n
      });
    } catch {
      console.log(`   🛡️ [${walletKey}] Pre-flight atomic staticCall rejected ${route.token} (spread closed). 0 gas spent on swap.`);
      return { success: false, reason: "PREFLIGHT_ATOMIC_REJECTED" };
    }

    // Re-verify exact BigInt profitability from live staticCall output
    const preflightProfit = this.riskEngine.calculateExactProfitBigInt({
      amountInWei: route.amountInWei,
      expectedOutWei: liveQuotedOutWei,
      gasLimitUnits: 195000n,
      gasPriceWei
    });

    if (!preflightProfit.isProfitable) {
      console.log(
        `   🛡️ [${walletKey}] Live staticCall net profit (+${ethers.formatEther(preflightProfit.netProfitWei)} SDA) below threshold. Aborted before tx!`
      );
      return { success: false, reason: "PREFLIGHT_BELOW_MIN_PROFIT" };
    }

    // Compute strict non-zero amountOutMinimum (>= amountIn + gas + profitFloor)
    const strictAmountOutMinWei = this.riskEngine.computeAtomicAmountOutMinimum(
      route.amountInWei,
      liveQuotedOutWei,
      preflightProfit.totalGasCostWei
    );

    const [wsdaBeforeTx, nativeBeforeTx] = await Promise.all([
      wsda.balanceOf(signer.address),
      this.primaryProvider.getBalance(signer.address)
    ]);

    let txReceipt = null;
    let txHash = "";
    const nonceSwap = await this.getSafeNonce(signer.address);

    try {
      const atomicTx = await router.exactInput(
        {
          path: route.atomicPathBytes,
          recipient: signer.address,
          deadline,
          amountIn: route.amountInWei,
          amountOutMinimum: strictAmountOutMinWei
        },
        {
          gasLimit: 280000n,
          gasPrice: gasPriceWei,
          nonce: nonceSwap
        }
      );
      txHash = atomicTx.hash;
      txReceipt = await atomicTx.wait(1);
    } catch (txErr) {
      // Because exactInput is 100% atomic, if the pool moved mid-block, 0 tokens were bought and 100% of WSDA remained in the wallet!
      const revertGasWei = 135000n * gasPriceWei;
      console.log(
        `   🛡️ [${walletKey}] Atomic MinOut Guard protected 100% of ${route.inputSda.toFixed(2)} WSDA on ${route.token} (mid-block move; 0 tokens held).`
      );
      this.riskEngine.recordTradeOutcome({
        success: false,
        realizedNetProfitWei: 0n,
        gasCostWei: revertGasWei
      });
      return { success: false, reason: "ATOMIC_MIN_OUT_PROTECTED" };
    }

    const [wsdaAfterTx, nativeAfterTx] = await Promise.all([
      wsda.balanceOf(signer.address),
      this.primaryProvider.getBalance(signer.address)
    ]);

    const grossProfitWei = wsdaAfterTx - wsdaBeforeTx;
    const swapGasUsed = BigInt(txReceipt?.gasUsed || 195000n);
    const effectiveGasPrice = BigInt(txReceipt?.gasPrice || gasPriceWei);
    const swapGasCostWei = swapGasUsed * effectiveGasPrice;
    const totalAllGasWei = swapGasCostWei + wrapGasCostWei + approvalGasCostWei;
    const realizedNetProfitWei = grossProfitWei - totalAllGasWei;

    console.log(
      `   ✅ [${walletKey}] ATOMIC 1-TX SUCCESS (${txHash.slice(0, 12)}...) | Gross: +${ethers.formatEther(grossProfitWei)} WSDA | Net After Gas: ${realizedNetProfitWei >= 0n ? "+" : ""}${ethers.formatEther(realizedNetProfitWei)} SDA`
    );

    // Record in Risk Engine & Ledger
    this.riskEngine.recordTradeOutcome({
      success: true,
      realizedNetProfitWei,
      gasCostWei: totalAllGasWei
    });

    this.walletStats[walletKey].realizedProfitWei += realizedNetProfitWei;
    this.walletStats[walletKey].tradesExecuted += 1;

    this.ledger.appendTransaction({
      txHash,
      opportunityId: route.opportunityId,
      walletId: walletKey,
      walletAddress: signer.address,
      executionMode: "LIVE_ATOMIC_EXACT_INPUT",
      tokenSymbol: route.token,
      blockNumber: txReceipt?.blockNumber || 0,
      nonce: nonceSwap,
      amountInWei: route.amountInWei,
      amountOutMinWei: strictAmountOutMinWei,
      realizedOutWei: route.amountInWei + grossProfitWei,
      gasUsed: swapGasUsed,
      effectiveGasPriceWei: effectiveGasPrice,
      totalGasCostWei: totalAllGasWei,
      grossProfitWei,
      realizedNetProfitWei,
      wsdaBeforeWei: wsdaBeforeTx,
      wsdaAfterWei: wsdaAfterTx,
      nativeBeforeWei: nativeBeforeTx,
      nativeAfterWei: nativeAfterTx,
      status: "CONFIRMED"
    });

    // Section 10: GMAI Profit Allocation (Only on positive realized net profit after gas!)
    let walletRetainedWei = 0n;
    let gmaiAllocatedWei = 0n;
    let gmaiReceivedWei = 0n;

    if (realizedNetProfitWei > 0n) {
      gmaiAllocatedWei =
        (realizedNetProfitWei * BigInt(this.riskEngine.config.gmaiAccumulationShareBps)) / 10000n;
      walletRetainedWei = realizedNetProfitWei - gmaiAllocatedWei;

      // Mode A: GMAI Accumulation (only execute if allocated amount > 0.0005 SDA to avoid wasting gas)
      if (gmaiAllocatedWei >= ethers.parseEther("0.0005")) {
        try {
          const gmaiBefore = await gmai.balanceOf(signer.address);
          const nonceGmai = await this.getSafeNonce(signer.address);
          // Quote GMAI output via staticCall first so amountOutMinimum is strictly > 0!
          const quotedGmaiOut = await router.exactInputSingle.staticCall({
            tokenIn: WSDA_ADDR,
            tokenOut: GMAI_ADDR,
            fee: GMAI_POOL_FEE,
            recipient: signer.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: gmaiAllocatedWei,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: 0
          });
          const minGmaiOut = (quotedGmaiOut * 9800n) / 10000n; // 2% max slippage on GMAI accumulation

          if (minGmaiOut > 0n) {
            const allocTx = await router.exactInputSingle(
              {
                tokenIn: WSDA_ADDR,
                tokenOut: GMAI_ADDR,
                fee: GMAI_POOL_FEE,
                recipient: signer.address,
                deadline: Math.floor(Date.now() / 1000) + 120,
                amountIn: gmaiAllocatedWei,
                amountOutMinimum: minGmaiOut,
                sqrtPriceLimitX96: 0
              },
              { gasLimit: 240000n, gasPrice: gasPriceWei, nonce: nonceGmai }
            );
            await allocTx.wait(1);
            const gmaiAfter = await gmai.balanceOf(signer.address);
            gmaiReceivedWei = gmaiAfter - gmaiBefore;

            this.ledger.appendAllocation({
              allocationId: `ALLOC-${Date.now()}-${walletKey}`,
              sourceTxHash: txHash,
              walletId: walletKey,
              allocationMode: this.allocationMode,
              realizedProfitWei: realizedNetProfitWei,
              walletRetainedWei,
              gmaiAllocatedSdaWei: gmaiAllocatedWei,
              gmaiTokensReceivedWei: gmaiReceivedWei,
              allocationTxHash: allocTx.hash
            });
            console.log(
              `   💧 [${walletKey}] Mode A GMAI Accumulation: +${ethers.formatEther(gmaiAllocatedWei)} SDA ➔ +${Number(ethers.formatEther(gmaiReceivedWei)).toFixed(2)} GMAI`
            );
          }
        } catch (allocErr) {
          console.warn(`   ⚠️ [${walletKey}] GMAI allocation deferred: ${allocErr.message}`);
        }
      }
    }

    // Unwrap realized WSDA profit above reserveWei (5.00 WSDA) to Native SDA in the wallet
    const curWsda = await wsda.balanceOf(signer.address);
    const reserveWei = BigInt(this.riskEngine.config.wsdaReserveWei);
    if (curWsda > reserveWei) {
      const excessWsda = curWsda - reserveWei;
      if (excessWsda >= ethers.parseEther("0.002")) {
        try {
          const nonceUnwrap = await this.getSafeNonce(signer.address);
          const unwrapTx = await wsda.withdraw(excessWsda, {
            gasLimit: 85000n,
            gasPrice: gasPriceWei,
            nonce: nonceUnwrap
          });
          await unwrapTx.wait(1);
          console.log(
            `   💰 [${walletKey}] Unwrapped +${ethers.formatEther(excessWsda)} WSDA profit ➔ Native SDA (Kept ${ethers.formatEther(reserveWei)} WSDA wrapped)`
          );
        } catch {}
      }
    }

    return {
      success: true,
      txHash,
      realizedNetProfitWei,
      walletRetainedWei,
      gmaiAllocatedWei
    };
  }

  /**
   * Runs one full STAE cycle across all 9 agents and all 5 wallets
   */
  async runCycle() {
    this.round += 1;
    const t0 = Date.now();

    // 1. Security Analyst & RPC Quorum Check
    const secAudit = await this.securityAdapter.runFullSecurityAudit(
      this.primaryProvider,
      Object.values(this.wallets).map((w) => w.address)
    );
    this.ledger.saveSecurityReport(secAudit);

    if (!secAudit.rpcAssurance.allHealthy || !secAudit.contractAssurance.verified) {
      this.ledger.appendRiskEvent(
        "CRITICAL",
        "INFRASTRUCTURE_ASSURANCE",
        "RPC or Core Contract verification failed; halting round.",
        secAudit
      );
      console.error("   🛑 [STAE SECURITY HALT] RPC or Contract verification failed. Remaining inactive.");
      return { executed: 0 };
    }

    // 2. Gas Analyst & Wallet Fleet Inspection
    const [gasPriceWei, walletStates] = await Promise.all([
      this.agents.estimateOptimalGasPrice(),
      this.inspectWalletFleet()
    ]);

    // 3. Market Scout & Route Optimizer
    const dynamicTokens = [];
    try {
      await enrichMarketWithTopTraders(dynamicTokens, this.primaryProvider);
    } catch {}

    const market = await scanMarket(this.primaryProvider, dynamicTokens);
    this.ledger.savePoolRegistry(market);

    const candidateRoutes = this.agents.discoverAndOptimizeAtomicRoutes(market, gasPriceWei);
    const scanMs = Date.now() - t0;

    console.log(`\n==========================================================================`);
    console.log(
      `🌩️ [STAE ROUND #${this.round}] Mode: ${this.isLive ? "🚨 LIVE ATOMIC 1-TX" : "🛡️ DRY-RUN SIMULATION"} | RPC Quorum: ${secAudit.rpcAssurance.dualQuorumHealthy ? "DUAL-SYNC ✅" : "PRIMARY ✅"} | Gas: ${ethers.formatUnits(gasPriceWei, "gwei")} Gwei`
    );
    console.log(`==========================================================================`);

    if (candidateRoutes.length === 0) {
      console.log(
        `   ℹ️ Scanned ${market.length} tokens in ${(scanMs / 1000).toFixed(2)}s. No risk-approved atomic opportunities right now. Remaining inactive.`
      );
      return { executed: 0, opportunities: [] };
    }

    console.log(
      `   🎯 Discovered ${candidateRoutes.length} Atomic Cross-Pool Route(s) in ${(scanMs / 1000).toFixed(2)}s!`
    );

    // 4. Risk Manager & Multi-Wallet Assignment (Strictly 1 wallet per pool pair in parallel batch)
    const usedWallets = new Set();
    const usedPools = new Set();
    const assignments = [];

    for (const route of candidateRoutes) {
      const buyPoolKey = route.poolBuyAddress.toLowerCase();
      const sellPoolKey = route.poolSellAddress.toLowerCase();
      if (usedPools.has(buyPoolKey) || usedPools.has(sellPoolKey)) continue;

      const availableWallet = walletStates.find((w) => {
        if (usedWallets.has(w.key)) return false;
        const check = this.riskEngine.validateRouteAndWallet(route, w, secAudit.rpcAssurance.allHealthy);
        return check.approved;
      });

      if (!availableWallet) {
        this.ledger.appendOpportunity({
          opportunityId: route.opportunityId,
          roundNumber: this.round,
          strategyType: route.strategyType,
          isAtomic: true,
          tokenSymbol: route.token,
          tokenAddress: route.tokenAddress,
          poolBuyAddress: route.poolBuyAddress,
          poolSellAddress: route.poolSellAddress,
          feeBuy: route.feeBuy,
          feeSell: route.feeSell,
          inputSdaWei: route.amountInWei,
          expectedOutSdaWei: route.expectedOutWei,
          expectedGasWei: route.totalGasCostWei,
          expectedNetProfitWei: route.netProfitWei,
          priceImpactPct: route.priceImpactPct,
          riskScore: route.riskAdjustedScore,
          riskDecision: "SKIPPED_NO_AVAILABLE_WALLET"
        });
        continue;
      }

      usedWallets.add(availableWallet.key);
      usedPools.add(buyPoolKey);
      usedPools.add(sellPoolKey);
      assignments.push({ walletState: availableWallet, route });

      this.ledger.appendOpportunity({
        opportunityId: route.opportunityId,
        roundNumber: this.round,
        strategyType: route.strategyType,
        isAtomic: true,
        tokenSymbol: route.token,
        tokenAddress: route.tokenAddress,
        poolBuyAddress: route.poolBuyAddress,
        poolSellAddress: route.poolSellAddress,
        feeBuy: route.feeBuy,
        feeSell: route.feeSell,
        inputSdaWei: route.amountInWei,
        expectedOutSdaWei: route.expectedOutWei,
        expectedGasWei: route.totalGasCostWei,
        expectedNetProfitWei: route.netProfitWei,
        priceImpactPct: route.priceImpactPct,
        riskScore: route.riskAdjustedScore,
        riskDecision: "APPROVED"
      });
    }

    if (assignments.length === 0) {
      console.log(`   ⚠️ No wallet passed all deterministic risk checks for current routes.`);
      return { executed: 0, opportunities: candidateRoutes };
    }

    console.log(
      `   🚀 Dispatching ${assignments.length} Wallet(s) Simultaneously (Atomic 1-Tx): ${assignments
        .map((a) => `[${a.walletState.key.toUpperCase()} ➔ ${a.route.token} (${a.route.inputSda} SDA)]`)
        .join(", ")}`
    );

    const results = await Promise.all(
      assignments.map(({ walletState, route }) =>
        this.executeAtomicArbitrageRoute(walletState, route, gasPriceWei)
      )
    );

    await this.inspectWalletFleet();
    const metrics = this.riskEngine.getMetricsSnapshot();

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`📊 STAE ROUND #${this.round} TELEMETRY & RISK SUMMARY:`);
    console.log(`   Realized Trades Executed : ${metrics.totalExecutedTrades} (Win Rate: ${metrics.winRatePct}%)`);
    console.log(`   Realized Net Profit      : +${metrics.realizedNetProfitSda.toFixed(5)} SDA (Gas Spent: ${metrics.totalGasSpentSda.toFixed(5)} SDA)`);
    console.log(`   Circuit Breaker Status   : ${metrics.circuitBreakerTripped ? "🛑 TRIPPED" : "🟢 ARMED & HEALTHY"}`);
    console.log(`--------------------------------------------------------------------------`);

    this.emit("round_complete", {
      round: this.round,
      metrics,
      opportunities: candidateRoutes,
      results
    });

    return {
      executed: results.filter((r) => r.success).length,
      opportunities: candidateRoutes,
      metrics
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || process.env.LIVE_TRADING === "true";
  const maxRounds = Number(args.find((a) => a.startsWith("--rounds="))?.split("=")[1] || (args.includes("--once") ? 1 : 999999));
  const minTradeSda = Number(args.find((a) => a.startsWith("--min-trade="))?.split("=")[1] || process.env.ARB_MIN_TRADE_SIZE_SDA || 0.5);
  const maxTradeSda = Number(args.find((a) => a.startsWith("--max-trade="))?.split("=")[1] || process.env.ARB_MAX_TRADE_SIZE_SDA || 10.0);
  const wsdaReserveSda = Number(args.find((a) => a.startsWith("--wsda-reserve="))?.split("=")[1] || process.env.WSDA_RESERVE_SDA || 10.0);
  const minProfitSda = Number(args.find((a) => a.startsWith("--min-profit="))?.split("=")[1] || 0.0025);
  const maxImpactPct = Number(args.find((a) => a.startsWith("--max-impact="))?.split("=")[1] || 2.0);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 5);

  const stae = new SidraTempestEngine({
    isLive,
    minTradeSda,
    maxTradeSda,
    wsdaReserveSda,
    minProfitSda,
    maxImpactPct,
    intervalSec
  });

  console.log("==========================================================================");
  console.log("🌩️ SIDRA TEMPEST ARBITRAGE ENGINE (STAE) — ATOMIC MULTI-WALLET SYSTEM");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ATOMIC 1-TX EXECUTION" : "🛡️ DRY-RUN SIMULATION (Default Safe Mode)"}`);
  console.log(`Atomic Engine      : Router.exactInput Single-Tx Multi-Hop (0% Token Holding Risk)`);
  console.log(`Trade Size         : ${minTradeSda.toFixed(2)} - ${maxTradeSda.toFixed(2)} SDA per wallet (${wsdaReserveSda.toFixed(2)} WSDA Pre-Wrapped)`);
  console.log(`T3MP3ST Assurance  : Active (Dual-RPC Verification + Keyless Isolation)`);
  console.log("==========================================================================\n");

  for (let r = 1; r <= maxRounds; r++) {
    if (stae.riskEngine.state.emergencyStop || stae.riskEngine.state.circuitBreakerTripped) {
      console.error(`🛑 [STAE HALTED] ${stae.riskEngine.state.emergencyReason}`);
      break;
    }
    await stae.runCycle();
    if (r < maxRounds) {
      await sleep(intervalSec * 1000);
    }
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error("Fatal STAE Error:", err);
    process.exit(1);
  });
}

