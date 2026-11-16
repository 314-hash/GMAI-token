import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { acquireWalletLock } from "./wallet_helper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const TOKENS_CONFIG_PATH = path.join(__dirname, "..", "config", "tokens.json");
const tokensConfig = JSON.parse(fs.readFileSync(TOKENS_CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const FACTORY_ADDR = tokensConfig.network?.factory || "0xCFE41fb5dA87916D84E7F22889087b4Ff7163cDE";

// STRICT EXCLUSIONS: Personal core assets that must NEVER be sold
const STRICT_EXCLUSIONS = new Set(["GMAI", "RIDE", "BANDIQ", "BNDQ", "SVM", "WSDA"]);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const WSDA_ABI = [
  ...ERC20_ABI,
  "function withdraw(uint256)"
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const POOL_ABI = [
  "function liquidity() view returns (uint128)"
];

const FACTORY_ABI = [
  "function getPool(address, address, uint24) view returns (address)"
];

const GAS_PRICE = 4200000000n;

async function discoverPoolsForToken(tokenAddress) {
  const factory = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, provider);
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
        const liq = await pool.liquidity().catch(() => 0n);
        if (liq > 0n) {
          activePools.push({ feeTier: fee, poolAddress: poolAddr, liquidity: BigInt(liq) });
        }
      } catch {}
    }
  }

  activePools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
  return activePools;
}

async function liquidateTokenToSda(walletKey, signer, tokenObj, tokenBal) {
  const router = new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, signer);
  const tokenContract = new ethers.Contract(tokenObj.address, ERC20_ABI, signer);

  console.log(`\n🔄 [${walletKey}] Liquidating ${ethers.formatEther(tokenBal)} ${tokenObj.symbol} -> WSDA/SDA...`);

  const pools = await discoverPoolsForToken(tokenObj.address);
  if (pools.length === 0) {
    console.log(`   ⚠️ No active pools found for ${tokenObj.symbol}.`);
    return false;
  }

  // Acquire mutex lock
  const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
  try {
    // Check & approve
    const allow = await tokenContract.allowance(signer.address, ROUTER_ADDR);
    if (allow < tokenBal) {
      console.log(`   🔓 Approving router for ${tokenObj.symbol}...`);
      const appTx = await tokenContract.approve(ROUTER_ADDR, ethers.MaxUint256, {
        gasLimit: 75000n,
        gasPrice: GAS_PRICE,
        nonce: lock.nonce
      });
      await appTx.wait(1);
      lock.nonce++;
    }

    // Try pools starting from highest liquidity
    for (const p of pools) {
      try {
        const deadline = Math.floor(Date.now() / 1000) + 180;
        // Pre-flight static call
        const expectedOut = await router.exactInputSingle.staticCall({
          tokenIn: tokenObj.address,
          tokenOut: WSDA_ADDR,
          fee: p.feeTier,
          recipient: signer.address,
          deadline,
          amountIn: tokenBal,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0
        });

        if (expectedOut > 0n) {
          console.log(`   ⚡ Swapping ${ethers.formatEther(tokenBal)} ${tokenObj.symbol} via Pool (Fee ${p.feeTier}) -> Expected +${ethers.formatEther(expectedOut)} WSDA...`);
          const tx = await router.exactInputSingle({
            tokenIn: tokenObj.address,
            tokenOut: WSDA_ADDR,
            fee: p.feeTier,
            recipient: signer.address,
            deadline,
            amountIn: tokenBal,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0
          }, {
            gasLimit: 300000n,
            gasPrice: GAS_PRICE,
            nonce: lock.nonce
          });
          const rc = await tx.wait(1);
          console.log(`   ✅ Confirmed in block ${rc.blockNumber}! (Tx: ${tx.hash})`);
          lock.nonce++;
          return true;
        }
      } catch (err) {
        console.log(`   ⚠️ Pool (Fee ${p.feeTier}) rejected full swap: ${err.message?.slice(0, 45)}`);
      }
    }
  } finally {
    await lock.release();
  }

  return false;
}

async function main() {
  console.log("==========================================================================");
  console.log("🔥 TOTAL FLEET TOKEN LIQUIDATION ENGINE (CONVERT ALL HELD TOKENS -> SDA)");
  console.log("==========================================================================");
  console.log("Protected Tokens   : GMAI, SVM, RIDE, BANDIQ (100% NEVER TOUCHED)");
  console.log("Target Tokens      : SDO, TAMBN, ACV, CSF, SDS, JSFT, SMRX, SMAf, VPE, LNH, etc.");
  console.log("Goal               : Free up 100% SDA Capital for Copy Trading & Scalping");
  console.log("==========================================================================\n");

  const tokens = (tokensConfig.tokens || []).filter(t => !STRICT_EXCLUSIONS.has(t.symbol));
  // Add ACV if not present
  if (!tokens.some(t => t.symbol === "ACV")) {
    tokens.push({ symbol: "ACV", address: "0x1Dbb8336663198BFc18346Cfe8172Da722918284", decimals: 18 });
  }

  const wallets = [];
  for (let i = 1; i <= 15; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!pk) continue;
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const signer = new ethers.Wallet(cleanPk, provider);
    wallets.push({ index: i, walletKey: `wallet${i}`, signer });
  }

  for (const w of wallets) {
    console.log(`\n==========================================================================`);
    console.log(`💼 Scanning Wallet ${w.index} (${w.signer.address})...`);
    console.log(`==========================================================================`);

    for (const t of tokens) {
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, w.signer);
        const b = await c.balanceOf(w.signer.address);
        if (b > ethers.parseEther("0.001")) {
          console.log(`   Holding: ${ethers.formatEther(b)} ${t.symbol}`);
          await liquidateTokenToSda(w.walletKey, w.signer, t, b);
        }
      } catch {}
    }

    // After liquidating tokens to WSDA, unwrap all WSDA to Native SDA!
    try {
      const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, w.signer);
      const wsdaBal = await wsda.balanceOf(w.signer.address);
      if (wsdaBal > ethers.parseEther("0.05")) {
        console.log(`   💰 [${w.walletKey}] Unwrapping +${ethers.formatEther(wsdaBal)} WSDA ➔ Native SDA...`);
        const lock = await acquireWalletLock(w.walletKey, w.signer.address, provider, 5000);
        try {
          const uTx = await wsda.withdraw(wsdaBal, {
            gasLimit: 85000n,
            gasPrice: GAS_PRICE,
            nonce: lock.nonce
          });
          const rc = await uTx.wait(1);
          console.log(`   ✅ Unwrapped in block ${rc.blockNumber}! (Tx: ${uTx.hash})`);
        } finally {
          await lock.release();
        }
      }
    } catch (uErr) {
      console.log(`   ⚠️ Unwrap notice: ${uErr.message?.slice(0, 50)}`);
    }

    const finalNative = await provider.getBalance(w.signer.address);
    console.log(`   🏁 Final Liquid Native Balance: ${Number(ethers.formatEther(finalNative)).toFixed(4)} SDA`);
  }

  console.log("\n==========================================================================");
  console.log("🎉 ALL NON-CORE TOKENS LIQUIDATED TO PURE LIQUID SDA FOR COPY TRADING!");
  console.log("==========================================================================");
}

main().catch(console.error);
