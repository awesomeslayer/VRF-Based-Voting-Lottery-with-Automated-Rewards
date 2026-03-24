// scripts/deploy.ts
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
require("dotenv").config();

async function main() {
  const vrfCoordinator = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B";

  // ── REPLACE WITH YOUR SUBSCRIPTION ID ──
  const subId = "71976383013050626898523674797117633078175280592919769013973987426031529380609";

  const keyHash = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

  if (!process.env.ENTRY_FEE) {
    throw new Error("ENTRY_FEE is not set in .env");
  }

  const entryFee = ethers.parseEther(process.env.ENTRY_FEE);
  const durationInMinutes = Number(process.env.DURATION_MINUTES);
  const numOptions = Number(process.env.NUM_OPTIONS);
  const splitAmongAllWinners = process.env.SPLIT_AMONG_ALL === "true";

  console.log("Deploying FlexibleVotingLottery...");
  console.log(`  Options: ${numOptions}`);
  console.log(`  Duration: ${durationInMinutes} minutes`);
  console.log(`  Entry Fee: ${ethers.formatEther(entryFee)} ETH`);
  console.log(`  Split mode: ${splitAmongAllWinners ? "Split among all winners" : "Single random winner"}`);

  const lottery = await ethers.deployContract("FlexibleVotingLottery", [
    vrfCoordinator,
    subId,
    keyHash,
    entryFee,
    durationInMinutes,
    numOptions,
    splitAmongAllWinners,
  ]);

  await lottery.waitForDeployment();
  const address = lottery.target as string;

  console.log(`\n✅ FlexibleVotingLottery deployed to: ${address}`);

  // Save to .env
  const envPath = path.resolve(__dirname, "../.env");
  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  }

  if (envContent.includes("CONTRACT_ADDRESS=")) {
    envContent = envContent.replace(/CONTRACT_ADDRESS=.*/g, `CONTRACT_ADDRESS="${address}"`);
  } else {
    envContent += `\nCONTRACT_ADDRESS="${address}"\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log("✅ CONTRACT_ADDRESS saved to .env");

  // Save ABI for frontend
  const artifactPath = path.resolve(
    __dirname,
    "../artifacts/contracts/FlexibleVotingLottery.sol/FlexibleVotingLottery.json"
  );
  const frontendAbiPath = path.resolve(__dirname, "../frontend/abi.json");

  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
    fs.writeFileSync(frontendAbiPath, JSON.stringify(artifact.abi, null, 2));
    console.log("✅ ABI saved to frontend/abi.json");
  }

  console.log("\n⚠️  IMPORTANT: Add this contract as a consumer in your Chainlink VRF Subscription!");
  console.log(`   Contract: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});