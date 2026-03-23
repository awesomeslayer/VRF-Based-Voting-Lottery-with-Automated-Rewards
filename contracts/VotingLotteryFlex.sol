// contracts/FlexibleVotingLottery.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract FlexibleVotingLottery is VRFConsumerBaseV2Plus {
    uint256 public s_subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 100000;
    uint16 public requestConfirmations = 3;
    uint32 public numWords = 1;

    uint256 public entryFee;
    uint256 public lotteryEndTime;
    uint256 public lotteryDuration;
    bool public isDrawn;

    uint8 public numOptions;
    bool public splitAmongAllWinners;
    uint256 public totalEntries;

    enum LotteryState { OPEN, CALCULATING, CLOSED }
    LotteryState public lotteryState;

    mapping(uint8 => address[]) public votersByOption;
    mapping(address => uint256) public claimableBalances;
    mapping(address => bool) public hasEntered;

    uint8 public winningOption;
    address[] public winnersList;
    uint256 public lastPrize;

    event LotteryEntered(address indexed player, uint8 option);
    event DrawRequested(uint256 requestId);
    event WinnersSelected(uint8 winningOption, address[] winners, uint256 totalPrize);
    event RewardClaimed(address indexed winner, uint256 amount);
    event LotteryReset();

    constructor(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint256 _entryFee,
        uint256 _durationInMinutes,
        uint8 _numOptions,
        bool _splitAmongAllWinners
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        require(_numOptions > 0, "Must have at least 1 option");

        s_subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        entryFee = _entryFee;
        lotteryDuration = _durationInMinutes * 1 minutes;
        lotteryEndTime = block.timestamp + lotteryDuration;

        numOptions = _numOptions;
        splitAmongAllWinners = _splitAmongAllWinners;

        lotteryState = LotteryState.OPEN;
    }

    function enterLottery(uint8 _option) external payable {
        require(lotteryState == LotteryState.OPEN, "Lottery is not open");
        require(block.timestamp < lotteryEndTime, "Entry window is closed");
        require(msg.value == entryFee, "Incorrect entry fee");
        require(_option >= 1 && _option <= numOptions, "Invalid option");

        votersByOption[_option].push(msg.sender);
        hasEntered[msg.sender] = true;
        totalEntries++;
        emit LotteryEntered(msg.sender, _option);
    }

    function triggerDraw() external {
        require(lotteryState == LotteryState.OPEN, "Already drawing or closed");
        require(block.timestamp >= lotteryEndTime, "Entry window still open");

        lotteryState = LotteryState.CALCULATING;

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        emit DrawRequested(requestId);
    }

    function fulfillRandomWords(uint256, uint256[] calldata _randomWords) internal override {
        require(lotteryState == LotteryState.CALCULATING, "Not calculating");

        uint256 randomWord = _randomWords[0];
        winningOption = uint8((randomWord % numOptions) + 1);

        address[] memory winners = votersByOption[winningOption];
        uint256 pot = address(this).balance;
        lastPrize = pot;

        delete winnersList;

        if (winners.length > 0) {
            if (splitAmongAllWinners) {
                uint256 share = pot / winners.length;
                for (uint256 i = 0; i < winners.length; i++) {
                    claimableBalances[winners[i]] += share;
                    winnersList.push(winners[i]);
                }
                emit WinnersSelected(winningOption, winners, pot);
            } else {
                uint256 winnerIndex = (randomWord / 100) % winners.length;
                address singleWinner = winners[winnerIndex];
                claimableBalances[singleWinner] += pot;

                winnersList.push(singleWinner);

                address[] memory singleArray = new address[](1);
                singleArray[0] = singleWinner;
                emit WinnersSelected(winningOption, singleArray, pot);
            }
        } else {
            address[] memory emptyArray = new address[](0);
            emit WinnersSelected(winningOption, emptyArray, 0);
        }

        lotteryState = LotteryState.CLOSED;
        isDrawn = true;
    }

    function claimReward() external {
        uint256 amount = claimableBalances[msg.sender];
        require(amount > 0, "No rewards");

        claimableBalances[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }

    // ── View helpers for the frontend ──

    function getVoterCount(uint8 _option) external view returns (uint256) {
        return votersByOption[_option].length;
    }

    function getVoters(uint8 _option) external view returns (address[] memory) {
        return votersByOption[_option];
    }

    function getPot() external view returns (uint256) {
        return address(this).balance;
    }

    function getWinners() external view returns (address[] memory) {
        return winnersList;
    }

    function getTimeRemaining() external view returns (uint256) {
        if (block.timestamp >= lotteryEndTime) return 0;
        return lotteryEndTime - block.timestamp;
    }

    function getLotteryInfo() external view returns (
        uint8 _state,
        uint256 _pot,
        uint256 _endTime,
        uint256 _entryFee,
        uint8 _numOptions,
        bool _splitAmongAll,
        uint256 _totalEntries,
        bool _isDrawn,
        uint8 _winningOption,
        uint256 _lastPrize
    ) {
        return (
            uint8(lotteryState),
            address(this).balance,
            lotteryEndTime,
            entryFee,
            numOptions,
            splitAmongAllWinners,
            totalEntries,
            isDrawn,
            winningOption,
            lastPrize
        );
    }
}