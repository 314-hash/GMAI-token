import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");
const tokensData = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 800;

const ROUTER_ADDR = ethers.getAddress(process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb");
const WSDA_ADDR = ethers.getAddress(process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182");

// STRICT EXCLUSIONS: Personal holding tokens that must NEVER be traded or liquidated
const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM", "ATES", "WSDA"]);

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

async function getSafeGasPrice() {
  try {
    const feeData = await provider.getFeeData();
    const netGas = feeData.gasPrice || 2500000000n;
    return (netGas * 120n) / 100n > 2500000000n ? (netGas * 120n) / 100n : 2500000000n;
  } catch {
    return 3000000000n;
  }
}

async function getFastNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

// Build list of valid ecosystem tokens (all 39 non-excluded tokens)
export const ELIGIBLE_TOKENS = [];
for (const t of tokensData.tokens || []) {
  const sym = t.symbol?.toUpperCase();
  if (!sym || STRICT_EXCLUSIONS.has(sym)) continue;
  if (!t.address || t.address === ethers.ZeroAddress) continue;

  const pools = t.pools || {};
  const tiers = [];
  if (pools["500"]) tiers.push(500);
  if (pools["3000"]) tiers.push(3000);
  if (pools["10000"]) tiers.push(10000);

  if (tiers.length === 0) continue;

  try {
    ELIGIBLE_TOKENS.push({
      symbol: t.symbol,
      name: t.name || t.symbol,
      address: ethers.getAddress(t.address),
      decimals: t.decimals || 18,
      pools,
      tiers,
      defaultFee: tiers.includes(3000) ? 3000 : tiers[0]
    });
  } catch {}
}

async function ensureApproval(signer, tokenAddress, amountWei) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const allowance = await token.allowance(signer.address, ROUTER_ADDR);
  if (allowance < amountWei) {
    const gasPrice = await getSafeGasPrice();
    const nonce = await getFastNonce(signer.address);
    const tx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, { gasLimit: 85000n, gasPrice, nonce });
    await tx.wait(1);
  }
}

/**
 * High-Risk Re-roll Trade Execution:
 * 1. Takes previous trade capital (or initial 10 SDA if step 1).
 * 2. Does NOT reject due to price impact ("i dont care on price impact").
 * 3. Leg 1: Swaps WSDA -> Target Token.
 * 4. Records ONLY the tokens acquired during Leg 1.
 * 5. Leg 2: Swaps 100% of acquired tokens back -> WSDA.
 * 6. Returns recovered WSDA to be re-rolled directly into the next trade.
 */
async function executeRerollTrade({
  walletKey,
  signer,
  targetToken,
  tradeCapitalSda,
  isLive,
  seriesNum = 1,
  stepInSeries = 1,
  totalSteps = 5
}) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const targetContract = new ethers.Contract(targetToken.address, ERC20_ABI, signer);
  const tradeCapitalWei = ethers.parseEther(tradeCapitalSda.toFixed(18));

  console.log(`\n==========================================================================`);
  console.log(`🔥 [SERIES #${seriesNum} | RE-ROLL ${stepInSeries}/${totalSteps}] [${walletKey.toUpperCase()}] ➔ ${targetToken.symbol}`);
  console.log(`==========================================================================`);
  console.log(`   Target Token        : ${targetToken.symbol} (${targetToken.address})`);
  console.log(`   Deploying Capital   : ${tradeCapitalSda.toFixed(6)} SDA ${stepInSeries === 1 ? "(Series Initial 10 SDA)" : "(100% Previous Trade Capital)"}`);
  console.log(`   Price Impact Policy : 🚀 UNCONSTRAINED (High impact fully accepted)`);
  console.log(`   Safety Invariant    : 100% Protected (Existing tokens untouched)`);
  console.log(`--------------------------------------------------------------------------`);

  if (!isLive) {
    // In dry-run mode, simulate trade
    const simulatedReturn = tradeCapitalSda * 0.994; // approx DEX fee return
    console.log(`   🛡️ [DRY-RUN SIMULATION]`);
    console.log(`      • Input Capital   : ${tradeCapitalSda.toFixed(6)} SDA`);
    console.log(`      • Simulated Return: ${simulatedReturn.toFixed(6)} WSDA`);
    console.log(`      • Re-roll Status  : Step ${stepInSeries}/${totalSteps} ${stepInSeries === totalSteps ? "(Series Complete -> Reset to 10 SDA)" : "-> Rolls to next trade"}`);
    return {
      success: true,
      inputSda: tradeCapitalSda,
      returnedSda: simulatedReturn,
      deltaSda: simulatedReturn - tradeCapitalSda,
      simulated: true
    };
  }

  // 1. Verify / Fund WSDA Capital
  let curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeCapitalWei) {
    const wrapNeeded = tradeCapitalWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.05")) {
      console.warn(`   ⚠️ [${walletKey}] Insufficient native SDA balance (${ethers.formatEther(nativeBal)}) to fund ${tradeCapitalSda.toFixed(4)} SDA.`);
      return { success: false, reason: "LOW_NATIVE_BALANCE" };
    }
    const nonceWrap = await getFastNonce(signer.address);
    const gasPrice = await getSafeGasPrice();
    const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 85000n, gasPrice, nonce: nonceWrap });
    await wrapTx.wait(1);
    curWsda = await wsda.balanceOf(signer.address);
    console.log(`   ✅ [${walletKey}] WSDA Capital Ready: Wrapped +${ethers.formatEther(wrapNeeded)} SDA ➔ WSDA`);
  }

  // 2. Ensure Router Approval for WSDA
  await ensureApproval(signer, WSDA_ADDR, tradeCapitalWei);

  // 3. Select best fee tier (lowest fee tier available on token, e.g. 500 or 3000)
  const feeTier = targetToken.tiers.includes(500) ? 500 : targetToken.defaultFee;
  const deadline = Math.floor(Date.now() / 1000) + 300;

  // 4. Record baseline balance of target token BEFORE Leg 1
  const tokenBalBefore = await targetContract.balanceOf(signer.address);

  // 5. Execute Leg 1: WSDA -> Target Token (No price impact gating)
  console.log(`   ▶️ [${walletKey}] Leg 1: Swapping ${tradeCapitalSda.toFixed(6)} WSDA ➔ ${targetToken.symbol} (Fee: ${feeTier})...`);
  const nonce1 = await getFastNonce(signer.address);
  const gasPrice1 = await getSafeGasPrice();

  let leg1Tx;
  try {
    leg1Tx = await router.exactInputSingle({
      tokenIn: WSDA_ADDR,
      tokenOut: targetToken.address,
      fee: feeTier,
      recipient: signer.address,
      deadline,
      amountIn: tradeCapitalWei,
      amountOutMinimum: 0n, // Unconstrained: High risk re-roll accepts high impact
      sqrtPriceLimitX96: 0
    }, { gasLimit: 300000n, gasPrice: gasPrice1, nonce: nonce1 });

    await leg1Tx.wait(1);
  } catch (err) {
    console.error(`   ❌ [${walletKey}] Leg 1 swap reverted: ${err.reason || err.message}`);
    return { success: false, reason: "LEG1_FAILED" };
  }

  const tokenBalAfter = await targetContract.balanceOf(signer.address);
  const tokensAcquired = tokenBalAfter - tokenBalBefore;

  console.log(`   ✅ [${walletKey}] Leg 1 Confirmed! Acquired: ${ethers.formatUnits(tokensAcquired, targetToken.decimals)} ${targetToken.symbol} (Tx: ${leg1Tx.hash.slice(0, 18)}...)`);

  if (tokensAcquired <= 0n) {
    console.warn(`   ⚠️ [${walletKey}] Zero tokens acquired. Aborting cycle.`);
    return { success: false, reason: "ZERO_TOKENS_ACQUIRED" };
  }

  // 6. Ensure Router Approval for ONLY the acquired tokens
  await ensureApproval(signer, targetToken.address, tokensAcquired);

  // 7. Execute Leg 2: Sell back 100% of acquired tokens -> WSDA
  console.log(`   ▶️ [${walletKey}] Leg 2: Swapping ${ethers.formatUnits(tokensAcquired, targetToken.decimals)} ${targetToken.symbol} back ➔ WSDA...`);
  const nonce2 = await getFastNonce(signer.address);
  const gasPrice2 = await getSafeGasPrice();
  const wsdaBalBeforeLeg2 = await wsda.balanceOf(signer.address);

  let leg2Tx;
  try {
    leg2Tx = await router.exactInputSingle({
      tokenIn: targetToken.address,
      tokenOut: WSDA_ADDR,
      fee: feeTier,
      recipient: signer.address,
      deadline,
      amountIn: tokensAcquired, // STRICT: Only sells tokens acquired in this round!
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    }, { gasLimit: 300000n, gasPrice: gasPrice2, nonce: nonce2 });

    await leg2Tx.wait(1);
  } catch (err) {
    console.error(`   ❌ [${walletKey}] Leg 2 swap reverted: ${err.reason || err.message}`);
    return { success: false, reason: "LEG2_FAILED" };
  }

  const wsdaBalAfterLeg2 = await wsda.balanceOf(signer.address);
  const wsdaReturned = wsdaBalAfterLeg2 - wsdaBalBeforeLeg2;
  const returnedSda = Number(ethers.formatEther(wsdaReturned));
  const deltaSda = returnedSda - tradeCapitalSda;
  const roiPct = (deltaSda / tradeCapitalSda) * 100;

  console.log(`   ✅ [${walletKey}] Leg 2 Confirmed! Recovered: ${returnedSda.toFixed(6)} WSDA (Tx: ${leg2Tx.hash.slice(0, 18)}...)`);
  console.log(`   📊 [STEP PnL] Delta: ${deltaSda >= 0 ? "+" : ""}${deltaSda.toFixed(6)} SDA (${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}%)`);

  return {
    success: true,
    inputSda: tradeCapitalSda,
    returnedSda,
    deltaSda,
    tx1: leg1Tx.hash,
    tx2: leg2Tx.hash
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const startingCapital = Number(args.find((a) => a.startsWith("--capital="))?.split("=")[1] || 10.0);
  const rerollsPerSeries = Number(args.find((a) => a.startsWith("--rerolls="))?.split("=")[1] || args.find((a) => a.startsWith("--series-length="))?.split("=")[1] || 5);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 30);
  const minCapital = Number(args.find((a) => a.startsWith("--min-capital="))?.split("=")[1] || 0.10);
  const maxCapital = Number(args.find((a) => a.startsWith("--max-capital="))?.split("=")[1] || 50.0);
  const walletArg = args.find((a) => a.startsWith("--wallet="))?.split("=")[1] || "wallet1";
  const unwrapOnExit = args.includes("--unwrap-on-exit");

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

  const isSwarm = walletArg.toLowerCase() === "swarm";
  let activeKeys = isSwarm ? availableKeys : [availableKeys.includes(walletArg.toLowerCase()) ? walletArg.toLowerCase() : availableKeys[0]];

  console.log("==========================================================================");
  console.log("🔥 5-REROLL HIGH-RISK SDA COMPOUND & RESET ENGINE");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Series Logic       : 🔁 5 RE-ROLLS THEN START OVER AGAIN (Infinite Series Loop)`);
  console.log(`Series Initial Cap : ${startingCapital.toFixed(2)} SDA deployed at Step 1 of each series`);
  console.log(`Re-Roll Mechanism  : Steps 2-5 trade directly on 100% recovered previous capital`);
  console.log(`Price Impact Mode  : ⚡ UNCONSTRAINED (Zero price impact filters)`);
  console.log(`Ecosystem Tokens   : ${ELIGIBLE_TOKENS.length} Non-Excluded Tokens`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM, ATES (100% PROTECTED & ISOLATED)`);
  console.log(`Cadence Interval   : 1 Trade Every ${intervalSec}s`);
  console.log(`Active Wallet(s)   : ${activeKeys.join(", ")} ${isSwarm ? "(Swarm Rotation)" : "(Dedicated)"}`);
  console.log("==========================================================================\n");

  console.log("👥 Active Wallet Initial Balances:");
  for (const k of activeKeys) {
    const w = swarmWallets[k];
    const bal = await provider.getBalance(w.address);
    const wsda = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
    const wsdaBal = await wsda.balanceOf(w.address);
    console.log(`   • [${k.toUpperCase().padEnd(8)}] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)}`);
  }

  let isShuttingDown = false;
  let activeCapital = startingCapital;
  let currentKey = activeKeys[0];

  process.on("SIGINT", async () => {
    if (isShuttingDown) process.exit(0);
    isShuttingDown = true;
    console.log(`\n\n🛑 Shutdown requested. Re-roll engine stopped.`);
    if (unwrapOnExit && isLive) {
      try {
        const signer = swarmWallets[currentKey];
        const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
        const wsdaBal = await wsda.balanceOf(signer.address);
        if (wsdaBal > 0n) {
          console.log(`   💰 Unwrapping remaining ${ethers.formatEther(wsdaBal)} WSDA ➔ Native SDA in ${currentKey}...`);
          const nonce = await getFastNonce(signer.address);
          const gasPrice = await getSafeGasPrice();
          const tx = await wsda.withdraw(wsdaBal, { gasLimit: 85000n, gasPrice, nonce });
          await tx.wait(1);
          console.log(`   ✅ Unwrapped 100% back to Native SDA!`);
        }
      } catch (e) {
        console.warn(`   ⚠️ Unwrap notice: ${e.message}`);
      }
    }
    process.exit(0);
  });

  let series = 1;
  let stepInSeries = 1; // 1 to rerollsPerSeries (1 to 5)
  let seriesStartCapital = startingCapital;
  let walletIndex = 0;
  let tokenIndex = 0;
  let totalLifetimeDeltaSda = 0.0;

  const tokenList = [...ELIGIBLE_TOKENS];

  while (!isShuttingDown) {
    currentKey = activeKeys[walletIndex % activeKeys.length];
    const currentSigner = swarmWallets[currentKey];
    const targetToken = tokenList[tokenIndex % tokenList.length];

    // If starting a fresh series, reset to initial starting capital (10 SDA)
    if (stepInSeries === 1) {
      activeCapital = startingCapital;
      seriesStartCapital = startingCapital;
    }

    // Bound capital between min and max limits
    const deployCapital = Math.min(Math.max(activeCapital, minCapital), maxCapital);

    try {
      const result = await executeRerollTrade({
        walletKey: currentKey,
        signer: currentSigner,
        targetToken,
        tradeCapitalSda: deployCapital,
        isLive,
        seriesNum: series,
        stepInSeries,
        totalSteps: rerollsPerSeries
      });

      if (result.success) {
        totalLifetimeDeltaSda += result.deltaSda;
        // Next trade capital = returned WSDA from this trade
        activeCapital = result.returnedSda;

        if (stepInSeries < rerollsPerSeries) {
          // Progress to next re-roll step within current series
          console.log(`--------------------------------------------------------------------------`);
          console.log(`🔄 [SERIES #${series}] Step ${stepInSeries}/${rerollsPerSeries} Complete ➔ Capital Rolled Over: ${activeCapital.toFixed(6)} SDA`);
          console.log(`   Next Token: ${tokenList[(tokenIndex + 1) % tokenList.length].symbol} | Step: ${stepInSeries + 1}/${rerollsPerSeries}`);
          console.log(`--------------------------------------------------------------------------`);
          stepInSeries++;
        } else {
          // Step 5 of 5 reached: SERIES COMPLETE -> START OVER AGAIN
          const seriesDelta = activeCapital - seriesStartCapital;
          const seriesRoiPct = (seriesDelta / seriesStartCapital) * 100;

          console.log(`\n==========================================================================`);
          console.log(`🏆 [SERIES #${series} COMPLETE] FINISHED 5/5 RE-ROLLS!`);
          console.log(`==========================================================================`);
          console.log(`   • Initial Series Capital : ${seriesStartCapital.toFixed(6)} SDA`);
          console.log(`   • Final Recovered Capital: ${activeCapital.toFixed(6)} SDA`);
          console.log(`   • Series Net PnL         : ${seriesDelta >= 0 ? "+" : ""}${seriesDelta.toFixed(6)} SDA (${seriesRoiPct >= 0 ? "+" : ""}${seriesRoiPct.toFixed(2)}%)`);
          console.log(`   • Total Lifetime PnL     : ${totalLifetimeDeltaSda >= 0 ? "+" : ""}${totalLifetimeDeltaSda.toFixed(6)} SDA`);
          console.log(`   🔁 [START OVER AGAIN] Resetting capital back to ${startingCapital.toFixed(2)} SDA for Series #${series + 1}...`);
          console.log(`==========================================================================\n`);

          series++;
          stepInSeries = 1;
          activeCapital = startingCapital; // Reset to 10 SDA for the next series!
        }
      } else {
        console.warn(`   ⚠️ Series #${series} Step ${stepInSeries} skipped: ${result.reason}`);
      }
    } catch (err) {
      console.error(`   ❌ Series #${series} Step ${stepInSeries} error: ${err.message}`);
    }

    walletIndex++;
    tokenIndex++;

    console.log(`⏳ Next trade in ${intervalSec} seconds (Ctrl+C to stop)...`);
    await sleep(intervalSec * 1000);
  }
}

main().catch(console.error);
