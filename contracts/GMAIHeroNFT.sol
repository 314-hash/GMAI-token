// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GMAIHeroNFT
 * @notice GameMind AI ($GMAI) 20 Full-Body MOBA Heroes NFT Collection on Sidra Chain.
 * @dev Implements ERC-721 token representing all 20 unique AI MOBA Heroes:
 *      1. Nexus (The Neural Vanguard) - Tank / Initiator, Frontline
 *      2. Vyra (The Quantum Assassin) - Assassin, Jungle / Roam
 *      3. Aura (The Synthweaver) - Support / Mage, Support
 *      4. Rex-9 (The Arena Machine) - Fighter, Solo
 *      5. Lyra (The Cyber Archer) - Marksman, Bottom
 *      6. Zeron (The Void Hacker) - Mage / Controller, Mid
 *      7. Kira-7 (The Combat Android) - Fighter / Assassin, Jungle
 *      8. Orion (The Star Engineer) - Mage / Artillery, Mid
 *      9. Mira (The Memory Keeper) - Support / Controller, Support
 *      10. Titan-X (The Mech Colossus) - Tank, Solo / Frontline
 *      11. Nova (The Energy Runner) - Assassin, Jungle
 *      12. Echo (The Sonic AI) - Mage / Support, Mid / Support
 *      13. Vanta (The Shadow Protocol) - Assassin, Jungle
 *      14. Solara (The Plasma Guardian) - Fighter / Support, Solo
 *      15. Byte (The Nano Swarm) - Specialist / Controller, Flexible
 *      16. Drax (The Blockchain Warlord) - Fighter / Tank, Solo
 *      17. Selene (The Dream Architect) - Mage / Controller, Mid
 *      18. Gravis (The Gravity Beast) - Tank, Frontline
 *      19. Pixel (The Reality Glitch) - Mage / Assassin, Mid
 *      20. Aegis (The Genesis Guardian) - Tank / Support, Frontline
 */
contract GMAIHeroNFT {
    string public constant name = "GameMind AI 20 MOBA Heroes NFT";
    string public constant symbol = "GMAIHERO";
    address public owner;

    uint256 public nextTokenId = 1;
    uint256 public constant TOTAL_HEROES_COUNT = 20;

    struct HeroAttributes {
        uint256 heroIndex; // 1 to 20
        string heroName;
        string title;
        string role;
        string lane;
        string passiveSkill;
        string qSkill;
        string wSkill;
        string eSkill;
        string ultSkill;
        uint256 battlePower;
        uint256 level;
        uint256 mintTimestamp;
    }

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    mapping(uint256 => HeroAttributes) public heroData;
    mapping(address => uint256) public activeEquippedHero;

    // Pre-defined static hero templates for the 20 MOBA heroes
    struct HeroTemplate {
        string heroName;
        string title;
        string role;
        string lane;
        string passive;
        string q;
        string w;
        string e;
        string ult;
    }

    mapping(uint256 => HeroTemplate) public templates;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event HeroMinted(address indexed player, uint256 indexed tokenId, uint256 heroIndex, string name);
    event HeroEquipped(address indexed player, uint256 indexed tokenId, uint256 heroIndex);
    event HeroLevelUp(uint256 indexed tokenId, uint256 newLevel, uint256 newBattlePower);

    modifier onlyOwner() {
        require(msg.sender == owner, "GMAIHero: Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        _initTemplates();
    }

    function _initTemplates() internal {
        templates[1] = HeroTemplate("Nexus", "The Neural Vanguard", "Tank / Initiator", "Frontline", "Shield", "Charge", "Ally Damage Link", "Guardian Armor", "Nexus Override");
        templates[2] = HeroTemplate("Vyra", "The Quantum Assassin", "Assassin", "Jungle / Roam", "Phase Step", "Quantum Mark", "Afterimage", "Zero-Frame Strike", "Zero Frame");
        templates[3] = HeroTemplate("Aura", "The Synthweaver", "Support / Mage", "Support", "Pulse Heal", "Prism Link", "Holo Barrier", "Synthesis Field", "Synthesis Field");
        templates[4] = HeroTemplate("Rex-9", "The Arena Machine", "Fighter", "Solo", "Power Punch", "Overdrive", "Reactive Armor", "Arena Breaker", "Arena Breaker");
        templates[5] = HeroTemplate("Lyra", "The Cyber Archer", "Marksman", "Bottom", "Photon Arrow", "Tracking Mark", "Energy Volley", "Starfall", "Starfall");
        templates[6] = HeroTemplate("Zeron", "The Void Hacker", "Mage / Controller", "Mid", "Code Spike", "System Corruption", "Firewall", "Kernel Panic", "Kernel Panic");
        templates[7] = HeroTemplate("Kira-7", "The Combat Android", "Fighter / Assassin", "Jungle", "Adaptive Combat", "Dash Slash", "Counter Protocol", "Combat Scan", "Perfect Execution");
        templates[8] = HeroTemplate("Orion", "The Star Engineer", "Mage / Artillery", "Mid", "Solar Bolt", "Gravity Well", "Orbit", "Artificial Supernova", "Artificial Supernova");
        templates[9] = HeroTemplate("Mira", "The Memory Keeper", "Support / Controller", "Support", "Recall", "Memory Fragment", "Echo Shield", "Second Chance", "Second Chance");
        templates[10] = HeroTemplate("Titan-X", "The Mech Colossus", "Tank", "Solo / Frontline", "Steel Charge", "Rail Shot", "Fortress Mode", "Colossus", "Colossus");
        templates[11] = HeroTemplate("Nova", "The Energy Runner", "Assassin", "Jungle", "Flash Run", "Momentum", "Portal Dash", "Lightspeed", "Lightspeed");
        templates[12] = HeroTemplate("Echo", "The Sonic AI", "Mage / Support", "Mid / Support", "Sound Wave", "Resonance", "Silence Pulse", "Final Frequency", "Final Frequency");
        templates[13] = HeroTemplate("Vanta", "The Shadow Protocol", "Assassin", "Jungle", "Shadow Dive", "Dark Mark", "Null Step", "Delete from Reality", "Delete from Reality");
        templates[14] = HeroTemplate("Solara", "The Plasma Guardian", "Fighter / Support", "Solo", "Solar Strike", "Radiant Shield", "Burning Path", "Solar Ascension", "Solar Ascension");
        templates[15] = HeroTemplate("Byte", "The Nano Swarm", "Specialist / Controller", "Flexible", "Swarm", "Nano Repair", "Assimilate", "Swarm Apocalypse", "Swarm Apocalypse");
        templates[16] = HeroTemplate("Drax", "The Blockchain Warlord", "Fighter / Tank", "Solo", "Ledger Smash", "Chain Guard", "Immutable Armor", "Block Finality", "Block Finality");
        templates[17] = HeroTemplate("Selene", "The Dream Architect", "Mage / Controller", "Mid", "Dream Bolt", "Illusion", "Sleep Protocol", "Dreamworld", "Dreamworld");
        templates[18] = HeroTemplate("Gravis", "The Gravity Beast", "Tank", "Frontline", "Gravity Slam", "Pull", "Mass Shift", "Singularity", "Singularity");
        templates[19] = HeroTemplate("Pixel", "The Reality Glitch", "Mage / Assassin", "Mid", "Pixel Shot", "Glitch Step", "Error Clone", "System Crash", "System Crash");
        templates[20] = HeroTemplate("Aegis", "The Genesis Guardian", "Tank / Support", "Frontline", "Guardian Strike", "Protective Dome", "Taunt Protocol", "Genesis Defense", "Genesis Defense");
    }

    /**
     * @notice Mints a specific MOBA Hero (1 to 20) for the caller.
     */
    function mintHero(uint256 heroIndex) public returns (uint256) {
        require(heroIndex >= 1 && heroIndex <= TOTAL_HEROES_COUNT, "GMAIHero: Invalid heroIndex (1-20)");
        uint256 tokenId = nextTokenId++;

        HeroTemplate memory t = templates[heroIndex];

        heroData[tokenId] = HeroAttributes({
            heroIndex: heroIndex,
            heroName: t.heroName,
            title: t.title,
            role: t.role,
            lane: t.lane,
            passiveSkill: t.passive,
            qSkill: t.q,
            wSkill: t.w,
            eSkill: t.e,
            ultSkill: t.ult,
            battlePower: 1000 + (heroIndex * 35),
            level: 1,
            mintTimestamp: block.timestamp
        });

        _balances[msg.sender] += 1;
        _owners[tokenId] = msg.sender;

        if (activeEquippedHero[msg.sender] == 0) {
            activeEquippedHero[msg.sender] = tokenId;
        }

        emit Transfer(address(0), msg.sender, tokenId);
        emit HeroMinted(msg.sender, tokenId, heroIndex, t.heroName);

        return tokenId;
    }

    /**
     * @notice Equips a hero token as the active avatar for metaverse matchmaking.
     */
    function equipHero(uint256 tokenId) external {
        require(_owners[tokenId] == msg.sender, "GMAIHero: Not your token");
        activeEquippedHero[msg.sender] = tokenId;
        emit HeroEquipped(msg.sender, tokenId, heroData[tokenId].heroIndex);
    }

    /**
     * @notice Level up hero attributes through training or battle experience.
     */
    function levelUpHero(uint256 tokenId) external {
        require(_owners[tokenId] == msg.sender, "GMAIHero: Not owner of NFT");
        HeroAttributes storage h = heroData[tokenId];
        h.level += 1;
        h.battlePower += 150;
        emit HeroLevelUp(tokenId, h.level, h.battlePower);
    }

    // --- Standard ERC-721 Interface ---

    function balanceOf(address account) external view returns (uint256) {
        require(account != address(0), "GMAIHero: Zero address");
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address currentOwner = _owners[tokenId];
        require(currentOwner != address(0), "GMAIHero: Token nonexistent");
        return currentOwner;
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        require(msg.sender == tokenOwner || isApprovedForAll(tokenOwner, msg.sender), "GMAIHero: Not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "GMAIHero: Nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf(tokenId) == from, "GMAIHero: Transfer from incorrect owner");
        require(to != address(0), "GMAIHero: Transfer to zero");
        require(
            msg.sender == from || 
            _tokenApprovals[tokenId] == msg.sender || 
            isApprovedForAll(from, msg.sender),
            "GMAIHero: Not approved"
        );

        _tokenApprovals[tokenId] = address(0);
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        if (activeEquippedHero[from] == tokenId) {
            activeEquippedHero[from] = 0;
        }

        emit Transfer(from, to, tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_owners[tokenId] != address(0), "GMAIHero: Nonexistent token");
        HeroAttributes memory h = heroData[tokenId];
        return string(abi.encodePacked("https://api.gamemindai.io/heroes/", h.heroName, ".json"));
    }
}
