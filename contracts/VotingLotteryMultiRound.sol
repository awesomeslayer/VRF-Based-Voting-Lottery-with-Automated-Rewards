// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

contract VotingLotteryMultiRound is VRFConsumerBaseV2Plus {
    uint256 public s_subscriptionId;
    bytes32 public keyHash;
    uint32  public callbackGasLimit    = 250000;  
    uint16  public requestConfirmations = 3;
    uint32  public numWords            = 2;      

    enum LotteryState { OPEN, CALCULATING, CLOSED }

    struct RoundInfo {
        uint256       roundId;
        uint256       entryFee;
        uint256       endTime;
        uint8         numOptions;
        bool          splitAmongAllWinners;
        LotteryState  state;
        bool          isDrawn;
        uint8         winningOption;
        uint256       totalPot;
        uint256       totalEntries;
    }
    uint256 public currentRoundId;

    uint256 public constant EMERGENCY_TIMEOUT = 1 days;

    mapping(uint256 => RoundInfo)                           public  rounds;
    mapping(uint256 => mapping(uint8 => address[]))         private votersByRoundAndOption;
    mapping(uint256 => mapping(address => bool))            public  hasVoted;
    
    
    mapping(uint256 => mapping(address => uint8))           public  playerOption;
    mapping(address => uint256)                             public  claimableBalances;
    mapping(uint256 => uint256)                             private vrfRequestToRound;

    event RoundStarted(uint256 indexed roundId, uint256 endTime, uint256 entryFee);
    event RoundClosedEmpty(uint256 indexed roundId);
    event LotteryEntered(uint256 indexed roundId, address indexed player, uint8 option);
    event DrawRequested(uint256 indexed roundId, uint256 requestId);
    event WinnersSelected(uint256 indexed roundId, uint8 winningOption, uint256 prizePool);
    event RewardClaimed(address indexed winner, uint256 amount);
    event EmergencyRefund(uint256 indexed roundId);
    event VRFConfigUpdated();

    constructor(
        address _vrfCoordinator,
        uint256 _subscriptionId,
        bytes32 _keyHash
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        s_subscriptionId = _subscriptionId;
        keyHash          = _keyHash;
    }

    /// @notice Update VRF parameters. Only callable between rounds.
    function setVRFConfig(
        bytes32 _keyHash,
        uint256 _subscriptionId,
        uint32  _callbackGasLimit,
        uint16  _requestConfirmations,
        uint32  _numWords
    ) external onlyOwner {
        require(_callbackGasLimit >= 200_000, "Gas limit too low");
        require(_numWords >= 2,               "Need >= 2 words");
        require(_requestConfirmations >= 1,   "Need >= 1 conf");

        keyHash              = _keyHash;
        s_subscriptionId     = _subscriptionId;
        callbackGasLimit     = _callbackGasLimit;
        requestConfirmations = _requestConfirmations;
        numWords             = _numWords;

        emit VRFConfigUpdated();
    }

    // Round management

    function startNewRound(
        uint256 _entryFee,
        uint256 _durationInMinutes,
        uint8   _numOptions,
        bool    _splitAmongAllWinners
    ) external onlyOwner {
        require(_numOptions >= 2,           "Need >= 2 options");
        require(_durationInMinutes > 0,     "Duration must be > 0");

        if (currentRoundId > 0) {
            RoundInfo storage prev = rounds[currentRoundId];

            // Auto-close expired empty rounds
            if (
                prev.state == LotteryState.OPEN &&
                block.timestamp >= prev.endTime &&
                prev.totalEntries == 0
            ) {
                prev.state = LotteryState.CLOSED;
                emit RoundClosedEmpty(currentRoundId);
            }

            require(
                prev.state == LotteryState.CLOSED,
                "Finish current round first"
            );
        }

        currentRoundId++;
        uint256 endTime = block.timestamp + (_durationInMinutes * 1 minutes);

        rounds[currentRoundId] = RoundInfo({
            roundId:              currentRoundId,
            entryFee:             _entryFee,
            endTime:              endTime,
            numOptions:           _numOptions,
            splitAmongAllWinners: _splitAmongAllWinners,
            state:                LotteryState.OPEN,
            isDrawn:              false,
            winningOption:        0,
            totalPot:             0,
            totalEntries:         0
        });

        emit RoundStarted(currentRoundId, endTime, _entryFee);
    }

    // Emergency Recovery

    /// @notice Refund all participants and close a stuck CALCULATING round.
    ///         Only callable after EMERGENCY_TIMEOUT since round end time.
    function emergencyCloseRound(uint256 _roundId) external onlyOwner {
        RoundInfo storage round = rounds[_roundId];

        require(
            round.state == LotteryState.CALCULATING,
            "Round not stuck"
        );
        require(
            block.timestamp >= round.endTime + EMERGENCY_TIMEOUT,
            "Too early for emergency"
        );

        // Credit each voter their entry fee back
        for (uint8 opt = 1; opt <= round.numOptions; opt++) {
            address[] storage voters = votersByRoundAndOption[_roundId][opt];
            uint256 len = voters.length;
            for (uint256 i = 0; i < len; i++) {
                claimableBalances[voters[i]] += round.entryFee;
            }
        }

        round.state = LotteryState.CLOSED;
        emit EmergencyRefund(_roundId);
    }

    // Enter Lottery

    function enterLottery(uint8 _option) external payable {
        uint256 roundId = currentRoundId;
        RoundInfo storage round = rounds[roundId];

        require(round.state == LotteryState.OPEN, "Not open");
        require(block.timestamp < round.endTime,  "Time's up");
        require(msg.value == round.entryFee,      "Wrong fee");
        require(
            _option >= 1 && _option <= round.numOptions,
            "Invalid option"
        );
        require(!hasVoted[roundId][msg.sender], "Already voted");

        hasVoted[roundId][msg.sender]     = true;
        playerOption[roundId][msg.sender] = _option;

        votersByRoundAndOption[roundId][_option].push(msg.sender);
        round.totalEntries++;
        round.totalPot += msg.value;

        emit LotteryEntered(roundId, msg.sender, _option);
    }

    // Draw

    function triggerDraw() external {
        _executeDraw();
    }

    function _executeDraw() internal {
        RoundInfo storage round = rounds[currentRoundId];

        require(round.state == LotteryState.OPEN, "Not open");
        require(block.timestamp >= round.endTime,  "Wait for end time");

        if (round.totalEntries == 0) {
            round.state = LotteryState.CLOSED;
            emit RoundClosedEmpty(currentRoundId);
            return;
        }

        round.state = LotteryState.CALCULATING;

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              keyHash,
                subId:                s_subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:     callbackGasLimit,
                numWords:             numWords,
                extraArgs:            VRFV2PlusClient._argsToBytes(
                                          VRFV2PlusClient.ExtraArgsV1({
                                              nativePayment: false
                                          })
                                      )
            })
        );

        vrfRequestToRound[requestId] = currentRoundId;

        emit DrawRequested(currentRoundId, requestId);
    }

    // VRF Callback

    /// @dev No require/revert — any failure path still closes the round
    ///      to prevent the contract from being bricked.
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata _randomWords
    ) internal override {
        uint256 roundId = vrfRequestToRound[requestId];
        RoundInfo storage round = rounds[roundId];

        // Only process CALCULATING rounds
        if (round.state != LotteryState.CALCULATING) {
            return;
        }

        uint256 randomWord0 = _randomWords[0];
        uint256 randomWord1 = _randomWords[1];
        uint256 prize       = round.totalPot;

        // Collect valid options (options with at least 1 voter)
        uint8[] memory validOptions = new uint8[](round.numOptions);
        uint256 validCount = 0;

        for (uint8 opt = 1; opt <= round.numOptions; opt++) {
            if (votersByRoundAndOption[roundId][opt].length > 0) {
                validOptions[validCount] = opt;
                validCount++;
            }
        }

        // If somehow no valid options exist, refund everyone
        if (validCount == 0) {
            _refundAll(roundId, round);
            return;
        }

        // Pick winning option using first random word
        uint8 winningOption = validOptions[randomWord0 % validCount];
        round.winningOption = winningOption;

        address[] storage winners =
            votersByRoundAndOption[roundId][winningOption];
        uint256 winnersLen = winners.length;

        // Distribute prize
        if (round.splitAmongAllWinners) {
            uint256 share     = prize / winnersLen;
            uint256 remainder = prize - (share * winnersLen);

            for (uint256 i = 0; i < winnersLen; i++) {
                claimableBalances[winners[i]] += share;
            }
            // Give dust to the first winner so no ETH is permanently locked
            if (remainder > 0) {
                claimableBalances[winners[0]] += remainder;
            }
        } else {
            // Use second random word for independent winner selection
            uint256 winnerIndex = randomWord1 % winnersLen;
            claimableBalances[winners[winnerIndex]] += prize;
        }

        round.state   = LotteryState.CLOSED;
        round.isDrawn = true;

        emit WinnersSelected(roundId, winningOption, prize);
    }

    /// @dev Refund all participants when the draw cannot complete.
    function _refundAll(uint256 _roundId, RoundInfo storage _round) private {
        for (uint8 opt = 1; opt <= _round.numOptions; opt++) {
            address[] storage voters = votersByRoundAndOption[_roundId][opt];
            uint256 len = voters.length;
            for (uint256 i = 0; i < len; i++) {
                claimableBalances[voters[i]] += _round.entryFee;
            }
        }
        _round.state = LotteryState.CLOSED;
        emit EmergencyRefund(_roundId);
    }

    // Claim Rewards

    function claimReward() external {
        uint256 amount = claimableBalances[msg.sender];
        require(amount > 0, "No rewards");

        claimableBalances[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit RewardClaimed(msg.sender, amount);
    }

    // Helpers

    function getCurrentRoundData()
        external view returns (RoundInfo memory)
    {
        return rounds[currentRoundId];
    }

    function getVoterCount(uint256 _roundId, uint8 _option)
        external view returns (uint256)
    {
        return votersByRoundAndOption[_roundId][_option].length;
    }

    function getVoters(uint256 _roundId, uint8 _option)
        external view returns (address[] memory)
    {
        return votersByRoundAndOption[_roundId][_option];
    }

    function getWinners(uint256 _roundId)
        external view returns (address[] memory)
    {
        RoundInfo memory r = rounds[_roundId];
        if (!r.isDrawn) return new address[](0);
        return votersByRoundAndOption[_roundId][r.winningOption];
    }

    function getPlayerOption(uint256 _roundId, address _player)
        external view returns (uint8)
    {
        return playerOption[_roundId][_player];
    }

    function getRoundInfo(uint256 _roundId) external view returns (
        uint8   state,
        uint256 pot,
        uint256 endTime,
        uint256 entryFee,
        uint8   numOptionsCount,
        bool    splitAmongAll,
        uint256 totalEntries,
        bool    isDrawn,
        uint8   winningOption
    ) {
        RoundInfo memory r = rounds[_roundId];
        return (
            uint8(r.state),
            r.totalPot,
            r.endTime,
            r.entryFee,
            r.numOptions,
            r.splitAmongAllWinners,
            r.totalEntries,
            r.isDrawn,
            r.winningOption
        );
    }

    receive() external payable {
        revert("Use enterLottery()");
    }
}