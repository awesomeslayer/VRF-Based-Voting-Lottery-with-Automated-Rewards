const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    const contractAddress = process.env.CONTRACT_ADDRESS;

    const contract = await ethers.getContractAt("VotingLottery", contractAddress);

    const tx = await contract.enterLottery(1, {
        value: ethers.parseEther(process.env.ENTRY_FEE)
    });

    await tx.wait();

    console.log("Entered lottery!");
}

main().catch(console.error);