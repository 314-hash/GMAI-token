import { ethers } from "ethers";
import dotenv from "dotenv";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import path from "path";
import process from "process";

dotenv.config();

/* ============================================================
   CONFIG & INITIALIZATION CONSTANTS
============================================================ */
export const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
export const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
export const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });

export const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
export const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";

export const DEFAULT_TARGET_TOKEN = process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || process.env.RIDE_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04";
export const DEFAULT_POOL_ADDR = process.env.POOL_ADDRESS || process.env.RIDE_POOL_ADDRESS || "0x64F21bC91D11531D88A16075d5E961d33f10B6eA";
export const DEFAULT_POOL_FEE = Number(process.env.POOL_FEE || process.env.RIDE_POOL_FEE || "10000");

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

export const WSDA_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

export const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

export const FACTORY_ABI = [
  "function getPool(address, address, uint24) view returns (address)"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================
   SWARM ENGINE CLASS
============================================================ */
export class SwarmEngine extends EventEmitter {
  constructor(customConfig = {}) {
    super();
    this.provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
    this.isRunning = false;
    this.isExecutingRound = false;
    this.isTerminating = false;
    this.activePool = customConfig.poolAddress || DEFAULT_POOL_ADDR;
    this.activeTargetToken = customConfig.targetTokenAddress || DEFAULT_TARGET_TOKEN;
    this.poolFee = customConfig.poolFee || DEFAULT_POOL_FEE;
    this.tokenSymbol = "GMAI";

    this.config = {
      isLive: customConfig.isLive ?? false,
      tradeSize: Number(customConfig.tradeSize ?? 0.03),
      refundRatio: Number(customConfig.refundRatio ?? 0.80),
      rounds: Number(customConfig.rounds ?? 0), // 0 = continuous
      buys: Number(customConfig.buys ?? 3),
      delay: Number(customConfig.delay ?? (process.env.STEP_DELAY_MS ? Number(process.env.STEP_DELAY_MS) : 3000)),
      walletDelay: Number(customConfig.walletDelay ?? (process.env.WALLET_DELAY_MS ? Number(process.env.WALLET_DELAY_MS) : 30000)),
      interval: Number(customConfig.interval ?? (process.env.INTERVAL_MS ? Number(process.env.INTERVAL_MS) : 60000)),
      minReserve: Number(customConfig.minReserve ?? 0.5),
      maxSlippageBps: BigInt(customConfig.maxSlippageBps ?? 100),
      gasPriceWei: BigInt(customConfig.gasPriceWei ?? 2500000000), // 2.5 Gwei
      walletsFilter: customConfig.walletsFilter || null
    };

    this.stats = {
      currentRound: 0,
      totalBuys: 0,
      totalSells: 0,
      totalSpentSda: 0,
      totalRefundedSda: 0,
      startedAt: null,
      lastCycleTime: null
    };

    this.wallets = {};
    this.initWallets();
  }

  log(level, message, meta = {}) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, level, message, ...meta };
    this.emit("log", entry);
    const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  initWallets() {
    const rawKeys = {
      wallet1: process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY,
      wallet2: process.env.PRIVATE_KEY_2,
      wallet3: process.env.PRIVATE_KEY_3,
      wallet4: process.env.PRIVATE_KEY_4,
      wallet5: process.env.PRIVATE_KEY_5
    };

    this.wallets = {};
    for (const [k, pk] of Object.entries(rawKeys)) {
      if (pk && (!this.config.walletsFilter || this.config.walletsFilter.includes(k))) {
        const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
        try {
          this.wallets[k] = new ethers.Wallet(cleanPk, this.provider);
        } catch (err) {
          this.log("warn", `Failed to initialize ${k}: ${err.message}`);
        }
      }
    }
  }

  async getSafeGasPrice() {
    if (this.config.gasPriceWei > 0n) return this.config.gasPriceWei;
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice ? (feeData.gasPrice * 120n) / 100n : 2500000000n;
    } catch {
      return 2500000000n;
    }
  }

  async waitForPendingNonce(address) {
    try {
      const [latest, pending] = await Promise.all([
        this.provider.getTransactionCount(address, "latest"),
        this.provider.getTransactionCount(address, "pending")
      ]);
      return pending >= latest ? pending : latest;
    } catch {
      return await this.provider.getTransactionCount(address, "latest");
    }
  }

  async getSpotPriceSda() {
    try {
      const pool = new ethers.Contract(this.activePool, POOL_ABI, this.provider);
      const [slot0, t0] = await Promise.all([pool.slot0(), pool.token0()]);
      const Q96 = 2n ** 96n;
      const sqrtP = Number(slot0.sqrtPriceX96) / Number(Q96);
      const rawRatio = sqrtP * sqrtP;
      const isWsdaToken0 = t0.toLowerCase() === WSDA_ADDR.toLowerCase();
      return isWsdaToken0 ? 1 / rawRatio : rawRatio;
    } catch (e) {
      this.log("warn", `Spot price fetch error: ${e.message}`);
      return 1.2975; // safe fallback
    }
  }

  async alignPoolAndToken() {
    try {
      const poolContract = new ethers.Contract(this.activePool, POOL_ABI, this.provider);
      const [t0, t1] = await Promise.all([poolContract.token0(), poolContract.token1()]);
      const isWsda0 = t0.toLowerCase() === WSDA_ADDR.toLowerCase();
      const isWsda1 = t1.toLowerCase() === WSDA_ADDR.toLowerCase();
      const pairedInPool = isWsda0 ? t1 : (isWsda1 ? t0 : null);

      if (pairedInPool && pairedInPool.toLowerCase() !== this.activeTargetToken.toLowerCase()) {
        const routerContract = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, this.provider);
        let factoryAddr = "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE";
        try { factoryAddr = await routerContract.factory(); } catch {}
        const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, this.provider);
        const tokenPool = await factory.getPool(WSDA_ADDR, this.activeTargetToken, this.poolFee);
        if (tokenPool && tokenPool !== ethers.ZeroAddress) {
          this.activePool = tokenPool;
        } else {
          this.activeTargetToken = pairedInPool;
        }
      }
    } catch (err) {
      this.log("warn", `Pool alignment notice: ${err.message}`);
    }

    try {
      const tokenContract = new ethers.Contract(this.activeTargetToken, ERC20_ABI, this.provider);
      this.tokenSymbol = await tokenContract.symbol();
    } catch {
      this.tokenSymbol = "GMAI";
    }
  }

  async ensureApproval(tokenAddress, signer, requiredAmountWei) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, ROUTER_ADDR);
    if (allowance >= requiredAmountWei) return;

    this.log("info", `[🔐 APPROVAL] Approving router for token ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`);
    if (!this.config.isLive) {
      this.log("info", `[DRY-RUN] Simulated approval of MaxUint256`);
      return;
    }

    const gasPrice = await this.getSafeGasPrice();
    const nonce = await this.waitForPendingNonce(signer.address);
    const tx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, {
      gasLimit: 100000n,
      gasPrice,
      nonce
    });
    await tx.wait(1);
    this.log("success", `Approved successfully (Tx: ${tx.hash})`);
  }

  async prepareWalletFuel(walletKey, signer, totalSdaNeeded, buyCount) {
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const neededWei = ethers.parseUnits(totalSdaNeeded.toFixed(6), 18);
    const curBal = await wsda.balanceOf(signer.address);

    if (curBal < neededWei) {
      const wrapAmount = neededWei - curBal;
      this.log("info", `[📦 WSDA BATCH] Wrapping ${ethers.formatEther(wrapAmount)} SDA into WSDA for ${buyCount}-Buy batch [${walletKey}]`);
      if (this.config.isLive) {
        const gasPrice = await this.getSafeGasPrice();
        const nonce = await this.waitForPendingNonce(signer.address);
        const wrapTx = await wsda.deposit({ value: wrapAmount, gasLimit: 120000n, gasPrice, nonce });
        await wrapTx.wait(1);
        await sleep(2000);
        this.log("success", `Wrapped successfully (Tx: ${wrapTx.hash})`);
      } else {
        this.log("info", `[DRY-RUN] Simulated wrapping ${ethers.formatEther(wrapAmount)} SDA into WSDA`);
      }
    }
    await this.ensureApproval(WSDA_ADDR, signer, neededWei);
  }

  async executeBuy(walletKey, signer, buyAmountSda) {
    const sdaAmountWei = ethers.parseUnits(buyAmountSda.toFixed(6), 18);
    const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);

    this.log("info", `[🟢 BUY] [${walletKey}] Swapping ${buyAmountSda} SDA -> ${this.tokenSymbol}...`, {
      type: "BUY",
      wallet: walletKey,
      amount: buyAmountSda
    });

    if (!this.config.isLive) {
      this.log("info", `[DRY-RUN] Simulated Buy: ${buyAmountSda} SDA via ${signer.address}`);
      return { success: true, sdaSpent: buyAmountSda, txHash: "sim_buy_" + Date.now() };
    }

    await this.ensureApproval(WSDA_ADDR, signer, sdaAmountWei);

    const simParams = {
      tokenIn: WSDA_ADDR,
      tokenOut: this.activeTargetToken,
      fee: this.poolFee,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
      amountIn: sdaAmountWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    };

    let minTokenOut = 0n;
    try {
      const simOut = await router.exactInputSingle.staticCall(simParams);
      minTokenOut = (simOut * (10000n - this.config.maxSlippageBps)) / 10000n;
    } catch {
      minTokenOut = 0n;
    }

    const gasPrice = await this.getSafeGasPrice();
    const nonce = await this.waitForPendingNonce(signer.address);

    const tx = await router.exactInputSingle({
      ...simParams,
      amountOutMinimum: minTokenOut
    }, { gasLimit: 280000n, gasPrice, nonce });

    const receipt = await tx.wait(1);
    this.log("success", `BUY Confirmed! Block: ${receipt.blockNumber} | Tx: ${tx.hash}`, {
      type: "BUY_CONFIRMED",
      txHash: tx.hash,
      blockNumber: receipt.blockNumber
    });
    return { success: true, sdaSpent: buyAmountSda, txHash: tx.hash, block: receipt.blockNumber };
  }

  async executeSell(walletKey, signer, targetRefundSda, spotPriceSda) {
    const token = new ethers.Contract(this.activeTargetToken, ERC20_ABI, signer);
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);

    const tokensToSellNum = targetRefundSda / spotPriceSda;
    let tokensToSellWei = ethers.parseUnits(tokensToSellNum.toFixed(6), 18);

    const curTokenBal = await token.balanceOf(signer.address);
    if (curTokenBal < tokensToSellWei) {
      tokensToSellWei = curTokenBal;
    }

    const displayTokens = ethers.formatUnits(tokensToSellWei, 18);
    this.log("info", `[🔴 SELL] [${walletKey}] Selling ${Number(displayTokens).toFixed(2)} ${this.tokenSymbol} -> Target Refund ~${targetRefundSda.toFixed(4)} SDA...`, {
      type: "SELL",
      wallet: walletKey,
      tokens: displayTokens,
      targetRefund: targetRefundSda
    });

    if (!this.config.isLive) {
      this.log("info", `[DRY-RUN] Simulated Sell: ${displayTokens} ${this.tokenSymbol} (~${targetRefundSda} SDA refund)`);
      return { success: true, sdaRefunded: targetRefundSda, txHash: "sim_sell_" + Date.now() };
    }

    await this.ensureApproval(this.activeTargetToken, signer, tokensToSellWei);

    const simParams = {
      tokenIn: this.activeTargetToken,
      tokenOut: WSDA_ADDR,
      fee: this.poolFee,
      recipient: signer.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
      amountIn: tokensToSellWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    };

    let minWsdaOut = 0n;
    try {
      const simOut = await router.exactInputSingle.staticCall(simParams);
      minWsdaOut = (simOut * (10000n - this.config.maxSlippageBps)) / 10000n;
    } catch {
      minWsdaOut = 0n;
    }

    let gasPrice = await this.getSafeGasPrice();
    let nonce = await this.waitForPendingNonce(signer.address);

    const tx = await router.exactInputSingle({
      ...simParams,
      amountOutMinimum: minWsdaOut
    }, { gasLimit: 280000n, gasPrice, nonce });

    const receipt = await tx.wait(1);
    this.log("success", `SELL Confirmed! Block: ${receipt.blockNumber} | Tx: ${tx.hash}`, {
      type: "SELL_CONFIRMED",
      txHash: tx.hash,
      blockNumber: receipt.blockNumber
    });

    await sleep(2500);

    // Unwrap WSDA back to Native SDA
    const wsdaBal = await wsda.balanceOf(signer.address);
    let unwrappedSda = 0;
    if (wsdaBal > 0n) {
      gasPrice = await this.getSafeGasPrice();
      nonce = await this.waitForPendingNonce(signer.address);
      const unwrapTx = await wsda.withdraw(wsdaBal, { gasLimit: 100000n, gasPrice, nonce });
      await unwrapTx.wait(1);
      unwrappedSda = Number(ethers.formatEther(wsdaBal));
      this.log("success", `💰 Unwrapped +${unwrappedSda.toFixed(4)} native SDA fuel into [${walletKey}]!`);
    }

    return { success: true, sdaRefunded: unwrappedSda || targetRefundSda, txHash: tx.hash, block: receipt.blockNumber };
  }

  async runRound(roundNumber) {
    this.isExecutingRound = true;
    const roundStartTime = Date.now();
    this.stats.currentRound = roundNumber;
    this.emit("round_start", { roundNumber, timestamp: new Date().toISOString() });

    this.log("info", `**************************************************************************`);
    this.log("info", `🌀 ROUND ${roundNumber}${this.config.rounds > 0 ? ` / ${this.config.rounds}` : ""} [${new Date().toLocaleTimeString()}]`);
    this.log("info", `**************************************************************************`);

    const spotPrice = await this.getSpotPriceSda();
    this.log("info", `Current Spot Price: ~${spotPrice.toFixed(8)} SDA per ${this.tokenSymbol} (1 SDA ≈ ${(1 / spotPrice).toFixed(2)} ${this.tokenSymbol})`);

    const totalSpentPerWallet = this.config.tradeSize * this.config.buys;
    const targetRefundPerWallet = Number((totalSpentPerWallet * this.config.refundRatio).toFixed(4));

    const walletEntries = Object.entries(this.wallets);
    for (let wIdx = 0; wIdx < walletEntries.length; wIdx++) {
      const [k, signer] = walletEntries[wIdx];
      if (this.isTerminating) break;

      try {
        const sdaBal = await this.provider.getBalance(signer.address);
        const sdaNum = Number(ethers.formatEther(sdaBal));
        if (sdaNum < totalSpentPerWallet + this.config.minReserve) {
          this.log("warn", `[${k}] Low native SDA balance (${sdaNum.toFixed(4)} SDA, needs ${totalSpentPerWallet.toFixed(4)} + ${this.config.minReserve} reserve). Skipping round.`);
          continue;
        }

        this.log("info", `▶️ [${k.toUpperCase()}] Balance: ${sdaNum.toFixed(4)} SDA (${signer.address})`);

        // Batch wrap WSDA
        await this.prepareWalletFuel(k, signer, totalSpentPerWallet, this.config.buys);

        // N BUYS
        for (let step = 1; step <= this.config.buys; step++) {
          if (this.isTerminating) break;
          this.log("info", `   [Step ${step}/${this.config.buys} BUYS] Wallet: ${k}`);
          await this.executeBuy(k, signer, this.config.tradeSize);
          this.stats.totalBuys++;
          this.stats.totalSpentSda += this.config.tradeSize;
          this.emit("stats", this.getStats());
          if (this.config.delay > 0) await sleep(this.config.delay);
        }

        // 1 SELL (Safe Harvest Refund)
        if (!this.isTerminating) {
          this.log("info", `   [Step ${this.config.buys + 1}/${this.config.buys + 1} SELL (SAFE HARVEST)] Wallet: ${k}`);
          await this.executeSell(k, signer, targetRefundPerWallet, spotPrice);
          this.stats.totalSells++;
          this.stats.totalRefundedSda += targetRefundPerWallet;
          this.emit("stats", this.getStats());
          if (this.config.delay > 0) await sleep(this.config.delay);
        }
      } catch (wErr) {
        this.log("error", `[${k}] Round ${roundNumber} error: ${wErr.reason || wErr.message}`);
      }

      // Delay between wallets (e.g. 30 seconds)
      if (!this.isTerminating && wIdx < walletEntries.length - 1 && this.config.walletDelay > 0) {
        const nextWalletKey = walletEntries[wIdx + 1][0].toUpperCase();
        this.log("info", `⏳ [Wallet Delay] Pausing ${(this.config.walletDelay / 1000).toFixed(0)}s before next wallet (${nextWalletKey})...`);
        const steps = Math.floor(this.config.walletDelay / 1000);
        for (let s = 0; s < steps; s++) {
          if (this.isTerminating) break;
          await sleep(1000);
        }
      }
    }

    const elapsedSec = ((Date.now() - roundStartTime) / 1000).toFixed(1);
    this.stats.lastCycleTime = new Date().toISOString();
    this.log("success", `Finished Round ${roundNumber} in ${elapsedSec}s.`);
    this.isExecutingRound = false;
    this.emit("round_end", { roundNumber, elapsedSec, stats: this.getStats() });
  }

  async start() {
    if (this.isRunning) {
      this.log("warn", "Swarm engine is already running!");
      return;
    }

    this.isRunning = true;
    this.isTerminating = false;
    this.stats.startedAt = new Date().toISOString();

    await this.alignPoolAndToken();

    this.log("info", "==========================================================================");
    this.log("info", `🔄 CONTINUOUS ${this.config.buys}:1 SWARM CADENCE LOOP [${this.tokenSymbol}]`);
    this.log("info", "==========================================================================");
    this.log("info", `Execution Mode  : ${this.config.isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute or LIVE=true)"}`);
    this.log("info", `Target Token    : ${this.tokenSymbol} (${this.activeTargetToken})`);
    this.log("info", `Pool Address    : ${this.activePool} (Fee: ${this.poolFee})`);
    this.log("info", `Trade Size      : ${this.config.tradeSize} SDA per buy (${(this.config.tradeSize * this.config.buys).toFixed(4)} SDA per wallet/round)`);
    this.log("info", `Buy Cadence     : ${this.config.buys} buys per round followed by 1 sell`);
    this.log("info", `Refund Target   : ${(this.config.refundRatio * 100).toFixed(0)}% recovery on sell leg`);
    this.log("info", `Min Reserve     : ${this.config.minReserve} SDA buffer per wallet`);
    this.log("info", `Max Slippage    : ${Number(this.config.maxSlippageBps) / 100}% (${this.config.maxSlippageBps.toString()} BPS)`);
    this.log("info", `Gas Price       : ${(Number(this.config.gasPriceWei) / 1e9).toFixed(2)} Gwei`);
    this.log("info", `Step Delay      : ${(this.config.delay / 1000).toFixed(1)}s between trade steps`);
    this.log("info", `Wallet Delay    : ${(this.config.walletDelay / 1000).toFixed(1)}s between wallets`);
    this.log("info", `Round Interval  : ${(this.config.interval / 1000).toFixed(1)}s between rounds`);
    this.log("info", `Target Rounds   : ${this.config.rounds === 0 ? "Continuous Infinite Loop" : `${this.config.rounds} rounds`}`);
    this.log("info", `Active Wallets  : ${Object.keys(this.wallets).join(", ")}`);
    this.log("info", "==========================================================================\n");

    this.emit("status", { state: "RUNNING", config: this.getConfig(), stats: this.getStats() });

    let currentRound = 1;
    while (!this.isTerminating && (this.config.rounds === 0 || currentRound <= this.config.rounds)) {
      await this.runRound(currentRound);
      currentRound++;

      if (!this.isTerminating && (this.config.rounds === 0 || currentRound <= this.config.rounds)) {
        this.log("info", `⏳ Cooldown: waiting ${(this.config.interval / 1000).toFixed(0)}s until next round...`);
        const steps = Math.floor(this.config.interval / 1000);
        for (let s = 0; s < steps; s++) {
          if (this.isTerminating) break;
          await sleep(1000);
        }
      }
    }

    this.isRunning = false;
    this.log("info", "==========================================================================");
    this.log("info", "🏁 CONTINUOUS SWARM LOOP TERMINATED — FINAL SUMMARY");
    this.log("info", "==========================================================================");
    this.log("info", `Completed Rounds : ${currentRound - 1}`);
    this.log("info", `Total Buys       : ${this.stats.totalBuys}`);
    this.log("info", `Total Sells      : ${this.stats.totalSells}`);
    this.log("info", `Total SDA Spent  : ~${this.stats.totalSpentSda.toFixed(4)} SDA`);
    this.log("info", `Total Recovered  : ~${this.stats.totalRefundedSda.toFixed(4)} SDA`);
    this.log("info", `Net Cost Fuel    : ~${(this.stats.totalSpentSda - this.stats.totalRefundedSda).toFixed(4)} SDA`);
    this.log("info", "==========================================================================\n");

    this.emit("status", { state: "STOPPED", config: this.getConfig(), stats: this.getStats() });
  }

  stop() {
    this.log("warn", "🛑 Stop command received. Gracefully concluding current cycle...");
    this.isTerminating = true;
    this.emit("status", { state: "STOPPING", config: this.getConfig(), stats: this.getStats() });
  }

  emergencyStop() {
    this.log("error", "🚨 EMERGENCY STOP TRIGGERED! Immediate shutdown requested.");
    this.isTerminating = true;
    this.isRunning = false;
    this.emit("status", { state: "EMERGENCY_HALTED", config: this.getConfig(), stats: this.getStats() });
  }

  updateConfig(newConfig) {
    if (newConfig.tradeSize !== undefined) this.config.tradeSize = Number(newConfig.tradeSize);
    if (newConfig.refundRatio !== undefined) this.config.refundRatio = Number(newConfig.refundRatio);
    if (newConfig.rounds !== undefined) this.config.rounds = Number(newConfig.rounds);
    if (newConfig.isLive !== undefined) this.config.isLive = Boolean(newConfig.isLive);
    if (newConfig.delay !== undefined) {
      let d = Number(newConfig.delay);
      if (d > 0 && d <= 600) d = d * 1000;
      this.config.delay = d;
    }
    if (newConfig.walletDelay !== undefined) {
      let wd = Number(newConfig.walletDelay);
      if (wd > 0 && wd <= 600) wd = wd * 1000;
      this.config.walletDelay = wd;
    }
    if (newConfig.interval !== undefined) this.config.interval = Number(newConfig.interval);
    if (newConfig.minReserve !== undefined) this.config.minReserve = Number(newConfig.minReserve);
    if (newConfig.buys !== undefined) this.config.buys = Number(newConfig.buys);
    this.log("info", `Config updated: Trade Size=${this.config.tradeSize} SDA, Refund Ratio=${this.config.refundRatio}, Live=${this.config.isLive}, Wallet Delay=${(this.config.walletDelay / 1000).toFixed(0)}s, Rounds=${this.config.rounds}`);
    this.emit("status", { state: this.isRunning ? "RUNNING" : "STOPPED", config: this.getConfig(), stats: this.getStats() });
  }

  getConfig() {
    return {
      ...this.config,
      gasPriceGwei: (Number(this.config.gasPriceWei) / 1e9).toFixed(2),
      maxSlippageBps: this.config.maxSlippageBps.toString(),
      gasPriceWei: this.config.gasPriceWei.toString(),
      tokenSymbol: this.tokenSymbol,
      targetTokenAddress: this.activeTargetToken,
      poolAddress: this.activePool,
      poolFee: this.poolFee
    };
  }

  getStats() {
    return {
      ...this.stats,
      netFuelSpentSda: Number((this.stats.totalSpentSda - this.stats.totalRefundedSda).toFixed(4)),
      recoveryPercent: this.stats.totalSpentSda > 0 ? Number(((this.stats.totalRefundedSda / this.stats.totalSpentSda) * 100).toFixed(1)) : 0
    };
  }

  async getWalletsOverview() {
    const results = [];
    const tokenContract = new ethers.Contract(this.activeTargetToken, ERC20_ABI, this.provider);
    const wsdaContract = new ethers.Contract(WSDA_ADDR, ERC20_ABI, this.provider);

    for (const [key, signer] of Object.entries(this.wallets)) {
      try {
        const [nativeBalWei, wsdaBalWei, tokenBalWei] = await Promise.all([
          this.provider.getBalance(signer.address),
          wsdaContract.balanceOf(signer.address).catch(() => 0n),
          tokenContract.balanceOf(signer.address).catch(() => 0n)
        ]);

        results.push({
          key,
          address: signer.address,
          nativeSda: Number(ethers.formatEther(nativeBalWei)),
          wsda: Number(ethers.formatEther(wsdaBalWei)),
          token: Number(ethers.formatUnits(tokenBalWei, 18)),
          tokenSymbol: this.tokenSymbol,
          isReady: Number(ethers.formatEther(nativeBalWei)) >= (this.config.tradeSize * this.config.buys + this.config.minReserve)
        });
      } catch (err) {
        results.push({
          key,
          address: signer.address,
          error: err.message
        });
      }
    }
    return results;
  }
}

/* ============================================================
   CLI ENTRYPOINT
============================================================ */
const isCli = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.basename(process.argv[1]) === "loop_3buy_1sell_continuous.js"
);

if (isCli) {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || process.env.LIVE === "true";
  
  const tradeSizeArg = Number(
    args.find((a) => a.startsWith("--trade-size="))?.split("=")[1] ||
    process.env.TRADE_SIZE_SDA ||
    0.03
  );
  
  const refundRatioArg = Number(
    args.find((a) => a.startsWith("--refund-ratio="))?.split("=")[1] ||
    (process.env.RECOVER_GAS_PERCENT ? Number(process.env.RECOVER_GAS_PERCENT) / 100 : 0.80)
  );
  
  let delayArg = Number(
    args.find((a) => a.startsWith("--delay="))?.split("=")[1] ||
    process.env.STEP_DELAY_MS ||
    3000
  );
  if (delayArg > 0 && delayArg <= 600) {
    delayArg = delayArg * 1000;
  }

  let walletDelayArg = Number(
    args.find((a) => a.startsWith("--wallet-delay="))?.split("=")[1] ||
    process.env.WALLET_DELAY_MS ||
    30000
  );
  if (walletDelayArg > 0 && walletDelayArg <= 600) {
    walletDelayArg = walletDelayArg * 1000;
  }
  
  const intervalArg = Number(
    args.find((a) => a.startsWith("--interval="))?.split("=")[1] ||
    process.env.INTERVAL_MS ||
    60000
  );
  
  const maxRoundsArg = Number(
    args.find((a) => a.startsWith("--rounds="))?.split("=")[1] ||
    process.env.ROUNDS ||
    0
  );

  const buyCount = Number(
    args.find((a) => a.startsWith("--buys="))?.split("=")[1] ||
    process.env.BUY_COUNT ||
    3
  );

  const minReserveArg = Number(
    args.find((a) => a.startsWith("--min-reserve="))?.split("=")[1] ||
    process.env.MIN_SDA_RESERVE ||
    0.5
  );

  const walletsArg = args.find((a) => a.startsWith("--wallets="))?.split("=")[1] || process.env.WALLETS;
  const walletsFilter = walletsArg ? walletsArg.split(",") : null;

  const engine = new SwarmEngine({
    isLive,
    tradeSize: tradeSizeArg,
    refundRatio: refundRatioArg,
    rounds: maxRoundsArg,
    buys: buyCount,
    delay: delayArg,
    walletDelay: walletDelayArg,
    interval: intervalArg,
    minReserve: minReserveArg,
    walletsFilter
  });

  process.on("SIGINT", () => {
    console.log("\n\n🛑 [INTERRUPT] Received SIGINT (Ctrl+C). Completing current cycle safely and shutting down...");
    engine.stop();
  });

  process.on("SIGTERM", () => {
    console.log("\n\n🛑 [TERMINATE] Received SIGTERM. Shutting down...");
    engine.stop();
  });

  engine.start().catch((err) => {
    console.error("[-] Continuous Loop Fatal Error:", err);
    process.exit(1);
  });
}
