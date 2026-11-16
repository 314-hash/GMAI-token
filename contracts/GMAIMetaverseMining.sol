// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GMAIMetaverseMining
 * @notice On-chain Block Mining protocol for GameMind AI ($GMAI) on Sidra Chain (97453).
 * @dev Inspired by PISO Chain PISODailyMining.sol and PISOMineCraft.sol.
 *      Allows players to mine 3D metaverse data blocks, extracting GMAI token rewards
 *      based on hero mining power and block hardness.
 */
contract GMAIMetaverseMining {
    address public owner;
    address public gmaiToken;

    uint256 public totalBlocksMined;
    uint256 public totalMiningRewardsDistributed;

    struct MiningNode {
        uint256 nodeId;
        string blockType; // "GMAI Crystal", "Genesis Ledger", "Void Monolith"
        uint256 hardness; // Hits required to mine
        uint256 rewardPerBlock; // in wei
        uint256 respawnCooldown; // in seconds
        bool active;
    }

    struct PlayerMiner {
        uint256 blocksMined;
        uint256 totalGMAIEarned;
        uint256 miningLevel;
        uint256 lastMinedTimestamp;
    }

    mapping(uint256 => MiningNode) public miningNodes;
    mapping(address => PlayerMiner) public miners;

    event BlockMined(
        address indexed player,
        uint256 indexed nodeId,
        string blockType,
        uint256 rewardAmount,
        uint256 newTotalMined
    );
    event MinerLevelUp(address indexed player, uint256 newLevel);

    modifier onlyOwner() {
        require(msg.sender == owner, "GMAIMining: Not owner");
        _;
    }

    constructor(address _gmaiToken) {
        owner = msg.sender;
        gmaiToken = _gmaiToken;

        // Initialize 3 node types matching Metaverse 3D blocks
        miningNodes[1] = MiningNode(1, "GMAI Graphene Crystal", 3, 25 * 10**18, 15, true);
        miningNodes[2] = MiningNode(2, "Sidra Consensus Ledger", 5, 60 * 10**18, 30, true);
        miningNodes[3] = MiningNode(3, "Cosmic Void Monolith", 8, 150 * 10**18, 60, true);
    }

    /**
     * @notice Records proof of mining a 3D block in the GameMind AI metaverse.
     */
    function recordMiningReward(uint256 nodeId) external returns (uint256) {
        require(miningNodes[nodeId].active, "GMAIMining: Inactive node");
        MiningNode memory node = miningNodes[nodeId];

        PlayerMiner storage miner = miners[msg.sender];
        require(
            block.timestamp >= miner.lastMinedTimestamp + 3,
            "GMAIMining: Mining rate limited"
        );

        miner.blocksMined += 1;
        miner.totalGMAIEarned += node.rewardPerBlock;
        miner.lastMinedTimestamp = block.timestamp;

        // Level up check: every 10 blocks increases mining level
        if (miner.blocksMined % 10 == 0) {
            miner.miningLevel += 1;
            emit MinerLevelUp(msg.sender, miner.miningLevel);
        }

        totalBlocksMined += 1;
        totalMiningRewardsDistributed += node.rewardPerBlock;

        emit BlockMined(
            msg.sender,
            nodeId,
            node.blockType,
            node.rewardPerBlock,
            miner.blocksMined
        );

        return node.rewardPerBlock;
    }

    function getMinerStats(address player) external view returns (PlayerMiner memory) {
        return miners[player];
    }
}
