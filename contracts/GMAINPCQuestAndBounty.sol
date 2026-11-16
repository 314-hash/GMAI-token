// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GMAINPCQuestAndBounty
 * @notice PISO Chain AI NPC Dialog & Web3 Gaming Monster Bounty Oracle on Sidra Chain.
 * @dev Inspired by PISOSakuraAIOracle.sol, PISOTurboFieldfareAI.sol, and PISOMonsterBountyManager.sol.
 *      Validates AI prompt completions, Web3 gaming mastery lessons, and bounties for
 *      Easy, Medium, and Hard combat enemies.
 */
contract GMAINPCQuestAndBounty {
    address public owner;

    enum EnemyDifficulty { EASY, MEDIUM, HARD }

    struct MonsterBounty {
        string name;
        EnemyDifficulty difficulty;
        uint256 baseHp;
        uint256 gmaiReward;
        uint256 expPoints;
    }

    struct Web3Lesson {
        string title;
        string topic;
        uint256 rewardGmai;
        bool completed;
    }

    struct PlayerProgress {
        uint256 monstersDefeated;
        uint256 totalBountyRewards;
        uint256 completedLessonsCount;
        uint256 playerLevel;
    }

    mapping(uint256 => MonsterBounty) public monsterBounties;
    mapping(address => PlayerProgress) public playerProgress;
    mapping(address => mapping(uint256 => bool)) public playerCompletedLesson;

    event MonsterDefeated(
        address indexed player,
        EnemyDifficulty difficulty,
        string monsterName,
        uint256 rewardAmount
    );
    event Web3LessonCompleted(
        address indexed player,
        uint256 indexed lessonId,
        string lessonTitle,
        uint256 rewardAmount
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "GMAINPC: Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;

        // Initialize 3 Enemy Tiers
        monsterBounties[0] = MonsterBounty("Glitch Drone", EnemyDifficulty.EASY, 100, 50 * 10**18, 25);
        monsterBounties[1] = MonsterBounty("Void Stalker", EnemyDifficulty.MEDIUM, 250, 150 * 10**18, 75);
        monsterBounties[2] = MonsterBounty("Cyber Mecha Colossus", EnemyDifficulty.HARD, 600, 500 * 10**18, 250);
    }

    /**
     * @notice Claims bounty reward upon defeating an AI enemy in the 3D metaverse.
     */
    function claimMonsterBounty(uint256 tier) external returns (uint256) {
        require(tier <= 2, "GMAINPC: Invalid monster tier");
        MonsterBounty memory m = monsterBounties[tier];

        PlayerProgress storage p = playerProgress[msg.sender];
        p.monstersDefeated += 1;
        p.totalBountyRewards += m.gmaiReward;
        p.playerLevel = 1 + (p.monstersDefeated / 5);

        emit MonsterDefeated(msg.sender, m.difficulty, m.name, m.gmaiReward);
        return m.gmaiReward;
    }

    /**
     * @notice Records completion of an AI NPC Web3 gaming curriculum prompt.
     */
    function completeWeb3Lesson(uint256 lessonId, string calldata title, uint256 reward) external {
        require(!playerCompletedLesson[msg.sender][lessonId], "GMAINPC: Already completed");

        playerCompletedLesson[msg.sender][lessonId] = true;
        PlayerProgress storage p = playerProgress[msg.sender];
        p.completedLessonsCount += 1;
        p.totalBountyRewards += reward;

        emit Web3LessonCompleted(msg.sender, lessonId, title, reward);
    }

    function getPlayerStats(address player) external view returns (PlayerProgress memory) {
        return playerProgress[player];
    }
}
