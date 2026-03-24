import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
require("dotenv").config();

async function main() {
  const vrfCoordinator = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B"; // Sepolia
  const subId = "ТВОЙ_SUB_ID"; 
  const keyHash = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

  const lottery = await ethers.deployContract("VotingLotteryMultiRound", [
    vrfCoordinator, subId, keyHash
  ]);

  await lottery.waitForDeployment();
  const address = await lottery.getAddress();
  console.log(`🚀 Contract deployed to: ${address}`);

  // Сразу запускаем 1-й раунд: 0.01 ETH, 10 минут, 3 варианта, делим на всех (true)
  console.log("🏁 Starting Round #1...");
  const tx = await lottery.startNewRound(
    ethers.parseEther("0.01"), 
    10, 
    3, 
    true
  );
  await tx.wait();
  console.log("✅ Round #1 is LIVE!");

  // Сохраняем адрес в .env
  fs.appendFileSync(".env", `\nCONTRACT_ADDRESS="${address}"`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });