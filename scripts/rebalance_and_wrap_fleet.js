import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { acquireWalletLock } from "./wallet_helper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL || "https://rpc.sidrachain.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "97453");
const sidraNetwork = ethers.Network.from({ name: "sidra", chainId: CHAIN_ID });
const provider = new ethers.JsonRpcProvider(RPC_URL, sidraNetwork, { staticNetwork: sidraNetwork });

const WSDA_ADDR = ethers.getAddress(process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182");
const ROUTER_ADDR = ethers.getAddress(process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb");

const WSDA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)"
];

const GAS_PRICE = 4000000000n; // 4 gwei

// Wrap targets requested by user:
// Wallets 1-5: 100 SDA
// Wallets 6-10: 10 SDA
// Wallets 11-15: 5 SDA
const TARGETS = {
  wallet1: 100.0,
  wallet2: 100.0,
  wallet3: 100.0,
  wallet4: 100.0,
  wallet5: 100.0,
  wallet6: 10.0,
  wallet7: 10.0,
  wallet8: 10.0,
  wallet9: 10.0,
  wallet10: 10.0,
  wallet11: 5.0,
  wallet12: 5.0,
  wallet13: 5.0,
  wallet14: 5.0,
  wallet15: 5.0
};

const GAS_BUFFER = 1.0; // Keep at least 1.0 SDA in Native for gas

async function main() {
  console.log("==========================================================================");
  console.log("🔄 FLEET WORKING CAPITAL REBALANCE & WSDA WRAP ENGINE");
  console.log("==========================================================================");
  console.log("Target Allocations:");
  console.log("   • Wallets 1 to 5  : 100 WSDA working capital each");
  console.log("   • Wallets 6 to 10 : 10 WSDA working capital each");
  console.log("   • Wallets 11 to 15: 5 WSDA working capital each");
  console.log("==========================================================================\n");

  const wallets = {};
  for (let i = 1; i <= 15; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!pk) throw new Error(`Missing PRIVATE_KEY_${i}`);
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    wallets[`wallet${i}`] = new ethers.Wallet(cleanPk, provider);
  }

  const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, provider);

  // 1. Check current status across all 15 wallets
  console.log("📊 Initial Balances:");
  const status = {};
  for (let i = 1; i <= 15; i++) {
    const k = `wallet${i}`;
    const signer = wallets[k];
    const nativeBal = await provider.getBalance(signer.address);
    const wsdaBal = await wsda.balanceOf(signer.address);
    const targetWsda = TARGETS[k];

    status[k] = {
      address: signer.address,
      native: Number(ethers.formatEther(nativeBal)),
      nativeWei: nativeBal,
      wsda: Number(ethers.formatEther(wsdaBal)),
      wsdaWei: wsdaBal,
      targetWsda
    };

    console.log(`   [${k.padEnd(8)}] Native: ${status[k].native.toFixed(4)} SDA | WSDA: ${status[k].wsda.toFixed(4)} (Target WSDA: ${targetWsda})`);
  }

  // 2. Fund any wallet that lacks enough Native SDA to wrap target + GAS_BUFFER
  // Primary funder: Wallet 1 (has 350+ Native SDA)
  const funderKey = "wallet1";
  const funderSigner = wallets[funderKey];

  console.log(`\n⛽ Checking Native SDA sufficiency for wrapping (Gas buffer: ${GAS_BUFFER} SDA)...`);
  for (let i = 2; i <= 15; i++) {
    const k = `wallet${i}`;
    const info = status[k];
    const neededWsda = Math.max(0, info.targetWsda - info.wsda);

    if (neededWsda > 0) {
      const requiredNative = neededWsda + GAS_BUFFER;
      if (info.native < requiredNative) {
        const deficit = requiredNative - info.native;
        const sendAmountSda = Math.ceil(deficit * 10) / 10 + 0.5; // round up with slight safety margin
        console.log(`   💸 [${k}] Deficit detected! Native ${info.native.toFixed(2)} SDA < ${requiredNative.toFixed(2)} SDA needed.`);
        console.log(`      Transferring +${sendAmountSda.toFixed(2)} SDA from ${funderKey} ➔ ${k}...`);

        const lockFunder = await acquireWalletLock(funderKey, funderSigner.address, provider, 5000);
        try {
          const freshNonce = await provider.getTransactionCount(funderSigner.address, "latest");
          const tx = await funderSigner.sendTransaction({
            to: info.address,
            value: ethers.parseEther(sendAmountSda.toFixed(18)),
            gasLimit: 30000n,
            gasPrice: 5000000000n,
            nonce: freshNonce
          });
          console.log(`      🚀 Tx: ${tx.hash}`);
          await tx.wait(1);
          console.log(`      ✅ Transfer confirmed in block!`);
          await new Promise(r => setTimeout(r, 3000));
        } finally {
          await lockFunder.release();
        }

        // Update local state
        info.native += sendAmountSda;
      }
    }
  }

  // 3. Execute WSDA wrap for each wallet to hit exact target
  console.log("\n📦 Wrapping Native SDA into WSDA working capital...");
  for (let i = 1; i <= 15; i++) {
    const k = `wallet${i}`;
    const signer = wallets[k];
    const curWsda = Number(ethers.formatEther(await wsda.balanceOf(signer.address)));
    const targetWsda = TARGETS[k];
    const diff = targetWsda - curWsda;

    if (diff > 0.05) {
      const wrapWei = ethers.parseEther(diff.toFixed(18));
      console.log(`\n⚡ [${k}] Wrapping +${diff.toFixed(4)} SDA ➔ WSDA (to reach ${targetWsda} WSDA)...`);

      const lock = await acquireWalletLock(k, signer.address, provider, 5000);
      try {
        const wsdaWithSigner = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
        const wrapTx = await wsdaWithSigner.deposit({
          value: wrapWei,
          gasLimit: 90000n,
          gasPrice: GAS_PRICE,
          nonce: lock.nonce
        });
        console.log(`   🚀 Tx: ${wrapTx.hash}`);
        const receipt = await wrapTx.wait(1);
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);

        // Check and ensure Router Approval
        const allowance = await wsda.allowance(signer.address, ROUTER_ADDR);
        if (allowance < ethers.parseEther("1000000")) {
          console.log(`   🔓 Approving router for WSDA...`);
          const approveTx = await wsdaWithSigner.approve(ROUTER_ADDR, ethers.MaxUint256, {
            gasLimit: 60000n,
            gasPrice: GAS_PRICE,
            nonce: lock.nonce + 1
          });
          await approveTx.wait(1);
          console.log(`   ✅ Router approved for WSDA!`);
        }
      } finally {
        await lock.release();
      }
    } else {
      console.log(`   ✅ [${k}] Already has ${curWsda.toFixed(2)} WSDA (Target: ${targetWsda}). No wrap needed.`);
    }
  }

  // 4. Final Fleet Verification
  console.log("\n==========================================================================");
  console.log("🏁 FINAL FLEET WORKING CAPITAL VERIFICATION");
  console.log("==========================================================================");
  for (let i = 1; i <= 15; i++) {
    const k = `wallet${i}`;
    const signer = wallets[k];
    const nativeBal = await provider.getBalance(signer.address);
    const wsdaBal = await wsda.balanceOf(signer.address);
    console.log(`   • ${k.padEnd(8)}: WSDA = ${Number(ethers.formatEther(wsdaBal)).toFixed(2).padStart(6)} | Native = ${Number(ethers.formatEther(nativeBal)).toFixed(2).padStart(6)} SDA`);
  }
  console.log("==========================================================================\n");
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
