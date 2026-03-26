import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { VotingLotteryMultiRound, VRFCoordinatorV2_5Mock } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("VotingLotteryMultiRound", function () {
  let lottery: VotingLotteryMultiRound;
  let vrfCoordinator: VRFCoordinatorV2_5Mock;
  let owner: HardhatEthersSigner;
  let player1: HardhatEthersSigner;
  let player2: HardhatEthersSigner;
  let player3: HardhatEthersSigner;
  let player4: HardhatEthersSigner;
  let subscriptionId: bigint;

  const ENTRY_FEE = ethers.parseEther("0.01");
  const DURATION_MINUTES = 5;
  const NUM_OPTIONS = 3;
  const KEY_HASH = "0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae";

  async function deployFixture() {
    [owner, player1, player2, player3, player4] = await ethers.getSigners();

    const VRFCoordinator = await ethers.getContractFactory("VRFCoordinatorV2_5Mock");
    vrfCoordinator = await VRFCoordinator.deploy(
      ethers.parseEther("0.1"),
      1000000000,
      4000000000000000n
    );
    await vrfCoordinator.waitForDeployment();

    const tx = await vrfCoordinator.createSubscription();
    const receipt = await tx.wait();
    const subCreatedEvent = receipt!.logs.find(
      (log) =>
        vrfCoordinator.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        })?.name === "SubscriptionCreated"
    );
    subscriptionId = vrfCoordinator.interface.parseLog({
      topics: subCreatedEvent!.topics as string[],
      data: subCreatedEvent!.data,
    })!.args[0];

    await vrfCoordinator.fundSubscription(subscriptionId, ethers.parseEther("1000"));

    const Lottery = await ethers.getContractFactory("VotingLotteryMultiRound");
    lottery = await Lottery.deploy(
      await vrfCoordinator.getAddress(),
      subscriptionId,
      KEY_HASH
    );
    await lottery.waitForDeployment();

    await vrfCoordinator.addConsumer(subscriptionId, await lottery.getAddress());

    return { lottery, vrfCoordinator, owner, player1, player2, player3, player4, subscriptionId };
  }

  async function startRound(split: boolean = false) {
    await lottery.startNewRound(ENTRY_FEE, DURATION_MINUTES, NUM_OPTIONS, split);
  }

  function getRequestIdFromReceipt(receipt: any): bigint {
    const drawEvent = receipt!.logs.find((log: any) => {
      try {
        return (
          lottery.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name ===
          "DrawRequested"
        );
      } catch {
        return false;
      }
    });
    return lottery.interface.parseLog({
      topics: drawEvent!.topics as string[],
      data: drawEvent!.data,
    })!.args[1]; // args[0] = roundId, args[1] = requestId
  }

  beforeEach(async function () {
    ({ lottery, vrfCoordinator, owner, player1, player2, player3, player4, subscriptionId } =
      await deployFixture());
  });

  // ─── Deployment ──────────────────────────────────────────────────

  describe("Deployment", function () {
    it("should initialize with roundId 0 (no active round)", async function () {
      expect(await lottery.currentRoundId()).to.equal(0);
    });

    it("should store correct VRF configuration", async function () {
      expect(await lottery.keyHash()).to.equal(KEY_HASH);
      expect(await lottery.s_subscriptionId()).to.equal(subscriptionId);
      expect(await lottery.callbackGasLimit()).to.equal(250000);
      expect(await lottery.requestConfirmations()).to.equal(3);
      expect(await lottery.numWords()).to.equal(2);
    });
  });

  // ─── Round Management ────────────────────────────────────────────

  describe("startNewRound", function () {
    it("should create round 1 with correct parameters", async function () {
      await expect(
        lottery.startNewRound(ENTRY_FEE, DURATION_MINUTES, NUM_OPTIONS, true)
      ).to.emit(lottery, "RoundStarted");

      const round = await lottery.getCurrentRoundData();
      expect(round.roundId).to.equal(1);
      expect(round.entryFee).to.equal(ENTRY_FEE);
      expect(round.numOptions).to.equal(NUM_OPTIONS);
      expect(round.splitAmongAllWinners).to.equal(true);
      expect(round.state).to.equal(0); // OPEN
    });

    it("should revert if called by non-owner", async function () {
      await expect(
        lottery.connect(player1).startNewRound(ENTRY_FEE, DURATION_MINUTES, NUM_OPTIONS, false)
      ).to.be.revertedWith("Only callable by owner");
    });

    it("should revert if numOptions < 2", async function () {
      await expect(
        lottery.startNewRound(ENTRY_FEE, DURATION_MINUTES, 1, false)
      ).to.be.revertedWith("Need >= 2 options");
    });

    it("should revert if duration is 0", async function () {
      await expect(
        lottery.startNewRound(ENTRY_FEE, 0, NUM_OPTIONS, false)
      ).to.be.revertedWith("Duration must be > 0");
    });

    it("should revert if previous round is still open with entries", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await expect(startRound()).to.be.revertedWith("Finish current round first");
    });

    it("should auto-close an expired empty round", async function () {
      await startRound();
      await time.increase(DURATION_MINUTES * 60 + 1);

      await expect(
        lottery.startNewRound(ENTRY_FEE, DURATION_MINUTES, NUM_OPTIONS, false)
      ).to.emit(lottery, "RoundClosedEmpty");

      expect(await lottery.currentRoundId()).to.equal(2);
    });
  });

  // ─── Enter Lottery ───────────────────────────────────────────────

  describe("enterLottery", function () {
    beforeEach(async function () {
      await startRound();
    });

    it("should allow entry with correct fee and valid option", async function () {
      await expect(lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE }))
        .to.emit(lottery, "LotteryEntered")
        .withArgs(1, player1.address, 1);
    });

    it("should record voter in the correct option", async function () {
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      const voters = await lottery.getVoters(1, 2);
      expect(voters).to.include(player1.address);
      expect(await lottery.getVoterCount(1, 2)).to.equal(1);
    });

    it("should track player option", async function () {
      await lottery.connect(player1).enterLottery(3, { value: ENTRY_FEE });
      expect(await lottery.getPlayerOption(1, player1.address)).to.equal(3);
    });

    it("should reject entry with incorrect fee", async function () {
      await expect(
        lottery.connect(player1).enterLottery(1, { value: ethers.parseEther("0.005") })
      ).to.be.revertedWith("Wrong fee");
    });

    it("should reject entry with option 0", async function () {
      await expect(
        lottery.connect(player1).enterLottery(0, { value: ENTRY_FEE })
      ).to.be.revertedWith("Invalid option");
    });

    it("should reject entry with option exceeding numOptions", async function () {
      await expect(
        lottery.connect(player1).enterLottery(4, { value: ENTRY_FEE })
      ).to.be.revertedWith("Invalid option");
    });

    it("should reject duplicate entry from same address", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await expect(
        lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE })
      ).to.be.revertedWith("Already voted");
    });

    it("should reject entry after the window closes", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await expect(
        lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE })
      ).to.be.revertedWith("Time's up");
    });

    it("should allow multiple players to enter different options", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });

      expect(await lottery.getVoterCount(1, 1)).to.equal(1);
      expect(await lottery.getVoterCount(1, 2)).to.equal(1);
      expect(await lottery.getVoterCount(1, 3)).to.equal(1);

      const round = await lottery.getCurrentRoundData();
      expect(round.totalEntries).to.equal(3);
      expect(round.totalPot).to.equal(ENTRY_FEE * 3n);
    });
  });

  // ─── Trigger Draw ────────────────────────────────────────────────

  describe("triggerDraw", function () {
    beforeEach(async function () {
      await startRound();
    });

    it("should revert if entry window is still open", async function () {
      await expect(lottery.triggerDraw()).to.be.revertedWith("Wait for end time");
    });

    it("should close round with no entries and emit RoundClosedEmpty", async function () {
      await time.increase(DURATION_MINUTES * 60 + 1);
      await expect(lottery.triggerDraw())
        .to.emit(lottery, "RoundClosedEmpty")
        .withArgs(1);

      const round = await lottery.getCurrentRoundData();
      expect(round.state).to.equal(2); // CLOSED
    });

    it("should emit DrawRequested and switch to CALCULATING with entries", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);

      await expect(lottery.triggerDraw()).to.emit(lottery, "DrawRequested");

      const round = await lottery.getCurrentRoundData();
      expect(round.state).to.equal(1); // CALCULATING
    });

    it("should revert if called twice", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();
      await expect(lottery.triggerDraw()).to.be.revertedWith("Not open");
    });
  });

  // ─── VRF Callback: Single Winner Mode ────────────────────────────

  describe("fulfillRandomWords — single winner mode", function () {
    beforeEach(async function () {
      await startRound(false); // single winner
    });

    it("should select a winning option and single winner", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      const round = await lottery.getCurrentRoundData();
      expect(round.state).to.equal(2); // CLOSED
      expect(round.isDrawn).to.equal(true);
      expect(round.winningOption).to.be.gte(1).and.lte(3);
    });

    it("should allocate full pot to a specific single winner", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 picks valid option: only options 1 and 2 have voters
      // randomWord0 = 0 → 0 % 2 = 0 → validOptions[0] = option 1 (2 voters)
      // randomWord1 = 1 → 1 % 2 = 1 → player2 wins
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 1n]
      );

      const totalPot = ENTRY_FEE * 3n;
      expect(await lottery.claimableBalances(player2.address)).to.equal(totalPot);
      expect(await lottery.claimableBalances(player1.address)).to.equal(0);
    });

    it("should allow the winner to claim their reward", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 = 0 → option 1 wins (validOptions[0]=1); randomWord1 = 0 → player1
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      const totalPot = ENTRY_FEE * 2n;
      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const claimTx = await lottery.connect(player1).claimReward();
      const claimReceipt = await claimTx.wait();
      const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(player1.address);

      expect(balanceAfter).to.equal(balanceBefore + totalPot - gasCost);
    });
  });

  // ─── VRF Callback: Split Mode ────────────────────────────────────

  describe("fulfillRandomWords — split among all winners mode", function () {
    beforeEach(async function () {
      await startRound(true); // split mode
    });

    it("should split pot equally among all voters of winning option", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 = 0 → validOptions[0] = option 1 (2 voters); split mode
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      const totalPot = ENTRY_FEE * 3n;
      const share = totalPot / 2n;
      const remainder = totalPot - share * 2n;

      expect(await lottery.claimableBalances(player1.address)).to.equal(share + remainder);
      expect(await lottery.claimableBalances(player2.address)).to.equal(share);
    });

    it("should emit WinnersSelected with correct parameters", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 = 0 → option 1 wins
      await expect(
        vrfCoordinator.fulfillRandomWordsWithOverride(
          requestId,
          await lottery.getAddress(),
          [0n, 0n]
        )
      )
        .to.emit(lottery, "WinnersSelected")
        .withArgs(1, 1, ENTRY_FEE * 2n);
    });

    it("should give full pot to single voter on winning option", async function () {
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 = 0 → option 1 wins (only player1)
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      expect(await lottery.claimableBalances(player1.address)).to.equal(ENTRY_FEE * 3n);
    });
  });

  // ─── Claim Rewards ───────────────────────────────────────────────

  describe("claimReward", function () {
    it("should revert if caller has no rewards", async function () {
      await expect(lottery.connect(player4).claimReward()).to.be.revertedWith("No rewards");
    });

    it("should emit RewardClaimed event", async function () {
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      await expect(lottery.connect(player1).claimReward())
        .to.emit(lottery, "RewardClaimed")
        .withArgs(player1.address, ENTRY_FEE);
    });

    it("should not allow double claim", async function () {
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      await lottery.connect(player1).claimReward();
      await expect(lottery.connect(player1).claimReward()).to.be.revertedWith("No rewards");
    });

    it("should accumulate rewards across multiple rounds", async function () {
      // Round 1
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      let tx = await lottery.triggerDraw();
      let receipt = await tx.wait();
      let requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      // Round 2
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      tx = await lottery.triggerDraw();
      receipt = await tx.wait();
      requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      // Both round prizes should be claimable at once
      expect(await lottery.claimableBalances(player1.address)).to.equal(ENTRY_FEE * 2n);
    });
  });

  // ─── Multi-Round Support ─────────────────────────────────────────

  describe("Multi-round lifecycle", function () {
    it("should support multiple sequential rounds", async function () {
      // Round 1
      await startRound(false);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      let tx = await lottery.triggerDraw();
      let receipt = await tx.wait();
      let requestId = getRequestIdFromReceipt(receipt);
      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      expect(await lottery.currentRoundId()).to.equal(1);

      // Round 2
      await startRound(true);
      expect(await lottery.currentRoundId()).to.equal(2);

      const round2 = await lottery.getCurrentRoundData();
      expect(round2.state).to.equal(0); // OPEN
      expect(round2.splitAmongAllWinners).to.equal(true);
    });

    it("should keep round 1 data accessible after round 2 starts", async function () {
      await startRound(false);
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);
      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      await startRound(true);

      const round1 = await lottery.rounds(1);
      expect(round1.totalEntries).to.equal(1);
      expect(round1.isDrawn).to.equal(true);
    });

    it("should allow players to re-enter in a new round", async function () {
      await startRound(false);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);
      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      await startRound(false);
      await expect(
        lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE })
      ).to.not.be.reverted;
    });
  });

  // ─── Emergency Close ─────────────────────────────────────────────

  describe("emergencyCloseRound", function () {
    it("should revert if round is not in CALCULATING state", async function () {
      await startRound();
      await expect(lottery.emergencyCloseRound(1)).to.be.revertedWith("Round not stuck");
    });

    it("should revert if called too early", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();

      await expect(lottery.emergencyCloseRound(1)).to.be.revertedWith("Too early for emergency");
    });

    it("should refund all participants after timeout", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();

      // Fast-forward past EMERGENCY_TIMEOUT (1 day)
      await time.increase(86400 + 1);

      await expect(lottery.emergencyCloseRound(1))
        .to.emit(lottery, "EmergencyRefund")
        .withArgs(1);

      expect(await lottery.claimableBalances(player1.address)).to.equal(ENTRY_FEE);
      expect(await lottery.claimableBalances(player2.address)).to.equal(ENTRY_FEE);

      const round = await lottery.getCurrentRoundData();
      expect(round.state).to.equal(2); // CLOSED
    });

    it("should revert if called by non-owner", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      await lottery.triggerDraw();
      await time.increase(86400 + 1);

      await expect(
        lottery.connect(player1).emergencyCloseRound(1)
      ).to.be.revertedWith("Only callable by owner");
    });
  });

  // ─── VRF Config ──────────────────────────────────────────────────

  describe("setVRFConfig", function () {
    it("should update VRF parameters", async function () {
      const newKeyHash = "0x" + "ab".repeat(32);
      await expect(
        lottery.setVRFConfig(newKeyHash, subscriptionId, 300000, 5, 3)
      ).to.emit(lottery, "VRFConfigUpdated");

      expect(await lottery.keyHash()).to.equal(newKeyHash);
      expect(await lottery.callbackGasLimit()).to.equal(300000);
      expect(await lottery.requestConfirmations()).to.equal(5);
      expect(await lottery.numWords()).to.equal(3);
    });

    it("should revert if gas limit too low", async function () {
      await expect(
        lottery.setVRFConfig(KEY_HASH, subscriptionId, 100000, 3, 2)
      ).to.be.revertedWith("Gas limit too low");
    });

    it("should revert if numWords < 2", async function () {
      await expect(
        lottery.setVRFConfig(KEY_HASH, subscriptionId, 250000, 3, 1)
      ).to.be.revertedWith("Need >= 2 words");
    });

    it("should revert if called by non-owner", async function () {
      await expect(
        lottery.connect(player1).setVRFConfig(KEY_HASH, subscriptionId, 250000, 3, 2)
      ).to.be.revertedWith("Only callable by owner");
    });
  });

  // ─── Helper / View Functions ─────────────────────────────────────

  describe("View functions", function () {
    it("getVoterCount should return correct count", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE });
      expect(await lottery.getVoterCount(1, 1)).to.equal(2);
      expect(await lottery.getVoterCount(1, 2)).to.equal(0);
    });

    it("getVoters should return addresses", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      const voters = await lottery.getVoters(1, 2);
      expect(voters.length).to.equal(1);
      expect(voters[0]).to.equal(player1.address);
    });

    it("getWinners should return empty array before draw", async function () {
      await startRound();
      const winners = await lottery.getWinners(1);
      expect(winners.length).to.equal(0);
    });

    it("getWinners should return winning option voters after draw", async function () {
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      // randomWord0 = 0 → option 1 wins
      await vrfCoordinator.fulfillRandomWordsWithOverride(
        requestId,
        await lottery.getAddress(),
        [0n, 0n]
      );

      const winners = await lottery.getWinners(1);
      expect(winners.length).to.equal(1);
      expect(winners[0]).to.equal(player1.address);
    });

    it("getRoundInfo should return structured data", async function () {
      await startRound(true);
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });

      const info = await lottery.getRoundInfo(1);
      expect(info.state).to.equal(0);
      expect(info.pot).to.equal(ENTRY_FEE);
      expect(info.entryFee).to.equal(ENTRY_FEE);
      expect(info.numOptionsCount).to.equal(NUM_OPTIONS);
      expect(info.splitAmongAll).to.equal(true);
      expect(info.totalEntries).to.equal(1);
      expect(info.isDrawn).to.equal(false);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  describe("Edge cases", function () {
    it("should reject direct ETH transfers", async function () {
      await expect(
        owner.sendTransaction({ to: await lottery.getAddress(), value: ENTRY_FEE })
      ).to.be.revertedWith("Use enterLottery()");
    });

    it("should accumulate contract balance from multiple entries", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player3).enterLottery(3, { value: ENTRY_FEE });
      await lottery.connect(player4).enterLottery(1, { value: ENTRY_FEE });

      const balance = await ethers.provider.getBalance(await lottery.getAddress());
      expect(balance).to.equal(ENTRY_FEE * 4n);
    });

    it("should not allow entry when round is CLOSED", async function () {
      await startRound();
      await lottery.connect(player1).enterLottery(1, { value: ENTRY_FEE });
      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);
      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      await expect(
        lottery.connect(player2).enterLottery(1, { value: ENTRY_FEE })
      ).to.be.revertedWith("Not open");
    });

    it("should only pick from options that have voters", async function () {
      await startRound(false);
      // Only option 2 has voters, options 1 and 3 are empty
      await lottery.connect(player1).enterLottery(2, { value: ENTRY_FEE });
      await lottery.connect(player2).enterLottery(2, { value: ENTRY_FEE });

      await time.increase(DURATION_MINUTES * 60 + 1);
      const tx = await lottery.triggerDraw();
      const receipt = await tx.wait();
      const requestId = getRequestIdFromReceipt(receipt);

      await vrfCoordinator.fulfillRandomWords(requestId, await lottery.getAddress());

      const round = await lottery.getCurrentRoundData();
      expect(round.winningOption).to.equal(2);
    });
  });
});
