import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { VotingLottery, VRFCoordinatorV2_5Mock } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("VotingLottery", function () {
  let lottery: VotingLottery;
  let vrfCoordinator: VRFCoordinatorV2_5Mock;
  let owner: HardhatEthersSigner;
  let player1: HardhatEthersSigner;
  let player2: HardhatEthersSigner;
  let player3: HardhatEthersSigner;
  let player4: HardhatEthersSigner;
  let subscriptionId: bigint;

  const ENTRY_FEE = ethers.parseEther("0.01");
  const DURATION_MINUTES = 5;
  const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

  async function deployFixture() {
    [owner, player1, player2, player3, player4] = await ethers.getSigners();

    const VRFCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    vrfCoordinator = await VRFCoordinator.deploy(
      ethers.parseEther("0.1"),  // base fee
      1000000000,                // gas price (wei per gas)
      4000000000000000n           // wei per LINK
    );
    await vrfCoordinator.waitForDeployment();

    const tx = await vrfCoordinator.createSubscription();
    const receipt = await tx.wait();
    const subCreatedEvent = receipt!.logs.find(
      (log) => vrfCoordinator.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "SubscriptionCreated"
    );
    subscriptionId = vrfCoordinator.interface.parseLog({
      topics: subCreatedEvent!.topics as string[],
      data: subCreatedEvent!.data,
    })!.args[0];

    await vrfCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    const Lottery = await ethers.getContractFactory("VotingLottery");
    lottery = await Lottery.deploy(
      await vrfCoordinator.getAddress(),
      subscriptionId,
      KEY_HASH,
      ENTRY_FEE,
      DURATION_MINUTES
    );
    await lottery.waitForDeployment();

    await vrfCoordinator.addConsumer(subscriptionId, await lottery.getAddress());

    return { lottery, vrfCoordinator, owner, player1, player2, player3, player4, subscriptionId };
  }

  beforeEach(async function () {
    ({ lottery, vrfCoordinator, owner, player1, player2, player3, player4, subscriptionId } =
      await deployFixture());
  });

  describe("Deployment", function () {
    it("should initialize with correct state", async function () {
      expect(await lottery.lotteryState()).to.equal(0); // OPEN
      expect(await lottery.entryFee()).to.equal(ENTRY_FEE);
      expect(await lottery.isDrawn()).to.equal(false);
    });

    it("should set correct lottery end time", async function () {
      const endTime = await lottery.lotteryEndTime();
      const currentBlock = await ethers.provider.getBlock("latest");
      expect(endTime).to.be.closeTo(
        BigInt(currentBlock!.timestamp) + BigInt(DURATION_MINUTES * 60),
        2n
      );
    });
  });

  describe("enterLottery", function () {
    it("should allow entry with correct fee and valid option", async function () {
      await expect(lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE }))
        .to.emit(lottery, "LotteryEntered")
        .withArgs(player1.address, 1);
    });

    it("should record voter in the correct option", async function () {
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      const voters = await lottery.getVotersByOption(2);
      expect(voters).to.include(player1.address);
      expect(await lottery.getVoterCount(2)).to.equal(1);
    });

    it("should reject entry with incorrect fee", async function () {
      await expect(
        lottery.connect(player1).enterLottery(1, { value: ethers.parseEther("0.005") })
      ).to.be.revertedWith("Incorrect entry fee");
    });

    it("should reject entry with invalid option (0)", async function () {
      await expect(
        lottery.connect(player1).enterLottery(0, { value: ENTRY_FEE })
      ).to.be.revertedWith("Invalid option. Choose 1, 2, or 3");
    });

    it("should reject entry with invalid option (4)", async function () {
      await expect(
        lottery.connect(player1).enterLottery(4, { value: ENTRY_FEE })
      ).to.be.revertedWith("Invalid option. Choose 1, 2, or 3");
    });

    it("should reject entry after the window closes", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await expect(
        lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE })
      ).to.be.revertedWith("Entry window is closed");
    });

    it("should allow multiple players to enter different options", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });

      expect(await lottery.getVoterCount(1)).to.equal(1);
      expect(await lottery.getVoterCount(2)).to.equal(1);
      expect(await lottery.getVoterCount(3)).to.equal(1);
    });
  });

  describe("triggerDraw", function () {
    it("should revert if entry window is still open", async function () {
      await expect(lottery.triggerDraw()).to.be.revertedWith("Entry window is still open");
    });

    it("should emit DrawRequested after the window closes", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await expect(lottery.triggerDraw()).to.emit(lottery, "DrawRequested");
    });

    it("should change state to CALCULATING", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();
      expect(await lottery.lotteryState()).to.equal(1); // CALCULATING
    });

    it("should revert if called twice", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();
      await expect(lottery.triggerDraw()).to.be.revertedWith("Already drawing or closed");
    });
  });

  describe("fulfillRandomWords — winner exists", function () {
    it("should select a winner and allocate the full pot", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find(
        (log) => {
          try {
            return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested";
          } catch { return false; }
        }
      );
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[],
        data: drawEvent!.data,
      })!.args[0];

      // VRF mock generates deterministic random words from requestId
      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      expect(await lottery.lotteryState()).to.equal(2); // CLOSED
      expect(await lottery.isDrawn()).to.equal(true);

      const winOpt = await lottery.winningOption();
      expect(winOpt).to.be.gte(1).and.lte(3);

      const winnerAddr = await lottery.winner();
      expect(winnerAddr).to.not.equal(ethers.ZeroAddress);

      const prize = await lottery.prizeAmount();
      expect(prize).to.equal(ENTRY_FEE * 3n);
    });

    it("should allow the winner to claim their reward", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(1, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      // Use specific random word so winning option = 1 → (randomWord % 3) + 1 = 1 when randomWord % 3 == 0
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [3n] // 3 % 3 = 0 → option 1; winner index = (3/100) % 3 = 0 → player1
      );

      const winnerAddr = await lottery.winner();
      expect(winnerAddr).to.equal(player1.address);

      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const claimTx = await lottery.connect(player1).claimReward();
      const claimReceipt = await claimTx.wait();
      const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(player1.address);

      expect(balanceAfter).to.equal(balanceBefore + ENTRY_FEE * 3n - gasCost);
    });
  });

  describe("fulfillRandomWords — no voters for winning option (refund)", function () {
    it("should refund all participants when no one voted for the winning option", async function () {
      // Only vote for options 2 and 3, leave option 1 empty
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(3, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      // Force winning option = 1 (no voters): randomWord=3 → (3%3)+1 = 1
      await expect(
        vrfCoordinator.fulfillRandomWordsWithOverride(
          requestId,
          await lottery.getAddress(),
          [3n]
        )
      ).to.emit(lottery, "NoWinnerRefund").withArgs(1, ENTRY_FEE * 2n);

      expect(await lottery.claimableBalances(player1.address)).to.equal(ENTRY_FEE);
      expect(await lottery.claimableBalances(player2.address)).to.equal(ENTRY_FEE);
    });

    it("should allow refunded participants to claim", async function () {
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(3, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId, await lottery.getAddress(), [3n]
      );

      const balBefore = await ethers.provider.getBalance(player1.address);
      const claimTx = await lottery.connect(player1).claimReward();
      const claimReceipt = await claimTx.wait();
      const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(player1.address);

      expect(balAfter).to.equal(balBefore + ENTRY_FEE - gasCost);
    });
  });

  describe("claimReward", function () {
    it("should revert if caller has no rewards", async function () {
      await expect(lottery.connect(player4).claimReward()).to.be.revertedWith("No rewards to claim");
    });

    it("should emit RewardClaimed event", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      // randomWord=0 → (0%3)+1=1; player1 is the only voter for option 1
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId, await lottery.getAddress(), [0n]
      );

      await expect(lottery.connect(player1).claimReward())
        .to.emit(lottery, "RewardClaimed")
        .withArgs(player1.address, ENTRY_FEE);
    });

    it("should not allow double claim", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId, await lottery.getAddress(), [0n]
      );

      await lottery.connect(player1).claimReward();
      await expect(lottery.connect(player1).claimReward()).to.be.revertedWith("No rewards to claim");
    });
  });

  describe("Edge cases", function () {
    it("should not allow entry when lottery is CLOSED", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();

      const drawEvent = receipt!.logs.find((log) => {
        try { return lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "DrawRequested"; }
        catch { return false; }
      });
      const requestId = lottery.interface.parseLog({
        topics: drawEvent!.topics as string[], data: drawEvent!.data,
      })!.args[0];

      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      await expect(
        lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE })
      ).to.be.revertedWith("Lottery is not open");
    });

    it("should accumulate balance from multiple entries", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });
      await lottery.connect(player4).enterLottery(1, { value: ENTRY_FEE });

      const balance = await ethers.provider.getBalance(await lottery.getAddress());
      expect(balance).to.equal(ENTRY_FEE * 4n);
    });
  });
});
