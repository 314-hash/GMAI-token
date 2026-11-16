// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GMAIAIOracle
 * @notice GameMind AI ($GMAI) Telemetry, Matchmaking, and Combat Simulation Oracle on Sidra Chain.
 * @dev Adapted from PISO Chain PISOAIOracle.sol & PISOTurboFieldfareAI.sol for Sidra Chain (Chain ID: 97453).
 *      Provides decentralized computation scores, skill cooldown reductions, and metaverse network gas estimates.
 */
contract GMAIAIOracle {
    address public owner;
    address public pendingOwner;

    string public constant VERSION = "1.0.0-sidra";
    uint256 public constant SIDRA_CHAIN_ID = 97453;

    struct TelemetryData {
        uint256 blockNumber;
        uint256 timestamp;
        uint256 recommendedGasGwei;
        uint256 activeNodes;
        uint256 threatLevel; // 0 = Nominal, 1 = Elevated, 2 = Critical
        uint256 aiEngineLatencyMs;
        bytes32 modelStateHash;
    }

    struct HeroMatchTelemetry {
        uint256 heroIndex;
        uint256 battleRating;
        uint256 skillMultiplierBps; // 10,000 = 100%
        uint256 matchesWon;
        uint256 matchesTotal;
    }

    TelemetryData public latestTelemetry;
    mapping(address => bool) public authorizedReporters;
    mapping(uint256 => HeroMatchTelemetry) public heroTelemetry;

    event TelemetryUpdated(uint256 timestamp, uint256 gasPriceGwei, uint256 activeNodes, uint256 threatLevel);
    event HeroMatchReported(uint256 indexed heroIndex, uint256 battleRating, uint256 skillMultiplierBps);
    event ReporterStatusChanged(address indexed reporter, bool active);

    modifier onlyOwner() {
        require(msg.sender == owner, "AIOracle: Not owner");
        _;
    }

    modifier onlyReporter() {
        require(authorizedReporters[msg.sender] || msg.sender == owner, "AIOracle: Not authorized reporter");
        _;
    }

    constructor() {
        owner = msg.sender;
        authorizedReporters[msg.sender] = true;

        latestTelemetry = TelemetryData({
            blockNumber: block.number,
            timestamp: block.timestamp,
            recommendedGasGwei: 1, // Sidra Chain low cost gas
            activeNodes: 64,
            threatLevel: 0,
            aiEngineLatencyMs: 14,
            modelStateHash: keccak256(abi.encodePacked("GameMindAI_Swarm_Cadence_v1"))
        });

        // Initialize hero baseline telemetry
        for (uint256 i = 1; i <= 20; i++) {
            heroTelemetry[i] = HeroMatchTelemetry({
                heroIndex: i,
                battleRating: 1500,
                skillMultiplierBps: 10000,
                matchesWon: 0,
                matchesTotal: 0
            });
        }
    }

    function setReporter(address reporter, bool authorized) external onlyOwner {
        require(reporter != address(0), "AIOracle: Zero address");
        authorizedReporters[reporter] = authorized;
        emit ReporterStatusChanged(reporter, authorized);
    }

    function reportTelemetry(
        uint256 recommendedGasGwei,
        uint256 activeNodes,
        uint256 threatLevel,
        uint256 aiEngineLatencyMs,
        bytes32 modelStateHash
    ) external onlyReporter {
        latestTelemetry = TelemetryData({
            blockNumber: block.number,
            timestamp: block.timestamp,
            recommendedGasGwei: recommendedGasGwei,
            activeNodes: activeNodes,
            threatLevel: threatLevel,
            aiEngineLatencyMs: aiEngineLatencyMs,
            modelStateHash: modelStateHash
        });

        emit TelemetryUpdated(block.timestamp, recommendedGasGwei, activeNodes, threatLevel);
    }

    function reportHeroCombat(
        uint256 heroIndex,
        uint256 battleRatingDelta,
        uint256 skillMultiplierBps,
        bool won
    ) external onlyReporter {
        require(heroIndex >= 1 && heroIndex <= 20, "AIOracle: Invalid hero");
        HeroMatchTelemetry storage h = heroTelemetry[heroIndex];

        if (won) {
            h.battleRating += battleRatingDelta;
            h.matchesWon += 1;
        } else if (h.battleRating > battleRatingDelta) {
            h.battleRating -= battleRatingDelta;
        }

        h.matchesTotal += 1;
        h.skillMultiplierBps = skillMultiplierBps;

        emit HeroMatchReported(heroIndex, h.battleRating, skillMultiplierBps);
    }

    function getHeroCombatStats(uint256 heroIndex) external view returns (HeroMatchTelemetry memory) {
        require(heroIndex >= 1 && heroIndex <= 20, "AIOracle: Invalid hero");
        return heroTelemetry[heroIndex];
    }
}
