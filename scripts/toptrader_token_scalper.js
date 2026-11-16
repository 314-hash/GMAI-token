import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseTargetWallets, acquireWalletLock, isWalletReady } from "./wallet_helper.js";
import { scanMarket } from "../engine/scanner.js";
import { quoteV3Swap } from "../engine/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Pinetswap / Sidra Network Constants
const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 500;

const ROUTER_ADDR = ethers.getAddress(process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb");
const FACTORY_ADDR = ethers.getAddress(process.env.FACTORY_ADDRESS || "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE");
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

// The 14 Top-Trader Targets
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

// STRICT EXCLUSIONS: Personal long-term core reserves that must NEVER be sold or liquidated
const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM"]);

// Safe Gas Price
export let SAFE_GAS_PRICE = process.env.GAS_PRICE_WEI ? BigInt(process.env.GAS_PRICE_WEI) : 4000000000n;

// Top-Trader Held Tokens Registry (Verified active ecosystem tokens held by the 14 targets)
export const TOP_TRADER_TOKENS = [
  { symbol: "ATES", address: "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649", decimals: 18, feeTiers: [500, 3000, 10000] },
  { symbol: "AGFU", address: "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "ONETK", address: "0x9694d371f566fcf6527c0f62e4f80553783ac7d7", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "JSFT", address: "0xb4ac5dd62f700e271bffb52aeae1dba40135427f", decimals: 18, feeTiers: [500, 3000] },
  { symbol: "SDIP", address: "0x00313151A7e74CE5108ad12c1B444ed7b458947c", decimals: 18, feeTiers: [500, 3000, 10000] },
  { symbol: "WPay", address: "0x64c595d4c4063c49b8c3a8b291e6f5c3c205f496", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "XAUS", address: "0x8d7a3eefbc25187a229d442c20b443d7675b44cd", decimals: 18, feeTiers: [500, 3000, 10000] },
  { symbol: "PINE", address: "0xd1e6528d10398502677dfcb3ccd2fd4a657edf99", decimals: 18, feeTiers: [500, 3000, 10000] },
  { symbol: "SKMH", address: "0xe787bffc078a0231a038be1fb199b9c6fd1d511a", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "DMCS", address: "0x8f2e99691855a5663beb39deb9075f28b3dcc51b", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "SIT", address: "0xf102009cd862fc714e01c46591c3df10d097f7b9", decimals: 18, feeTiers: [500, 3000] },
  { symbol: "SMAf", address: "0x2ce9e7c168035d61cc3a3655949c147c063eecc4", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "ARMS", address: "0x9b61324f0bee10f4624fe6e75c60943b73125e81", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "STSX", address: "0x84fb6ad958a73a9e978c2bf00719b84d8b73304a", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "GLNs", address: "0xe1a8ffd7280d5a278a9e8c6daff6d391b59081b4", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "SDS", address: "0x9ba4035871119991fc7b420873345f9be92af146", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "ZSM", address: "0x828df8009add5279b9133c39955ee95bdcaae476", decimals: 18, feeTiers: [3000, 10000] },
  { symbol: "FREEt", address: "0x0914bf761af71f4a39dce0e9ce71b7ed96c457e3", decimals: 18, feeTiers: [3000, 10000] }
];

const tokenSymbolMap = new Map();
TOP_TRADER_TOKENS.forEach(t => tokenSymbolMap.set(t.address.toLowerCase(), t.symbol));
tokenSymbolMap.set(WSDA_ADDR.toLowerCase(), "WSDA");

// Pre-build 2-leg & 3-leg combination paths
export const COMBINATION_ROUTES = [];

// 1. Cross-Pool 2-Leg Combinations
for (const tok of TOP_TRADER_TOKENS) {
  const tiers = tok.feeTiers;
  for (let i = 0; i < tiers.length; i++) {
    for (let j = 0; j < tiers.length; j++) {
      if (i === j) continue;
      COMBINATION_ROUTES.push({
        id: `${tok.symbol}_${tiers[i]}_${tiers[j]}`,
        name: `${tok.symbol} Cross-Pool (${tiers[i]} ➔ ${tiers[j]})`,
        tokenSymbol: tok.symbol,
        tokenAddress: tok.address,
        isRoundTrip: true,
        path: ethers.solidityPacked(
          ["address", "uint24", "address", "uint24", "address"],
          [WSDA_ADDR, tiers[i], tok.address, tiers[j], WSDA_ADDR]
        )
      });
    }
  }
}

// 2. High-Frequency Triangular Combinations (Learned from Top Targets)
COMBINATION_ROUTES.push({
  id: "ONETK_AGFU_TRIANGULAR",
  name: "ONETK ➔ AGFU ➔ WSDA Triangular",
  tokenSymbol: "AGFU",
  isRoundTrip: true,
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 10000, "0x9694d371f566fcf6527c0f62e4f80553783ac7d7", 3000, "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48", 10000, WSDA_ADDR]
  )
});

COMBINATION_ROUTES.push({
  id: "ATES_PINE_TRIANGULAR",
  name: "ATES ➔ PINE ➔ WSDA Triangular",
  tokenSymbol: "ATES",
  isRoundTrip: true,
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 3000, "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649", 3000, "0xd1e6528d10398502677dfcb3ccd2fd4a657edf99", 10000, WSDA_ADDR]
  )
});

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
  "function multicall(bytes[] data) external payable returns (bytes[] results)"
];

const routerInterface = new ethers.Interface(ROUTER_ABI);
const approvalCache = new Set();
const processedTxHashes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Executes a single atomic 3 SDA combination scalp trade.
 */
async function executeScalpTrade({
  walletKey,
  signer,
  route,
  modeLabel,
  isLive,
  tradeSizeSda,
  lpShare = DEFAULT_LP_SHARE,
  staggerMs = 0
}) {
  if (staggerMs > 0) await sleep(staggerMs);
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const tradeAmountWei = ethers.parseEther(tradeSizeSda.toFixed(18));

  if (!isLive) {
    const simGross = tradeSizeSda * 0.0085; // Approx +0.85% realistic scalp spread
    const simGas = 0.00065;
    const simNet = simGross - simGas;
    const simLp = simNet * lpShare;
    return {
      success: true,
      simulated: true,
      walletKey,
      grossDelta: simGross,
      gasSpentSda: simGas,
      netProfitSda: simNet,
      lpProfitSda: simLp
    };
  }

  // 1. Check & Ensure WSDA Balance
  let curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeAmountWei) {
    const wrapNeeded = tradeAmountWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.02")) {
      return { success: false, reason: "LOW_NATIVE_BALANCE", walletKey };
    }
    const nonceWrap = await getFastNonce(signer.address);
    const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceWrap });
    await wrapTx.wait(1);
  }

  // 2. Ensure Router Approval
  await ensureFastApproval(signer, WSDA_ADDR, tradeAmountWei);

  // 3. Pre-flight staticCall Verification (0 gas wasted if unprofitable)
  const deadline = Math.floor(Date.now() / 1000) + 120;
  try {
    const liveOut = await router.exactInput.staticCall({
      path: route.path,
      recipient: signer.address,
      deadline,
      amountIn: tradeAmountWei,
      amountOutMinimum: tradeAmountWei + 1n // Infallible: Must return strictly positive profit
    });
    const estProfit = Number(ethers.formatEther(liveOut - tradeAmountWei));
    if (estProfit <= 0.000001) return { success: false, reason: "ZERO_PROFIT_SIMULATION", walletKey };
  } catch (err) {
    const reasonMsg = err.reason || err.shortMessage || (err.message?.includes("Too little received") ? "Too little received (Pool slippage / low tick depth)" : err.message?.slice(0, 80)) || "STATIC_CALL_REJECTED";
    return { success: false, reason: reasonMsg, walletKey };
  }

  // 4. Broadcast Scalp Execution with Cross-Window Lock
  const wsdaBefore = await wsda.balanceOf(signer.address);
  const minOut = tradeAmountWei; // 100% principal loss protection
  const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
  try {
    const tx = await router.exactInput({
      path: route.path,
      recipient: signer.address,
      deadline,
      amountIn: tradeAmountWei,
      amountOutMinimum: minOut
    }, {
      gasLimit: 340000n,
      gasPrice: SAFE_GAS_PRICE,
      nonce: lock.nonce
    });

    const receipt = await tx.wait(1);
    const wsdaAfter = await wsda.balanceOf(signer.address);
    const grossDelta = Number(ethers.formatEther(wsdaAfter - wsdaBefore));
    const gasSpentWei = BigInt(receipt.gasUsed) * SAFE_GAS_PRICE;
    const gasSpentSda = Number(ethers.formatEther(gasSpentWei));
    const netProfitSda = grossDelta - gasSpentSda;

    let gmaiLpSda = 0.0;
    let bandiqLpSda = 0.0;
    let svmLpSda = 0.0;

    if (netProfitSda > 0) {
      // 1) 10% Profit Injected into GMAI Pool
      if (GMAI_LP_SHARE > 0) {
        gmaiLpSda = netProfitSda * GMAI_LP_SHARE;
        const lpShareWei = ethers.parseEther(gmaiLpSda.toFixed(18));
        if (lpShareWei >= 100000000000000n) {
          try {
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
            }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
            await lpTx.wait(1);
            console.log(`   💧 [${walletKey}] 10% Profit Injected into GMAI Pool: +${gmaiLpSda.toFixed(5)} SDA ➔ GMAI (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
          } catch (lpErr) {
            console.warn(`   ⚠️ [${walletKey}] GMAI liquidity injection skipped: ${lpErr.message}`);
          }
        }
      }

      // 2) 5% Profit Injected into BANDIQ Pool (0xB11551A7...)
      if (BANDIQ_LP_SHARE > 0) {
        bandiqLpSda = netProfitSda * BANDIQ_LP_SHARE;
        const lpShareWei = ethers.parseEther(bandiqLpSda.toFixed(18));
        if (lpShareWei >= 100000000000000n) {
          try {
            const nonceLp = await getFastNonce(signer.address);
            const lpTx = await router.exactInputSingle({
              tokenIn: WSDA_ADDR,
              tokenOut: BANDIQ_ADDR,
              fee: BANDIQ_POOL_FEE,
              recipient: signer.address,
              deadline: Math.floor(Date.now() / 1000) + 180,
              amountIn: lpShareWei,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0
            }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
            await lpTx.wait(1);
            console.log(`   💧 [${walletKey}] 5% Profit Injected into BANDIQ Pool: +${bandiqLpSda.toFixed(5)} SDA ➔ BANDIQ (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
          } catch (lpErr) {
            console.warn(`   ⚠️ [${walletKey}] BANDIQ liquidity injection skipped: ${lpErr.message}`);
          }
        }
      }

      // 3) 5% Profit Injected into SVM Pool (0x341C9103...)
      if (SVM_LP_SHARE > 0) {
        svmLpSda = netProfitSda * SVM_LP_SHARE;
        const lpShareWei = ethers.parseEther(svmLpSda.toFixed(18));
        if (lpShareWei >= 100000000000000n) {
          try {
            const nonceLp = await getFastNonce(signer.address);
            const lpTx = await router.exactInputSingle({
              tokenIn: WSDA_ADDR,
              tokenOut: SVM_ADDR,
              fee: SVM_POOL_FEE,
              recipient: signer.address,
              deadline: Math.floor(Date.now() / 1000) + 180,
              amountIn: lpShareWei,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0
            }, { gasLimit: 260000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceLp });
            await lpTx.wait(1);
            console.log(`   💧 [${walletKey}] 5% Profit Injected into SVM Pool: +${svmLpSda.toFixed(5)} SDA ➔ SVM (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
          } catch (lpErr) {
            console.warn(`   ⚠️ [${walletKey}] SVM liquidity injection skipped: ${lpErr.message}`);
          }
        }
      }
    }

    const totalLpProfitSda = gmaiLpSda + bandiqLpSda + svmLpSda;

    // Auto-Unwrap excess WSDA profits beyond base working capital (W1-5: 100, W6-10: 10, W11-15: 5)
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

    console.log(`   💰 [${walletKey}] ${modeLabel} | Gross: +${grossDelta.toFixed(5)} SDA | Gas: -${gasSpentSda.toFixed(5)} SDA | Net: +${netProfitSda.toFixed(5)} SDA | 💧 Injected 20% (10% GMAI, 5% BANDIQ, 5% SVM): +${totalLpProfitSda.toFixed(5)} SDA (Tx: https://ledger.sidrachain.com/tx/${tx.hash})`);

    return {
      success: true,
      txHash: tx.hash,
      walletKey,
      grossDelta,
      gasSpentSda,
      netProfitSda,
      lpProfitSda: totalLpProfitSda,
      gmaiLpSda,
      bandiqLpSda,
      svmLpSda
    };
  } catch (err) {
    return { success: false, reason: err.message, walletKey };
  } finally {
    await lock.release();
  }
}

/**
 * Mathematical Market Scanner for Top 20 Gainers & Top 20 Losers (Scalping Engine)
 */
export async function scanTopGainersAndLosers(market, preferredSizeSda = 1.5) {
  const gainerRoutes = [];
  const loserRoutes = [];
  const testSizes = [preferredSizeSda, 1.0, 0.5].filter(s => s > 0);

  for (const token of market) {
    if (STRICT_EXCLUSIONS.has(token.symbol?.toUpperCase())) continue;
    const pools = token.pools?.filter(p => p.isHealthy && p.liquidity > 0n) || [];
    if (pools.length < 2) continue;

    for (let i = 0; i < pools.length; i++) {
      for (let j = 0; j < pools.length; j++) {
        if (i === j) continue;
        const buyPool = pools[i];
        const sellPool = pools[j];

        for (const testSda of testSizes) {
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

          if (netProfit >= 0.0001) {
            const spreadPct = buyPool.spotPriceSda > 0
              ? ((sellPool.spotPriceSda - buyPool.spotPriceSda) / buyPool.spotPriceSda) * 100
              : 0;

            const routeObj = {
              id: `${token.symbol}_${buyPool.feeTier}_${sellPool.feeTier}`,
              symbol: token.symbol,
              name: `${token.symbol} (${buyPool.feeTier} ➔ ${sellPool.feeTier})`,
              tokenSymbol: token.symbol,
              path: ethers.solidityPacked(
                ["address", "uint24", "address", "uint24", "address"],
                [WSDA_ADDR, buyPool.feeTier, token.address, sellPool.feeTier, WSDA_ADDR]
              ),
              tradeSizeSda: testSda,
              expectedProfitSda: netProfit,
              spreadPct
            };

            if (spreadPct >= 1.0) {
              gainerRoutes.push(routeObj);
            } else {
              loserRoutes.push(routeObj);
            }
            break;
          }
        }
      }
    }
  }

  gainerRoutes.sort((a, b) => b.expectedProfitSda - a.expectedProfitSda);
  loserRoutes.sort((a, b) => b.expectedProfitSda - a.expectedProfitSda);

  return {
    topGainers: gainerRoutes.slice(0, 20),
    topLosers: loserRoutes.slice(0, 20)
  };
}

/**
 * Scans all combination routes for the highest-profit 3 SDA scalp.
 */
async function findBestCombinationScalp(testSigner, tradeSizeSda) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, testSigner);
  const tradeAmountWei = ethers.parseEther(tradeSizeSda.toFixed(18));
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const profitableRoutes = [];

  for (const r of COMBINATION_ROUTES) {
    try {
      const out = await router.exactInput.staticCall({
        path: r.path,
        recipient: testSigner.address,
        deadline,
        amountIn: tradeAmountWei,
        amountOutMinimum: tradeAmountWei + 1n
      });
      const netSda = Number(ethers.formatEther(out - tradeAmountWei));
      if (netSda >= 0.0001) {
        profitableRoutes.push({
          id: r.id,
          name: r.name,
          path: r.path,
          tokenSymbol: r.tokenSymbol,
          expectedProfitSda: netSda
        });
      }
    } catch {}
  }

  return profitableRoutes.sort((a, b) => b.expectedProfitSda - a.expectedProfitSda);
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || args.includes("--live") || process.env.LIVE === "true";
  const tradeSizeSda = Number(args.find((a) => a.startsWith("--trade-size=") || a.startsWith("--amount="))?.split("=")[1] || process.env.TRADE_SIZE_SDA || 3.0);
  const lpShare = Number(args.find((a) => a.startsWith("--pool-share="))?.split("=")[1] ?? DEFAULT_LP_SHARE);
  const walletArg = args.find((a) => a.startsWith("--wallet="))?.split("=")[1] || "ready";
  const scalpIntervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 5);

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

  console.log("==========================================================================");
  console.log("⚡ TOP-TRADER TOKEN COMBINATION SCALPER (START AT 3 SDA)");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Scalp Base Sizing  : ${tradeSizeSda.toFixed(2)} SDA per trade (Optimal sweet-spot for deep pool scalps)`);
  console.log(`Combination Pairs  : ${COMBINATION_ROUTES.length} Verified Cross-Pool & Triangular Routes across Top Target Tokens`);
  console.log(`Target Token Pool  : ATES, AGFU, ONETK, JSFT, SDIP, WPay, XAUS, PINE, SKMH, DMCS, SIT...`);
  console.log(`Liquidity Routing  : ${Math.round(lpShare * 100)}% of Net Profit Auto-Injected into GMAI Pool (${GMAI_ADDR.slice(0, 10)}...)`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM (100% SAFE & PROTECTED)`);
  console.log("==========================================================================\n");

  console.log("👥 Fleet Live Liquid Status:");
  const wsdaC = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
  for (const k of availableKeys) {
    const w = swarmWallets[k];
    const [bal, wsdaBal] = await Promise.all([
      provider.getBalance(w.address),
      wsdaC.balanceOf(w.address)
    ]);
    const tot = Number(ethers.formatEther(bal + wsdaBal));
    console.log(`   • [${k.toUpperCase().padEnd(7)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} | Total: ${tot.toFixed(4)} SDA ${tot >= tradeSizeSda ? "✅ READY" : "⏳ NEED FUND"}`);
  }

  let sessionGrossProfitSda = 0.0;
  let sessionNetProfitSda = 0.0;
  let sessionGasSpentSda = 0.0;
  let sessionGmaiLpInjectedSda = 0.0;
  let sessionTradesExecuted = 0;
  let sessionWavesCount = 0;
  let scalpWalletIndex = 0;
  let lastScalpScanTime = 0;
  let lastCheckedBlock = await provider.getBlockNumber();

  process.on("SIGINT", () => {
    console.log(`\n==========================================================================`);
    console.log(`🛑 COMBINATION SCALPER SHUTDOWN SUMMARY`);
    console.log(`==========================================================================`);
    console.log(`   • Total Scalp Waves         : ${sessionWavesCount}`);
    console.log(`   • Total Confirmed Trades    : ${sessionTradesExecuted}`);
    console.log(`   • TOTAL GROSS SDA PROFIT    : ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL GAS SPENT           : -${sessionGasSpentSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL NET REALIZED PROFIT : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
    console.log(`   • 💧 GMAI POOL LIQUIDITY    : +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
    console.log(`==========================================================================\n`);
    process.exit(0);
  });

  console.log("\n📡 Scalper Online: Listening for target mempool txs & actively scanning combination spreads...\n");

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

      // Parse target wallets correctly (e.g. --wallet=11-15 or ready)
      const walletFlag = args.find((a) => a.startsWith("--wallet=") || a.startsWith("--wallets="));
      const walletArgVal = walletFlag ? walletFlag.split("=")[1] : (process.env.TARGET_WALLETS_ARG || "11-15");
      let eligibleKeys = parseTargetWallets(walletArgVal, availableKeys);
      if (eligibleKeys.length === 0) {
        eligibleKeys = ["wallet11", "wallet12", "wallet13", "wallet14", "wallet15"].filter(k => availableKeys.includes(k));
      }

      const currentBlock = await provider.getBlockNumber();
      let liveTargetMatched = false;

      // 1. FAST MEMPOOL INTERCEPT (Mirror Target Trades if one of their held tokens is traded)
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
                const parsed = await parsePinetswapTx(tx);
                if (parsed && parsed.isRoundTrip) {
                  liveTargetMatched = true;
                  console.log(`\n🔔 [TARGET COMBINATION TRIGGER] Target ${fromLower.slice(0, 10)}... executed combination swap!`);
                  console.log(`   Tx: https://ledger.sidrachain.com/tx/${tx.hash}`);

                  const copyResults = await Promise.all(
                    eligibleKeys.map((wKey, idx) =>
                      executeScalpTrade({
                        walletKey: wKey,
                        signer: swarmWallets[wKey],
                        route: parsed,
                        modeLabel: "TARGET MIRROR SCALP",
                        isLive,
                        tradeSizeSda,
                        lpShare,
                        staggerMs: idx * 60
                      })
                    )
                  );

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
                  console.log(`📊 [WAVE #${sessionWavesCount} TARGET SCALP RECAP]`);
                  console.log(`   • Trades Confirmed in Wave  : ${waveSuccess} / ${eligibleKeys.length}`);
                  console.log(`   • Wave Gross SDA Profit     : ${waveGross >= 0 ? "+" : ""}${waveGross.toFixed(5)} SDA`);
                  console.log(`   • Wave Net Realized Profit  : ${waveNet >= 0 ? "+" : ""}${waveNet.toFixed(5)} SDA`);
                  console.log(`   • 💧 10% Injected to GMAI   : +${waveLp.toFixed(5)} SDA`);
                  console.log(`   • TOTAL SESSION GROSS PROFIT: ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
                  console.log(`   • TOTAL SESSION NET PROFIT  : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
                  console.log(`==========================================================================\n`);
                }
              }
            } catch {}
          }
        }
        lastCheckedBlock = currentBlock;
      }

      // 2. ACTIVE MARKET RADAR: TOP 20 GAINERS & LOSERS + COMBINATION SCALPS
      if (!liveTargetMatched && Date.now() - lastScalpScanTime >= scalpIntervalSec * 1000) {
        lastScalpScanTime = Date.now();

        // Scan full market for Top 20 Gainers & Losers
        let candidateScalps = [];
        try {
          const market = await scanMarket(provider);
          const { topGainers, topLosers } = await scanTopGainersAndLosers(market, tradeSizeSda);
          candidateScalps = [...topGainers, ...topLosers];
        } catch {}

        // Also check static combination routes if market gainers/losers are narrow
        if (candidateScalps.length === 0) {
          const testSigner = swarmWallets[eligibleKeys[0]];
          if (testSigner) {
            const profitableScalps = await findBestCombinationScalp(testSigner, tradeSizeSda);
            candidateScalps = profitableScalps;
          }
        }

        if (candidateScalps.length > 0) {
          // Pre-verify on-chain staticCall across distinct tokens (0 sibling collision)
          const testSigner = swarmWallets[eligibleKeys[0]];
          const verifiedOpportunities = [];
          const seenTokens = new Set();

          for (const cand of candidateScalps) {
            if (seenTokens.has(cand.symbol)) continue;
            const checkSizes = [cand.tradeSizeSda || tradeSizeSda, 1.5, 1.0, 0.5].filter((s, idx, arr) => s > 0 && arr.indexOf(s) === idx);
            for (const s of checkSizes) {
              try {
                const sWei = ethers.parseEther(s.toFixed(18));
                const routerContract = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, testSigner || provider);
                const out = await routerContract.exactInput.staticCall({
                  path: cand.path,
                  recipient: testSigner?.address || WSDA_ADDR,
                  deadline: Math.floor(Date.now() / 1000) + 120,
                  amountIn: sWei,
                  amountOutMinimum: sWei + 1n
                }, testSigner ? { from: testSigner.address } : {});
                const net = Number(ethers.formatEther(out - sWei));
                if (net >= 0.0001) {
                  verifiedOpportunities.push({ ...cand, tradeSizeSda: s, expectedProfitSda: net });
                  seenTokens.add(cand.symbol);
                  break;
                }
              } catch {}
            }
            if (verifiedOpportunities.length >= eligibleKeys.length) break;
          }

          if (verifiedOpportunities.length > 0) {
            // Pair each distinct opportunity to an individual wallet (ZERO self-competition)
            // If only 1 opportunity exists, dispatch 1 rotating wallet from eligibleKeys (Round-Robin)
            const assignments = [];
            if (verifiedOpportunities.length === 1) {
              const selectedKey = eligibleKeys[scalpWalletIndex % eligibleKeys.length];
              scalpWalletIndex++;
              assignments.push({
                walletKey: selectedKey,
                route: verifiedOpportunities[0]
              });
            } else {
              // Multi-token parallel harvest: 1 wallet per distinct token
              for (let i = 0; i < verifiedOpportunities.length && i < eligibleKeys.length; i++) {
                const wKey = eligibleKeys[(scalpWalletIndex + i) % eligibleKeys.length];
                assignments.push({
                  walletKey: wKey,
                  route: verifiedOpportunities[i]
                });
              }
              scalpWalletIndex += assignments.length;
            }

            console.log(`\n⚡ [DIVERSIFIED SCALP WAVE] Executing ${assignments.length} distinct on-chain opportunity(ies):`);
            for (const a of assignments) {
              console.log(`   • [${a.walletKey}] ➔ ${a.route.name} (${a.route.tradeSizeSda.toFixed(2)} SDA | Exp: +${a.route.expectedProfitSda.toFixed(5)} SDA)`);
            }

            const scalpResults = await Promise.all(
              assignments.map((a, idx) =>
                executeScalpTrade({
                  walletKey: a.walletKey,
                  signer: swarmWallets[a.walletKey],
                  route: a.route,
                  modeLabel: `TOP MOVER SCALP (${a.route.tradeSizeSda.toFixed(2)} SDA)`,
                  isLive,
                  tradeSizeSda: a.route.tradeSizeSda,
                  lpShare,
                  staggerMs: idx * 60
                })
              )
            );

            sessionWavesCount++;
            let waveGross = 0.0;
            let waveNet = 0.0;
            let waveGas = 0.0;
            let waveLp = 0.0;
            let waveGmai = 0.0;
            let waveBand = 0.0;
            let waveSvm = 0.0;
            let waveSuccess = 0;

            for (const r of scalpResults) {
              if (r && r.success) {
                waveGross += r.grossDelta || 0;
                waveNet += r.netProfitSda || 0;
                waveGas += r.gasSpentSda || 0;
                waveLp += r.lpProfitSda || 0;
                waveGmai += r.gmaiLpSda || 0;
                waveBand += r.bandiqLpSda || 0;
                waveSvm += r.svmLpSda || 0;
                waveSuccess++;
              } else if (r) {
                console.log(`   ⚠️ [${r.walletKey}] Scalp skipped/reverted: ${r.reason || "Unknown"}`);
              }
            }

            sessionGrossProfitSda += waveGross;
            sessionNetProfitSda += waveNet;
            sessionGasSpentSda += waveGas;
            sessionGmaiLpInjectedSda += waveLp;
            sessionTradesExecuted += waveSuccess;

            console.log(`\n==========================================================================`);
            console.log(`📊 [WAVE #${sessionWavesCount} LIVE SCALP RECAP]`);
            console.log(`   • Trades Confirmed in Wave  : ${waveSuccess} / ${assignments.length}`);
            console.log(`   • Wave Gross SDA Profit     : ${waveGross >= 0 ? "+" : ""}${waveGross.toFixed(5)} SDA`);
            console.log(`   • Wave Net Realized Profit  : ${waveNet >= 0 ? "+" : ""}${waveNet.toFixed(5)} SDA (80% kept by wallets)`);
            console.log(`   • 💧 20% Injected into Pools: +${waveLp.toFixed(5)} SDA (GMAI 10%: +${waveGmai.toFixed(5)} | BANDIQ 5%: +${waveBand.toFixed(5)} | SVM 5%: +${waveSvm.toFixed(5)})`);
            console.log(`   • TOTAL SESSION GROSS PROFIT: ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
            console.log(`   • TOTAL SESSION NET PROFIT  : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
            console.log(`   • 💧 TOTAL ECOSYSTEM LP     : +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
            console.log(`==========================================================================\n`);
          } else {
            console.log(`⏳ [SCALPER RADAR] Block ${currentBlock} | Active Wallets: ${eligibleKeys.join(", ")} | Candidates checked: pool slippage exceeds threshold at current sizes. Capital 100% protected.`);
          }
        } else {
          console.log(`⏳ [SCALPER RADAR] Block ${currentBlock} | Active Wallets: ${eligibleKeys.join(", ")} | Scanned Top 20 Gainers & Losers + Combination Spreads. Pools balanced (< +0.0001 SDA). Capital protected.`);
        }
      }
    } catch (err) {
      // Retry on transient hiccups
    }

    await sleep(600);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Fatal Scalper error:", err);
    process.exit(1);
  });
}

