// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SidraTempestAtomicExecutor (STAE)
 * @notice Production-grade, non-custodial Atomic Arbitrage Executor for Sidra Chain (Chain ID: 97453).
 * @dev Executes complete buy-and-sell cross-pool or multi-hop arbitrage within ONE single EVM transaction.
 *      If the final WSDA output does not exceed (amountIn + minProfit), the entire transaction reverts
 *      atomically so the operator never holds intermediate tokens or suffers principal loss.
 */

interface IERC20Minimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

interface IWSDA is IERC20Minimal {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface ISidraV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract SidraTempestAtomicExecutor {
    // =========================================================================
    // STATE VARIABLES & IMMUTABLES
    // =========================================================================
    address public owner;
    address public immutable wsda;
    bool public paused;
    uint256 private _unlocked = 1;

    uint256 public minTradeSizeWei;
    uint256 public maxTradeSizeWei;
    uint256 public defaultMinProfitWei;

    mapping(address => bool) public authorizedOperators;
    mapping(address => bool) public whitelistedRouters;
    mapping(address => bool) public whitelistedTokens;
    mapping(address => bool) public whitelistedRecipients;

    // =========================================================================
    // EVENTS
    // =========================================================================
    event AtomicArbExecuted(
        address indexed operator,
        address indexed token,
        address indexed recipient,
        uint256 amountInWei,
        uint256 amountOutWei,
        uint256 netProfitWei,
        uint24 feeBuy,
        uint24 feeSell
    );
    event AtomicMultiHopExecuted(
        address indexed operator,
        address indexed recipient,
        uint256 amountInWei,
        uint256 amountOutWei,
        uint256 netProfitWei
    );
    event OperatorUpdated(address indexed operator, bool allowed);
    event RouterWhitelisted(address indexed router, bool allowed);
    event TokenWhitelisted(address indexed token, bool allowed);
    event RecipientWhitelisted(address indexed recipient, bool allowed);
    event TradeLimitsUpdated(uint256 minTradeWei, uint256 maxTradeWei, uint256 defaultMinProfitWei);
    event EmergencyPaused(address indexed triggeredBy, bool isPaused);
    event EmergencyTokenRescued(address indexed token, address indexed to, uint256 amount);

    // =========================================================================
    // ERRORS
    // =========================================================================
    error Unauthorized();
    error ContractPaused();
    error ReentrancyGuard();
    error DeadlineExpired(uint256 deadline, uint256 currentTimestamp);
    error RouterNotWhitelisted(address router);
    error TokenNotWhitelisted(address token);
    error RecipientNotWhitelisted(address recipient);
    error TradeSizeOutOfBounds(uint256 amountIn, uint256 minAllowed, uint256 maxAllowed);
    error InsufficientAtomicProfit(uint256 amountIn, uint256 amountOut, uint256 requiredOut);
    error StrandedTokenBalanceDetected(address token, uint256 remainingBalance);
    error SafeTransferFailed(address token, address to, uint256 amount);

    // =========================================================================
    // MODIFIERS
    // =========================================================================
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != owner && !authorizedOperators[msg.sender]) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_unlocked != 1) revert ReentrancyGuard();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================
    constructor(
        address _wsda,
        address _defaultRouter,
        uint256 _minTradeSizeWei,
        uint256 _maxTradeSizeWei,
        uint256 _defaultMinProfitWei
    ) {
        require(_wsda != address(0) && _defaultRouter != address(0), "Zero address");
        owner = msg.sender;
        wsda = _wsda;

        minTradeSizeWei = _minTradeSizeWei;
        maxTradeSizeWei = _maxTradeSizeWei;
        defaultMinProfitWei = _defaultMinProfitWei;

        authorizedOperators[msg.sender] = true;
        whitelistedRouters[_defaultRouter] = true;
        whitelistedTokens[_wsda] = true;
        whitelistedRecipients[msg.sender] = true;
    }

    // =========================================================================
    // ATOMIC ARBITRAGE EXECUTION (TWO-LEG CROSS-POOL IN ONE TRANSACTION)
    // =========================================================================
    struct CrossPoolArbParams {
        address routerBuy;
        address routerSell;
        address targetToken;
        uint24 feeBuy;
        uint24 feeSell;
        uint256 amountInWei;
        uint256 minLeg1TokenOutWei;
        uint256 minTotalWsdaOutWei;
        uint256 minProfitWei;
        uint256 deadline;
        address profitRecipient;
    }

    /**
     * @notice Executes Leg 1 (WSDA -> Token) and Leg 2 (Token -> WSDA) atomically in one EVM transaction.
     *         Pulls `amountInWei` WSDA from `msg.sender` (or uses pre-funded contract balance) and returns
     *         principal + profit to `profitRecipient`. Reverts the entire transaction if final WSDA < amountIn + minProfit.
     */
    function executeAtomicCrossPoolArb(
        CrossPoolArbParams calldata params
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 amountOutWei, uint256 netProfitWei) {
        if (block.timestamp > params.deadline) {
            revert DeadlineExpired(params.deadline, block.timestamp);
        }
        if (!whitelistedRouters[params.routerBuy]) revert RouterNotWhitelisted(params.routerBuy);
        if (!whitelistedRouters[params.routerSell]) revert RouterNotWhitelisted(params.routerSell);
        if (!whitelistedTokens[params.targetToken]) revert TokenNotWhitelisted(params.targetToken);
        if (!whitelistedRecipients[params.profitRecipient]) revert RecipientNotWhitelisted(params.profitRecipient);

        if (params.amountInWei < minTradeSizeWei || params.amountInWei > maxTradeSizeWei) {
            revert TradeSizeOutOfBounds(params.amountInWei, minTradeSizeWei, maxTradeSizeWei);
        }

        uint256 requiredProfit = params.minProfitWei > defaultMinProfitWei ? params.minProfitWei : defaultMinProfitWei;
        uint256 requiredFinalWsda = params.amountInWei + requiredProfit;
        if (params.minTotalWsdaOutWei > requiredFinalWsda) {
            requiredFinalWsda = params.minTotalWsdaOutWei;
        }

        require(params.minLeg1TokenOutWei > 0, "Zero Leg 1 amountOutMinimum forbidden");

        IERC20Minimal wsdaToken = IERC20Minimal(wsda);
        IERC20Minimal arbToken = IERC20Minimal(params.targetToken);

        // Pull WSDA from operator if not already in contract
        uint256 contractWsdaBefore = wsdaToken.balanceOf(address(this));
        if (contractWsdaBefore < params.amountInWei) {
            uint256 pullAmt = params.amountInWei - contractWsdaBefore;
            _safeTransferFrom(wsda, msg.sender, address(this), pullAmt);
        }

        uint256 wsdaBaseline = wsdaToken.balanceOf(address(this)) - params.amountInWei;
        uint256 tokenBaseline = arbToken.balanceOf(address(this));

        // Approve routerBuy for WSDA
        _ensureAllowance(wsda, params.routerBuy, params.amountInWei);

        // Leg 1: Swap WSDA -> targetToken
        uint256 acquiredTokens = ISidraV3SwapRouter(params.routerBuy).exactInputSingle(
            ISidraV3SwapRouter.ExactInputSingleParams({
                tokenIn: wsda,
                tokenOut: params.targetToken,
                fee: params.feeBuy,
                recipient: address(this),
                deadline: params.deadline,
                amountIn: params.amountInWei,
                amountOutMinimum: params.minLeg1TokenOutWei,
                sqrtPriceLimitX96: 0
            })
        );

        uint256 actualTokenDelta = arbToken.balanceOf(address(this)) - tokenBaseline;
        uint256 sellAmount = actualTokenDelta < acquiredTokens ? actualTokenDelta : acquiredTokens;
        require(sellAmount >= params.minLeg1TokenOutWei, "Insufficient Leg 1 tokens received");

        // Approve routerSell for targetToken
        _ensureAllowance(params.targetToken, params.routerSell, sellAmount);

        // Leg 2: Swap 100% of acquired targetToken -> WSDA
        amountOutWei = ISidraV3SwapRouter(params.routerSell).exactInputSingle(
            ISidraV3SwapRouter.ExactInputSingleParams({
                tokenIn: params.targetToken,
                tokenOut: wsda,
                fee: params.feeSell,
                recipient: address(this),
                deadline: params.deadline,
                amountIn: sellAmount,
                amountOutMinimum: requiredFinalWsda,
                sqrtPriceLimitX96: 0
            })
        );

        // Verify zero leftover targetToken and strict WSDA balance gain
        uint256 remainingToken = arbToken.balanceOf(address(this)) - tokenBaseline;
        if (remainingToken > 0) {
            revert StrandedTokenBalanceDetected(params.targetToken, remainingToken);
        }

        uint256 wsdaAfter = wsdaToken.balanceOf(address(this));
        uint256 realizedWsdaOut = wsdaAfter - wsdaBaseline;
        if (realizedWsdaOut < requiredFinalWsda) {
            revert InsufficientAtomicProfit(params.amountInWei, realizedWsdaOut, requiredFinalWsda);
        }

        netProfitWei = realizedWsdaOut - params.amountInWei;

        // Return principal + profit to whitelisted profitRecipient
        _safeTransfer(wsda, params.profitRecipient, realizedWsdaOut);

        emit AtomicArbExecuted(
            msg.sender,
            params.targetToken,
            params.profitRecipient,
            params.amountInWei,
            realizedWsdaOut,
            netProfitWei,
            params.feeBuy,
            params.feeSell
        );
    }

    // =========================================================================
    // ADMIN & RISK CONTROLS
    // =========================================================================
    function setOperator(address operator, bool allowed) external onlyOwner {
        authorizedOperators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function setRouterWhitelist(address router, bool allowed) external onlyOwner {
        whitelistedRouters[router] = allowed;
        emit RouterWhitelisted(router, allowed);
    }

    function setTokenWhitelist(address token, bool allowed) external onlyOwner {
        whitelistedTokens[token] = allowed;
        emit TokenWhitelisted(token, allowed);
    }

    function setBatchTokenWhitelist(address[] calldata tokens, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            whitelistedTokens[tokens[i]] = allowed;
            emit TokenWhitelisted(tokens[i], allowed);
        }
    }

    function setRecipientWhitelist(address recipient, bool allowed) external onlyOwner {
        whitelistedRecipients[recipient] = allowed;
        emit RecipientWhitelisted(recipient, allowed);
    }

    function setTradeLimits(
        uint256 _minTradeWei,
        uint256 _maxTradeWei,
        uint256 _defaultMinProfitWei
    ) external onlyOwner {
        require(_minTradeWei > 0 && _maxTradeWei >= _minTradeWei, "Invalid trade bounds");
        minTradeSizeWei = _minTradeWei;
        maxTradeSizeWei = _maxTradeWei;
        defaultMinProfitWei = _defaultMinProfitWei;
        emit TradeLimitsUpdated(_minTradeWei, _maxTradeWei, _defaultMinProfitWei);
    }

    function setPaused(bool _paused) external onlyOperator {
        paused = _paused;
        emit EmergencyPaused(msg.sender, _paused);
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (!whitelistedRecipients[to]) revert RecipientNotWhitelisted(to);
        _safeTransfer(token, to, amount);
        emit EmergencyTokenRescued(token, to, amount);
    }

    // =========================================================================
    // INTERNAL SAFE ERC20 HELPERS
    // =========================================================================
    function _ensureAllowance(address token, address spender, uint256 requiredAmount) internal {
        uint256 current = IERC20Minimal(token).allowance(address(this), spender);
        if (current < requiredAmount) {
            bool ok = IERC20Minimal(token).approve(spender, type(uint256).max);
            if (!ok) revert SafeTransferFailed(token, spender, requiredAmount);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed(token, to, amount);
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed(token, to, amount);
        }
    }
}

