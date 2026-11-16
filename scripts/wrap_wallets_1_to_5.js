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

const ROUTER_ADDR = process.env.ROUTER_ADDRESS || "0x35cAC72Db00e8dAC0e4f7F8A0F53D339E0cC23fb";
const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const GAS_PRICE = 4500000000n;

const WSDA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)"
];

async function main() {
  const targetSda = 50.0;
  const targetWei = ethers.parseEther(targetSda.toString());
  const minGasBufferWei = ethers.parseEther("5.0"); // Keep at least 5 SDA native for gas

  console.log("==========================================================================");
  console.log(`⚡ WRAPPING WALLETS 1 TO 5 UP TO ${targetSda.toFixed(2)} WSDA`);
  console.log("==========================================================================\n");

  for (let i = 1; i <= 5; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (!pk) continue;
    const cleanPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const signer = new ethers.Wallet(cleanPk, provider);
    const wsda = new ethers.Contract(WSDA_ADDR, WSDA_ABI, signer);
    const walletKey = `wallet${i}`;

    try {
      const [nativeBal, wsdaBal, allowance] = await Promise.all([
        provider.getBalance(signer.address),
        wsda.balanceOf(signer.address),
        wsda.allowance(signer.address, ROUTER_ADDR)
      ]);

      console.log(`🔹 [WALLET ${i}] ${signer.address}`);
      console.log(`   Current: Native = ${Number(ethers.formatEther(nativeBal)).toFixed(4)} SDA | WSDA = ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} WSDA`);

      if (wsdaBal < targetWei) {
        const neededWei = targetWei - wsdaBal;
        if (nativeBal >= neededWei + minGasBufferWei) {
          console.log(`   🔒 Acquiring mutex lock for ${walletKey}...`);
          const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
          try {
            console.log(`   ⏳ Wrapping +${ethers.formatEther(neededWei)} SDA -> WSDA with Nonce ${lock.nonce}...`);
            const tx = await wsda.deposit({
              value: neededWei,
              gasLimit: 90000n,
              gasPrice: GAS_PRICE,
              nonce: lock.nonce
            });
            console.log(`   Tx Broadcast: ${tx.hash}`);
            const rc = await tx.wait(1);
            console.log(`   ✅ Confirmed in block ${rc.blockNumber}!`);
          } finally {
            await lock.release();
          }
        } else {
          console.log(`   ⚠️ Insufficient Native SDA to reach ${targetSda} WSDA while retaining 5.0 SDA gas buffer.`);
        }
      } else {
        console.log(`   ✅ Already holds >= ${targetSda.toFixed(2)} WSDA.`);
      }

      // Check router approval
      if (allowance < targetWei) {
        const lock = await acquireWalletLock(walletKey, signer.address, provider, 5000);
        try {
          const appTx = await wsda.approve(ROUTER_ADDR, ethers.MaxUint256, {
            gasLimit: 75000n,
            gasPrice: GAS_PRICE,
            nonce: lock.nonce
          });
          await appTx.wait(1);
          console.log(`   🔓 Router Max-Approved for WSDA.`);
        } finally {
          await lock.release();
        }
      }

      const [afterNative, afterWsda] = await Promise.all([
        provider.getBalance(signer.address),
        wsda.balanceOf(signer.address)
      ]);
      console.log(`   Updated: Native = ${Number(ethers.formatEther(afterNative)).toFixed(4)} SDA | WSDA = ${Number(ethers.formatEther(afterWsda)).toFixed(4)} WSDA\n`);
    } catch (err) {
      console.error(`   ❌ [WALLET ${i}] Error: ${err.message}\n`);
    }
  }

  console.log("==========================================================================");
  console.log("🏁 WRAPPING COMPLETE FOR WALLETS 1 TO 5");
  console.log("==========================================================================");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
