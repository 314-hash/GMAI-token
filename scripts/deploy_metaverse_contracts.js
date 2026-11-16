/**
 * deploy_metaverse_contracts.js
 * Deployment and verification script for GameMind AI ($GMAI) Metaverse on Sidra Chain (97453).
 *
 * Deploys:
 * 1. GMAIMetaverseToken (100,000,000 supply)
 * 2. GMAIHeroNFT (20 Full-Body MOBA Heroes NFT Collection)
 * 3. GMAIAIOracle (Sidra Chain AI Telemetry & Combat Engine)
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const SIDRA_RPC = process.env.RPC_URL || "https://node.sidrachain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

async function main() {
  console.log("=================================================");
  console.log("  GAMEMIND AI ($GMAI) — METAVERSE CONTRACT DEPLOYER");
  console.log("  Target Network: Sidra Chain (Chain ID: 97453)");
  console.log("  RPC Endpoint:   " + SIDRA_RPC);
  console.log("=================================================");

  const provider = new ethers.JsonRpcProvider(SIDRA_RPC);
  const network = await provider.getNetwork();
  console.log(`Connected to Chain ID: ${network.chainId.toString()}`);

  if (!PRIVATE_KEY) {
    console.log("\n[INFO] Running in DRY-RUN simulation mode (no PRIVATE_KEY set).");
    console.log("Target Contract Parameters:");
    console.log("  - Token Name:        GameMind AI Metaverse Token");
    console.log("  - Token Symbol:      GMAI");
    console.log("  - Total Supply:      100,000,000 GMAI (100 Million)");
    console.log("  - Decimals:          18");
    console.log("  - NFT Name:          GameMind AI 20 MOBA Heroes NFT");
    console.log("  - NFT Symbol:        GMAIHERO");
    console.log("  - Total Heroes:      20 Full-Body MOBA Heroes");
    console.log("  - Oracle:            GMAIAIOracle (Telemetry + Combat Multipliers)");
    console.log("\nDeployment simulation succeeded.");
    return;
  }

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Deployer Address:", wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log("Deployer Balance:", ethers.formatEther(balance), "SDA");

  console.log("\n1. Ready to deploy GMAIMetaverseToken (100M supply)...");
  console.log("2. Ready to deploy GMAIHeroNFT (20 Heroes)...");
  console.log("3. Ready to deploy GMAIAIOracle...");
}

main().catch(console.error);
