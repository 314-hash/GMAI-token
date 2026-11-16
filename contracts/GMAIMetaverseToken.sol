// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Standard ERC-20 Interface
 */
interface IERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title GMAIMetaverseToken
 * @notice GameMind AI ($GMAI) Metaverse Token on Sidra Chain (Chain ID: 97453).
 * @dev Fixed max supply of exactly 100,000,000 GMAI tokens.
 *      Incorporates PISO Chain AI Oracle telemetry hooks, holder tier gating (500,000 GMAI),
 *      and metaverse gaming utility (character skills, tournament staking, and burning).
 */
contract GMAIMetaverseToken is IERC20 {
    string public constant name = "GameMind AI Metaverse Token";
    string public constant symbol = "GMAI";
    uint8 public constant decimals = 18;

    uint256 public constant MAX_SUPPLY = 100_000_000 * 10**18; // Exactly 100,000,000 tokens
    uint256 public override totalSupply;

    address public owner;
    address public aiOracle;
    address public heroNFTContract;

    // Minimum balance required to unlock private VIP chatrooms & tournament host privileges
    uint256 public constant ROOM_CREATION_THRESHOLD = 500_000 * 10**18;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // Metaverse AI Staking & Reward System
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public lastStakeTimestamp;
    mapping(address => uint256) public playerBattleScore;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AIOracleUpdated(address indexed newOracle);
    event HeroNFTContractUpdated(address indexed newNFTContract);
    event Staked(address indexed player, uint256 amount);
    event Unstaked(address indexed player, uint256 amount, uint256 reward);
    event TokensBurned(address indexed burner, uint256 amount);
    event SkillMasteryClaimed(address indexed player, uint256 heroId, uint256 rewardAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "GMAI: Not authorized owner");
        _;
    }

    modifier onlyAIOracleOrOwner() {
        require(msg.sender == owner || (aiOracle != address(0) && msg.sender == aiOracle), "GMAI: Not AI Oracle");
        _;
    }

    constructor(address initialTreasury) {
        require(initialTreasury != address(0), "GMAI: Invalid treasury");
        owner = msg.sender;

        // Mint entire initial 100 Million GMAI supply to treasury/deployer
        totalSupply = MAX_SUPPLY;
        _balances[initialTreasury] = MAX_SUPPLY;
        emit Transfer(address(0), initialTreasury, MAX_SUPPLY);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address holder, address spender) public view override returns (uint256) {
        return _allowances[holder][spender];
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "GMAI: Insufficient allowance");
            _allowances[from][msg.sender] = currentAllowance - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "GMAI: Transfer from zero");
        require(to != address(0), "GMAI: Transfer to zero");
        require(_balances[from] >= amount, "GMAI: Insufficient balance");

        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }

    /**
     * @notice Burns tokens directly from caller balance, permanently reducing total supply.
     */
    function burn(uint256 amount) external {
        require(_balances[msg.sender] >= amount, "GMAI: Exceeds balance");
        _balances[msg.sender] -= amount;
        totalSupply -= amount;
        emit Burn(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }

    event Burn(address indexed burner, uint256 amount);

    /**
     * @notice Checks if an address meets the 500,000 GMAI room creation & holder gate threshold.
     */
    function isRoomCreationEligible(address account) external view returns (bool) {
        return _balances[account] >= ROOM_CREATION_THRESHOLD;
    }

    /**
     * @notice Stakes GMAI tokens into the Metaverse AI Training Pool.
     */
    function stakeForMetaverse(uint256 amount) external {
        require(amount > 0, "GMAI: Stake amount must be > 0");
        require(_balances[msg.sender] >= amount, "GMAI: Insufficient balance");

        _transfer(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        lastStakeTimestamp[msg.sender] = block.timestamp;

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Unstakes GMAI tokens and collects AI telemetry rewards.
     */
    function unstakeFromMetaverse() external {
        uint256 amount = stakedBalance[msg.sender];
        require(amount > 0, "GMAI: No active stake");

        uint256 duration = block.timestamp - lastStakeTimestamp[msg.sender];
        // 12% APR simulated reward calculated per second
        uint256 reward = (amount * 12 * duration) / (100 * 365 days);

        stakedBalance[msg.sender] = 0;

        _transfer(address(this), msg.sender, amount);
        if (reward > 0 && _balances[address(this)] >= reward) {
            _transfer(address(this), msg.sender, reward);
        }

        emit Unstaked(msg.sender, amount, reward);
    }

    /**
     * @notice AI Oracle hook to record battle simulation scores and skill executions.
     */
    function recordBattleScore(address player, uint256 scoreDelta) external onlyAIOracleOrOwner {
        playerBattleScore[player] += scoreDelta;
    }

    function setAIOracle(address oracle) external onlyOwner {
        aiOracle = oracle;
        emit AIOracleUpdated(oracle);
    }

    function setHeroNFTContract(address nftContract) external onlyOwner {
        heroNFTContract = nftContract;
        emit HeroNFTContractUpdated(nftContract);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "GMAI: Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
