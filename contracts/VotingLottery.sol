// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract VotingLottery is VRFConsumerBaseV2Plus {
    uint256 public s_subscriptionId;
    bytes32 public keyHash; 
    uint32 public callbackGasLimit = 50000;
    uint16 public requestConfirmations = 3;
    uint32 public numWords = 1;

    uint256 public entryFee;
    uint256 public lotteryEndTime;
    bool public isDrawn; 

    enum LotteryState { OPEN, CALCULATING, CLOSED }
    LotteryState public lotteryState;

    mapping(uint8 => address[]) public votersByOption;
    mapping(address => uint256) public claimableBalances;

    event LotteryEntered(address indexed player, uint8 option);
    event DrawRequested(uint256 requestId);
    event WinnerSelected(uint8 winningOption, address indexed winner, uint256 prize);
    event RewardClaimed(address indexed winner, uint256 amount);

    constructor(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint256 _entryFee,
        uint256 _durationInMinutes
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        s_subscriptionId = _subscriptionId;
        keyHash = _keyHash;
        entryFee = _entryFee;
        lotteryEndTime = block.timestamp + (_durationInMinutes * 1 minutes);
        lotteryState = LotteryState.OPEN;
    }

    function enterLottery(uint8 _option) external payable {
        require(lotteryState == LotteryState.OPEN, "Lottery is not open");
        require(block.timestamp < lotteryEndTime, "Entry window is closed");
        require(msg.value == entryFee, "Incorrect entry fee");
        require(_option >= 1 && _option <= 3, "Invalid option. Choose 1, 2, or 3");

        votersByOption[_option].push(msg.sender);
        emit LotteryEntered(msg.sender, _option);
    }

    function triggerDraw() external {
        require(lotteryState == LotteryState.OPEN, "Already drawing or closed");
        require(block.timestamp >= lotteryEndTime, "Entry window is still open");
        
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

    function fulfillRandomWords(uint256 /* _requestId */, uint256[] calldata _randomWords) internal override {
        require(lotteryState == LotteryState.CALCULATING, "Not calculating");

        uint256 randomWord = _randomWords[0];
        uint8 winningOption = uint8((randomWord % 3) + 1);

        address[] memory winnersOfOption = votersByOption[winningOption];
        uint256 pot = address(this).balance;

        if (winnersOfOption.length > 0) {
            uint256 winnerIndex = (randomWord / 100) % winnersOfOption.length;
            address absoluteWinner = winnersOfOption[winnerIndex];

            claimableBalances[absoluteWinner] += pot;
            emit WinnerSelected(winningOption, absoluteWinner, pot);
        } else {
            emit WinnerSelected(winningOption, address(0), 0);
        }

        lotteryState = LotteryState.CLOSED;
        isDrawn = true;
    }

    function claimReward() external {
        uint256 amount = claimableBalances[msg.sender];
        require(amount > 0, "No rewards to claim");

        claimableBalances[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }
}