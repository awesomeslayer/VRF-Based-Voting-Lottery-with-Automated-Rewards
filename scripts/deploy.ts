import { ethers } from "hardhat";

async function main() {
  const vrfCoordinator = "0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B";
  
  const subId = "112461650924573506797826670689333574977044810759906456739730321273531230346292"; 
  
  const keyHash = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";
  
  const entryFee = ethers.parseEther("0.01"); 
  const durationInMinutes = 1; 

  console.log("Deploying VotingLottery...");

  const lottery = await ethers.deployContract("VotingLottery", [
    vrfCoordinator,
    subId,
    keyHash,
    entryFee,
    durationInMinutes
  ]);

  await lottery.waitForDeployment();
  
  console.log(`VotingLottery deployed to: ${lottery.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});