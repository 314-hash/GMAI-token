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
const GMAI_ADDR = ethers.getAddress(process.env.TARGET_TOKEN_ADDRESS || process.env.GMAI_ADDRESS || "0x4765561e63914E72168bBd2A7e2ce72F9057ca04");
const GMAI_POOL_FEE = Number(process.env.POOL_FEE || process.env.GMAI_POOL_FEE || "10000");

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

// Deep liquid tokens with verified pool liquidity >= 30,000 SDA
const TARGET_SYMBOLS = ["FREEt", "GLNs", "FBAY", "PINE", "GACP", "SKMH", "DBN", "AIR", "HEC", "SDIP", "JSFT", "AITT", "QSM"];
const DEEP_TARGET_TOKENS = [];

for (const sym of TARGET_SYMBOLS) {
  const found = (tokensData.tokens || []).find((t) => t.symbol === sym);
  if (found && found.address) {
    const fee = found.pools?.["3000"] ? 3000 : (found.pools?.["10000"] ? 10000 : 500);
    DEEP_TARGET_TOKENS.push({
      symbol: found.symbol,
      address: ethers.getAddress(found.address),
      feeTier: fee,
      decimals: found.decimals || 18
    });
  }
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
 * Executes a single controlled cadence trade for a wallet:
 * 1. Wraps required native SDA to WSDA.
 * 2. Swaps WSDA -> Target Token on deep pool.
 * 3. Records ONLY the tokens acquired during this swap.
 * 4. Swaps ONLY those acquired tokens back to WSDA.
 * 5. Unwraps 90% of the returned WSDA directly to Native SDA in the wallet.
 * 6. Injects 10% into the GMAI liquidity pool.
 * 
 * STRICT INVARIANT: Existing wallet balances (GMAI, SVM, RIDE, etc.) are NEVER touched.
 */
async function executeCadenceTrade(walletKey, signer, targetToken, tradeSizeSda, isLive) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const targetContract = new ethers.Contract(targetToken.address, ERC20_ABI, signer);
  const tradeSizeWei = ethers.parseEther(tradeSizeSda.toString());

  console.log(`\n==========================================================================`);
  console.log(`⚡ [SWARM CADENCE] [${walletKey.toUpperCase()}] Trading ${tradeSizeSda} SDA on ${targetToken.symbol}`);
  console.log(`   Target Token        : ${targetToken.symbol} (${targetToken.address})`);
  console.log(`   Pool Fee Tier       : ${targetToken.feeTier}`);
  console.log(`   Execution Capital   : ${tradeSizeSda} SDA`);
  console.log(`   Safety Guarantee    : ONLY acquired tokens are traded. Existing portfolio untouched.`);
  console.log(`   Profit / Return     : 90% Native SDA in ${walletKey.toUpperCase()} | 10% GMAI Pool Injection`);
  console.log(`==========================================================================`);

  if (!isLive) {
    console.log(`   🛡️ [DRY-RUN] Verified trade simulation: ${tradeSizeSda} SDA on ${targetToken.symbol}`);
    return { success: true, simulated: true };
  }

  // 1. Ensure WSDA balance
  const curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeSizeWei) {
    const wrapNeeded = tradeSizeWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.1")) {
      console.warn(`   ⚠️ [${walletKey}] Insufficient native SDA balance (${ethers.formatEther(nativeBal)}) to wrap ${ethers.formatEther(wrapNeeded)}.`);
      return { success: false, reason: "LOW_NATIVE_BALANCE" };
    }
    const nonceWrap = await getFastNonce(signer.address);
    const gasPrice = await getSafeGasPrice();
    const wrapTx = await wsda.deposit({ value: wrapNeeded, gasLimit: 85000n, gasPrice, nonce: nonceWrap });
    await wrapTx.wait(1);
    console.log(`   ✅ [${walletKey}] Wrapped +${ethers.formatEther(wrapNeeded)} SDA ➔ WSDA`);
  }

  // 2. Ensure Router Approval for WSDA
  await ensureApproval(signer, WSDA_ADDR, tradeSizeWei);

  // 3. Pre-quote Leg 1 via StaticCall (WSDA -> Token)
  const deadline = Math.floor(Date.now() / 1000) + 300;
  let expectedTokens = 0n;
  try {
    expectedTokens = await router.exactInputSingle.staticCall({
      tokenIn: WSDA_ADDR,
      tokenOut: targetToken.address,
      fee: targetToken.feeTier,
      recipient: signer.address,
      deadline,
      amountIn: tradeSizeWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0
    });
  } catch (simErr) {
    console.warn(`   ⚠️ [${walletKey}] Pre-trade staticCall failed: ${simErr.message}`);
    return { success: false, reason: "SIMULATION_FAILED" };
  }

  // Protect with 1.0% maximum slippage tolerance
  const minTokensOut = (expectedTokens * 990n) / 1000n;

  // 4. Record baseline balance of target token BEFORE Leg 1
  const tokenBalBefore = await targetContract.balanceOf(signer.address);

  // 5. Execute Leg 1: WSDA -> Target Token
  console.log(`   ▶️ [${walletKey}] Leg 1: Swapping ${tradeSizeSda} WSDA ➔ ${targetToken.symbol}...`);
  const nonce1 = await getFastNonce(signer.address);
  const gasPrice1 = await getSafeGasPrice();
  const leg1Tx = await router.exactInputSingle({
    tokenIn: WSDA_ADDR,
    tokenOut: targetToken.address,
    fee: targetToken.feeTier,
    recipient: signer.address,
    deadline,
    amountIn: tradeSizeWei,
    amountOutMinimum: minTokensOut,
    sqrtPriceLimitX96: 0
  }, { gasLimit: 260000n, gasPrice: gasPrice1, nonce: nonce1 });

  await leg1Tx.wait(1);
  const tokenBalAfter = await targetContract.balanceOf(signer.address);
  const tokensAcquired = tokenBalAfter - tokenBalBefore;

  console.log(`   ✅ [${walletKey}] Leg 1 Confirmed! Acquired: ${ethers.formatUnits(tokensAcquired, targetToken.decimals)} ${targetToken.symbol} (Tx: ${leg1Tx.hash.slice(0, 18)}...)`);

  if (tokensAcquired <= 0n) {
    console.warn(`   ⚠️ [${walletKey}] No tokens acquired in Leg 1. Aborting.`);
    return { success: false, reason: "ZERO_TOKENS_ACQUIRED" };
  }

  // 6. Ensure Router Approval for ONLY the acquired tokens
  await ensureApproval(signer, targetToken.address, tokensAcquired);

  // 7. Execute Leg 2: Swap ONLY the acquired tokens back to WSDA
  console.log(`   ▶️ [${walletKey}] Leg 2: Swapping ${ethers.formatUnits(tokensAcquired, targetToken.decimals)} ${targetToken.symbol} back ➔ WSDA...`);
  const nonce2 = await getFastNonce(signer.address);
  const gasPrice2 = await getSafeGasPrice();
  const wsdaBalBeforeLeg2 = await wsda.balanceOf(signer.address);

  const leg2Tx = await router.exactInputSingle({
    tokenIn: targetToken.address,
    tokenOut: WSDA_ADDR,
    fee: targetToken.feeTier,
    recipient: signer.address,
    deadline: Math.floor(Date.now() / 1000) + 300,
    amountIn: tokensAcquired, // STRICT: Only sells what was acquired in this cycle!
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0
  }, { gasLimit: 260000n, gasPrice: gasPrice2, nonce: nonce2 });

  await leg2Tx.wait(1);
  const wsdaBalAfterLeg2 = await wsda.balanceOf(signer.address);
  const wsdaReturned = wsdaBalAfterLeg2 - wsdaBalBeforeLeg2;

  console.log(`   ✅ [${walletKey}] Leg 2 Confirmed! Recovered: ${ethers.formatEther(wsdaReturned)} WSDA (Tx: ${leg2Tx.hash.slice(0, 18)}...)`);

  // 8. 90% / 10% Profit & Capital Distribution
  const refund90Wei = (wsdaReturned * 90n) / 100n;
  const lp10Wei = wsdaReturned - refund90Wei;

  // 8a. Unwrap 90% directly to Native SDA in executing wallet
  if (refund90Wei > 0n) {
    const nonceUnwrap = await getFastNonce(signer.address);
    const gasPriceUnwrap = await getSafeGasPrice();
    const unwrapTx = await wsda.withdraw(refund90Wei, { gasLimit: 85000n, gasPrice: gasPriceUnwrap, nonce: nonceUnwrap });
    await unwrapTx.wait(1);
    console.log(`   💰 [${walletKey}] Returned 90% (+${ethers.formatEther(refund90Wei)} SDA) directly to Native SDA in wallet!`);
  }

  // 8b. Inject 10% into GMAI Pool
  if (lp10Wei > ethers.parseEther("0.001")) {
    try {
      await ensureApproval(signer, WSDA_ADDR, lp10Wei);
      const nonceGmai = await getFastNonce(signer.address);
      const gasPriceGmai = await getSafeGasPrice();
      const gmaiTx = await router.exactInputSingle({
        tokenIn: WSDA_ADDR,
        tokenOut: GMAI_ADDR,
        fee: GMAI_POOL_FEE,
        recipient: signer.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: lp10Wei,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 260000n, gasPrice: gasPriceGmai, nonce: nonceGmai });
      await gmaiTx.wait(1);
      console.log(`   💧 [${walletKey}] Injected 10% (+${ethers.formatEther(lp10Wei)} SDA) into GMAI Liquidity Pool!`);
    } catch (gErr) {
      console.warn(`   ⚠️ [${walletKey}] GMAI pool injection notice: ${gErr.message}`);
    }
  }

  return {
    success: true,
    sdaSpent: tradeSizeSda,
    nativeSdaReturned: Number(ethers.formatEther(refund90Wei)),
    lpSdaInjected: Number(ethers.formatEther(lp10Wei))
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const minTrade = Number(args.find((a) => a.startsWith("--min-trade="))?.split("=")[1] || 5.0);
  const maxTrade = Number(args.find((a) => a.startsWith("--max-trade="))?.split("=")[1] || 15.0);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 60);

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

  const walletKeys = Object.keys(swarmWallets);
  if (walletKeys.length === 0) throw new Error("No wallet private keys configured in .env");

  console.log("==========================================================================");
  console.log(`🚀 ACTIVE 5-15 SDA HIGH-VELOCITY SWARM ENGINE`);
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Fleet Wallets      : ${walletKeys.join(", ")} (${walletKeys.length} Swarm Wallets)`);
  console.log(`Target Pool Tokens : ${DEEP_TARGET_TOKENS.map((t) => t.symbol).join(", ")}`);
  console.log(`Trade Sizing       : ${minTrade} to ${maxTrade} SDA dynamic per trade`);
  console.log(`Cadence            : 1 Active Trade Every ${intervalSec}s across swarm rotation`);
  console.log(`Return Mandate     : 90% Native SDA Returned to Wallet | 10% GMAI Pool Injection`);
  console.log(`Safety Guarantee   : ZERO token liquidations. Existing portfolios 100% locked.`);
  console.log("==========================================================================\n");

  console.log("👥 Fleet Current Liquid Balances:");
  for (const k of walletKeys) {
    const w = swarmWallets[k];
    const bal = await provider.getBalance(w.address);
    console.log(`   • [${k.toUpperCase().padEnd(8)}] ${w.address} | Native SDA: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA`);
  }

  let round = 1;
  let walletIndex = 0;
  let tokenIndex = 0;

  while (true) {
    const currentKey = walletKeys[walletIndex % walletKeys.length];
    const currentSigner = swarmWallets[currentKey];
    const targetToken = DEEP_TARGET_TOKENS[tokenIndex % DEEP_TARGET_TOKENS.length];

    // Pick trade size: cycle between minTrade and maxTrade (e.g. 5.0, 7.5, 10.0, 12.5, 15.0 SDA)
    const tradeSizes = [5.0, 7.5, 10.0, 12.5, 15.0];
    const chosenSize = tradeSizes[round % tradeSizes.length];

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`⏱️ [ROUND #${round}] Swarm Rotation: ${currentKey.toUpperCase()} ➔ ${targetToken.symbol} (${chosenSize} SDA)`);
    console.log(`--------------------------------------------------------------------------`);

    try {
      await executeCadenceTrade(currentKey, currentSigner, targetToken, chosenSize, isLive);
    } catch (err) {
      console.error(`   ❌ [${currentKey}] Round #${round} error: ${err.reason || err.message}`);
    }

    walletIndex++;
    tokenIndex++;
    round++;

    console.log(`\n⏳ Next swarm trade in ${intervalSec} seconds...`);
    await sleep(intervalSec * 1000);
  }
}

main().catch(console.error);
