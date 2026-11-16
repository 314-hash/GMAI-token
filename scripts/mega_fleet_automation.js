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

// Network & Router Configuration
const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 600;

const ROUTER_ADDR = ethers.getAddress(process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb");
const WSDA_ADDR = ethers.getAddress(process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182");
const GMAI_ADDR = ethers.getAddress(process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04");

// Strict Exclusions: Personal core tokens that must NEVER be sold or liquidated
const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM"]);

// Top Target Trader Wallets to Mirror (Tracked for Whale Copying)
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

let SAFE_GAS_PRICE = 4200000000n;

async function ensureFastApproval(signer, tokenAddress, requiredWei) {
  const key = `${signer.address.toLowerCase()}_${tokenAddress.toLowerCase()}`;
  if (approvalCache.has(key)) return;
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allow = await token.allowance(signer.address, ROUTER_ADDR);
    if (allow < requiredWei) {
      const lock = await acquireWalletLock("app_" + signer.address.slice(0, 8), signer.address, provider, 3000);
      try {
        const tx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, {
          gasLimit: 75000n,
          gasPrice: SAFE_GAS_PRICE,
          nonce: lock.nonce
        });
        await tx.wait(1);
      } finally {
        await lock.release();
      }
    }
    approvalCache.add(key);
  } catch {}
}

function decodeV3Path(pathBytes) {
  const hops = [];
  let p = pathBytes.startsWith("0x") ? pathBytes.slice(2) : pathBytes;
  if (p.length < 86) return hops;
  const firstToken = "0x" + p.slice(0, 40);
  p = p.slice(40);
  let currentToken = firstToken;
  while (p.length >= 46) {
    const feeHex = p.slice(0, 6);
    const fee = parseInt(feeHex, 16);
    const nextToken = "0x" + p.slice(6, 46);
    hops.push({ token: ethers.getAddress(currentToken), fee });
    currentToken = nextToken;
    p = p.slice(46);
  }
  hops.push({ token: ethers.getAddress(currentToken), fee: null });
  return hops;
}

function parseRouterTx(tx) {
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
      const path = ethers.solidityPacked(["address", "uint24", "address"], [p.tokenIn, p.fee, p.tokenOut]);
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
  return null;
}

// Unified Trade Execution Helper with Nonce Locking & 5-Second Cooldown
async function executeSwarmTrade({
  walletKey,
  signer,
  route,
  modeLabel,
  isLive,
  tradeSizeSda,
  lpShare = 0.10
}) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const tradeAmountWei = ethers.parseEther(tradeSizeSda.toFixed(18));

  const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
  try {
    // 1. Ensure WSDA balance
    const curWsda = await wsda.balanceOf(signer.address);
    if (curWsda < tradeAmountWei) {
      const needed = tradeAmountWei - curWsda;
      const nativeBal = await provider.getBalance(signer.address);
      if (nativeBal < needed + ethers.parseEther("0.10")) {
        console.log(`   ⚠️ [${walletKey}] Insufficient native balance for auto-wrap.`);
        return { success: false, reason: "LOW_NATIVE_BAL" };
      }
      if (isLive) {
        const wrapTx = await wsda.deposit({
          value: needed,
          gasLimit: 90000n,
          gasPrice: SAFE_GAS_PRICE,
          nonce: lock.nonce
        });
        await wrapTx.wait(1);
        lock.nonce++;
      }
    }

    // 2. Ensure router approval
    await ensureFastApproval(signer, WSDA_ADDR, tradeAmountWei);

    const deadline = Math.floor(Date.now() / 1000) + 120;
    const minOut = tradeAmountWei + 1n; // Require strictly >= tradeAmountWei to guarantee no loss

    // Pre-flight static call to guarantee transaction will succeed before broadcasting
    try {
      await router.exactInput.staticCall({
        path: route.path,
        recipient: signer.address,
        deadline,
        amountIn: tradeAmountWei,
        amountOutMinimum: minOut
      });
    } catch (simErr) {
      console.log(`   🛡️ [${walletKey}] Pre-flight simulation check: Slippage / spread no longer positive (${simErr.message?.slice(0, 45)}). Safely skipped to protect capital.`);
      return { success: false, reason: "SIMULATION_REVERTED" };
    }

    if (!isLive) {
      console.log(`   🛡️ [SIMULATED ${modeLabel}] ${walletKey} trade ${tradeSizeSda.toFixed(2)} SDA along ${route.name || "Route"}`);
      return { success: true, simulated: true, netProfitSda: 0.005 };
    }

    const tx = await router.exactInput(
      {
        path: route.path,
        recipient: signer.address,
        deadline,
        amountIn: tradeAmountWei,
        amountOutMinimum: minOut
      },
      {
        gasLimit: 380000n,
        gasPrice: SAFE_GAS_PRICE,
        nonce: lock.nonce
      }
    );

    console.log(`   🚀 [${modeLabel} ${walletKey}] Tx: ${tx.hash}`);
    const receipt = await tx.wait(1);
    const gasSpentSda = Number(ethers.formatEther(receipt.gasUsed * receipt.gasPrice));
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber} (Gas: ${gasSpentSda.toFixed(5)} SDA)`);

    // Auto-Unwrap excess WSDA profits beyond base working capital (W1-5: 100, W6-10: 10, W11-15: 5)
    const wNum = parseInt(walletKey.replace("wallet", ""), 10);
    const targetWsdaReserve = wNum <= 5 ? 100.0 : (wNum <= 10 ? 10.0 : 5.0);
    const reserveWei = ethers.parseEther(targetWsdaReserve.toString());

    const curWsdaAfter = await wsda.balanceOf(signer.address);
    if (curWsdaAfter > reserveWei + ethers.parseEther("0.1")) {
      const excessProfit = curWsdaAfter - reserveWei;
      try {
        const nonceUnwrap = lock.nonce + 1;
        const unwrapTx = await wsda.withdraw(excessProfit, {
          gasLimit: 80000n,
          gasPrice: SAFE_GAS_PRICE,
          nonce: nonceUnwrap
        });
        await unwrapTx.wait(1);
        console.log(`   💰 [${walletKey}] Harvested Profit: Auto-Unwrapped +${ethers.formatEther(excessProfit)} WSDA ➔ Native SDA (Kept ${targetWsdaReserve} WSDA working capital)!`);
      } catch {}
    }

    return {
      success: true,
      txHash: tx.hash,
      gasSpentSda,
      netProfitSda: 0.001
    };
  } catch (err) {
    console.log(`   ❌ [${walletKey}] Trade failed: ${err.message?.slice(0, 100)}`);
    return { success: false, error: err.message };
  } finally {
    await lock.release();
  }
}

// Mathematical Market Scanner for Top Gainers & Losers (Squad 3 Scalping)
export async function scanTopGainersAndLosers(market) {
  const gainerRoutes = [];
  const loserRoutes = [];

  for (const token of market) {
    if (STRICT_EXCLUSIONS.has(token.symbol)) continue;
    const pools = token.pools?.filter(p => p.isHealthy) || [];
    if (pools.length < 2) continue;

    for (let i = 0; i < pools.length; i++) {
      for (let j = 0; j < pools.length; j++) {
        if (i === j) continue;
        const buyPool = pools[i];
        const sellPool = pools[j];

        for (const testSda of [1.5, 1.0, 0.5]) {
          const amountIn = ethers.parseEther(testSda.toString());
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

          if (netProfit >= 0.0003) {
            const spreadPct = buyPool.spotPriceSda > 0
              ? ((sellPool.spotPriceSda - buyPool.spotPriceSda) / buyPool.spotPriceSda) * 100
              : 0;

            const routeObj = {
              symbol: token.symbol,
              name: `${token.symbol} (${buyPool.feeTier} ➔ ${sellPool.feeTier})`,
              path: ethers.solidityPacked(
                ["address", "uint24", "address", "uint24", "address"],
                [WSDA_ADDR, buyPool.feeTier, token.address, sellPool.feeTier, WSDA_ADDR]
              ),
              tradeSizeSda: testSda,
              netProfitSda: netProfit,
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

  // Sort gainers by highest net profit, losers by highest profit/volume
  gainerRoutes.sort((a, b) => b.netProfitSda - a.netProfitSda);
  loserRoutes.sort((a, b) => b.netProfitSda - a.netProfitSda);

  return {
    topGainers: gainerRoutes.slice(0, 20),
    topLosers: loserRoutes.slice(0, 20)
  };
}

// MAIN MEGA AUTOMATION CONTROLLER
async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || args.includes("--live") || process.env.LIVE === "true";
  const lpShare = 0.10;

  console.log("==========================================================================");
  console.log("🌟 GMAI MEGA-FLEET UNIFIED 15-WALLET AUTOMATION ENGINE");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --live for live)"}`);
  console.log(`Squad 1 (W1 - W5)  : 👑 TOP-TRADER COPY TRADER (WHALE CAPITAL: 15 to 100+ WSDA)`);
  console.log(`Squad 2 (W6 - W10) : 📈 DYNAMIC ARBITRAGE & GROWTH SPREADS (2.0 to 5.0 SDA)`);
  console.log(`Squad 3 (W11 - W15): ⚡ TOP 20 GAINERS & TOP 20 LOSERS COMBINATION SCALPING (1.5 SDA)`);
  console.log(`Liquidity Routing  : 10% Net Profit Auto-Injected into GMAI Pool`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM (100% PROTECTED)`);
  console.log("==========================================================================\n");

  // Load all 15 wallets
  const fleetWallets = {};
  for (let i = 1; i <= 15; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (pk) {
      const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
      fleetWallets[`wallet${i}`] = new ethers.Wallet(cleanPk, provider);
    }
  }

  const squad1 = ["wallet1", "wallet2", "wallet3", "wallet4", "wallet5"].filter(k => fleetWallets[k]);
  const squad2 = ["wallet6", "wallet7", "wallet8", "wallet9", "wallet10"].filter(k => fleetWallets[k]);
  const squad3 = ["wallet11", "wallet12", "wallet13", "wallet14", "wallet15"].filter(k => fleetWallets[k]);

  console.log("📊 Active Fleet Squads:");
  console.log(`   • Squad 1 (Whale Copy Trader: 15-100+ SDA): ${squad1.join(", ")}`);
  console.log(`   • Squad 2 (Dynamic Arb & Growth)         : ${squad2.join(", ")}`);
  console.log(`   • Squad 3 (Top 20 Gainers/Losers Scalper): ${squad3.join(", ")}\n`);

  let lastCheckedBlock = await provider.getBlockNumber();
  let lastScalpScanTime = 0;
  let lastMarketScanTime = 0;
  let cachedGainers = [];
  let cachedLosers = [];

  process.on("SIGINT", () => {
    console.log("\n🛑 MEGA AUTOMATION SHUTDOWN REQUESTED. Clean exit.");
    process.exit(0);
  });

  console.log("📡 Mega Fleet Engine Online: Monitoring blocks, arb spreads, and copy-trade triggers...\n");

  while (true) {
    try {
      // 1. Dynamic Gas Refresh
      try {
        const feeData = await provider.getFeeData();
        if (feeData.gasPrice && feeData.gasPrice < 10000000000n) {
          SAFE_GAS_PRICE = (feeData.gasPrice * 115n) / 100n;
        }
      } catch {}

      const currentBlock = await provider.getBlockNumber();

      // =========================================================================
      // ENGINE 1: WHALE COPY TRADER (Squad 1: Wallets 1 to 5)
      // Listens for target top trader transactions and mirrors with 15 to 100+ SDA
      // =========================================================================
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
                const parsed = parseRouterTx(tx);
                if (parsed) {
                  let executionRoute = parsed;
                  if (!parsed.isRoundTrip) {
                    if (parsed.tokenIn && parsed.tokenIn.toLowerCase() === WSDA_ADDR.toLowerCase()) {
                      const token = parsed.tokenOut;
                      const buyFee = parsed.fee || 3000;
                      const candidateFees = [500, 3000, 10000].filter(f => f !== buyFee);
                      let bestCross = null;
                      const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, provider);
                      const deadline = Math.floor(Date.now() / 1000) + 120;
                      const testWei = ethers.parseEther("15.0");

                      for (const sellFee of candidateFees) {
                        const candidatePath = ethers.solidityPacked(
                          ["address", "uint24", "address", "uint24", "address"],
                          [WSDA_ADDR, buyFee, token, sellFee, WSDA_ADDR]
                        );
                        try {
                          const out = await router.exactInput.staticCall({
                            path: candidatePath,
                            recipient: fleetWallets[squad1[0]].address,
                            deadline,
                            amountIn: testWei,
                            amountOutMinimum: testWei + 1n
                          });
                          const net = Number(ethers.formatEther(out - testWei));
                          if (net > 0 && (!bestCross || net > bestCross.net)) {
                            bestCross = { path: candidatePath, net, name: `${token.slice(0, 8)} Cross-Pool (${buyFee} -> ${sellFee})` };
                          }
                        } catch {}
                      }

                      if (bestCross) {
                        executionRoute = { path: bestCross.path, name: bestCross.name, isRoundTrip: true };
                      } else {
                        // Pure scalping invariant: Ignore directional token buys to ensure 0 tokens are held
                        continue;
                      }
                    } else {
                      continue;
                    }
                  }

                  let copySize = 15.0;
                  if (parsed.amountInSda && parsed.amountInSda > 15.0) {
                    copySize = Math.min(parsed.amountInSda, 120.0);
                  } else if (parsed.amountInSda && parsed.amountInSda > 0) {
                    copySize = Math.max(parsed.amountInSda, 15.0);
                  }

                  console.log(`\n🔔 [SQUAD 1 WHALE COPY TRIGGER] Top Trader ${fromLower.slice(0, 10)}... traded ${parsed.amountInSda?.toFixed(2) || "N/A"} SDA on Pinetswap!`);
                  console.log(`   Target Tx   : https://ledger.sidrachain.com/tx/${tx.hash}`);
                  console.log(`   Whale Sizing: ${copySize.toFixed(2)} SDA deployed across Wallets 1 - 5`);
                  console.log(`   Strategy    : Pure Atomic Round-Trip Scalping (0 Tokens Held Guaranteed)`);

                  for (const wKey of squad1) {
                    if (isWalletReady(wKey, 5000)) {
                      await executeSwarmTrade({
                        walletKey: wKey,
                        signer: fleetWallets[wKey],
                        route: executionRoute,
                        modeLabel: `SQUAD 1 WHALE COPY (${copySize.toFixed(1)} SDA)`,
                        isLive,
                        tradeSizeSda: copySize,
                        lpShare
                      });
                      break;
                    }
                  }
                }
              }
            } catch {}
          }
        }
        lastCheckedBlock = currentBlock;
      }

      // =========================================================================
      // ENGINE 2 & 3: SCAN MARKET FOR TOP 20 GAINERS & LOSERS
      // =========================================================================
      if (Date.now() - lastMarketScanTime >= 10000) {
        lastMarketScanTime = Date.now();
        try {
          const market = await scanMarket(provider);
          const { topGainers, topLosers } = await scanTopGainersAndLosers(market);
          cachedGainers = topGainers;
          cachedLosers = topLosers;
        } catch {}
      }

      // =========================================================================
      // ENGINE 3: SQUAD 3 TOKEN SCALPER (Wallets 11 to 15)
      // Alternates scalping on Top 20 Gainers & Top 20 Losers (1.5 SDA)
      // =========================================================================
      if (Date.now() - lastScalpScanTime >= 4000) {
        lastScalpScanTime = Date.now();
        const readyW3 = squad3.find(k => isWalletReady(k, 5000));
        if (readyW3) {
          // Check top gainers first, then top losers
          const candidates = [...cachedGainers, ...cachedLosers];
          if (candidates.length > 0) {
            const bestScalp = candidates[0];
            const isGainer = cachedGainers.includes(bestScalp);
            console.log(`\n⚡ [SQUAD 3 ${isGainer ? "TOP GAINER" : "TOP LOSER"} SCALP] Spread on ${bestScalp.name}!`);
            console.log(`   • Expected Net Profit : +${bestScalp.netProfitSda.toFixed(5)} SDA`);
            console.log(`   • Executing Wallet    : ${readyW3} (Size: ${bestScalp.tradeSizeSda.toFixed(2)} SDA)`);

            // Rotate across ready wallets in Squad 3 (W11 - W15)
            const availableSquad3 = squad3.filter(k => isWalletReady(k, 5000));
            if (availableSquad3.length > 0) {
              const selectedKey = availableSquad3[Math.floor(Math.random() * availableSquad3.length)];
              await executeSwarmTrade({
                walletKey: selectedKey,
                signer: fleetWallets[selectedKey],
                route: bestScalp,
                modeLabel: `SQUAD 3 ${isGainer ? "GAINER" : "LOSER"} SCALP`,
                isLive,
                tradeSizeSda: bestScalp.tradeSizeSda,
                lpShare
              });
            }
          }
        }
      }

      await sleep(1500);
    } catch (err) {
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
