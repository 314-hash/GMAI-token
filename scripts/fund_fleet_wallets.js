import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";

// Do not trigger tiny dust transfers if the wallet is already within 0.05 SDA of target
const DUST_TOLERANCE_SDA = 0.05;

const WSDA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function withdraw(uint256)"
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSafeGasPrice(multiplier = 130n) {
  try {
    const feeData = await provider.getFeeData();
    const netGas = feeData.gasPrice || 4000000000n;
    return (netGas * multiplier) / 100n > 4000000000n ? (netGas * multiplier) / 100n : 5000000000n;
  } catch {
    return 5000000000n;
  }
}

async function getFreshCleanNonce(address) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending")
  ]);
  return Math.max(latest, pending);
}

/**
 * Loads all configured private keys from .env
 */
function loadAllFleetWallets() {
  const wallets = {};
  for (let i = 1; i <= 50; i++) {
    const rawKey = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!rawKey) continue;
    const cleanPk = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    try {
      const signer = new ethers.Wallet(cleanPk, provider);
      wallets[i] = {
        index: i,
        keyName: `wallet${i}`,
        signer,
        address: signer.address
      };
    } catch (e) {
      console.warn(`⚠️ Could not parse PRIVATE_KEY_${i}: ${e.message}`);
    }
  }
  return wallets;
}

export async function fundFleetWallets() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--execute") || args.includes("--live");
  const amountSda = Number(args.find((a) => a.startsWith("--amount="))?.split("=")[1] || "5.0");
  const minSourceReserveSda = Number(args.find((a) => a.startsWith("--reserve="))?.split("=")[1] || "2.0");
  const autoApproveNew = args.includes("--approve") || args.includes("--init-router");

  const allWallets = loadAllFleetWallets();
  const allIndices = Object.keys(allWallets).map(Number).sort((a, b) => a - b);

  // Default Source Wallets: 1 to 5
  const sourceIndices = allIndices.filter((idx) => idx >= 1 && idx <= 5);
  // Default Target Wallets: 6 onwards (e.g. 6 to 15)
  const targetIndices = allIndices.filter((idx) => idx > 5);

  console.log("==========================================================================");
  console.log("💰 AUTOMATED FLEET WALLET FUNDING ENGINE");
  console.log("==========================================================================");
  console.log(`Execution Mode     : ${isLive ? "🚨 LIVE ON-CHAIN BROADCAST" : "🛡️ DRY-RUN SIMULATION (pass --execute to broadcast)"}`);
  console.log(`Target Balance     : ${amountSda.toFixed(2)} Native SDA per target wallet`);
  console.log(`Dust Tolerance     : ±${DUST_TOLERANCE_SDA} SDA (prevents micro-dust transactions)`);
  console.log(`Source Wallets (${sourceIndices.length}) : ${sourceIndices.map((i) => `Wallet ${i}`).join(", ")}`);
  console.log(`Target Wallets (${targetIndices.length}) : ${targetIndices.map((i) => `Wallet ${i} (${allWallets[i].address.slice(0, 8)}...)`).join(", ")}`);
  console.log(`Min Reserve Kept   : ${minSourceReserveSda.toFixed(2)} SDA per source wallet`);
  console.log(`Auto Router Approve: ${autoApproveNew ? "YES" : "NO (pass --approve to initialize Router allowances)"}`);
  console.log("==========================================================================\n");

  if (targetIndices.length === 0) {
    console.log("ℹ️ No target wallets found (Wallets > 5). Please verify .env keys.");
    return;
  }

  // 1. Audit current balances
  console.log("📊 CURRENT SOURCE FLEET STATUS (Wallets 1 - 5):");
  const sourceBalances = {};
  const wsdaContract = new ethers.Contract(WSDA_ADDR, WSDA_ABI, provider);

  for (const idx of sourceIndices) {
    const w = allWallets[idx];
    const [nativeBal, wsdaBal] = await Promise.all([
      provider.getBalance(w.address),
      wsdaContract.balanceOf(w.address).catch(() => 0n)
    ]);
    const nativeNum = Number(ethers.formatEther(nativeBal));
    const wsdaNum = Number(ethers.formatEther(wsdaBal));
    sourceBalances[idx] = { nativeNum, wsdaNum, totalSda: nativeNum + wsdaNum };
    console.log(`   • [WALLET ${idx}] ${w.address} | Native: ${nativeNum.toFixed(4)} SDA | WSDA: ${wsdaNum.toFixed(4)}`);
  }

  console.log("\n📊 CURRENT TARGET FLEET STATUS (Wallets 6 - 15):");
  const targetBalances = {};
  for (const idx of targetIndices) {
    const w = allWallets[idx];
    const nativeBal = await provider.getBalance(w.address);
    const nativeNum = Number(ethers.formatEther(nativeBal));
    targetBalances[idx] = nativeNum;
    const isFunded = nativeNum >= (amountSda - DUST_TOLERANCE_SDA);
    console.log(`   • [WALLET ${idx}] ${w.address} | Native: ${nativeNum.toFixed(4)} SDA ${isFunded ? "✅ (Fully Funded)" : "⏳ (Needs Funding)"}`);
  }

  // Identify targets needing funding (ignoring sub-dust variance)
  const neededTargets = targetIndices.filter((idx) => targetBalances[idx] < (amountSda - DUST_TOLERANCE_SDA));
  if (neededTargets.length === 0) {
    console.log(`\n🎉 All target wallets are fully funded (>= ${(amountSda - DUST_TOLERANCE_SDA).toFixed(2)} SDA). No transfers needed!`);
    
    // Check if any router approvals are missing
    if (autoApproveNew) {
      console.log("\n🔐 Verifying Pinetswap Router Approvals on Target Wallets (6-15)...");
      for (const tIdx of targetIndices) {
        const targetSigner = allWallets[tIdx].signer;
        try {
          const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, targetSigner);
          const curAllow = await wsda.allowance(targetSigner.address, ROUTER_ADDR);
          if (curAllow < ethers.parseEther("1000000")) {
            const gasPrice = await getSafeGasPrice();
            const nonce = await getFreshCleanNonce(targetSigner.address);
            const appTx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, {
              gasLimit: 85000n,
              gasPrice,
              nonce
            });
            await appTx.wait(1);
            console.log(`   ✅ Wallet ${tIdx} (${targetSigner.address.slice(0, 8)}...) Router Approved!`);
          } else {
            console.log(`   ✅ Wallet ${tIdx} already approved.`);
          }
        } catch (aErr) {
          console.warn(`   ⚠️ Wallet ${tIdx} approval notice: ${aErr.message}`);
        }
      }
    }
    return;
  }

  console.log(`\n🎯 Targets Requiring Funding (${neededTargets.length} wallets): ${neededTargets.map((i) => `W${i}`).join(", ")}`);
  
  // 2. Intelligent Mapping: Source -> Target
  const fundingPlan = [];
  const simulatedBalances = { ...sourceBalances };

  for (const targetIdx of neededTargets) {
    const deficit = amountSda - targetBalances[targetIdx];
    // Find source wallet with the highest available liquid balance
    let bestSourceIdx = null;
    let maxAvail = -1;

    for (const sIdx of sourceIndices) {
      const avail = simulatedBalances[sIdx].nativeNum - minSourceReserveSda;
      if (avail >= deficit && avail > maxAvail) {
        maxAvail = avail;
        bestSourceIdx = sIdx;
      }
    }

    if (bestSourceIdx === null) {
      for (const sIdx of sourceIndices) {
        const availTotal = simulatedBalances[sIdx].totalSda - minSourceReserveSda;
        if (availTotal >= deficit && availTotal > maxAvail) {
          maxAvail = availTotal;
          bestSourceIdx = sIdx;
        }
      }
    }

    if (bestSourceIdx === null) {
      console.error(`❌ Insufficient collective funds across Wallets 1-5 to fund Wallet ${targetIdx}!`);
      continue;
    }

    fundingPlan.push({
      sourceIdx: bestSourceIdx,
      targetIdx,
      amountSda: deficit,
      targetAddress: allWallets[targetIdx].address,
      sourceAddress: allWallets[bestSourceIdx].address
    });

    simulatedBalances[bestSourceIdx].nativeNum -= deficit;
    simulatedBalances[bestSourceIdx].totalSda -= deficit;
  }

  console.log("\n📋 PLANNED FUNDING TRANSFERS:");
  for (const p of fundingPlan) {
    console.log(`   • [WALLET ${p.sourceIdx}] ➔ [WALLET ${p.targetIdx}] (${p.targetAddress.slice(0, 8)}...): ${p.amountSda.toFixed(4)} SDA`);
  }

  if (!isLive) {
    console.log("\n==========================================================================");
    console.log("ℹ️ DRY-RUN SIMULATION COMPLETE. No actual transactions were sent.");
    console.log("👉 To broadcast live on-chain, re-run with:");
    console.log("   npm run fund:fleet:live");
    console.log("==========================================================================\n");
    return;
  }

  // 3. Live Execution with Resilient Nonce & Gas Handling
  console.log("\n🚨 BROADCASTING ON-CHAIN FUNDING TRANSACTIONS...\n");
  let totalSent = 0.0;
  let successCount = 0;

  for (let i = 0; i < fundingPlan.length; i++) {
    const item = fundingPlan[i];
    const sourceWallet = allWallets[item.sourceIdx].signer;
    const targetAddress = item.targetAddress;
    const valueWei = ethers.parseEther(item.amountSda.toFixed(18));

    console.log(`[${i + 1}/${fundingPlan.length}] Sending ${item.amountSda.toFixed(4)} SDA from Wallet ${item.sourceIdx} to Wallet ${item.targetIdx}...`);

    let transferSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const gasPrice = await getSafeGasPrice(attempt === 1 ? 130n : attempt === 2 ? 150n : 180n);
        const nonce = await getFreshCleanNonce(sourceWallet.address);

        const tx = await sourceWallet.sendTransaction({
          to: targetAddress,
          value: valueWei,
          gasLimit: 25000n,
          gasPrice,
          nonce
        });

        console.log(`   Tx Broadcast: ${tx.hash}`);
        const rc = await tx.wait(1);
        console.log(`   ✅ Confirmed in block ${rc.blockNumber}!`);
        totalSent += item.amountSda;
        successCount++;
        transferSuccess = true;
        await sleep(1200);
        break;
      } catch (err) {
        console.warn(`   ⚠️ Attempt ${attempt} failed: ${err.message.slice(0, 60)}... Retrying with higher gas & clean nonce...`);
        await sleep(2000);
      }
    }

    if (!transferSuccess) {
      console.error(`   ❌ Failed sending funds to Wallet ${item.targetIdx} after 3 attempts.`);
    }
  }

  // 4. Final Report
  console.log("\n==========================================================================");
  console.log("🏁 FUNDING COMPLETE! VERIFIED FINAL BALANCES:");
  console.log("==========================================================================");
  for (const idx of allIndices) {
    const w = allWallets[idx];
    const bal = await provider.getBalance(w.address);
    const tag = idx <= 5 ? "SOURCE" : "TARGET";
    console.log(`   • [WALLET ${idx.toString().padStart(2, " ")} (${tag})] ${w.address} | Native: ${Number(ethers.formatEther(bal)).toFixed(4)} SDA`);
  }
  console.log(`\n💰 Total SDA Distributed: ${totalSent.toFixed(4)} SDA across ${successCount} transfers.`);
  console.log("==========================================================================\n");
}

fundFleetWallets().catch(console.error);
