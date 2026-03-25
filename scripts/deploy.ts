import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
require("dotenv").config();

async function main() {
  const subId = process.env.VRF_SUB_ID || "YOUR_SUB_ID";
  const vrfCoordinator = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B"; // Sepolia
  const keyHash = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

  console.log("Deploying VotingLotteryMultiRound...");
  const lottery = await ethers.deployContract("VotingLotteryMultiRound", [
    vrfCoordinator, subId, keyHash
  ]);

  await lottery.waitForDeployment();
  const address = await lottery.getAddress();
  console.log(`Contract deployed to: ${address}`);

  // Copy ABI to frontend
  const artifactPath = path.join(__dirname, "../artifacts/contracts/VotingLotteryMultiRound.sol/VotingLotteryMultiRound.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const frontendAbiPath = path.join(__dirname, "../frontend/abi.json");
  fs.writeFileSync(frontendAbiPath, JSON.stringify(artifact.abi, null, 2));
  console.log("ABI copied to frontend/abi.json");

  // Start a first round: 0.01 ETH entry, 10 minutes, 3 options, split among all winners
  console.log("Starting Round #1: 0.01 ETH, 10 min, 3 options, split mode...");
  const tx = await lottery.startNewRound(
    ethers.parseEther("0.01"),
    10,
    3,
    true
  );
  await tx.wait();
  console.log("Round #1 is LIVE!");

  fs.appendFileSync(".env", `\nCONTRACT_ADDRESS="${address}"`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
