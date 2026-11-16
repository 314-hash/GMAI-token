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
const tokensConfig = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });
provider.pollingInterval = 800;

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const FACTORY_ADDR = tokensConfig.network?.factory || "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)"
];

const WSDA_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256)"
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"
];

const FACTORY_ABI = [
  "function getPool(address, address, uint24) view returns (address)"
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSafeGasPrice() {
  try {
    const feeData = await provider.getFeeData();
    const netGas = feeData.gasPrice || 3500000000n;
    const buffered = (netGas * 125n) / 100n;
    return buffered > 3500000000n ? buffered : 3500000000n;
  } catch {
    return 4000000000n;
  }
}

async function getFastNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

/**
 * Discovers all active V3 pools (500, 3000, 10000) for a token and ranks them by WSDA reserve
 */
async function discoverPoolsForToken(tokenAddress) {
  const factory = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, provider);
  const wsda = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const tiers = [500, 3000, 10000];
  const activePools = [];

  const cfgToken = (tokensConfig.tokens || []).find(
    (t) => t.address && t.address.toLowerCase() === tokenAddress.toLowerCase()
  );

  for (const fee of tiers) {
    let poolAddr = cfgToken?.pools?.[String(fee)] || null;
    if (!poolAddr) {
      try {
        poolAddr = await factory.getPool(WSDA_ADDR, tokenAddress, fee);
      } catch {}
    }
    if (poolAddr && poolAddr !== ethers.ZeroAddress) {
      try {
        const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
        const [liq, wsdaBal, tokBal] = await Promise.all([
          pool.liquidity().catch(() => 0n),
          wsda.balanceOf(poolAddr).catch(() => 0n),
          token.balanceOf(poolAddr).catch(() => 0n)
        ]);
        if (liq > 0n || wsdaBal > 0n) {
          activePools.push({
            feeTier: fee,
            poolAddress: poolAddr,
            liquidity: BigInt(liq),
            poolWsdaBal: BigInt(wsdaBal),
            poolTokenBal: BigInt(tokBal)
          });
        }
      } catch {}
    }
  }

  activePools.sort((a, b) => (b.poolWsdaBal > a.poolWsdaBal ? 1 : b.poolWsdaBal < a.poolWsdaBal ? -1 : 0));
  return activePools;
}

/**
 * Finds the maximum chunk size that a specific pool feeTier will accept without reverting on-chain.
 */
async function findMaxExecutableChunkForPool(router, signerAddr, tokenAddress, feeTier, maxAmountWei) {
  const tryQuote = async (amt) => {
    if (amt <= 0n) return 0n;
    try {
      const out = await router.exactInputSingle.staticCall({
        tokenIn: tokenAddress,
        tokenOut: WSDA_ADDR,
        fee: feeTier,
        recipient: signerAddr,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: amt,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0
      });
      return out;
    } catch {
      return 0n;
    }
  };

  // 1. First test 100% of balance
  const fullOut = await tryQuote(maxAmountWei);
  if (fullOut > 0n) {
    return { amountIn: maxAmountWei, expectedWsda: fullOut };
  }

  // 2. Exponential step-down to find a working lower bound (1/2, 1/4, 1/8, ..., 1/4096)
  let workingLow = 0n;
  let workingLowOut = 0n;
  let failingHigh = maxAmountWei;

  let testAmt = maxAmountWei / 2n;
  for (let step = 0; step < 14; step++) {
    if (testAmt <= 0n) break;
    const out = await tryQuote(testAmt);
    if (out > 0n) {
      workingLow = testAmt;
      workingLowOut = out;
      break;
    } else {
      failingHigh = testAmt;
      testAmt = testAmt / 2n;
    }
  }

  if (workingLow === 0n) {
    return null;
  }

  // 3. Binary search between workingLow and failingHigh (5 iterations) to maximize chunk size
  let bestAmt = workingLow;
  let bestOut = workingLowOut;
  let low = workingLow;
  let high = failingHigh;

  for (let i = 0; i < 5; i++) {
    const mid = (low + high) / 2n;
    if (mid <= low || mid >= high) break;
    const out = await tryQuote(mid);
    if (out > 0n) {
      bestAmt = mid;
      bestOut = out;
      low = mid;
    } else {
      high = mid;
    }
  }

  // Apply a 2% safety margin below the cliff so on-chain execution never hits the tick boundary
  const safeAmt = (bestAmt * 98n) / 100n;
  const safeOut = await tryQuote(safeAmt);
  if (safeOut > 0n) {
    return { amountIn: safeAmt, expectedWsda: safeOut };
  }

  return { amountIn: bestAmt, expectedWsda: bestOut };
}

/**
 * Force-sells a token balance from a wallet using binary-searched chunk sizes & 100% slippage tolerance
 */
export async function forceSellTokenForWallet(walletKey, signer, tokenAddress, symbol = "TOKEN", decimals = 18) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);

  let bal = await token.balanceOf(signer.address);
  const formattedInit = Number(ethers.formatUnits(bal, decimals));
  if (bal <= 0n || formattedInit < 0.0001) {
    return { sold: false, reason: "ZERO_OR_DUST_BALANCE" };
  }

  console.log(`\n🚨 [${walletKey.toUpperCase()}] (${signer.address}) FORCE-SELLING ${formattedInit.toFixed(6)} ${symbol} (${tokenAddress})...`);

  const pools = await discoverPoolsForToken(tokenAddress);
  if (pools.length === 0) {
    console.log(`   ❌ [${walletKey}] No active Uniswap V3 pools found for ${symbol}.`);
    return { sold: false, reason: "NO_POOLS_FOUND" };
  }

  console.log(`   🔎 Discovered ${pools.length} Pool(s) for ${symbol}:`);
  for (const p of pools) {
    console.log(`      • Fee ${p.feeTier} (${p.poolAddress}) | Pool WSDA Reserve: ${Number(ethers.formatEther(p.poolWsdaBal)).toFixed(4)} WSDA | Liquidity: ${p.liquidity.toString()}`);
  }

  // Ensure router approval once
  const gasPrice = await getSafeGasPrice();
  const curAllow = await token.allowance(signer.address, ROUTER_ADDR);
  if (curAllow < bal) {
    console.log(`   🔐 [${walletKey}] Approving ${symbol} to Router...`);
    const nonceApp = await getFastNonce(signer.address);
    const appTx = await token.approve(ROUTER_ADDR, ethers.MaxUint256, {
      gasLimit: 85000n,
      gasPrice,
      nonce: nonceApp
    });
    await appTx.wait(1);
    console.log(`   ✅ [${walletKey}] Approved ${symbol} (Tx: ${appTx.hash.slice(0, 16)}...)`);
  }

  let totalWsdaRecovered = 0n;
  let chunksExecuted = 0;
  let maxLoops = 30;

  while (bal > 0n && maxLoops > 0) {
    maxLoops--;
    const curFormatted = Number(ethers.formatUnits(bal, decimals));
    if (curFormatted < 0.0001) break;

    let bestPlan = null;

    for (const p of pools) {
      if (p.poolWsdaBal <= 1000000000000n) continue;
      const candidate = await findMaxExecutableChunkForPool(router, signer.address, tokenAddress, p.feeTier, bal);
      if (candidate && candidate.expectedWsda > 0n) {
        if (!bestPlan || candidate.expectedWsda > bestPlan.expectedWsda) {
          bestPlan = {
            ...candidate,
            feeTier: p.feeTier,
            poolAddress: p.poolAddress
          };
        }
      }
    }

    if (!bestPlan) {
      console.log(`   ⚠️ [${walletKey}] Remaining ${curFormatted.toFixed(6)} ${symbol} rejected by all pools (active tick liquidity exhausted).`);
      break;
    }

    const expectedSdaNum = Number(ethers.formatEther(bestPlan.expectedWsda));
    if (expectedSdaNum < 0.00005) {
      console.log(`   ℹ️ [${walletKey}] Remaining ${symbol} chunk is worth < 0.00005 SDA (${expectedSdaNum.toFixed(7)} SDA). Stopping to save gas.`);
      break;
    }

    const chunkPct = Number((bestPlan.amountIn * 10000n) / bal) / 100;
    console.log(
      `   ⚡ [${walletKey}] Force-Selling Chunk (${chunkPct.toFixed(2)}% = ${Number(ethers.formatUnits(bestPlan.amountIn, decimals)).toFixed(4)} ${symbol}) on Fee ${bestPlan.feeTier} ➔ Est. +${expectedSdaNum.toFixed(5)} WSDA...`
    );

    try {
      const wsdaBefore = await wsda.balanceOf(signer.address);
      const nonce = await getFastNonce(signer.address);
      const curGasPrice = await getSafeGasPrice();

      const tx = await router.exactInputSingle({
        tokenIn: tokenAddress,
        tokenOut: WSDA_ADDR,
        fee: bestPlan.feeTier,
        recipient: signer.address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn: bestPlan.amountIn,
        amountOutMinimum: 0n, // 100% slippage tolerance
        sqrtPriceLimitX96: 0
      }, {
        gasLimit: 350000n,
        gasPrice: curGasPrice,
        nonce
      });

      await tx.wait(1);
      const wsdaAfter = await wsda.balanceOf(signer.address);
      const gained = wsdaAfter > wsdaBefore ? wsdaAfter - wsdaBefore : bestPlan.expectedWsda;
      totalWsdaRecovered += gained;
      chunksExecuted++;

      console.log(`   ✅ [${walletKey}] Chunk #${chunksExecuted} Confirmed! Recovered +${Number(ethers.formatEther(gained)).toFixed(5)} WSDA (Tx: ${tx.hash.slice(0, 18)}...)`);
    } catch (txErr) {
      console.warn(`   ⚠️ [${walletKey}] Chunk tx failed (${txErr.reason || txErr.message}).`);
      break;
    }

    bal = await token.balanceOf(signer.address);
    await sleep(600);
  }

  // Unwrap all WSDA in wallet directly to Native SDA
  const finalWsda = await wsda.balanceOf(signer.address);
  if (finalWsda > 0n) {
    try {
      const nonceUnwrap = await getFastNonce(signer.address);
      const curGas = await getSafeGasPrice();
      const unwrapTx = await wsda.withdraw(finalWsda, {
        gasLimit: 90000n,
        gasPrice: curGas,
        nonce: nonceUnwrap
      });
      await unwrapTx.wait(1);
      console.log(`   💰 [${walletKey}] Unwrapped +${Number(ethers.formatEther(finalWsda)).toFixed(5)} WSDA ➔ Native SDA in wallet!`);
    } catch (uErr) {
      console.warn(`   ⚠️ [${walletKey}] WSDA unwrap notice: ${uErr.message}`);
    }
  }

  return {
    sold: chunksExecuted > 0,
    chunksExecuted,
    totalSdaRecovered: Number(ethers.formatEther(totalWsdaRecovered))
  };
}

async function main() {
  const args = process.argv.slice(2);
  const targetTokenAddr = args.find((a) => a.startsWith("0x")) || "0x05322f2356e8FfdC28c4a5e69d4FEebEbbB33649";

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

  const erc20 = new ethers.Contract(targetTokenAddr, ERC20_ABI, provider);
  const [symbol, decimals, name] = await Promise.all([
    erc20.symbol().catch(() => "TOKEN"),
    erc20.decimals().catch(() => 18),
    erc20.name().catch(() => "Target Token")
  ]);

  console.log("==========================================================================");
  console.log(`🔥 FORCE SWAP TOKEN TO NATIVE SDA (BINARY-SEARCH CHUNKED LIQUIDATION)`);
  console.log(`   Token : ${symbol} (${name})`);
  console.log(`   Addr  : ${targetTokenAddr}`);
  console.log("==========================================================================");

  console.log("\n🔎 Checking balances across all 5 fleet wallets:");
  for (const [k, signer] of Object.entries(swarmWallets)) {
    const bal = await erc20.balanceOf(signer.address);
    console.log(`   • [${k.toUpperCase().padEnd(7)}] ${signer.address} | ${symbol} Balance: ${ethers.formatUnits(bal, Number(decimals))} ${symbol}`);
  }

  for (const [k, signer] of Object.entries(swarmWallets)) {
    await forceSellTokenForWallet(k, signer, targetTokenAddr, symbol, Number(decimals));
  }

  console.log("\n==========================================================================");
  console.log(`✅ FORCE SWAP COMPLETE! Updated Fleet Balances:`);
  const wsdaContract = new ethers.Contract(WSDA_ADDR, ERC20_ABI, provider);
  for (const [k, signer] of Object.entries(swarmWallets)) {
    const [nativeBal, wsdaBal, tokBal] = await Promise.all([
      provider.getBalance(signer.address),
      wsdaContract.balanceOf(signer.address),
      erc20.balanceOf(signer.address)
    ]);
    console.log(
      `   • [${k.toUpperCase().padEnd(7)}] ${signer.address} | Native: ${Number(ethers.formatEther(nativeBal)).toFixed(4)} SDA | WSDA: ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} | ${symbol}: ${Number(ethers.formatUnits(tokBal, Number(decimals))).toFixed(4)}`
    );
  }
  console.log("==========================================================================\n");
}

main().catch(console.error);
