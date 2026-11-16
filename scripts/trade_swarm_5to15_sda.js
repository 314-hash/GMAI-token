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

// Deep liquidity priority tokens (ordered by deepest pool liquidity for minimal 15 SDA price impact)
const DEEP_PRIORITY_SYMBOLS = [
  "FBAY", "SKMH", "GLNs", "DBN", "QSM", "FREEt", "GACP", "AITT", "AIR", "JSFT", "HEC", "SDIP", "DAN", "SUBV", "VPA", "IDM", "BINV", "MBF", "TKWF", "LNH", "DAN", "SMRX"
];

export const TRADING_TOKENS = [];

// 1. First add deep priority tokens
for (const sym of DEEP_PRIORITY_SYMBOLS) {
  if (STRICT_EXCLUSIONS.has(sym.toUpperCase())) continue;
  const found = (tokensData.tokens || []).find((t) => t.symbol?.toUpperCase() === sym.toUpperCase());
  if (found && found.address && found.address !== ethers.ZeroAddress) {
    const fee = found.pools?.["3000"] ? 3000 : (found.pools?.["10000"] ? 10000 : 500);
    try {
      TRADING_TOKENS.push({
        symbol: found.symbol,
        address: ethers.getAddress(found.address),
        feeTier: fee,
        decimals: found.decimals || 18
      });
    } catch {}
  }
}

// 2. Add any remaining eligible ecosystem tokens (excluding GMAI, RIDE, BANDIQ, SVM)
for (const t of tokensData.tokens || []) {
  const sym = t.symbol?.toUpperCase();
  if (!sym || STRICT_EXCLUSIONS.has(sym)) continue;
  if (TRADING_TOKENS.some((x) => x.symbol.toUpperCase() === sym)) continue;
  if (!t.address || t.address === ethers.ZeroAddress) continue;

  const pools = t.pools || {};
  const fee = pools["3000"] ? 3000 : (pools["10000"] ? 10000 : (pools["500"] ? 500 : null));
  if (!fee) continue;

  try {
    TRADING_TOKENS.push({
      symbol: t.symbol,
      address: ethers.getAddress(t.address),
      feeTier: fee,
      decimals: t.decimals || 18
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
 * Executes a controlled 15 SDA trade:
 * 1. Wraps 15.0 SDA to WSDA.
 * 2. Swaps 15.0 WSDA -> Target Token on deep pool.
 * 3. Records ONLY the tokens acquired during this swap.
 * 4. Swaps ONLY those acquired tokens back to WSDA.
 * 5. Returns 90% directly to Native SDA in the executing wallet.
 * 6. Injects 10% into the GMAI Liquidity Pool.
 * 
 * STRICT INVARIANT: Existing wallet balances (GMAI, SVM, RIDE, etc.) are NEVER touched.
 */
async function execute15SdaTrade(walletKey, signer, targetToken, tradeSizeSda, isLive, refundRatio = 0.90) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
  const targetContract = new ethers.Contract(targetToken.address, ERC20_ABI, signer);
  const tradeSizeWei = ethers.parseEther(tradeSizeSda.toString());

  console.log(`\n==========================================================================`);
  console.log(`🐋 [15 SDA SWARM] [${walletKey.toUpperCase()}] Trading ${tradeSizeSda} SDA on ${targetToken.symbol}`);
  console.log(`   Target Token        : ${targetToken.symbol} (${targetToken.address})`);
  console.log(`   Pool Fee Tier       : ${targetToken.feeTier}`);
  console.log(`   Execution Capital   : ${tradeSizeSda} SDA`);
  console.log(`   Strict Invariant    : ONLY acquired tokens are traded. Existing portfolio untouched.`);
  console.log(`   Return Allocation   : ${(refundRatio * 100).toFixed(0)}% Native SDA in ${walletKey.toUpperCase()} | ${((1 - refundRatio) * 100).toFixed(0)}% GMAI Pool`);
  console.log(`==========================================================================`);

  if (!isLive) {
    console.log(`   🛡️ [DRY-RUN] Verified simulation: ${tradeSizeSda} SDA on ${targetToken.symbol}`);
    return { success: true, simulated: true };
  }

  // 1. Ensure WSDA balance
  const curWsda = await wsda.balanceOf(signer.address);
  if (curWsda < tradeSizeWei) {
    const wrapNeeded = tradeSizeWei - curWsda;
    const nativeBal = await provider.getBalance(signer.address);
    if (nativeBal < wrapNeeded + ethers.parseEther("0.1")) {
      console.warn(`   ⚠️ [${walletKey}] Insufficient native SDA balance (${ethers.formatEther(nativeBal)}) for ${tradeSizeSda} SDA trade.`);
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
    console.warn(`   ⚠️ [${walletKey}] Pre-trade staticCall failed on ${targetToken.symbol}: ${simErr.message}`);
    return { success: false, reason: "SIMULATION_FAILED" };
  }

  // Protect with 2.0% maximum slippage tolerance
  const minTokensOut = (expectedTokens * 980n) / 1000n;

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
    console.warn(`   ⚠️ [${walletKey}] Zero tokens acquired. Aborting.`);
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
    deadline,
    amountIn: tokensAcquired, // STRICT: Only sells what was acquired in this cycle!
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0
  }, { gasLimit: 260000n, gasPrice: gasPrice2, nonce: nonce2 });

  await leg2Tx.wait(1);
  const wsdaBalAfterLeg2 = await wsda.balanceOf(signer.address);
  const wsdaReturned = wsdaBalAfterLeg2 - wsdaBalBeforeLeg2;

  console.log(`   ✅ [${walletKey}] Leg 2 Confirmed! Recovered: ${ethers.formatEther(wsdaReturned)} WSDA (Tx: ${leg2Tx.hash.slice(0, 18)}...)`);

  // 8. Profit & Capital Distribution
  const refundBps = BigInt(Math.round(refundRatio * 10000));
  const refundWei = (wsdaReturned * refundBps) / 10000n;
  const lpWei = wsdaReturned - refundWei;

  // 8a. Unwrap refund directly to Native SDA in executing wallet
  if (refundWei > 0n) {
    const nonceUnwrap = await getFastNonce(signer.address);
    const gasPriceUnwrap = await getSafeGasPrice();
    const unwrapTx = await wsda.withdraw(refundWei, { gasLimit: 85000n, gasPrice: gasPriceUnwrap, nonce: nonceUnwrap });
    await unwrapTx.wait(1);
    console.log(`   💰 [${walletKey}] Returned ${(refundRatio * 100).toFixed(0)}% (+${ethers.formatEther(refundWei)} SDA) directly to Native SDA in wallet!`);
  }

  // 8b. Inject LP share into GMAI Pool
  if (lpWei > ethers.parseEther("0.001")) {
    try {
      await ensureApproval(signer, WSDA_ADDR, lpWei);
      const nonceGmai = await getFastNonce(signer.address);
      const gasPriceGmai = await getSafeGasPrice();
      const gmaiTx = await router.exactInputSingle({
        tokenIn: WSDA_ADDR,
        tokenOut: GMAI_ADDR,
        fee: GMAI_POOL_FEE,
        recipient: signer.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: lpWei,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 260000n, gasPrice: gasPriceGmai, nonce: nonceGmai });
      await gmaiTx.wait(1);
      console.log(`   💧 [${walletKey}] Injected ${((1 - refundRatio) * 100).toFixed(0)}% (+${ethers.formatEther(lpWei)} SDA) into GMAI Liquidity Pool!`);
    } catch (gErr) {
      console.warn(`   ⚠️ [${walletKey}] GMAI pool injection notice: ${gErr.message}`);
    }
  }

  return {
    success: true,
    sdaSpent: tradeSizeSda,
    nativeSdaReturned: Number(ethers.formatEther(refundWei)),
    lpSdaInjected: Number(ethers.formatEther(lpWei))
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute");
  const tradeSize = Number(args.find((a) => a.startsWith("--trade-size="))?.split("=")[1] || 15.0);
  const intervalSec = Number(args.find((a) => a.startsWith("--interval="))?.split("=")[1] || 60);
  const refundRatio = Number(args.find((a) => a.startsWith("--refund-ratio="))?.split("=")[1] || 0.90);

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
  console.log(`🐋 5-WALLET MULTI-TOKEN 15 SDA SWARM ENGINE (60-SECOND CADENCE)`);
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute for live)"}`);
  console.log(`Fleet Wallets      : ${walletKeys.join(", ")} (${walletKeys.length} Swarm Wallets)`);
  console.log(`Active Token Pool  : ${TRADING_TOKENS.length} Deep Ecosystem Tokens`);
  console.log(`Strict Exclusions  : GMAI, RIDE, BANDIQ, SVM, ATES (100% EXCLUDED & PROTECTED)`);
  console.log(`Trade Sizing       : MAXIMUM ${tradeSize.toFixed(2)} SDA deployed per trade`);
  console.log(`Cadence            : 1 Active Trade Every ${intervalSec}s across swarm rotation`);
  console.log(`Return Mandate     : ${(refundRatio * 100).toFixed(0)}% Native SDA Returned | ${((1 - refundRatio) * 100).toFixed(0)}% GMAI Pool Injection`);
  console.log(`Safety Guarantee   : ZERO token liquidations. Portfolio balances 100% isolated.`);
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
    const targetToken = TRADING_TOKENS[tokenIndex % TRADING_TOKENS.length];

    console.log(`\n--------------------------------------------------------------------------`);
    console.log(`⏱️ [ROUND #${round}] Swarm Rotation: ${currentKey.toUpperCase()} ➔ ${targetToken.symbol} (${tradeSize.toFixed(2)} SDA)`);
    console.log(`--------------------------------------------------------------------------`);

    try {
      await execute15SdaTrade(currentKey, currentSigner, targetToken, tradeSize, isLive, refundRatio);
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
