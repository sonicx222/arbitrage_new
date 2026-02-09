# Overview

Welcome to the SyncSwap API documentation.

SyncSwap protocol is a suite of Smart Contracts deployed on zkSync Era network.

# Vault

The Vault is a contract for storing and transferring funds for liquidity pools. It is designed to support internal transfers between liquidity pools to reduce gas costs and potential transfer taxes.

The Vault supports deposit, withdrawal, and transfers with native ETH and ERC20 tokens. Additionally, the Vault has integrated the flash loan feature.

## wETH

The vault integrates wETH by nature. All wETH deposits will be immediately unwrapped to native ETH and will wrap ETH on withdrawing wETH. The reserve and balance of wETH and ETH are the same value.

For native ETH, the vault uses the zero address as its address placeholder.

You can use the following functions to get the wETH address.

```solidity
// Returns address of the wETH contract.
function wETH() external view returns (address);
```

## Balance

You can use the following functions to get the token balance of an account in the vault. The balance of wETH and ETH is the same value.

```solidity
// Returns token balance of the owner.
// Use `address(0)` or wETH address for ETH balance.
function balanceOf(address token, address owner) external view returns (uint balance);

```

## Reserve

The reserve is the total amount of specific token in the vault since the token's last event (deposit, transfer, or withdraw).

You can use the following functions to query the reserve of a token.

```solidity
// Returns reserve of the token. Use `address(0)` or wETH address for ETH.
function reserves(address token) external view returns (uint);
```

## Deposit

By depositing to the vault, the corresponding token balance of the account will be increased. All wETH deposits will be immediately unwrapped to native ETH.

You can use the following functions to deposit.

```solidity

// Deposit ETH or ERC20 tokens with recipient.
// Use `address(0)` as `token` with value to deposit native ETH.
// Returns `msg.value` for ETH and actual amount received for ERC20 tokens.
function deposit(address token, address to) public payable returns (uint amount);

// Deposit ETH with recipient, returns `msg.value`.
function depositETH(address to) external payable returns (uint amount);

// Transfer ERC20 tokens of given amount from `msg.sender` and deposit with recipient.
// This requires pre-approval of the ERC20 token.
// This function also supports ETH deposit, use `address(0)` as `token` for ETH.
// For ETH deposits, `amount` must match `msg.value`.
// Returns `msg.value` for ETH and actual amount received for ERC20 tokens.
function transferAndDeposit(address token, address to, uint amount) external payable returns (uint);

```

## Transfer

The vault transfer allows moving balances between accounts without actually transferring the token to reduce gas costs or avoid transfer taxes.

You can use the following functions to transfer.

```solidity
// Transfer ETH or ERC20 tokens to recipient.
// Use `address(0)` or wETH address for ETH.
function transfer(address token, address to, uint amount) external;

```

## Withdraw

By withdrawing, the account's balance will be decreased, and the underlying assets will be transferred out.

You can use the following functions to withdraw.

```solidity
// Withdraw ETH or ERC20 tokens to recipient.
// Use `address(0)` to withdraw native ETH, and use the wETH address to withdraw wETH.
function withdraw(address token, address to, uint amount) external;

// Withdraw ETH or ERC20 tokens to recipient with mode.
// The mode has no effects for ERC20 tokens, and is only for ETH/wETH.
// Supported modes:
// `0` - default behavior, withdraw native ETH when the `token` is `address(0)`, and wETH when `token` is the wETH.
// `1` - unwrapped, always withdraw native ETH.
// `2` - wrapped, always withdraw wETH.
function withdrawAlternative(address token, address to, uint amount, uint8 mode) external;

// Withdraw some native ETH to recipient.
function withdrawETH(address to, uint amount) external;

```

## Flash Loan

WIP

## Interface

```solidity

interface IVault is IFlashLoan {
    function wETH() external view returns (address);

    function reserves(address token) external view returns (uint reserve);

    function balanceOf(address token, address owner) external view returns (uint balance);

    function deposit(address token, address to) external payable returns (uint amount);

    function depositETH(address to) external payable returns (uint amount);

    function transferAndDeposit(address token, address to, uint amount) external payable;

    function transfer(address token, address to, uint amount) external;

    function withdraw(address token, address to, uint amount) external;

    function withdrawAlternative(address token, address to, uint amount, uint8 mode) external;

    function withdrawETH(address to, uint amount) external;
}

interface IFlashLoan {
    // Balancer style multiple flashloan

    /**
     * @dev Performs a 'flash loan', sending tokens to `recipient`, executing the `receiveFlashLoan` hook on it,
     * and then reverting unless the tokens plus a proportional protocol fee have been returned.
     *
     * The `tokens` and `amounts` arrays must have the same length, and each entry in these indicates the loan amount
     * for each token contract. `tokens` must be sorted in ascending order.
     *
     * The 'userData' field is ignored by the Vault, and forwarded as-is to `recipient` as part of the
     * `receiveFlashLoan` call.
     *
     * Emits `FlashLoan` events.
     */
    function flashLoanMultiple(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint[] memory amounts,
        bytes memory userData
    ) external;
    
    // EIP-3156 style flashloan
    
    /**
     * @dev The amount of currency available to be lent.
     * @param token The loan currency.
     * @return The amount of `token` that can be borrowed.
     */
    // Returns `IERC20(token).balanceOf(address(this))`
    function maxFlashLoan(address token) external view returns (uint256);
    
    /**
     * @dev The fee to be charged for a given loan.
     * @param amount The amount of tokens lent.
     * @return The amount of `token` to be charged for the loan, on top of the returned principal.
     */
    // Returns `amount * flashLoanFeePercentage / 1e18`
    function flashFee(address token, uint256 amount) external view returns (uint256);
    
    /**
     * @dev Initiate a flash loan.
     * @param receiver The receiver of the tokens in the loan, and the receiver of the callback.
     * @param token The loan currency.
     * @param amount The amount of tokens lent.
     * @param userData Arbitrary data structure, intended to contain user-defined parameters.
     */
    function flashLoan(
        IERC3156FlashBorrower receiver,
        address token,
        uint amount,
        bytes memory userData
    ) external returns (bool);

    // The fee percentage is in 18 decimals.
    // Fees will be applied to the surplus balance (postLoanBalance - preLoanBalance).
    function flashLoanFeePercentage() external view returns (uint);

    /**
     * @dev Emitted for each individual flash loan performed by `flashLoan`.
     */
    event FlashLoan(IFlashLoanRecipient indexed recipient, address indexed token, uint amount, uint feeAmount);
}

// Callback for multiple flashloan
interface IFlashLoanRecipient {
    /**
     * @dev When `flashLoan` is called on the Vault, it invokes the `receiveFlashLoan` hook on the recipient.
     *
     * At the time of the call, the Vault will have transferred `amounts` for `tokens` to the recipient. Before this
     * call returns, the recipient must have transferred `amounts` plus `feeAmounts` for each token back to the
     * Vault, or else the entire flash loan will revert.
     *
     * `userData` is the same value passed in the `IVault.flashLoan` call.
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint[] memory amounts,
        uint[] memory feeAmounts,
        bytes memory userData
    ) external;
}

// Callback for ERC3156 flashloan
interface IERC3156FlashBorrower {
    /**
     * @dev Receive a flash loan.
     * @param initiator The initiator of the loan.
     * @param token The loan currency.
     * @param amount The amount of tokens lent.
     * @param fee The additional amount of tokens to repay.
     * @param data Arbitrary data structure, intended to contain user-defined parameters.
     * @return The keccak256 hash of "ERC3156FlashBorrower.onFlashLoan"
     */
    function onFlashLoan(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}

```
# Pool Master

The Pool Master is a registry for all liquidity pools and manages the whitelist of pool factories.

The master inherits the interface of the fee manager to support the queries of pools' trading fees and the protocol fees in one place.

## Interface

See the Fee Manager for more information regarding fees.

```solidity

/// @dev The master contract to create pools and manage whitelisted factories.
/// Inheriting the fee manager interface to support fee queries.
interface IPoolMaster is IFeeManager {
    event SetFactoryWhitelisted(address indexed factory, bool whitelisted);

    event RegisterPool(
        address indexed factory,
        address indexed pool,
        uint16 indexed poolType,
        bytes data
    );

    event UpdateFeeManager(address indexed previousFeeManager, address indexed newFeeManager);

    function vault() external view returns (address);

    function feeManager() external view returns (address);

    // Fees
    function setFeeManager(address) external;

    // Factories
    function isFactoryWhitelisted(address) external view returns (bool);

    function setFactoryWhitelisted(address factory, bool whitelisted) external;

    // Pools
    function isPool(address) external view returns (bool);

    function getPool(bytes32) external view returns (address);
    
    function pools(uint index) external view returns (address);
    
    function poolsLength() external view returns (uint);

    function createPool(address factory, bytes calldata data) external returns (address pool);

    function registerPool(address pool, uint16 poolType, bytes calldata data) external;
}

/// @dev The manager contract to control fees.
/// Management functions are omitted.
interface IFeeManager {
    // [Deprecated] The old interface before the dynamic fees update.
    //function defaultSwapFee(uint16 poolType) external view returns (uint24);

    // [Deprecated] The old interface before the dynamic fees update.
    //function customSwapFee(address pool) external view returns (uint24);

    // [Deprecated] The old interface before the dynamic fees update.
    //function feeRecipient() external view returns (address);

    // [Deprecated] The old interface before the dynamic fees update.
    //function protocolFee(uint16 poolType) external view returns (uint24);
    
    // [Deprecated] The old interface before the dynamic fees update.
    //function getSwapFee(address pool) external view returns (uint24 swapFee);
    
    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `0` for zero pool fee.
    function getSwapFee(
        address pool,
        address sender,
        address tokenIn,
        address tokenOut,
        bytes calldata data
    ) external view returns (uint24 fee);
    
    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `0` for zero pool fee.
    function getProtocolFee(address pool) external view returns (uint24 fee);
    
    // [Recommended] The new interface after the dynamic fees update.
    function getFeeRecipient() external view returns (address recipient);
}

```
# Fee Manager

The Fee Manager manages trading fees for pools and the global protocol fee.

The Pool Master is an independent module that could be replaced in the future. Since the pool master will forward all fee queries to the current fee manager, it's recommended to get fees directly with the pool master.

## Interface

Fees are stored in `uint24` type with `6` decimals. For a protocol fee of `30%`, the value will be `30,000` and for a trading fee of `0.1%`, the value would be `100`.

Since the default value of `uint24` in the mappings is zero, the custom fee value of pools without a specific custom fee is `0`, which actually indicates the pool fee will inherit the default fee of its pool type.

For pools with zero custom fee `type(uint24).max` will be used as the custom fee. This does not affect the default swap fee of pool types and the protocol fee, and the `0` value simply indicates zero fees.

```solidity

/// @dev The manager contract to control fees.
/// Management functions are omitted.
interface IFeeManager {
    function defaultSwapFee(uint16 poolType) external view returns (uint24);

    // [Deprecated] The old interface before the dynamic fees update.
    //function customSwapFee(address pool) external view returns (uint24);

    function feeRecipient() external view returns (address);

    // [Deprecated] The old interface before the dynamic fees update.
    //function protocolFee(uint16 poolType) external view returns (uint24);
    
    // [Deprecated] The old interface before the dynamic fees update.
    //function getSwapFee(address pool) external view returns (uint24 swapFee);

    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `0` for zero pool fee.
    function getSwapFee(
        address pool,
        address sender,
        address tokenIn,
        address tokenOut,
        bytes calldata data
    ) external view returns (uint24 fee);
    
    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `0` for zero pool fee.
    function getProtocolFee(address pool) external view returns (uint24 fee);

    // [Recommended] The new interface after the dynamic fees update.
    function getFeeRecipient() external view returns (address recipient);

    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `type(uint24).max` for zero pool fee.
    function poolSwapFee(address pool) external view returns (uint24);
    
    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `0` for zero pool fee.
    function defaultProtocolFee(uint16 poolType) external view returns (uint24);

    // [Recommended] The new interface after the dynamic fees update.
    /// @dev Returns `type(uint24).max` for zero pool fee.
    function poolProtocolFee(address pool) external view returns (uint24);
}

```
# Pool

A Pool describes a specific AMM trading algorithm and enables the storage and transfer of funds through the Vault.

Currently, there are two types of pools.

* **Classic Pool** for general purpose
* **Stable Pool** for efficient stablecoin exchange

## Prefund the Pool with Vault

Like Uniswap V2 pools, the pool must be prefund before executing swapping. However, different from directly transferring tokens to the pool contract, caller have to prefund the pool via Vault deposit.

Here is an example.

```solidity
// ...

// Transfer tokens from user and prefund the pool.
if (token == NATIVE_ETH) {
    // Deposit ETH to the vault.
    IVault(vault).deposit{value: amount}(token, pool);
} else {
    // Transfer tokens to the vault.
    TransferHelper.safeTransferFrom(token, msg.sender, vault, amount);

    // Notify the vault to deposit.
    IVault(vault).deposit(token, pool);
}

// Execute swap with the pool.
IBasePool(pool).swap(data);

```

## Withdraw Tokens to Recipient

The `withdrawMode` on swapping will determine how to send the swapped tokens.

A `withdrawMode` of `0` will do an internal transfer. Please specify a withdraw mode, no matter whether the token is ETH, if you want to send the swapped tokens to the user account instead of leaving them in the vault. The withdraw mode has no effects on ERC20 tokens.

The following is the transfer implementation of pools.

```solidity

// Transfer swapped tokens to recipient.
function _transferTokens(address token, address to, uint amount, uint8 withdrawMode) private {
    if (withdrawMode == 0) {
        IVault(vault).transfer(token, to, amount);
    } else {
        IVault(vault).withdrawAlternative(token, to, amount, withdrawMode);
    }
}

```

## Interface

The sender needs to be equal to `msg.sender` or sent from a trusted forwarder (the router), otherwise will be set to `address(0)` when passing to the callback.

```solidity
// The standard interface.
interface IPool {
    struct TokenAmount {
        address token;
        uint amount;
    }

    /// @dev Returns the address of pool master.
    function master() external view returns (address);

    /// @dev Returns the vault.
    function vault() external view returns (address);

    // [Deprecated] This is the interface before the dynamic fees update.
    /// @dev Returns the pool type.
    function poolType() external view returns (uint16);

    /// @dev Returns the assets of the pool.
    function getAssets() external view returns (address[] memory assets);

    // [Deprecated] This is the interface before the dynamic fees update.
    /// @dev Returns the swap fee of the pool.
    // This function will forward calls to the pool master.
    // function getSwapFee() external view returns (uint24 swapFee);
    
     // [Recommended] This is the latest interface.
    /// @dev Returns the swap fee of the pool.
    /// This function will forward calls to the pool master.
    function getSwapFee(
        address sender, address tokenIn, address tokenOut, bytes calldata data
    ) external view returns (uint24 swapFee);

    /// @dev Returns the protocol fee of the pool.
    function getProtocolFee() external view returns (uint24 protocolFee);

    // [Deprecated] The old interface for Era testnet.
    /// @dev Mints liquidity.
    // The data for Classic and Stable Pool is as follows.
    // `address _to = abi.decode(_data, (address));`
    //function mint(bytes calldata data) external returns (uint liquidity);
    
    /// @dev Mints liquidity.
    function mint(
        bytes calldata data,
        address sender,
        address callback,
        bytes calldata callbackData
    ) external returns (uint liquidity);

    // [Deprecated] The old interface for Era testnet.
    /// @dev Burns liquidity.
    // The data for Classic and Stable Pool is as follows.
    // `(address _to, uint8 _withdrawMode) = abi.decode(_data, (address, uint8));`
    //function burn(bytes calldata data) external returns (TokenAmount[] memory amounts);

    /// @dev Burns liquidity.
    function burn(
        bytes calldata data,
        address sender,
        address callback,
        bytes calldata callbackData
    ) external returns (TokenAmount[] memory tokenAmounts);

    // [Deprecated] The old interface for Era testnet.
    /// @dev Burns liquidity with single output token.
    // The data for Classic and Stable Pool is as follows.
    // `(address _tokenOut, address _to, uint8 _withdrawMode) = abi.decode(_data, (address, address, uint8));`
    //function burnSingle(bytes calldata data) external returns (uint amountOut);

    /// @dev Burns liquidity with single output token.
    function burnSingle(
        bytes calldata data,
        address sender,
        address callback,
        bytes calldata callbackData
    ) external returns (TokenAmount memory tokenAmount);

    // [Deprecated] The old interface for Era testnet.
    /// @dev Swaps between tokens.
    // The data for Classic and Stable Pool is as follows.
    // `(address _tokenIn, address _to, uint8 _withdrawMode) = abi.decode(_data, (address, address, uint8));`
    //function swap(bytes calldata data) external returns (uint amountOut);

    /// @dev Swaps between tokens.
    function swap(
        bytes calldata data,
        address sender,
        address callback,
        bytes calldata callbackData
    ) external returns (TokenAmount memory tokenAmount);
}

// The base interface, with two tokens and Liquidity Pool (LP) token.
interface IBasePool is IPool, IERC20Permit2 {
    function token0() external view returns (address);
    function token1() external view returns (address);

    function reserve0() external view returns (uint);
    function reserve1() external view returns (uint);
    function invariantLast() external view returns (uint);

    function getReserves() external view returns (uint, uint);
    
    // [Deprecated] The old interface for Era testnet.
    //function getAmountOut(address tokenIn, uint amountIn) external view returns (uint amountOut);
    //function getAmountIn(address tokenOut, uint amountOut) external view returns (uint amountIn);

    function getAmountOut(address tokenIn, uint amountIn, address sender) external view returns (uint amountOut);
    function getAmountIn(address tokenOut, uint amountOut, address sender) external view returns (uint amountIn);

    event Mint(
        address indexed sender,
        uint amount0,
        uint amount1,
        uint liquidity,
        address indexed to
    );

    event Burn(
        address indexed sender,
        uint amount0,
        uint amount1,
        uint liquidity,
        address indexed to
    );

    event Swap(
        address indexed sender,
        uint amount0In,
        uint amount1In,
        uint amount0Out,
        uint amount1Out,
        address indexed to
    );

    event Sync(
        uint reserve0,
        uint reserve1
    );
}

// The Classic Pool.
interface IClassicPool is IBasePool {
}

// The Stable Pool with the additional multiplier for pool tokens.
interface IStablePool is IBasePool {
    function token0PrecisionMultiplier() external view returns (uint);
    function token1PrecisionMultiplier() external view returns (uint);
}

// The interface of callback (optional).
interface ICallback {

    struct BaseMintCallbackParams {
        address sender;
        address to;
        uint reserve0;
        uint reserve1;
        uint balance0;
        uint balance1;
        uint amount0;
        uint amount1;
        uint fee0;
        uint fee1;
        uint newInvariant;
        uint oldInvariant;
        uint totalSupply;
        uint liquidity;
        uint24 swapFee;
        bytes callbackData;
    }
    function syncSwapBaseMintCallback(BaseMintCallbackParams calldata params) external;

    struct BaseBurnCallbackParams {
        address sender;
        address to;
        uint balance0;
        uint balance1;
        uint liquidity;
        uint totalSupply;
        uint amount0;
        uint amount1;
        uint8 withdrawMode;
        bytes callbackData;
    }
    function syncSwapBaseBurnCallback(BaseBurnCallbackParams calldata params) external;

    struct BaseBurnSingleCallbackParams {
        address sender;
        address to;
        address tokenIn;
        address tokenOut;
        uint balance0;
        uint balance1;
        uint liquidity;
        uint totalSupply;
        uint amount0;
        uint amount1;
        uint amountOut;
        uint amountSwapped;
        uint feeIn;
        uint24 swapFee;
        uint8 withdrawMode;
        bytes callbackData;
    }
    function syncSwapBaseBurnSingleCallback(BaseBurnSingleCallbackParams calldata params) external;

    struct BaseSwapCallbackParams {
        address sender;
        address to;
        address tokenIn;
        address tokenOut;
        uint reserve0;
        uint reserve1;
        uint balance0;
        uint balance1;
        uint amountIn;
        uint amountOut;
        uint feeIn;
        uint24 swapFee;
        uint8 withdrawMode;
        bytes callbackData;
    }
    function syncSwapBaseSwapCallback(BaseSwapCallbackParams calldata params) external;
}

```
# Pool Factory

There will be one Pool Factory for each type of pool, and the factory will be used to create pools for the pool type. The factory implementations will then register the newly created pool to the Pool Master.

## Interface

```solidity

// The standard interface.
interface IPoolFactory {
    function master() external view returns (address);
    
    function getDeployData() external view returns (bytes memory);

    // Call the function with data to create a pool.
    // For base pool factories, the data is as follows.
    // `(address tokenA, address tokenB) = abi.decode(data, (address, address));`
    function createPool(bytes calldata data) external returns (address pool);
}

// The interface for base pools has two tokens.
interface IBasePoolFactory is IPoolFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address pool
    );

    function getPool(address tokenA, address tokenB) external view returns (address pool);

    // [Deprecated] This is the interface before the dynamic fees update.
    // This function will forward calls to the pool master.
    //function getSwapFee(address pool) external view returns (uint24 swapFee);
    
    // [Recommended] This is the latest interface.
    // This function will forward calls to the pool master.
    function getSwapFee(
        address pool,
        address sender,
        address tokenIn,
        address tokenOut,
        bytes calldata data
    ) external view override returns (uint24 swapFee) {
        swapFee = IPoolMaster(master).getSwapFee(pool, sender, tokenIn, tokenOut, data);
    }
}

```
# Pool Factory

There will be one Pool Factory for each type of pool, and the factory will be used to create pools for the pool type. The factory implementations will then register the newly created pool to the Pool Master.

## Interface

```solidity

// The standard interface.
interface IPoolFactory {
    function master() external view returns (address);
    
    function getDeployData() external view returns (bytes memory);

    // Call the function with data to create a pool.
    // For base pool factories, the data is as follows.
    // `(address tokenA, address tokenB) = abi.decode(data, (address, address));`
    function createPool(bytes calldata data) external returns (address pool);
}

// The interface for base pools has two tokens.
interface IBasePoolFactory is IPoolFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address pool
    );

    function getPool(address tokenA, address tokenB) external view returns (address pool);

    // [Deprecated] This is the interface before the dynamic fees update.
    // This function will forward calls to the pool master.
    //function getSwapFee(address pool) external view returns (uint24 swapFee);
    
    // [Recommended] This is the latest interface.
    // This function will forward calls to the pool master.
    function getSwapFee(
        address pool,
        address sender,
        address tokenIn,
        address tokenOut,
        bytes calldata data
    ) external view override returns (uint24 swapFee) {
        swapFee = IPoolMaster(master).getSwapFee(pool, sender, tokenIn, tokenOut, data);
    }
}

```
# Router

The router is a universal interface for users to access functions across different protocol parts in one place.

It handles the allowances and transfers of tokens and allows chained swaps/operations across multiple pools, with additional features like slippage protection and permit support.

## Interface

The router has Vault integrated and will transfer funds from the sender and then deposit them to the corresponding vault account (to the pool of the first step of the path).

```solidity
// The Router contract has Multicall and SelfPermit enabled.

struct TokenInput {
    address token;
    uint amount;
}

struct SwapStep {
    address pool; // The pool of the step.
    bytes data; // The data to execute swap with the pool.
    address callback;
    bytes callbackData;
}

struct SwapPath {
    SwapStep[] steps; // Steps of the path.
    address tokenIn; // The input token of the path.
    uint amountIn; // The input token amount of the path.
}

struct SplitPermitParams {
    address token;
    uint approveAmount;
    uint deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct ArrayPermitParams {
    uint approveAmount;
    uint deadline;
    bytes signature;
}

// Returns the vault address.
function vault() external view returns (address);

// Returns the wETH address.
function wETH() external view returns (address);

// Adds some liquidity (supports unbalanced mint).
// Alternatively, use `addLiquidity2` with the same params to register the position,
// to make sure it can be indexed by the interface.
function addLiquidity(
    address pool,
    TokenInput[] calldata inputs,
    bytes calldata data,
    uint minLiquidity,
    address callback,
    bytes calldata callbackData
) external payable returns (uint liquidity)

// Adds some liquidity with permit (supports unbalanced mint).
// Alternatively, use `addLiquidityWithPermit` with the same params to register the position,
// to make sure it can be indexed by the interface.
function addLiquidityWithPermit(
    address pool,
    TokenInput[] calldata inputs,
    bytes calldata data,
    uint minLiquidity,
    address callback,
    bytes calldata callbackData,
    SplitPermitParams[] memory permits
) external payable returns (uint liquidity);

// Burns some liquidity (balanced).
function burnLiquidity(
    address pool,
    uint liquidity,
    bytes calldata data,
    uint[] calldata minAmounts,
    address callback,
    bytes calldata callbackData
) external returns (IPool.TokenAmount[] memory amounts);

// Burns some liquidity with permit (balanced).
function burnLiquidityWithPermit(
    address pool,
    uint liquidity,
    bytes calldata data,
    uint[] calldata minAmounts,
    address callback,
    bytes calldata callbackData,
    ArrayPermitParams memory permit
) external returns (IPool.TokenAmount[] memory amounts);

// Burns some liquidity (single).
function burnLiquiditySingle(
    address pool,
    uint liquidity,
    bytes memory data,
    uint minAmount,
    address callback,
    bytes memory callbackData
) external returns (uint amountOut);
    
// Burns some liquidity with permit (single).
function burnLiquiditySingleWithPermit(
    address pool,
    uint liquidity,
    bytes memory data,
    uint minAmount,
    address callback,
    bytes memory callbackData,
    ArrayPermitParams calldata permit
) external returns (uint amountOut);

// Performs a swap.
function swap(
    SwapPath[] memory paths,
    uint amountOutMin,
    uint deadline
) external payable returns (uint amountOut);

function swapWithPermit(
    SwapPath[] memory paths,
    uint amountOutMin,
    uint deadline,
    SplitPermitParams calldata permit
) external payable returns (uint amountOut);

/// @notice Wrapper function to allow pool deployment to be batched.
function createPool(address factory, bytes calldata data) external payable returns (address);

```
# Smart Contract

## zkSync Era Mainnet

```
WETH
0x5aea5775959fbc2557cc8789bc1bf90a239d9a91

SyncSwapVault
0x621425a1Ef6abE91058E9712575dcc4258F8d091

SyncSwapPoolMaster
0xbB05918E9B4bA9Fe2c8384d223f0844867909Ffb

SyncSwapClassicPoolFactory
0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb

SyncSwapStablePoolFactory
0x5b9f21d407F35b10CbfDDca17D5D84b129356ea3

SyncSwapRouter
0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295

```

## Sophon Testnet

`Router V2 0x5C07E74cB541c3D1875AEEE441D691DED6ebA204`

`Pool Master 0xbB05918E9B4bA9Fe2c8384d223f0844867909Ffb`

`Classic Factory v2.1 0x701f3B10b5Cc30CA731fb97459175f45E0ac1247`

`Stable Factory v2.1 0xfd43b4DB521DA13490E79EB6CfbA19C9b012811c`

`Aqua Factory v2.1 0x5b9f21d407F35b10CbfDDca17D5D84b129356ea3`

`Route Helper 0x5FeE4bbc7000b57CE246fd5d8E392099F65f5e09`

## ZKsync Testnet (Sepolia)

`Pool Master 0x5b9f21d407F35b10CbfDDca17D5D84b129356ea3`

`Classic Factory 0x5FeE4bbc7000b57CE246fd5d8E392099F65f5e09`

`Stable Factory 0x4444f80DfB8a8a29E79087f066eaC306784699Ce`

`Router 0x3f39129e54d2331926c1E4bf034e111cf471AA97`

`Route Helper` 0x46384918127fBd1679C757DF7b495C3F61481467

## Scroll Alpha Testnet

Note the address of testnet contracts is subject to change without notice.

```
WETH
0x7160570bb153edd0ea1775ec2b2ac9b65f1ab61b

SyncSwapVault
0xBe87D2faF9863130D60fe0c454B5990863d45BBa

SyncSwapPoolMaster
0x3e846B1520E74728EFf445F1f86D348755F738d9

SyncSwapClassicPoolFactory
0x46c8dc568ED604bB18C066Fc8d387859b7977836

SyncSwapStablePoolFactory
0x441B24fc497317767a9D293931A33939953F251f

SyncSwapRouter
0xC458eED598eAb247ffc19d15F19cf06ae729432c

```

## Polygon zkEVM Testnet

```
WETH
0xee589e91401066068af129b0005ac3ef69e3fdb4

SyncSwapVault
0xBe87D2faF9863130D60fe0c454B5990863d45BBa

SyncSwapPoolMaster
0x3e846B1520E74728EFf445F1f86D348755F738d9

SyncSwapClassicPoolFactory
0x46c8dc568ED604bB18C066Fc8d387859b7977836

SyncSwapStablePoolFactory
0x441B24fc497317767a9D293931A33939953F251f

SyncSwapRouter
0xC458eED598eAb247ffc19d15F19cf06ae729432c

```

## zkSync Era Testnet

Note the address of testnet contracts is subject to change without notice.

### Staging Testnet (Recommended)

The staging testnet includes updates on dynamic fees.

```
WETH
0x20b28b1e4665fff290650586ad76e977eab90c5d

SyncSwapVault
0x4Ff94F499E1E69D687f3C3cE2CE93E717a0769F8

SyncSwapPoolMaster
0x22E50b84ec0C362427B617dB3e33914E91Bf865a

SyncSwapClassicPoolFactory
0xf2FD2bc2fBC12842aAb6FbB8b1159a6a83E72006

SyncSwapStablePoolFactory
0xB6a70D6ab2dE494592546B696208aCEeC18D755f

SyncSwapRouter
0xB3b7fCbb8Db37bC6f572634299A58f51622A847e

```

### Era Testnet (Deprecated)

```
WETH
0x20b28b1e4665fff290650586ad76e977eab90c5d

SyncSwapVault
0x6C41e61C5449B0916103d536c638E470bbabf95e

SyncSwapPoolMaster
0x4bEAC45efEE4DfB45f7397C19c13a89611dE193D

SyncSwapClassicPoolFactory
0xeaeDD100A9e61CE0412664CE598F0a624CFB3ccB

SyncSwapStablePoolFactory
0x51372e0F0BfAa5be848762AE828D1a24bb0d7Fa0

SyncSwapRouter
0x4dbcd68F735e91ccBa5dff2d4DAb7B0729BBc1a4

```
# ABIs

## Vault

SyncSwapVault

<https://gist.github.com/0xnakato/0bf6964981a2854515f6320fd8923718>

## Router

SyncSwapRouter

<https://gist.github.com/0xnakato/80ca6221ef258b7b27bf309c8a3eeff2>

## Pool Master

SyncSwapPoolMaster

<https://gist.github.com/0xnakato/a257333030793ea47259fe04061fbbdf>

## Pool Factory

BasePoolFactory

<https://gist.github.com/0xnakato/aa8b19ed3ac9761a2c145ca76e0b93c0>

SyncSwapClassicPoolFactory

<https://gist.github.com/0xnakato/13e8393c09ea842912f5f2e5995e9770>

SyncSwapStablePoolFactory

<https://gist.github.com/0xnakato/3865d9114a58f71a9891e426bfa406f9>

## Pool

SyncSwapClassicPool

<https://gist.github.com/0xnakato/56cea29869fafb72d3c5e18c8160073d>

SyncSwapStablePool

<https://gist.github.com/0xnakato/a63358c698b61bfb6f2ef6a28a7242c3>

## Fee

SyncSwapFeeManager

<https://gist.github.com/0xnakato/88688593dd290a09a1418b545041c6ce>

SyncSwapFeeRecipient

<https://gist.github.com/0xnakato/38565ab82796cc35a1f58aebb644e69c>

# Query Pool Info

In this simple example, we query the basic information of a pool with given pool tokens and type.

```solidity
// Solidity
function _getPoolReserves(
    address factory,
    address tokenA,
    address tokenB
) private view returns (
    address pool,
    uint reserveA,
    uint reserveB,
    uint16 poolType
) {
    pool = IFactory(factory).getPool(tokenA, tokenB);

    if (pool.isContract()) { // return empty values if pool not exists
        (uint reserve0, uint reserve1) = IBasePool(pool).getReserves();
        (reserveA, reserveB) = tokenA < tokenB ? (reserve0, reserve1) : (reserve1, reserve0);
        poolType = IBasePool(pool).poolType();
    }
}

function _getRoutePool(
    address factory,
    address tokenA,
    address tokenB
) private view returns (
    RoutePool memory data
) {
    (address contractAddress, uint reserveA, uint reserveB, uint16 poolType) = _getPoolReserves(
        factory, tokenA, tokenB
    );

    if (reserveA != 0) {
        data = Pool({
            pool: contractAddress,
            tokenA: tokenA,
            tokenB: tokenB,
            poolType: poolType,
            reserveA: reserveA,
            reserveB: reserveB,
            swapFee: IFactory(factory).getSwapFee(contractAddress)
        });
    }
}

```
