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

const WSDA_ADDR = process.env.WSDA_ADDRESS || "0xE4095a910209D7BE03B55D02F40d4554B1666182";
const SAFE_GAS_PRICE = 2500000000n; // 2.5 Gwei

const WSDA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256)"
];

async function waitForCleanNonce(address, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(address, "latest"),
      provider.getTransactionCount(address, "pending")
    ]);
    if (latest === pending) return latest;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return await provider.getTransactionCount(address, "latest");
}

export async function unwrapAllWallets() {
  console.log("==========================================================================");
  console.log("🔄 FLEET WSDA -> NATIVE SDA AUTO-CONVERTER / UNWRAPPER");
  console.log("==========================================================================");

  const rawKeys = {};
  for (let i = 1; i <= 50; i++) {
    const pk = process.env[`PRIVATE_KEY_${i}`] || (i === 1 ? process.env.PRIVATE_KEY : null);
    if (pk) rawKeys[`wallet${i}`] = pk;
  }

  const wsdaContract = new ethers.Contract(WSDA_ADDR, WSDA_ABI, provider);
  let totalUnwrappedSda = 0n;

  for (const [key, pk] of Object.entries(rawKeys)) {
    if (!pk) continue;
    const formattedPk = pk.startsWith("0x") ? pk : `0x${pk}`;
    const wallet = new ethers.Wallet(formattedPk, provider);
    const wsdaWithSigner = wsdaContract.connect(wallet);

    const [nativeBal, wsdaBal] = await Promise.all([
      provider.getBalance(wallet.address),
      wsdaContract.balanceOf(wallet.address)
    ]);

    console.log(`\n• [${key.toUpperCase()}] ${wallet.address}`);
    console.log(`   Native Balance : ${Number(ethers.formatEther(nativeBal)).toFixed(4)} SDA`);
    console.log(`   WSDA Balance   : ${Number(ethers.formatEther(wsdaBal)).toFixed(4)} WSDA`);

    if (wsdaBal > 0n) {
      console.log(`   ⚡ Swapping ${ethers.formatEther(wsdaBal)} WSDA -> Native SDA token...`);
      try {
        const freshBal = await wsdaContract.balanceOf(wallet.address);
        if (freshBal === 0n) {
          console.log(`   ℹ️ Balance already zero on-chain.`);
          continue;
        }
        const nonce = await waitForCleanNonce(wallet.address);
        const tx = await wsdaWithSigner.withdraw(freshBal, {
          gasLimit: 85000n,
          gasPrice: SAFE_GAS_PRICE,
          nonce
        });
        console.log(`   Tx Broadcast: ${tx.hash}`);
        const receipt = await tx.wait(1);
        const newNative = await provider.getBalance(wallet.address);
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);
        console.log(`   💰 New Native Balance: ${Number(ethers.formatEther(newNative)).toFixed(4)} SDA (0.0 WSDA remaining)`);
        totalUnwrappedSda += freshBal;
      } catch (err) {
        console.error(`   ❌ Failed unwrapping for ${key}:`, err.message);
      }
    } else {
      console.log(`   ✅ Already 100% Native SDA (0 WSDA).`);
    }
  }

  console.log("\n==========================================================================");
  console.log(`🏁 FINISHED: Converted Total of ${ethers.formatEther(totalUnwrappedSda)} WSDA -> Native SDA across fleet!`);
  console.log("==========================================================================");
}

if (process.argv[1] && process.argv[1].endsWith("unwrap_all_wallets.js")) {
  unwrapAllWallets().catch(console.error);
}
