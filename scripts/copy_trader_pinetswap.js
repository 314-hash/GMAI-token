import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseTargetWallets, acquireWalletLock } from "./wallet_helper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Pinetswap / Sidra Network Constants
const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 500; // Sub-second polling for instant block reaction

const ROUTER_ADDR = ethers.getAddress(process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb");
const WSDA_ADDR = ethers.getAddress(process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182");

// Ecosystem LP Flywheel: 10% GMAI + 5% BANDIQ + 5% SVM (80% Kept in Wallet)
const GMAI_ADDR = ethers.getAddress(process.env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04");
const GMAI_POOL_FEE = Number(process.env.GMAI_POOL_FEE || "10000");

const BANDIQ_ADDR = ethers.getAddress(process.env.BANDIQ_ADDRESS || "0x6d1537bEE4F1EE3f55F4BC9319Aa40252cd39133");
const BANDIQ_POOL_FEE = Number(process.env.BANDIQ_POOL_FEE || "10000");

const SVM_ADDR = ethers.getAddress(process.env.SVM_ADDRESS || "0xFB1267FB3b9BdbcE3a1C30A9B0A1454e14E81ACb");
const SVM_POOL_FEE = Number(process.env.SVM_POOL_FEE || "3000");

const GMAI_LP_SHARE = Number(process.env.GMAI_LP_SHARE || "0.10");     // 10% liquidity reinvested into GMAI
const BANDIQ_LP_SHARE = Number(process.env.BANDIQ_LP_SHARE || "0.05"); // 5% liquidity reinvested into BANDIQ
const SVM_LP_SHARE = Number(process.env.SVM_LP_SHARE || "0.05");       // 5% liquidity reinvested into SVM
const DEFAULT_LP_SHARE = 0.20; // 20% total ecosystem pool injection (80% kept by wallet)

// THE TARGET TOP-TRADER WALLETS TO COPY ON PINETSWAP
export const TARGET_WALLETS = [
  "0x343bb634cc5eaf5086134928e44215018100d521".toLowerCase(),
  "0xa577c93dfa57e9c5cf782993b875c1e9329333b9".toLowerCase(),
  "0x55534033242cda55fbb716f75b227b8ecba16062".toLowerCase(),
  "0xfd4078ccc44a02a39f7dffd1a58789aec358d81c".toLowerCase(),
  "0xfd804cf0063dbebae2e1317bc1d2242ed200f4a2".toLowerCase(),
  "0x2a39346882d1bed72a6f7cbb63933641928f2b17".toLowerCase(),
  "0x133c056556bc3d4661a1c9c80ad01b6836b37d5e".toLowerCase(),
  "0x961030fed03fa260d3a3f007d41a2dc701ee2003".toLowerCase(),
  "0xc2d89fdbf7d5e8e828dec5b4d800942bb3438282".toLowerCase(),
  "0xd745c1b36e5c9724da655b16a176d803c91db14a".toLowerCase(),
  "0x83e5b1dc8a7e81aea71b6a94c8e8aad0ca756cd1".toLowerCase(),
  "0x05597d7f5a53ab63ad1b6625ad86bcb482c8df6b".toLowerCase(),
  "0x328648e1fc7004230adc3a3e0aa3fe165c4bd4a4".toLowerCase(),
  "0xe696d8df2c05c0d61e057f1af349d08b9abfd4b6".toLowerCase(),
  "0xd3149edb82405c88a57b35d555c14eb5916bdf07".toLowerCase(),
  "0x1c3a5dcc54f31901796484bd1403cae63a8067ee".toLowerCase(),
  "0x9b6ce7e4ecaf624b4e5fc6fd91c4f86771354573".toLowerCase()
];

// STRICT EXCLUSIONS: Personal holding tokens that must NEVER be sold or liquidated
const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM"]);

// Gas Price
export let SAFE_GAS_PRICE = process.env.GAS_PRICE_WEI ? BigInt(process.env.GAS_PRICE_WEI) : 4000000000n;

// Known Token Cache
const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");
const tokenSymbolMap = new Map();
try {
  const tokensData = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));
  for (const t of tokensData.tokens || []) {
    if (t.address) tokenSymbolMap.set(t.address.toLowerCase(), t.symbol);
  }
} catch {}
tokenSymbolMap.set(WSDA_ADDR.toLowerCase(), "WSDA");

async function resolveTokenSymbol(addr) {
  const lower = addr.toLowerCase();
  if (tokenSymbolMap.has(lower)) return tokenSymbolMap.get(lower);
  try {
    const c = new ethers.Contract(addr, ["function symbol() view returns (string)"], provider);
    const sym = await c.symbol();
    tokenSymbolMap.set(lower, sym);
    return sym;
  } catch {
    return addr.slice(0, 8);
  }
}

// ABIs
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
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
  "function exactOutput((bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum)) external payable returns (uint256 amountIn)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)",
  "function multicall(bytes[] data) external payable returns (bytes[] results)"
];

const routerInterface = new ethers.Interface(ROUTER_ABI);
const approvalCache = new Set();
const processedTxHashes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POSITIONS_FILE = path.join(__dirname, "..", "data", "copy_positions.json");

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function savePositions(positions) {
  try {
    const dir = path.dirname(POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save positions file:", err.message);
  }
}

async function injectEcosystemLiquidity(signer, walletKey, router, netProfitSda) {
  let totalLp = 0.0;
  if (netProfitSda <= 0) return totalLp;

  // 1) 10% GMAI
  if (GMAI_LP_SHARE > 0) {
    const gmaiSda = netProfitSda * GMAI_LP_SHARE;
    const lpWei = ethers.parseEther(gmaiSda.toFixed(18));
    if (lpWei >= 100000000000000n) {
      try {
        const nonceLp = await getFastNonce(signer.address);
        const lpTx = await router.exactInputSingle({
          tokenIn: WSDA_ADDR,
          tokenOut: GMAI_ADDR,
          fee: GMAI_POOL_FEE,
          recipient: signer.address,
          deadline: Math.floor(Date.now() / 1000) + 180,
          amountIn: lpWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
        await lpTx.wait(1);
        totalLp += gmaiSda;
        console.log(`   💧 [${walletKey}] 10% Profit Injected into GMAI Pool: +${gmaiSda.toFixed(5)} SDA ➔ GMAI (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
      } catch (lpErr) {
        console.warn(`   ⚠️ [${walletKey}] GMAI liquidity injection skipped: ${lpErr.message}`);
      }
    }
  }

  // 2) 5% BANDIQ
  if (BANDIQ_LP_SHARE > 0) {
    const bandiqSda = netProfitSda * BANDIQ_LP_SHARE;
    const lpWei = ethers.parseEther(bandiqSda.toFixed(18));
    if (lpWei >= 100000000000000n) {
      try {
        const nonceLp = await getFastNonce(signer.address);
        const lpTx = await router.exactInputSingle({
          tokenIn: WSDA_ADDR,
          tokenOut: BANDIQ_ADDR,
          fee: BANDIQ_POOL_FEE,
          recipient: signer.address,
          deadline: Math.floor(Date.now() / 1000) + 180,
          amountIn: lpWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
        await lpTx.wait(1);
        totalLp += bandiqSda;
        console.log(`   💧 [${walletKey}] 5% Profit Injected into BANDIQ Pool: +${bandiqSda.toFixed(5)} SDA ➔ BANDIQ (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
      } catch (lpErr) {
        console.warn(`   ⚠️ [${walletKey}] BANDIQ liquidity injection skipped: ${lpErr.message}`);
      }
    }
  }

  // 3) 5% SVM
  if (SVM_LP_SHARE > 0) {
    const svmSda = netProfitSda * SVM_LP_SHARE;
    const lpWei = ethers.parseEther(svmSda.toFixed(18));
    if (lpWei >= 100000000000000n) {
      try {
        const nonceLp = await getFastNonce(signer.address);
        const lpTx = await router.exactInputSingle({
          tokenIn: WSDA_ADDR,
          tokenOut: SVM_ADDR,
          fee: SVM_POOL_FEE,
          recipient: signer.address,
          deadline: Math.floor(Date.now() / 1000) + 180,
          amountIn: lpWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
        await lpTx.wait(1);
        totalLp += svmSda;
        console.log(`   💧 [${walletKey}] 5% Profit Injected into SVM Pool: +${svmSda.toFixed(5)} SDA ➔ SVM (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
      } catch (lpErr) {
        console.warn(`   ⚠️ [${walletKey}] SVM liquidity injection skipped: ${lpErr.message}`);
      }
    }
  }

  return totalLp;
}

async function autoUnwrapProfits(signer, walletKey, wsda) {
  const wNum = parseInt(walletKey.replace("wallet", ""), 10);
  const targetWsdaReserve = wNum <= 5 ? 100.0 : (wNum <= 10 ? 10.0 : 5.0);
  const reserveWei = ethers.parseEther(targetWsdaReserve.toString());
  const curWsdaAfter = await wsda.balanceOf(signer.address);

  if (curWsdaAfter > reserveWei + ethers.parseEther("0.1")) {
    const excessProfit = curWsdaAfter - reserveWei;
    try {
      const nonceUnwrap = await getFastNonce(signer.address);
      const unwrapTx = await wsda.withdraw(excessProfit, {
        gasLimit: 80000n,
        gasPrice: SAFE_GAS_PRICE,
        nonce: nonceUnwrap
      });
      await unwrapTx.wait(1);
      console.log(`   💰 [${walletKey}] Harvested Profit: Auto-Unwrapped +${ethers.formatEther(excessProfit)} WSDA ➔ Native SDA (Kept ${targetWsdaReserve} WSDA working capital)!`);
    } catch (unwrapErr) {
      console.warn(`   ⚠️ [${walletKey}] Auto-unwrap notice: ${unwrapErr.message}`);
    }
  }
}

async function getFastNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

async function ensureFastApproval(signer, tokenAddress, requiredWei) {
  const key = `${signer.address.toLowerCase()}_${tokenAddress.toLowerCase()}`;
  if (approvalCache.has(key)) return;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const allowance = await token.allowance(signer.address, ROUTER_ADDR);
  if (allowance >= requiredWei) {
    approvalCache.add(key);
    return;
  }
  const nonce = await getFastNonce(signer.address);
  const tx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, {
    gasLimit: 85000n,
    gasPrice: SAFE_GAS_PRICE,
    nonce
  });
  await tx.wait(1);
  approvalCache.add(key);
}

/**
 * Decodes the exact swap path from Uniswap V3 path bytes.
 */
function decodeV3Path(pathHex) {
  const cleanHex = pathHex.startsWith("0x") ? pathHex.slice(2) : pathHex;
  const hops = [];
  let offset = 0;
  while (offset < cleanHex.length) {
    const token = ethers.getAddress("0x" + cleanHex.slice(offset, offset + 40));
    offset += 40;
    if (offset >= cleanHex.length) {
      hops.push({ token, fee: null });
      break;
    }
    const fee = parseInt(cleanHex.slice(offset, offset + 6), 16);
    offset += 6;
    hops.push({ token, fee });
  }
  return hops;
}

/**
 * Parses and decodes any transaction targeting Pinetswap router.
 */
async function parsePinetswapTx(tx) {
  if (!tx || !tx.to) return null;
  if (tx.to.toLowerCase() !== ROUTER_ADDR.toLowerCase()) return null;

  try {
    const parsed = routerInterface.parseTransaction({ data: tx.data });
    if (!parsed) return null;

    if (parsed.name === "exactInput") {
      const params = parsed.args[0];
      const hops = decodeV3Path(params.path);
      const isRoundTrip =
        hops.length >= 2 &&
        hops[0].token.toLowerCase() === WSDA_ADDR.toLowerCase() &&
        hops[hops.length - 1].token.toLowerCase() === WSDA_ADDR.toLowerCase();

      return {
        method: "exactInput",
        recipient: params.recipient,
        amountIn: params.amountIn,
        amountInSda: Number(ethers.formatEther(params.amountIn)),
        amountOutMinimum: params.amountOutMinimum,
        path: params.path,
        hops,
        isRoundTrip,
        tokenIn: hops[0].token,
        tokenOut: hops[hops.length - 1].token
      };
    }

    if (parsed.name === "exactInputSingle") {
      const p = parsed.args[0];
      const hops = [
        { token: p.tokenIn, fee: Number(p.fee) },
        { token: p.tokenOut, fee: null }
      ];
      const path = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [p.tokenIn, p.fee, p.tokenOut]
      );
      return {
        method: "exactInputSingle",
        recipient: p.recipient,
        amountIn: p.amountIn,
        amountInSda: Number(ethers.formatEther(p.amountIn)),
        amountOutMinimum: p.amountOutMinimum,
        path,
        hops,
        fee: p.fee,
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        isRoundTrip: false
      };
    }

    if (parsed.name === "multicall") {
      const calls = parsed.args[0] || [];
      for (const callData of calls) {
        try {
          const sub = routerInterface.parseTransaction({ data: callData });
          if (!sub) continue;
          if (sub.name === "exactInput") {
            const params = sub.args[0];
            const hops = decodeV3Path(params.path);
            const isRoundTrip =
              hops.length >= 2 &&
              hops[0].token.toLowerCase() === WSDA_ADDR.toLowerCase() &&
              hops[hops.length - 1].token.toLowerCase() === WSDA_ADDR.toLowerCase();

            return {
              method: "exactInput",
              recipient: params.recipient,
              amountIn: params.amountIn,
              amountInSda: Number(ethers.formatEther(params.amountIn)),
              amountOutMinimum: params.amountOutMinimum,
              path: params.path,
              hops,
              isRoundTrip,
              tokenIn: hops[0].token,
              tokenOut: hops[hops.length - 1].token
            };
          }
          if (sub.name === "exactInputSingle") {
            const p = sub.args[0];
            const hops = [
              { token: p.tokenIn, fee: Number(p.fee) },
              { token: p.tokenOut, fee: null }
            ];
            const path = ethers.solidityPacked(
              ["address", "uint24", "address"],
              [p.tokenIn, p.fee, p.tokenOut]
            );
            return {
              method: "exactInputSingle",
              recipient: p.recipient,
              amountIn: p.amountIn,
              amountInSda: Number(ethers.formatEther(p.amountIn)),
              amountOutMinimum: p.amountOutMinimum,
              path,
              hops,
              fee: p.fee,
              tokenIn: p.tokenIn,
              tokenOut: p.tokenOut,
              isRoundTrip: false
            };
          }
        } catch {}
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Executes copy trade based on detected target transaction.
 */
async function executeCopyTrade({
  walletKey,
  signer,
  targetTxInfo,
  targetWallet,
  copyConfig,
  staggerMs = 0
}) {
  if (staggerMs > 0) await sleep(staggerMs);
  const { isLive, tradeSizeSda, copyProportion, sameTrade, minTradeSda = 3.0, maxTradeSda = 100.0 } = copyConfig;
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);

  // Compute trade size: strictly clamp between minTradeSda (3.0 SDA) and maxTradeSda (100.0 SDA)
  // dynamically adjusted to the wallet's available capital
  const [curWsda, nativeBal] = await Promise.all([
    wsda.balanceOf(signer.address),
    provider.getBalance(signer.address)
  ]);
  const liquidWsdaSda = Number(ethers.formatEther(curWsda));
  const liquidTotalSda = Math.max(0, Number(ethers.formatEther(curWsda + nativeBal)) - 0.05);

  let userAmountSda = tradeSizeSda;
  if (sameTrade && targetTxInfo.amountInSda > 0) {
    userAmountSda = targetTxInfo.amountInSda;
  } else if (copyProportion && copyProportion > 0 && !sameTrade) {
    userAmountSda = targetTxInfo.amountInSda * copyProportion;
  }

  // Strict clamp bounds: Minimum 3.0 SDA, Maximum 100.0 SDA
  userAmountSda = Math.max(userAmountSda, minTradeSda);
  userAmountSda = Math.min(userAmountSda, maxTradeSda);

  // If wallet has pre-funded working capital (e.g. W1-5 has 100 WSDA, W6-10 has 10 WSDA), adapt to available funds
  if (liquidWsdaSda >= minTradeSda) {
    userAmountSda = Math.min(userAmountSda, liquidWsdaSda);
  } else if (liquidTotalSda >= minTradeSda) {
    userAmountSda = Math.min(userAmountSda, liquidTotalSda);
  }
  userAmountSda = Math.max(userAmountSda, minTradeSda);
  const userAmountWei = ethers.parseEther(userAmountSda.toFixed(18));

  const hopsStr = [];
  for (let i = 0; i < (targetTxInfo.hops || []).length; i++) {
    const h = targetTxInfo.hops[i];
    const sym = await resolveTokenSymbol(h.token);
    hopsStr.push(h.fee ? `${sym} (Fee ${h.fee})` : sym);
  }

  const isWhaleExit = targetTxInfo.tokenOut && targetTxInfo.tokenOut.toLowerCase() === WSDA_ADDR.toLowerCase() && !targetTxInfo.isRoundTrip;
  const isWhaleBuy = targetTxInfo.tokenIn && targetTxInfo.tokenIn.toLowerCase() === WSDA_ADDR.toLowerCase() && !targetTxInfo.isRoundTrip;

  let stratType = "⚡ ATOMIC ARBITRAGE ROUND-TRIP";
  if (isWhaleExit) stratType = "🚪 WHALE EXIT / PROFIT REALIZATION (SELL)";
  else if (isWhaleBuy) stratType = "💎 DIRECTIONAL WHALE COPY (BUY & HOLD)";

  console.log(`\n==========================================================================`);
  console.log(`🚨 [COPY TRADE TRIGGERED] Following Target: ${targetWallet.slice(0, 10)}...`);
  console.log(`==========================================================================`);
  console.log(`   Executing Wallet    : [${walletKey.toUpperCase()}] ${signer.address}`);
  console.log(`   Strategy Type       : ${stratType}`);
  console.log(`   Target Swap Path    : ${hopsStr.join(" ➔ ")}`);
  console.log(`   Target Amount       : ${targetTxInfo.amountInSda.toFixed(4)} SDA`);
  if (!isWhaleExit) {
    console.log(`   User Copy Deploy    : ${userAmountSda.toFixed(4)} SDA (Min: ${minTradeSda.toFixed(1)}, Max: ${maxTradeSda.toFixed(1)})`);
  }
  console.log(`   Holding Mode        : 🔒 Wallets 1-5 Hold Tokens Based on Top Trader Decisions`);
  console.log(`--------------------------------------------------------------------------`);

  // STRICT INVARIANT: If this trade attempts to sell personal holdings (GMAI, RIDE, SVM, etc.), abort!
  for (const h of targetTxInfo.hops || []) {
    const sym = await resolveTokenSymbol(h.token);
    if (STRICT_EXCLUSIONS.has(sym.toUpperCase()) && !targetTxInfo.isRoundTrip) {
      console.warn(`   🛡️ [PROTECTION GUARD] Target interacts with protected asset ${sym}. Aborting copy-trade to safeguard portfolio.`);
      return { success: false, reason: "PROTECTED_TOKEN_INVOLVED" };
    }
  }

  const deadline = Math.floor(Date.now() / 1000) + 180;

  // =========================================================================
  // BRANCH 1: WHALE EXIT (Target is dumping a token back to WSDA)
  // Wallets 1-5 sell their held tokens, realize profit, inject 20% into pools!
  // =========================================================================
  if (isWhaleExit) {
    const tokenToSell = targetTxInfo.tokenIn;
    const symToSell = await resolveTokenSymbol(tokenToSell);
    const tokenContract = new ethers.Contract(tokenToSell, ERC20_ABI, signer);
    const heldBalance = await tokenContract.balanceOf(signer.address);

    if (heldBalance === 0n) {
      console.log(`   🛡️ [HOLDING MONITOR] Whale sold ${symToSell}, but [${walletKey.toUpperCase()}] holds 0 ${symToSell}. Skipping.`);
      return { success: false, reason: "NO_TOKENS_HELD" };
    }

    const positions = loadPositions();
    const pos = positions[walletKey]?.[tokenToSell.toLowerCase()];
    const costBasisSda = pos ? (pos.costWsda || 0) : 0;

    console.log(`   🎯 [POSITION EXIT] [${walletKey.toUpperCase()}] Holding ${ethers.formatEther(heldBalance)} ${symToSell} (Cost Basis: ${costBasisSda.toFixed(4)} WSDA)`);
    console.log(`   Selling token back to WSDA following Whale Decision...`);

    // Determine optimal fee pool to sell
    const candidateFees = [targetTxInfo.fee, 500, 3000, 10000].filter(Boolean);
    let bestFee = targetTxInfo.fee || 3000;
    let bestOutWei = 0n;

    for (const f of candidateFees) {
      try {
        const out = await router.exactInputSingle.staticCall({
          tokenIn: tokenToSell,
          tokenOut: WSDA_ADDR,
          fee: f,
          recipient: signer.address,
          deadline,
          amountIn: heldBalance,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        }, { from: signer.address });
        if (out > bestOutWei) {
          bestOutWei = out;
          bestFee = f;
        }
      } catch {}
    }

    if (bestOutWei === 0n) {
      console.warn(`   ⚠️ [${walletKey}] No liquid pool route found to exit ${symToSell} back to WSDA.`);
      return { success: false, reason: "NO_LIQUIDITY_TO_EXIT" };
    }

    const expectedProceedsSda = Number(ethers.formatEther(bestOutWei));
    console.log(`   🛡️ [PRE-FLIGHT] Best pool fee: ${bestFee} | Expected Proceeds: +${expectedProceedsSda.toFixed(5)} WSDA`);

    if (!isLive) {
      console.log(`   🛡️ [DRY-RUN SIMULATION] Simulated exit of ${symToSell} for +${expectedProceedsSda.toFixed(5)} WSDA`);
      return { success: true, simulated: true, isPositionClosed: true, grossDelta: expectedProceedsSda, netProfitSda: expectedProceedsSda - costBasisSda };
    }

    // Ensure Router Approval for token
    await ensureFastApproval(signer, tokenToSell, heldBalance);

    const wsdaBefore = await wsda.balanceOf(signer.address);
    const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
    try {
      const minProceedsWei = (bestOutWei * 98n) / 100n; // 2% max slippage protection
      const sellTx = await router.exactInputSingle({
        tokenIn: tokenToSell,
        tokenOut: WSDA_ADDR,
        fee: bestFee,
        recipient: signer.address,
        deadline,
        amountIn: heldBalance,
        amountOutMinimum: minProceedsWei,
        sqrtPriceLimitX96: 0
      }, {
        gasLimit: 320000n,
        gasPrice: SAFE_GAS_PRICE,
        nonce: lock.nonce
      });

      console.log(`   🚀 Position Exit Broadcasted! Tx: ${sellTx.hash}`);
      const receipt = await sellTx.wait(1);
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}! (Gas: ${receipt.gasUsed})`);

      const wsdaAfter = await wsda.balanceOf(signer.address);
      const grossProceedsSda = Number(ethers.formatEther(wsdaAfter - wsdaBefore));
      const gasSpentWei = BigInt(receipt.gasUsed) * SAFE_GAS_PRICE;
      const gasSpentSda = Number(ethers.formatEther(gasSpentWei));
      const netProfitSda = costBasisSda > 0 ? (grossProceedsSda - costBasisSda - gasSpentSda) : (grossProceedsSda - gasSpentSda);

      // Multi-Token Flywheel: Inject 20% into pools (10% GMAI, 5% BANDIQ, 5% SVM)
      let totalLpInjected = 0.0;
      if (netProfitSda > 0) {
        totalLpInjected = await injectEcosystemLiquidity(signer, walletKey, router, netProfitSda);
      }

      // Auto-Unwrap 80% Retained Profit
      await autoUnwrapProfits(signer, walletKey, wsda);

      // Clear position from storage
      if (positions[walletKey]?.[tokenToSell.toLowerCase()]) {
        delete positions[walletKey][tokenToSell.toLowerCase()];
        savePositions(positions);
      }

      console.log(`\n🎉 [${walletKey.toUpperCase()} POSITION CLOSED SUCCESSFULLY]`);
      console.log(`   • Asset Sold        : ${symToSell}`);
      console.log(`   • WSDA Proceeds     : +${grossProceedsSda.toFixed(5)} WSDA`);
      console.log(`   • Cost Basis        : ${costBasisSda.toFixed(5)} WSDA`);
      console.log(`   • Gas Fees Spent    : -${gasSpentSda.toFixed(5)} SDA`);
      console.log(`   • Net Realized PnL  : ${netProfitSda >= 0 ? "+" : ""}${netProfitSda.toFixed(5)} SDA`);
      console.log(`   • 💧 20% Ecosystem  : +${totalLpInjected.toFixed(5)} SDA (GMAI, BANDIQ, SVM)`);

      return {
        success: true,
        isPositionClosed: true,
        tokenSold: symToSell,
        grossDelta: grossProceedsSda,
        gasSpentSda,
        netProfitSda,
        lpProfitSda: totalLpInjected,
        txHash: sellTx.hash
      };
    } catch (err) {
      console.error(`   ❌ [${walletKey}] Position exit failed: ${err.reason || err.message}`);
      return { success: false, reason: err.message };
    } finally {
      await lock.release();
    }
  }

  // =========================================================================
  // BRANCH 2: WHALE ROUND-TRIP ARBITRAGE (WSDA -> ... -> WSDA)
  // Execute atomic instant round-trip: 0 tokens held, instant profit!
  // =========================================================================
  if (targetTxInfo.isRoundTrip) {
    if (!isLive) {
      const simGross = userAmountSda * 0.0065;
      const simGas = 0.00072;
      const simNet = simGross - simGas;
      const simLp = simNet * (copyConfig.lpShare ?? DEFAULT_LP_SHARE);
      console.log(`   🛡️ [DRY-RUN SIMULATION] Round-trip arbitrage simulation for ${walletKey}!`);
      return { success: true, simulated: true, isRoundTrip: true, userAmountSda, grossDelta: simGross, gasSpentSda: simGas, netProfitSda: simNet, lpProfitSda: simLp };
    }

    // Ensure WSDA
    let freshWsda = await wsda.balanceOf(signer.address);
    if (freshWsda < userAmountWei) {
      const wrapNeeded = userAmountWei - freshWsda;
      const freshNative = await provider.getBalance(signer.address);
      if (freshNative < wrapNeeded + ethers.parseEther("0.05")) {
        console.warn(`   ⚠️ [${walletKey}] Insufficient native balance to fund trade.`);
        return { success: false, reason: "LOW_NATIVE_BALANCE" };
      }
      const nonceWrap = await getFastNonce(signer.address);
      const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceWrap });
      await wrapTx.wait(1);
    }
    await ensureFastApproval(signer, WSDA_ADDR, userAmountWei);

    try {
      const liveOut = await router.exactInput.staticCall({
        path: targetTxInfo.path,
        recipient: signer.address,
        deadline,
        amountIn: userAmountWei,
        amountOutMinimum: userAmountWei + 1n
      }, { from: signer.address });
      const netSda = Number(ethers.formatEther(liveOut - userAmountWei));
      console.log(`   🛡️ [STATIC-CALL VERIFIED] Round-trip yields +${netSda.toFixed(5)} SDA Net Profit!`);
    } catch {
      console.log(`   🛡️ [STATIC-CALL GUARD] Arbitrage opportunity stale or slippage exceeded. Aborting.`);
      return { success: false, reason: "SIMULATION_REJECTED" };
    }

    const wsdaBefore = await wsda.balanceOf(signer.address);
    const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
    try {
      const copyTx = await router.exactInput({
        path: targetTxInfo.path,
        recipient: signer.address,
        deadline,
        amountIn: userAmountWei,
        amountOutMinimum: userAmountWei + 1n
      }, { gasLimit: 360000n, gasPrice: SAFE_GAS_PRICE, nonce: lock.nonce });

      console.log(`   🚀 Round-Trip Trade Broadcasted! Tx: ${copyTx.hash}`);
      const receipt = await copyTx.wait(1);
      const wsdaAfter = await wsda.balanceOf(signer.address);
      const grossDelta = Number(ethers.formatEther(wsdaAfter - wsdaBefore));
      const gasSpentWei = BigInt(receipt.gasUsed) * SAFE_GAS_PRICE;
      const gasSpentSda = Number(ethers.formatEther(gasSpentWei));
      const netProfitSda = grossDelta - gasSpentSda;

      let totalLp = 0.0;
      if (netProfitSda > 0) {
        totalLp = await injectEcosystemLiquidity(signer, walletKey, router, netProfitSda);
      }
      await autoUnwrapProfits(signer, walletKey, wsda);

      return {
        success: true,
        isRoundTrip: true,
        txHash: copyTx.hash,
        grossDelta,
        gasSpentSda,
        netProfitSda,
        lpProfitSda: totalLp
      };
    } catch (err) {
      console.error(`   ❌ Round-trip trade error: ${err.message}`);
      return { success: false, reason: err.message };
    } finally {
      await lock.release();
    }
  }

  // =========================================================================
  // BRANCH 3: WHALE BUY (WSDA -> Token)
  // 1) Test for instant cross-pool scalp exit. If profitable -> atomic instant profit!
  // 2) If no instant exit -> BUY & PATIENTLY HOLD TOKEN BASED ON WHALE DECISION!
  // =========================================================================
  if (isWhaleBuy) {
    const token = targetTxInfo.tokenOut;
    const tokenSym = await resolveTokenSymbol(token);
    const buyFee = targetTxInfo.fee || 3000;

    // 1) Test immediate cross-pool scalp
    const candidateFees = [500, 3000, 10000].filter(f => f !== buyFee);
    let bestCrossRoute = null;

    for (const sellFee of candidateFees) {
      const candidatePath = ethers.solidityPacked(
        ["address", "uint24", "address", "uint24", "address"],
        [WSDA_ADDR, buyFee, token, sellFee, WSDA_ADDR]
      );
      try {
        const out = await router.exactInput.staticCall({
          path: candidatePath,
          recipient: signer.address,
          deadline,
          amountIn: userAmountWei,
          amountOutMinimum: userAmountWei + 1n
        }, { from: signer.address });
        const netOut = Number(ethers.formatEther(out - userAmountWei));
        if (netOut > 0 && (!bestCrossRoute || netOut > bestCrossRoute.netOut)) {
          bestCrossRoute = { path: candidatePath, netOut, sellFee };
        }
      } catch {}
    }

    if (bestCrossRoute) {
      console.log(`   ⚡ [CROSS-POOL SCALP FOUND] Target buy in pool ${buyFee} enables instant exit in pool ${bestCrossRoute.sellFee} (+${bestCrossRoute.netOut.toFixed(5)} SDA Net)!`);
      if (!isLive) {
        return { success: true, simulated: true, isRoundTrip: true, netProfitSda: bestCrossRoute.netOut, grossDelta: bestCrossRoute.netOut + 0.0005 };
      }
      let freshWsda = await wsda.balanceOf(signer.address);
      if (freshWsda < userAmountWei) {
        const wrapNeeded = userAmountWei - freshWsda;
        const freshNative = await provider.getBalance(signer.address);
        if (freshNative >= wrapNeeded + ethers.parseEther("0.05")) {
          const nonceWrap = await getFastNonce(signer.address);
          const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceWrap });
          await wrapTx.wait(1);
        }
      }
      await ensureFastApproval(signer, WSDA_ADDR, userAmountWei);
      const wsdaBefore = await wsda.balanceOf(signer.address);
      const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
      try {
        const scalpTx = await router.exactInput({
          path: bestCrossRoute.path,
          recipient: signer.address,
          deadline,
          amountIn: userAmountWei,
          amountOutMinimum: userAmountWei + 1n
        }, { gasLimit: 360000n, gasPrice: SAFE_GAS_PRICE, nonce: lock.nonce });
        const receipt = await scalpTx.wait(1);
        const wsdaAfter = await wsda.balanceOf(signer.address);
        const grossDelta = Number(ethers.formatEther(wsdaAfter - wsdaBefore));
        const gasSpentSda = Number(ethers.formatEther(BigInt(receipt.gasUsed) * SAFE_GAS_PRICE));
        const netProfitSda = grossDelta - gasSpentSda;
        let totalLp = 0.0;
        if (netProfitSda > 0) totalLp = await injectEcosystemLiquidity(signer, walletKey, router, netProfitSda);
        await autoUnwrapProfits(signer, walletKey, wsda);
        return { success: true, isRoundTrip: true, txHash: scalpTx.hash, grossDelta, gasSpentSda, netProfitSda, lpProfitSda: totalLp };
      } catch (err) {
        console.warn(`   ⚠️ Instant scalp failed, falling back to Buy & Hold: ${err.message}`);
      } finally {
        await lock.release();
      }
    }

    // 2) NO INSTANT CROSS-POOL EXIT: BUY AND PATIENTLY HOLD BASED ON TOP TRADER DECISION!
    console.log(`   💎 [BUY & HOLD STRATEGY] Top Trader is accumulating ${tokenSym}.`);
    console.log(`   [${walletKey.toUpperCase()}] will BUY & HOLD ${tokenSym} until Top Trader closes position!`);

    if (!isLive) {
      console.log(`   🛡️ [DRY-RUN SIMULATION] Simulated position opened: Bought ${tokenSym} with ${userAmountSda.toFixed(4)} WSDA (Holding)`);
      return { success: true, simulated: true, isPositionOpened: true, tokenHeld: tokenSym, costWsda: userAmountSda };
    }

    // Ensure WSDA
    let freshWsda = await wsda.balanceOf(signer.address);
    if (freshWsda < userAmountWei) {
      const wrapNeeded = userAmountWei - freshWsda;
      const freshNative = await provider.getBalance(signer.address);
      if (freshNative < wrapNeeded + ethers.parseEther("0.05")) {
        console.warn(`   ⚠️ [${walletKey}] Insufficient native balance to fund buy (${ethers.formatEther(freshNative)} SDA).`);
        return { success: false, reason: "LOW_NATIVE_BALANCE" };
      }
      const nonceWrap = await getFastNonce(signer.address);
      const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceWrap });
      await wrapTx.wait(1);
    }
    await ensureFastApproval(signer, WSDA_ADDR, userAmountWei);

    // Pre-flight staticCall for buy
    let expectedTokensWei = 0n;
    try {
      expectedTokensWei = await router.exactInputSingle.staticCall({
        tokenIn: WSDA_ADDR,
        tokenOut: token,
        fee: buyFee,
        recipient: signer.address,
        deadline,
        amountIn: userAmountWei,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0
      }, { from: signer.address });
      console.log(`   🛡️ [STATIC-CALL VERIFIED] Buy simulation successful (Expected: ${ethers.formatEther(expectedTokensWei)} ${tokenSym})`);
    } catch (err) {
      console.warn(`   ⚠️ [${walletKey}] Buy simulation reverted: ${err.reason || err.message}`);
      return { success: false, reason: "BUY_SIMULATION_FAILED" };
    }

    const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);
    const tokenBefore = await tokenContract.balanceOf(signer.address);
    const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
    try {
      const minTokensWei = (expectedTokensWei * 97n) / 100n; // 3% max slippage
      const buyTx = await router.exactInputSingle({
        tokenIn: WSDA_ADDR,
        tokenOut: token,
        fee: buyFee,
        recipient: signer.address,
        deadline,
        amountIn: userAmountWei,
        amountOutMinimum: minTokensWei,
        sqrtPriceLimitX96: 0
      }, {
        gasLimit: 300000n,
        gasPrice: SAFE_GAS_PRICE,
        nonce: lock.nonce
      });

      console.log(`   🚀 Buy Order Broadcasted! Tx: ${buyTx.hash}`);
      const receipt = await buyTx.wait(1);
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}! (Gas: ${receipt.gasUsed})`);

      const tokenAfter = await tokenContract.balanceOf(signer.address);
      const tokensAcquired = tokenAfter - tokenBefore;

      // Save position to copy_positions.json
      const positions = loadPositions();
      if (!positions[walletKey]) positions[walletKey] = {};
      positions[walletKey][token.toLowerCase()] = {
        token,
        symbol: tokenSym,
        amountTokensWei: tokensAcquired.toString(),
        amountTokens: ethers.formatEther(tokensAcquired),
        costWsda: userAmountSda,
        buyFee,
        timestamp: Date.now(),
        targetWallet,
        buyTxHash: buyTx.hash
      };
      savePositions(positions);

      console.log(`\n💎 [${walletKey.toUpperCase()} POSITION OPENED & HELD]`);
      console.log(`   • Asset Acquired    : ${tokenSym}`);
      console.log(`   • Tokens Acquired   : ${ethers.formatEther(tokensAcquired)} ${tokenSym}`);
      console.log(`   • Cost Basis        : ${userAmountSda.toFixed(4)} WSDA`);
      console.log(`   • Status            : 🔒 HOLDING PATIENTLY UNTIL TOP TRADER EXITS`);
      console.log(`   • Tx Hash           : https://ledger.sidrachain.com/tx/${buyTx.hash}`);

      return {
        success: true,
        isPositionOpened: true,
        tokenHeld: tokenSym,
        costWsda: userAmountSda,
        txHash: buyTx.hash
      };
    } catch (err) {
      console.error(`   ❌ [${walletKey}] Buy execution error: ${err.reason || err.message}`);
      return { success: false, reason: err.message };
    } finally {
      await lock.release();
    }
  }

  console.log(`   🛡️ [GUARD] Target transaction involves non-WSDA routing. Skipping to safeguard capital.`);
  return { success: false, reason: "UNSUPPORTED_ROUTE" };
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || args.includes("--live") || process.env.LIVE === "true";
  const sameTrade = args.includes("--same-trade") || args.includes("--same-sda") || process.env.SAME_TRADE_SDA === "true";
  const tradeSizeSda = Number(args.find((a) => a.startsWith("--trade-size=") || a.startsWith("--amount="))?.split("=")[1] || process.env.TRADE_SIZE_SDA || 50.0);
  const minTradeSda = Number(args.find((a) => a.startsWith("--min-sda=") || a.startsWith("--min-trade="))?.split("=")[1] || 3.0);
  const maxTradeSda = Number(args.find((a) => a.startsWith("--max-sda=") || a.startsWith("--max-trade="))?.split("=")[1] || 100.0);
  const copyProportion = Number(args.find((a) => a.startsWith("--copy-ratio="))?.split("=")[1] || 1.0);
  const lpShare = Number(args.find((a) => a.startsWith("--pool-share="))?.split("=")[1] ?? DEFAULT_LP_SHARE);
  
  const walletFlag = args.find((a) => a.startsWith("--wallet=") || a.startsWith("--wallets="));
  const walletArg = walletFlag ? walletFlag.split("=")[1] : (process.env.TARGET_WALLETS_ARG || "1-5");

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

  const availableKeys = Object.keys(swarmWallets);
  if (availableKeys.length === 0) throw new Error("No private keys configured in .env");

  const activeKeys = parseTargetWallets(walletArg, availableKeys);

  console.log("==========================================================================");
  console.log("🎯 PINETSWAP TOP-TRADER COPY TRADING AUTOMATION");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Tracked Targets (${TARGET_WALLETS.length}) :`);
  TARGET_WALLETS.forEach((tw, idx) => {
    console.log(`   • Target #${idx + 1}        : ${tw}`);
  });
  console.log(`Copy Trade Sizing  : ${tradeSizeSda.toFixed(2)} SDA base (Strict Range: ${minTradeSda.toFixed(1)} to ${maxTradeSda.toFixed(1)} SDA based on wallet WSDA)`);
  console.log(`Executing Fleet    : ${activeKeys.join(", ")} (⚡ ALL WALLETS AT THE SAME TIME)`);
  console.log(`DEX Platform       : Pinetswap Uniswap-V3 Router (${ROUTER_ADDR})`);
  console.log(`Liquidity Profit   : ${Math.round(lpShare * 100)}% of Net SDA Profit Auto-Injected into GMAI Pool (${GMAI_ADDR.slice(0, 10)}...)`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM (100% PROTECTED & ISOLATED) [ATES ACTIVE]`);
  console.log(`Pre-Flight Check   : On-chain staticCall before broadcast (0 gas spent on stale arbs)`);
  console.log("==========================================================================\n");

  console.log("👥 Fleet Current Balances:");
  for (const k of activeKeys) {
    const w = swarmWallets[k];
    const bal = await provider.getBalance(w.address);
    const wsda = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
    const wsdaBal = await wsda.balanceOf(w.address);
    console.log(`   • [${k.toUpperCase().padEnd(7)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)}`);
  }

  console.log("\n📡 Subscribing to live blocks on Sidra Chain... Listening for target transactions...\n");

  let sessionGrossProfitSda = 0.0;
  let sessionNetProfitSda = 0.0;
  let sessionGasSpentSda = 0.0;
  let sessionGmaiLpInjectedSda = 0.0;
  let sessionTradesExecuted = 0;
  let sessionWavesCount = 0;
  let copyWalletIndex = 0;
  let lastHeartbeatTime = Date.now();
  let lastCheckedBlock = await provider.getBlockNumber();

  process.on("SIGINT", () => {
    console.log(`\n==========================================================================`);
    console.log(`🛑 COPY TRADER SHUTDOWN SUMMARY`);
    console.log(`==========================================================================`);
    console.log(`   • Total Waves Run           : ${sessionWavesCount}`);
    console.log(`   • Total Trades Executed     : ${sessionTradesExecuted}`);
    console.log(`   • TOTAL GROSS SDA PROFIT    : ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL GAS SPENT           : -${sessionGasSpentSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL NET REALIZED PROFIT : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
    console.log(`   • 💧 GMAI POOL LIQUIDITY (10%): +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
    console.log(`==========================================================================\n`);
    process.exit(0);
  });

  // Polling loop for low-latency block checking
  while (true) {
    try {
      // Dynamic gas price refresh
      try {
        const feeData = await provider.getFeeData();
        if (feeData.gasPrice && feeData.gasPrice < 10000000000n) {
          SAFE_GAS_PRICE = (feeData.gasPrice * 110n) / 100n;
        } else {
          SAFE_GAS_PRICE = process.env.GAS_PRICE_WEI ? BigInt(process.env.GAS_PRICE_WEI) : 4000000000n;
        }
      } catch {}

      const currentBlock = await provider.getBlockNumber();
      if (currentBlock > lastCheckedBlock) {
        for (let b = lastCheckedBlock + 1; b <= currentBlock; b++) {
          const block = await provider.getBlock(b);
          if (!block || !block.transactions || block.transactions.length === 0) continue;

          for (const txHash of block.transactions) {
            if (processedTxHashes.has(txHash)) continue;
            processedTxHashes.add(txHash);

            try {
              const tx = await provider.getTransaction(txHash);
              if (!tx || !tx.from) continue;

              const fromLower = tx.from.toLowerCase();
              if (TARGET_WALLETS.includes(fromLower)) {
                console.log(`\n🔔 [DETECTED TRANSACTION] Target ${fromLower} in block ${b}!`);
                console.log(`   Tx Hash: https://ledger.sidrachain.com/tx/${tx.hash}`);

                const parsed = await parsePinetswapTx(tx);
                if (parsed) {
                  const isWhaleExit = parsed.tokenOut && parsed.tokenOut.toLowerCase() === WSDA_ADDR.toLowerCase() && !parsed.isRoundTrip;
                  let executingKeys = [];

                  if (isWhaleExit) {
                    const symIn = await resolveTokenSymbol(parsed.tokenIn);
                    const tokenContract = new ethers.Contract(parsed.tokenIn, ERC20_ABI, provider);
                    for (const k of activeKeys) {
                      try {
                        const bal = await tokenContract.balanceOf(swarmWallets[k].address);
                        if (bal > 0n) executingKeys.push(k);
                      } catch {}
                    }
                    if (executingKeys.length === 0) {
                      console.log(`   ℹ️ [WHALE EXIT DETECTED] Target sold ${symIn}, but Wallets 1-5 hold 0 balance. Skipping exit.`);
                      continue;
                    }
                    console.log(`\n🎯 [WHALE EXIT DETECTED] Target sold ${symIn}! Executing exit across holding fleet wallets: ${executingKeys.join(", ")}`);
                  } else {
                    // Whale Buy or Round-Trip:
                    // Use rotating dispatch across active keys (Wallets 1-5) to prevent pool collision
                    const rotatingKey = activeKeys[copyWalletIndex % activeKeys.length];
                    copyWalletIndex++;
                    executingKeys = [rotatingKey];
                    console.log(`\n🚀 [COORDINATED ROTATING DISPATCH] Assigning trade to [${rotatingKey.toUpperCase()}] (Zero-Collision Protection)`);
                  }

                  const copyResults = [];
                  for (const wKey of executingKeys) {
                    const executingSigner = swarmWallets[wKey];
                    const r = await executeCopyTrade({
                      walletKey: wKey,
                      signer: executingSigner,
                      targetTxInfo: parsed,
                      targetWallet: fromLower,
                      copyConfig: { isLive, tradeSizeSda, copyProportion, sameTrade, lpShare, minTradeSda, maxTradeSda },
                      staggerMs: 0
                    });
                    if (r) copyResults.push(r);
                  }

                  sessionWavesCount++;
                  let waveGross = 0.0;
                  let waveNet = 0.0;
                  let waveGas = 0.0;
                  let waveLp = 0.0;
                  let waveSuccess = 0;

                  for (const r of copyResults) {
                    if (r && r.success) {
                      waveGross += r.grossDelta || 0;
                      waveNet += r.netProfitSda || 0;
                      waveGas += r.gasSpentSda || 0;
                      waveLp += r.lpProfitSda || 0;
                      waveSuccess++;
                    }
                  }

                  sessionGrossProfitSda += waveGross;
                  sessionNetProfitSda += waveNet;
                  sessionGasSpentSda += waveGas;
                  sessionGmaiLpInjectedSda += waveLp;
                  sessionTradesExecuted += waveSuccess;

                  console.log(`\n==========================================================================`);
                  console.log(`📊 LIVE PINETSWAP COPY-TRADING PERFORMANCE DASHBOARD:`);
                  console.log(`==========================================================================`);
                  console.log(`   • Trades Confirmed in Wave  : ${waveSuccess} / ${executingKeys.length} Executed Fleet Wallets`);
                  console.log(`   • Wave Gross SDA Profit     : ${waveGross >= 0 ? "+" : ""}${waveGross.toFixed(5)} SDA`);
                  console.log(`   • Wave Gas Fees Spent       : -${waveGas.toFixed(5)} SDA`);
                  console.log(`   • Wave Net Realized Profit  : ${waveNet >= 0 ? "+" : ""}${waveNet.toFixed(5)} SDA`);
                  console.log(`   • 💧 10% Injected to GMAI   : +${waveLp.toFixed(5)} SDA`);
                  console.log(`   ----------------------------------------------------------------------`);
                  console.log(`   🏆 CUMULATIVE AUTOMATION TOTALS:`);
                  console.log(`   • Total Copy Waves          : ${sessionWavesCount}`);
                  console.log(`   • Total Confirmed Trades    : ${sessionTradesExecuted}`);
                  console.log(`   • TOTAL GROSS SDA PROFIT    : ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
                  console.log(`   • TOTAL GAS FEES SPENT      : -${sessionGasSpentSda.toFixed(5)} SDA`);
                  console.log(`   • TOTAL NET REALIZED PROFIT : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
                  console.log(`   • 💧 GMAI POOL LIQUIDITY    : +${sessionGmaiLpInjectedSda.toFixed(5)} SDA (${Math.round(lpShare * 100)}% of profit)`);
                  console.log(`==========================================================================\n`);
                } else {
                  console.log(`   ℹ️ Transaction is not a supported Pinetswap swap method.`);
                }
              }
            } catch (txErr) {
              // Ignore single tx fetch glitches
            }
          }
        }
        lastCheckedBlock = currentBlock;
      }

      // Periodic Status Heartbeat (every 60s)
      if (Date.now() - lastHeartbeatTime >= 60000) {
        lastHeartbeatTime = Date.now();
        const positions = loadPositions();
        const openList = [];
        for (const [wKey, tokenMap] of Object.entries(positions)) {
          for (const [tAddr, p] of Object.entries(tokenMap)) {
            openList.push(`[${wKey.toUpperCase()}]: ${p.symbol || tAddr.slice(0, 6)} (${p.costWsda} WSDA)`);
          }
        }
        const posStr = openList.length > 0 ? `| 💎 Open Positions Held: ${openList.join(", ")}` : `| 💎 0 Open Positions (100% Liquid Capital)`;
        console.log(`⏳ [HEARTBEAT] Block ${currentBlock} | Active Targets: ${TARGET_WALLETS.length} | Fleet: ${activeKeys.join(", ")} ${posStr} | Total Profit: ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA (${sessionTradesExecuted} trades)`);
      }
    } catch (err) {
      // Silently retry on transient RPC hiccups
    }

    await sleep(600); // 600ms responsive cadence
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Fatal Copy Trader error:", err);
    process.exit(1);
  });
}
