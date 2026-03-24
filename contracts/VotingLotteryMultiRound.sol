// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract VotingLotteryMultiRound is VRFConsumerBaseV2Plus {
    // Настройки VRF
    uint256 public s_subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 250000;
    uint16 public requestConfirmations = 3;
    uint32 public numWords = 1;

    enum LotteryState { OPEN, CALCULATING, CLOSED }

    struct RoundInfo {
        uint256 roundId;
        uint256 entryFee;
        uint256 endTime;
        uint8 numOptions;
        bool splitAmongAllWinners;
        LotteryState state;
        bool isDrawn;
        uint8 winningOption;
        uint256 totalPot;
        uint256 totalEntries;
    }

    uint256 public currentRoundId;
    mapping(uint256 => RoundInfo) public rounds;
    mapping(uint256 => mapping(uint8 => address[])) private votersByRoundAndOption;
    mapping(address => uint256) public claimableBalances;

    event RoundStarted(uint256 indexed roundId, uint256 endTime, uint256 entryFee);
    event LotteryEntered(uint256 indexed roundId, address indexed player, uint8 option);
    event DrawRequested(uint256 indexed roundId, uint256 requestId);
    event WinnersSelected(uint256 indexed roundId, uint8 winningOption, uint256 prizePool);
    event RewardClaimed(address indexed winner, uint256 amount);

    constructor(address _vrfCoordinator, uint256 _subscriptionId, bytes32 _keyHash) 
        VRFConsumerBaseV2Plus(_vrfCoordinator) 
    {
        s_subscriptionId = _subscriptionId;
        keyHash = _keyHash;
    }

    function startNewRound(
        uint256 _entryFee,
        uint256 _durationInMinutes,
        uint8 _numOptions,
        bool _splitAmongAllWinners
    ) external onlyOwner {
        if (currentRoundId > 0) {
            require(rounds[currentRoundId].state == LotteryState.CLOSED, "Finish current round first");
        }

        currentRoundId++;
        rounds[currentRoundId] = RoundInfo({
            roundId: currentRoundId,
            entryFee: _entryFee,
            endTime: block.timestamp + (_durationInMinutes * 1 minutes),
            numOptions: _numOptions,
            splitAmongAllWinners: _splitAmongAllWinners,
            state: LotteryState.OPEN,
            isDrawn: false,
            winningOption: 0,
            totalPot: 0,
            totalEntries: 0
        });

        emit RoundStarted(currentRoundId, rounds[currentRoundId].endTime, _entryFee);
    }

    function enterLottery(uint8 _option) external payable {
        RoundInfo storage round = rounds[currentRoundId];
        require(round.state == LotteryState.OPEN, "Not open");
        require(block.timestamp < round.endTime, "Time's up");
        require(msg.value == round.entryFee, "Wrong fee");
        require(_option >= 1 && _option <= round.numOptions, "Invalid option");

        votersByRoundAndOption[currentRoundId][_option].push(msg.sender);
        round.totalEntries++;
        round.totalPot += msg.value;

        emit LotteryEntered(currentRoundId, msg.sender, _option);
    }

    function triggerDraw() external {
        RoundInfo storage round = rounds[currentRoundId];
        require(round.state == LotteryState.OPEN, "Not open");
        require(block.timestamp >= round.endTime, "Wait for end time");
        require(round.totalEntries > 0, "No participants");

        round.state = LotteryState.CALCULATING;

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
            })
        );
        emit DrawRequested(currentRoundId, requestId);
    }

    function fulfillRandomWords(uint256, uint256[] calldata _randomWords) internal override {
        RoundInfo storage round = rounds[currentRoundId];
        uint256 randomWord = _randomWords[0];
        round.winningOption = uint8((randomWord % round.numOptions) + 1);
        
        address[] memory winners = votersByRoundAndOption[currentRoundId][round.winningOption];
        uint256 prize = round.totalPot;

        if (winners.length > 0) {
            if (round.splitAmongAllWinners) {
                uint256 share = prize / winners.length;
                for (uint256 i = 0; i < winners.length; i++) {
                    claimableBalances[winners[i]] += share;
                }
            } else {
                uint256 winnerIndex = (randomWord / 100) % winners.length;
                claimableBalances[winners[winnerIndex]] += prize;
            }
        }
        
        round.state = LotteryState.CLOSED;
        round.isDrawn = true;
        emit WinnersSelected(currentRoundId, round.winningOption, prize);
    }

    function claimReward() external {
        uint256 amount = claimableBalances[msg.sender];
        require(amount > 0, "No rewards");
        claimableBalances[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Failed");
        emit RewardClaimed(msg.sender, amount);
    }

    function getCurrentRoundData() external view returns (RoundInfo memory) {
        return rounds[currentRoundId];
    }
}