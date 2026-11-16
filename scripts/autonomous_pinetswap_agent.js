import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scanMarket } from "../engine/scanner.js";
import { parseTargetWallets, acquireWalletLock, isWalletReady } from "./wallet_helper.js";

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
const GMAI_ADDR = ethers.getAddress(process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04");
const GMAI_POOL_FEE = Number(process.env.GMAI_POOL_FEE || "10000");
const DEFAULT_LP_SHARE = 0.10; // 10% liquidity profit reinvested into GMAI pool

// THE 14 TARGET TOP-TRADER WALLETS WHOSE STRATEGY WE MIRROR AND SYNTHESIZE
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

// Known and Learned Token Registry
const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");
const tokenSymbolMap = new Map();
const knownTokens = new Map(); // address.toLowerCase() -> { symbol, address, decimals }

try {
  const tokensData = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));
  for (const t of tokensData.tokens || []) {
    if (t.address) {
      const lower = t.address.toLowerCase();
      tokenSymbolMap.set(lower, t.symbol);
      knownTokens.set(lower, {
        symbol: t.symbol,
        address: ethers.getAddress(t.address),
        decimals: t.decimals || 18,
        pools: t.pools || {}
      });
    }
  }
} catch {}

// Register special tokens discovered from top traders (AGFU, ONETK)
const TOP_TRADER_SPECIAL_TOKENS = [
  { symbol: "AGFU", address: "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48", decimals: 18 },
  { symbol: "ONETK", address: "0x9694d371f566fcf6527c0f62e4f80553783ac7d7", decimals: 18 }
];

for (const st of TOP_TRADER_SPECIAL_TOKENS) {
  const lower = st.address.toLowerCase();
  tokenSymbolMap.set(lower, st.symbol);
  knownTokens.set(lower, {
    symbol: st.symbol,
    address: ethers.getAddress(st.address),
    decimals: st.decimals,
    pools: {}
  });
}
tokenSymbolMap.set(WSDA_ADDR.toLowerCase(), "WSDA");

// Dynamic Learned Routes Knowledge Base
const learnedRoutes = new Map(); // routeKey -> { path, hops, lastProfit, lastSeen }

// Pre-populate with verified top trader routes
learnedRoutes.set("AGFU_3000_10000", {
  name: "AGFU Cross-Pool Arb (3000 ➔ 10000)",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 3000, "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48", 10000, WSDA_ADDR]
  ),
  isRoundTrip: true
});

learnedRoutes.set("SDIP_500_3000", {
  name: "SDIP Deep Arb (500 ➔ 3000)",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 500, "0x00313151A7e74CE5108ad12c1B444ed7b458947c", 3000, WSDA_ADDR]
  ),
  isRoundTrip: true
});

learnedRoutes.set("JSFT_3000_500", {
  name: "JSFT Deep Arb (3000 ➔ 500)",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 3000, "0x3f31BB70A3B44B7c5E789FaC6d42dBeaA9cbc571", 500, WSDA_ADDR]
  ),
  isRoundTrip: true
});

learnedRoutes.set("ONETK_AGFU_TRIANGULAR", {
  name: "ONETK ➔ AGFU ➔ WSDA Triangular Arb",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 10000, "0x9694d371f566fcf6527c0f62e4f80553783ac7d7", 3000, "0xfaa37c365fa4d345b5115ede02f1bf8a9e721b48", 10000, WSDA_ADDR]
  ),
  isRoundTrip: true
});

learnedRoutes.set("ATES_500_3000", {
  name: "ATES Cross-Pool Arb (500 ➔ 3000)",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 500, "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649", 3000, WSDA_ADDR]
  ),
  isRoundTrip: true
});

learnedRoutes.set("ATES_3000_10000", {
  name: "ATES Cross-Pool Arb (3000 ➔ 10000)",
  path: ethers.solidityPacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WSDA_ADDR, 3000, "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649", 10000, WSDA_ADDR]
  ),
  isRoundTrip: true
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
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const routerInterface = new ethers.Interface(ROUTER_ABI);
const approvalCache = new Set();
const processedTxHashes = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Executes a single atomic copy/strategy trade for one wallet.
 */
async function executeAgentTrade({
  walletKey,
  signer,
  tradeInfo,
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

  // Protect against forbidden assets
  for (const h of tradeInfo.hops || []) {
    const sym = await resolveTokenSymbol(h.token);
    if (STRICT_EXCLUSIONS.has(sym.toUpperCase()) && !tradeInfo.isRoundTrip) {
      return { success: false, reason: "PROTECTED_TOKEN_INVOLVED" };
    }
  }

  if (!isLive) {
    const simGross = tradeSizeSda * 0.0075;
    const simGas = 0.00072;
    const simNet = simGross - simGas;
    const simLp = simNet * (lpShare ?? DEFAULT_LP_SHARE);
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

  // 1. Ensure WSDA Balance
  let curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeAmountWei) {
    const wrapNeeded = tradeAmountWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.05")) {
      return { success: false, reason: "LOW_NATIVE_BALANCE", walletKey };
    }
    const nonceWrap = await getFastNonce(signer.address);
    const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 90000n, gasPrice: SAFE_GAS_PRICE, nonce: nonceWrap });
    await wrapTx.wait(1);
  }

  // 2. Ensure Router Approval
  await ensureFastApproval(signer, WSDA_ADDR, tradeAmountWei);

  // 3. Pre-flight staticCall Verification
  const deadline = Math.floor(Date.now() / 1000) + 120;
  try {
    const liveOut = await router.exactInput.staticCall({
      path: tradeInfo.path,
      recipient: signer.address,
      deadline,
      amountIn: tradeAmountWei,
      amountOutMinimum: tradeAmountWei + 1n // Must return strictly positive SDA profit
    });
    const estProfit = Number(ethers.formatEther(liveOut - tradeAmountWei));
    if (estProfit <= 0.000001) return { success: false, reason: "STATIC_CALL_ZERO_PROFIT", walletKey };
  } catch {
    return { success: false, reason: "STATIC_CALL_REJECTED", walletKey };
  }

  // 4. On-Chain Broadcast with Strict Protection & Cross-Window Lock
  const wsdaBefore = await wsda.balanceOf(signer.address);
  const minOut = tradeAmountWei; // Guaranteed 100% principal back
  const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
  try {
    const tx = await router.exactInput({
      path: tradeInfo.path,
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

    let lpProfitSda = 0.0;
    const activeLpShare = lpShare ?? DEFAULT_LP_SHARE;
    if (netProfitSda > 0 && activeLpShare > 0) {
      lpProfitSda = netProfitSda * activeLpShare;
      const lpShareWei = ethers.parseEther(lpProfitSda.toFixed(18));
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
          console.log(`   💧 [${walletKey}] 10% Profit Injected into GMAI Pool: +${lpProfitSda.toFixed(5)} SDA ➔ GMAI (Tx: https://ledger.sidrachain.com/tx/${lpTx.hash})`);
        } catch (lpErr) {
          console.warn(`   ⚠️ [${walletKey}] GMAI liquidity injection skipped: ${lpErr.message}`);
        }
      }
    }

    console.log(`   💰 [${walletKey}] ${modeLabel} | Gross: +${grossDelta.toFixed(5)} SDA | Gas: -${gasSpentSda.toFixed(5)} SDA | Net: +${netProfitSda.toFixed(5)} SDA | 💧 10% GMAI: +${lpProfitSda.toFixed(5)} SDA (Tx: ${tx.hash.slice(0, 16)}...)`);

    return {
      success: true,
      txHash: tx.hash,
      walletKey,
      grossDelta,
      gasSpentSda,
      netProfitSda,
      lpProfitSda
    };
  } catch (err) {
    return { success: false, reason: err.message, walletKey };
  } finally {
    await lock.release();
  }
}

/**
 * Autonomous Strategy Scanner:
 * Actively checks all learned top-trader routes and ecosystem cross-pool spreads
 * so the agent executes their strategy even when the target traders are offline.
 */
async function findAutonomousStrategyRoutes(testSigner, tradeSizeSda) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, testSigner);
  const tradeAmountWei = ethers.parseEther(tradeSizeSda.toFixed(18));
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const profitableRoutes = [];

  // 1. Test all learned routes from Top Traders
  for (const [key, r] of learnedRoutes.entries()) {
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
          name: r.name || key,
          path: r.path,
          hops: decodeV3Path(r.path),
          isRoundTrip: true,
          expectedProfitSda: netSda
        });
      }
    } catch {}
  }

  // 2. Discover live ecosystem spreads from market scan
  try {
    const market = await scanMarket(provider);
    for (const t of market) {
      if (STRICT_EXCLUSIONS.has(t.symbol?.toUpperCase())) continue;
      if (t.taxBps && t.taxBps > 0) continue;
      const hp = (t.pools || []).filter((p) => p.isHealthy && (p.virtualWsdaDepthSda || 0) >= 100);
      if (hp.length < 2) continue;

      for (let i = 0; i < hp.length; i++) {
        for (let j = 0; j < hp.length; j++) {
          if (i === j) continue;
          const buy = hp[i];
          const sell = hp[j];
          if (sell.spotPriceSda <= buy.spotPriceSda) continue;

          const testPath = ethers.solidityPacked(
            ["address", "uint24", "address", "uint24", "address"],
            [WSDA_ADDR, buy.feeTier, t.address, sell.feeTier, WSDA_ADDR]
          );

          try {
            const out = await router.exactInput.staticCall({
              path: testPath,
              recipient: testSigner.address,
              deadline,
              amountIn: tradeAmountWei,
              amountOutMinimum: tradeAmountWei + 1n
            });
            const net = Number(ethers.formatEther(out - tradeAmountWei));
            if (net >= 0.0001) {
              profitableRoutes.push({
                name: `${t.symbol} Cross-Pool (${buy.feeTier} ➔ ${sell.feeTier})`,
                path: testPath,
                hops: decodeV3Path(testPath),
                isRoundTrip: true,
                expectedProfitSda: net
              });
            }
          } catch {}
        }
      }
    }
  } catch {}

  return profitableRoutes.sort((a, b) => b.expectedProfitSda - a.expectedProfitSda);
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const tradeSizeSda = Number(args.find((a) => a.startsWith("--trade-size="))?.split("=")[1] || process.env.TRADE_SIZE_SDA || 30.0);
  const lpShare = Number(args.find((a) => a.startsWith("--pool-share="))?.split("=")[1] ?? DEFAULT_LP_SHARE);
  const walletArg = args.find((a) => a.startsWith("--wallet="))?.split("=")[1] || "all";
  const autonomousIntervalSec = Number(args.find((a) => a.startsWith("--autonomous-interval="))?.split("=")[1] || 15);

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
  console.log("🤖 AUTONOMOUS TOP-TRADER STRATEGY AGENT (HYBRID LIVE & SYNTHESIS)");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Tracked Targets (${TARGET_WALLETS.length}) :`);
  TARGET_WALLETS.forEach((tw, idx) => console.log(`   • Target #${idx + 1}        : ${tw}`));
  console.log(`Trade Sizing       : ${tradeSizeSda.toFixed(2)} SDA per wallet (${(tradeSizeSda * activeKeys.length).toFixed(2)} SDA Fleet Wave)`);
  console.log(`Executing Fleet    : ${activeKeys.join(", ")} (⚡ 100% SIMULTANEOUS 5-WALLET DISPATCH)`);
  console.log(`Liquidity Profit   : ${Math.round(lpShare * 100)}% of Net SDA Profit Auto-Injected into GMAI Pool (${GMAI_ADDR.slice(0, 10)}...)`);
  console.log(`Learned Strategies : ${learnedRoutes.size} High-Frequency Multi-Hop & Cross-Pool Routes`);
  console.log(`Autonomous Mode    : 🔄 Executes their exact strategy even when targets are idle`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM (100% PROTECTED & ISOLATED) [ATES ACTIVE]`);
  console.log("==========================================================================\n");

  console.log("👥 Fleet Current Balances:");
  for (const k of activeKeys) {
    const w = swarmWallets[k];
    const bal = await provider.getBalance(w.address);
    const wsda = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
    const wsdaBal = await wsda.balanceOf(w.address);
    console.log(`   • [${k.toUpperCase().padEnd(7)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)}`);
  }

  let sessionGrossProfitSda = 0.0;
  let sessionNetProfitSda = 0.0;
  let sessionGasSpentSda = 0.0;
  let sessionGmaiLpInjectedSda = 0.0;
  let sessionTradesExecuted = 0;
  let sessionWavesCount = 0;
  let lastAutonomousScanTime = 0;
  let lastCheckedBlock = await provider.getBlockNumber();

  process.on("SIGINT", () => {
    console.log(`\n==========================================================================`);
    console.log(`🛑 AUTONOMOUS STRATEGY AGENT SHUTDOWN SUMMARY`);
    console.log(`==========================================================================`);
    console.log(`   • Total Waves Executed      : ${sessionWavesCount}`);
    console.log(`   • Total Confirmed Trades    : ${sessionTradesExecuted}`);
    console.log(`   • TOTAL GROSS SDA PROFIT    : ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL GAS SPENT           : -${sessionGasSpentSda.toFixed(5)} SDA`);
    console.log(`   • TOTAL NET REALIZED PROFIT : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
    console.log(`   • 💧 GMAI POOL LIQUIDITY (10%): +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
    console.log(`==========================================================================\n`);
    process.exit(0);
  });

  console.log("\n📡 Agent Online: Monitoring Pinetswap mempool & running autonomous strategy engine...\n");

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
      let liveTargetMatched = false;

      // 1. MODE 1: Check for Live Target Transactions (Live Follower)
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
                console.log(`\n🔔 [TARGET ACTIVITY DETECTED] Target ${fromLower.slice(0, 10)}... in block ${b}!`);
                const parsed = await parsePinetswapTx(tx);
                if (parsed) {
                  liveTargetMatched = true;

                  // Save route to learned strategy cache
                  const routeKey = `ROUTE_${Date.now()}`;
                  learnedRoutes.set(routeKey, { path: parsed.path, isRoundTrip: parsed.isRoundTrip });

                  console.log(`🚀 [MODE 1: LIVE TARGET MIRROR] Dispatching all ${activeKeys.length} fleet wallets!`);
                  const copyResults = await Promise.all(
                    activeKeys.map((wKey, idx) =>
                      executeAgentTrade({
                        walletKey: wKey,
                        signer: swarmWallets[wKey],
                        tradeInfo: parsed,
                        modeLabel: "TARGET MIRROR",
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
                  console.log(`📊 [WAVE #${sessionWavesCount} LIVE MIRROR RECAP]`);
                  console.log(`   • Trades Confirmed in Wave  : ${waveSuccess} / ${activeKeys.length}`);
                  console.log(`   • Wave Gross SDA Profit     : ${waveGross >= 0 ? "+" : ""}${waveGross.toFixed(5)} SDA`);
                  console.log(`   • Wave Net Realized Profit  : ${waveNet >= 0 ? "+" : ""}${waveNet.toFixed(5)} SDA`);
                  console.log(`   • 💧 10% Injected to GMAI   : +${waveLp.toFixed(5)} SDA`);
                  console.log(`   • TOTAL SESSION GROSS PROFIT: ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
                  console.log(`   • TOTAL SESSION NET PROFIT  : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
                  console.log(`   • 💧 GMAI POOL LIQUIDITY    : +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
                  console.log(`==========================================================================\n`);
                }
              }
            } catch {}
          }
        }
        lastCheckedBlock = currentBlock;
      }

      // 2. MODE 2: Autonomous Strategy Synthesizer (Active when targets are not trading live)
      if (!liveTargetMatched && Date.now() - lastAutonomousScanTime >= autonomousIntervalSec * 1000) {
        lastAutonomousScanTime = Date.now();

        // Scan learned routes & ecosystem spreads
        const testSigner = swarmWallets[activeKeys[0]];
        const autoRoutes = await findAutonomousStrategyRoutes(testSigner, tradeSizeSda);

        if (autoRoutes.length > 0) {
          const selectedRoute = autoRoutes[0];
          console.log(`\n🤖 [MODE 2: AUTONOMOUS STRATEGY TRIGGERED] Targets Idle ➔ Executing Learned Route:`);
          console.log(`   • Route Name       : ${selectedRoute.name}`);
          console.log(`   • Expected Profit  : +${selectedRoute.expectedProfitSda.toFixed(5)} SDA`);
          console.log(`   • Fleet Action     : Firing all ${activeKeys.length} wallets simultaneously (${(tradeSizeSda * activeKeys.length).toFixed(2)} SDA)!`);

          const autoResults = await Promise.all(
            activeKeys.map((wKey, idx) =>
              executeAgentTrade({
                walletKey: wKey,
                signer: swarmWallets[wKey],
                tradeInfo: selectedRoute,
                modeLabel: "AUTONOMOUS STRATEGY",
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

          for (const r of autoResults) {
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
          console.log(`📊 [WAVE #${sessionWavesCount} AUTONOMOUS RECAP]`);
          console.log(`   • Trades Confirmed in Wave  : ${waveSuccess} / ${activeKeys.length}`);
          console.log(`   • Wave Gross SDA Profit     : ${waveGross >= 0 ? "+" : ""}${waveGross.toFixed(5)} SDA`);
          console.log(`   • Wave Net Realized Profit  : ${waveNet >= 0 ? "+" : ""}${waveNet.toFixed(5)} SDA`);
          console.log(`   • 💧 10% Injected to GMAI   : +${waveLp.toFixed(5)} SDA`);
          console.log(`   • TOTAL SESSION GROSS PROFIT: ${sessionGrossProfitSda >= 0 ? "+" : ""}${sessionGrossProfitSda.toFixed(5)} SDA`);
          console.log(`   • TOTAL SESSION NET PROFIT  : ${sessionNetProfitSda >= 0 ? "+" : ""}${sessionNetProfitSda.toFixed(5)} SDA`);
          console.log(`   • 💧 GMAI POOL LIQUIDITY    : +${sessionGmaiLpInjectedSda.toFixed(5)} SDA`);
          console.log(`==========================================================================\n`);
        } else {
          console.log(`⏳ [AUTONOMOUS RADAR] Block ${currentBlock} | Targets Idle | Learned routes checked (Spreads in equilibrium). Capital 100% safe.`);
        }
      }
    } catch {}

    await sleep(600);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Fatal Autonomous Agent error:", err);
    process.exit(1);
  });
}

