import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: 97453 });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const rawKeys = {};
for (let i = 1; i <= 50; i++) {
  const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
  if (pk) rawKeys[`wallet${i}`] = pk;
}

async function main() {
  const args = process.argv.slice(2);
  const targetWalletArg = args.find((a) => a.startsWith("--wallet="))?.split("=")[1];
  const autoClear = args.includes("--clear") || args.includes("--fix");

  console.log("==========================================================================");
  console.log("🛠️  BANDIQ / GMAI FLEET MEMPOOL & NONCE DIAGNOSTIC / UNSTICK TOOL");
  console.log("==========================================================================");
  console.log(`RPC URL        : ${RPC_URL}`);
  console.log(`Target Wallet  : ${targetWalletArg || "All Fleet Wallets"}`);
  console.log(`Auto-Clear Mode: ${autoClear ? "🚨 ACTIVE (will send replacement txs if stuck)" : "🔍 CHECK ONLY (pass --clear to auto-fix)"}`);
  console.log("==========================================================================\n");

  const feeData = await provider.getFeeData();
  const currentGasPrice = feeData.gasPrice || 3000000000n;
  const clearGasPrice = (currentGasPrice * 130n) / 100n > 4000000000n ? (currentGasPrice * 130n) / 100n : 4500000000n; // 4.5 Gwei min for speedups

  console.log(`Current Network Gas Price: ${ethers.formatUnits(currentGasPrice, "gwei")} Gwei`);
  console.log(`Replacement Gas Price    : ${ethers.formatUnits(clearGasPrice, "gwei")} Gwei\n`);

  for (const [key, pk] of Object.entries(rawKeys)) {
    if (targetWalletArg && key !== targetWalletArg && !pk?.toLowerCase().includes(targetWalletArg.toLowerCase())) {
      continue;
    }
    if (!pk) continue;

    const formattedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const wallet = new ethers.Wallet(formattedPk, provider);
    const address = wallet.address;

    const [bal, latestNonce, pendingNonce] = await Promise.all([
      provider.getBalance(address),
      provider.getTransactionCount(address, "latest"),
      provider.getTransactionCount(address, "pending")
    ]);

    const sdaBal = ethers.formatEther(bal);
    const gap = pendingNonce - latestNonce;

    console.log(`📌 [${key.toUpperCase()}] ${address}`);
    console.log(`   Balance      : ${Number(sdaBal).toFixed(4)} SDA`);
    console.log(`   Latest Nonce : ${latestNonce} (mined)`);
    console.log(`   Pending Nonce: ${pendingNonce} (mempool)`);

    if (gap > 0) {
      console.log(`   ⚠️  STATUS: ${gap} TRANSACTION(S) STUCK IN MEMPOOL!`);
      if (autoClear) {
        console.log(`   🚨 Clearing ${gap} stuck nonces (${latestNonce} -> ${pendingNonce - 1})...`);
        for (let n = latestNonce; n < pendingNonce; n++) {
          try {
            const tx = await wallet.sendTransaction({
              to: address,
              value: 0n,
              nonce: n,
              gasLimit: 25000n,
              gasPrice: clearGasPrice
            });
            console.log(`      ✅ Replacement tx sent for nonce ${n}: ${tx.hash.slice(0, 18)}...`);
          } catch (e) {
            console.warn(`      ❌ Nonce ${n} error: ${e.message}`);
          }
        }
        console.log(`   ⏳ Waiting for block confirmation...`);
        let synced = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));
          const [newL, newP] = await Promise.all([
            provider.getTransactionCount(address, "latest"),
            provider.getTransactionCount(address, "pending")
          ]);
          if (newL === newP) {
            console.log(`   🎉 [${key.toUpperCase()}] FULLY SYNCHRONIZED! Clean Nonce: ${newL}\n`);
            synced = true;
            break;
          }
        }
        if (!synced) {
          console.log(`   ⏳ Still waiting for confirmations. Run again in a few seconds.\n`);
        }
      } else {
        console.log(`   💡 Tip: Run 'node scripts/unstick_wallet.js --wallet=${key} --clear' to fix immediately.\n`);
      }
    } else {
      console.log(`   ✅ STATUS: HEALTHY & SYNCHRONIZED (Ready to transact)\n`);
    }
  }

  console.log("==========================================================================");
  console.log("Diagnostic complete.");
  console.log("==========================================================================");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
