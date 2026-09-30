// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MPGRExecutorDelegated} from "../contracts/executor/MPGRExecutorDelegated.sol";
import {IPermit2SignatureTransfer, IWETH9} from "../contracts/executor/interfaces/IMPGRExecutorRouters.sol";
import {MPGRTestnetToken} from "../contracts/testnet/MPGRTestnetToken.sol";

interface INonfungiblePositionManagerDelegated {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256);
}

interface IUniswapV3QuoterV2Delegated {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// @title DeployMPGRExecutorDelegatedBaseSepolia
/// @notice BASE SEPOLIA ONLY (chainId 84532). Deploys MPGRExecutorDelegated
///         (the delegated autonomous-executor spec — execution of this script
///         is an explicit, human-approved deployment action; it NEVER runs on
///         Base mainnet and enables nothing by itself), seeds a real Uniswap V3
///         testnet pool, then proves the delegated flow end-to-end with REAL
///         Permit2 witness permits signed by the deployer acting as the demo
///         taker, broadcast by the deployer acting as the operator:
///           1. BUY        tUSD   -> tSTOCK
///           2. SELL       tSTOCK -> tUSD   (fee taken in tSTOCK = sell token)
///           3. NATIVE OUT tUSD   -> ETH   (WETH unwrapped to the taker/owner)
///         Each swap asserts the fee recipient received EXACTLY
///         floor(gross * 25 / 10000) of the sell token and that the executor
///         retained nothing.
///
/// Env (supplied by the operator from repo secrets/variables — never pasted in
/// chat, never committed):
///   BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY  (secret)  pays gas; signs the demo permits
///   MPGR_EXECUTOR_OWNER                (var)     admin (Ownable2Step)
///   MPGR_EXECUTOR_FEE_RECIPIENT        (var)     REQUIRED; must differ from the
///                                                deployer (the demo taker) — an
///                                                autonomous taker can never be
///                                                the fee wallet.
///
/// Usage (after explicit approval):
///   forge script script/DeployMPGRExecutorDelegatedBaseSepolia.s.sol \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
contract DeployMPGRExecutorDelegatedBaseSepolia is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    // Canonical addresses on Base Sepolia (Uniswap V3 deployments page; OP-stack WETH predeploy).
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNI_V3_NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant UNI_V3_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    address internal constant UNI_V3_SWAP_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

    uint16 internal constant FEE_BPS = 25;
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;

    uint256 internal constant WETH_LIQUIDITY = 0.003 ether;
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.008 ether;

    /// @notice Must match MPGRExecutorDelegated.WITNESS_TYPE_STRING exactly.
    string internal constant WITNESS_TYPE_STRING =
        "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)";
    bytes32 internal constant WITNESS_TYPEHASH = keccak256(
        bytes(
            "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)"
        )
    );
    /// @notice Permit2's witness-typehash stub (deployed PermitHash library).
    /// @notice Raw stub string — PermitHash.hashWithWitness packs the STRING
    ///         itself with the witness type string (NOT its keccak).
    string internal constant PERMIT2_WITNESS_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    string internal constant OUT_DIR = "deployments/base-sepolia";
    string internal constant OUT_FILE = "deployments/base-sepolia/mpgr-executor-delegated.json";

    struct Ctx {
        uint256 pk;
        address deployer;
        address owner;
        address feeRecipient;
        MPGRExecutorDelegated dex;
        MPGRTestnetToken tUSD;
        MPGRTestnetToken tSTOCK;
        address poolUsdStock;
        address poolWethUsd;
    }

    struct SwapRecord {
        string kind;
        bytes32 intentId;
        address tokenIn;
        address tokenOut;
        uint256 grossAmountIn;
        uint256 feeAmount;
        uint256 amountOut;
    }

    SwapRecord[] internal records;

    function run() external {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "MPGR: BASE SEPOLIA (84532) ONLY - refusing to run");

        Ctx memory c;
        c.pk = vm.envUint("BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.owner = vm.envAddress("MPGR_EXECUTOR_OWNER");
        c.feeRecipient = vm.envAddress("MPGR_EXECUTOR_FEE_RECIPIENT");
        require(c.owner != address(0), "MPGR: MPGR_EXECUTOR_OWNER unset");
        require(c.feeRecipient != address(0), "MPGR: MPGR_EXECUTOR_FEE_RECIPIENT unset");
        // The demo taker signs the permits — an autonomous taker can never be
        // the fee wallet (the contract reverts OwnerIsFeeRecipient).
        require(c.feeRecipient != c.deployer, "MPGR: fee recipient must differ from the deployer/demo taker");
        require(c.deployer.balance >= MIN_DEPLOYER_BALANCE, "MPGR: deployer needs >= 0.008 Base Sepolia ETH");
        require(UNI_V3_SWAP_ROUTER02.code.length > 0 && UNI_V3_NPM.code.length > 0, "MPGR: Uniswap V3 missing");

        console2.log("deployer (gas payer / demo taker / permit signer):", c.deployer);
        console2.log("owner (admin):", c.owner);
        console2.log("fee recipient:", c.feeRecipient);

        _deployTokensAndPools(c);
        _deployExecutor(c);

        vm.startPrank(c.deployer);
        IERC20(address(c.tUSD)).approve(PERMIT2, type(uint256).max);
        IERC20(address(c.tSTOCK)).approve(PERMIT2, type(uint256).max);
        IERC20(WETH).approve(PERMIT2, type(uint256).max);
        vm.stopPrank();

        _swapBuy(c);
        _swapSell(c);
        _swapNativeOut(c);

        _writeDeployment(c);
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    function _deployTokensAndPools(Ctx memory c) internal {
        vm.startBroadcast(c.pk);
        c.tUSD = new MPGRTestnetToken("MPGR Test USD", "tUSD", 6, c.deployer, 1_000_000e6);
        c.tSTOCK = new MPGRTestnetToken("MPGR Test Stock", "tSTOCK", 18, c.deployer, 10_000e18);
        IWETH9(WETH).deposit{value: WETH_LIQUIDITY}();
        IERC20(address(c.tUSD)).approve(UNI_V3_NPM, type(uint256).max);
        IERC20(address(c.tSTOCK)).approve(UNI_V3_NPM, type(uint256).max);
        IERC20(WETH).approve(UNI_V3_NPM, WETH_LIQUIDITY);
        // 1 tSTOCK = 100 tUSD ; 1 WETH = 2000 tUSD
        c.poolUsdStock = _createFullRangePool(c.deployer, address(c.tUSD), 50_000e6, address(c.tSTOCK), 500e18);
        c.poolWethUsd = _createFullRangePool(c.deployer, WETH, WETH_LIQUIDITY, address(c.tUSD), 6e6);
        vm.stopBroadcast();
    }

    function _createFullRangePool(address to, address tokenA, uint256 amountA, address tokenB, uint256 amountB)
        internal
        returns (address pool)
    {
        (address t0, address t1, uint256 a0, uint256 a1) =
            tokenA < tokenB ? (tokenA, tokenB, amountA, amountB) : (tokenB, tokenA, amountB, amountA);
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(a1, 1 << 192, a0)));
        pool = INonfungiblePositionManagerDelegated(UNI_V3_NPM).createAndInitializePoolIfNecessary(
            t0, t1, POOL_FEE, sqrtPriceX96
        );
        INonfungiblePositionManagerDelegated(UNI_V3_NPM).mint(
            INonfungiblePositionManagerDelegated.MintParams({
                token0: t0,
                token1: t1,
                fee: POOL_FEE,
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: to,
                deadline: block.timestamp + 1800
            })
        );
    }

    function _deployExecutor(Ctx memory c) internal {
        MPGRExecutorDelegated.RouterConfig[] memory routers = new MPGRExecutorDelegated.RouterConfig[](1);
        routers[0] =
            MPGRExecutorDelegated.RouterConfig(UNI_V3_SWAP_ROUTER02, MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory tokens = new address[](3);
        tokens[0] = WETH;
        tokens[1] = address(c.tUSD);
        tokens[2] = address(c.tSTOCK);

        vm.startBroadcast(c.pk);
        c.dex = new MPGRExecutorDelegated(c.owner, c.feeRecipient, FEE_BPS, WETH, PERMIT2, routers, tokens);
        vm.stopBroadcast();

        require(c.dex.owner() == c.owner, "MPGR: owner mismatch");
        require(c.dex.pendingOwner() == address(0), "MPGR: unexpected pending owner");
        require(c.dex.feeBps() == FEE_BPS, "MPGR: feeBps mismatch");
        require(c.dex.feeRecipient() == c.feeRecipient, "MPGR: fee recipient mismatch");
        require(address(c.dex.PERMIT2()) == PERMIT2, "MPGR: Permit2 mismatch");
        console2.log("MPGRExecutorDelegated:", address(c.dex));
    }

    // ------------------------------------------------------------------
    // Delegated swaps: deployer signs the permit (taker), deployer broadcasts
    // (operator role) — proving the signature is what authorizes, not the sender.
    // ------------------------------------------------------------------

    function _quote(address tokenIn, address tokenOut, uint256 netIn) internal returns (uint256 minOut) {
        (uint256 out,,,) = IUniswapV3QuoterV2Delegated(UNI_V3_QUOTER_V2).quoteExactInputSingle(
            IUniswapV3QuoterV2Delegated.QuoteExactInputSingleParams(tokenIn, tokenOut, netIn, POOL_FEE, 0)
        );
        require(out > 0, "MPGR: zero quote");
        minOut = (out * 99) / 100; // 1% slippage guard
    }

    function _params(Ctx memory c, string memory tag, address tokenIn, address tokenOut, uint256 gross, bool unwrap)
        internal
        view
        returns (MPGRExecutorDelegated.SwapParams memory p)
    {
        (uint256 fee,) = c.dex.quoteFee(gross);
        p = MPGRExecutorDelegated.SwapParams({
            router: UNI_V3_SWAP_ROUTER02,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: fee,
            amountOutMinimum: 0, // set by the caller after quoting
            recipient: c.deployer, // MUST equal the signing owner (enforced on-chain)
            deadline: block.timestamp + 1800,
            intentId: keccak256(abi.encode("mpgr-base-sepolia-delegated", tag, block.number, gross)),
            unwrapNativeOut: unwrap
        });
    }

    /// @notice Builds the full Permit2 witness authorization: the digest follows
    ///         the DEPLOYED Permit2 hashing convention exactly (stub typehash +
    ///         witness type string; spender = the delegated executor).
    function _signPermit(Ctx memory c, MPGRExecutorDelegated.SwapParams memory p, uint256 nonce)
        internal
        view
        returns (MPGRExecutorDelegated.Permit2Authorization memory auth)
    {
        auth.permit = IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions({token: p.tokenIn, amount: p.grossAmountIn}),
            nonce: nonce,
            deadline: p.deadline
        });
        auth.witness = MPGRExecutorDelegated.ActionWitness({
            owner: c.deployer,
            buyToken: p.tokenOut,
            minAmountOut: p.amountOutMinimum,
            deadline: p.deadline,
            actionId: p.intentId,
            policyHash: keccak256(abi.encode("mpgr-sepolia-demo-policy", c.deployer))
        });

        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, auth.witness));
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", _permit2Domain(), _witnessSigHash(auth.permit, address(c.dex), witnessHash))
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(c.pk, digest);
        auth.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Deployed Permit2 EIP-712 domain ("Permit2", chainId, canonical address).
    function _permit2Domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
    }

    /// @dev Deployed PermitHash.hashWithWitness convention (stub + type string).
    function _witnessSigHash(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        address executor,
        bytes32 witnessHash
    ) internal pure returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(PERMIT2_WITNESS_STUB, WITNESS_TYPE_STRING));
        bytes32 tpHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        return keccak256(abi.encode(typeHash, tpHash, executor, permit.nonce, permit.deadline, witnessHash));
    }

    function _swapBuy(Ctx memory c) internal {
        uint256 gross = 10_000e6; // 10k tUSD -> tSTOCK
        MPGRExecutorDelegated.SwapParams memory p = _params(c, "buy", address(c.tUSD), address(c.tSTOCK), gross, false);
        p.amountOutMinimum = _quote(address(c.tUSD), address(c.tSTOCK), gross - p.expectedFeeAmount);
        MPGRExecutorDelegated.Permit2Authorization memory auth = _signPermit(c, p, 1);
        uint256 feeBefore = IERC20(address(c.tUSD)).balanceOf(c.feeRecipient);
        vm.startBroadcast(c.pk);
        uint256 out = c.dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, auth);
        vm.stopBroadcast();
        _verifyAndRecord(c, "BUY delegated (witness permit)", p, out, address(c.tUSD), feeBefore);
    }

    function _swapSell(Ctx memory c) internal {
        uint256 gross = 25e18; // 25 tSTOCK -> tUSD
        MPGRExecutorDelegated.SwapParams memory p = _params(c, "sell", address(c.tSTOCK), address(c.tUSD), gross, false);
        p.amountOutMinimum = _quote(address(c.tSTOCK), address(c.tUSD), gross - p.expectedFeeAmount);
        MPGRExecutorDelegated.Permit2Authorization memory auth = _signPermit(c, p, 2);
        uint256 feeBefore = IERC20(address(c.tSTOCK)).balanceOf(c.feeRecipient);
        vm.startBroadcast(c.pk);
        uint256 out = c.dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, auth);
        vm.stopBroadcast();
        _verifyAndRecord(c, "SELL delegated (witness permit)", p, out, address(c.tSTOCK), feeBefore);
    }

    function _swapNativeOut(Ctx memory c) internal {
        uint256 gross = 10_000e6; // tUSD -> WETH -> native ETH to the taker
        MPGRExecutorDelegated.SwapParams memory p = _params(c, "native-out", address(c.tUSD), WETH, gross, true);
        p.amountOutMinimum = _quote(address(c.tUSD), WETH, gross - p.expectedFeeAmount);
        MPGRExecutorDelegated.Permit2Authorization memory auth = _signPermit(c, p, 3);
        uint256 feeBefore = IERC20(address(c.tUSD)).balanceOf(c.feeRecipient);
        vm.startBroadcast(c.pk);
        uint256 out = c.dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, auth);
        vm.stopBroadcast();
        _verifyAndRecord(c, "NATIVE OUT delegated (witness permit)", p, out, address(c.tUSD), feeBefore);
    }

    function _verifyAndRecord(
        Ctx memory c,
        string memory kind,
        MPGRExecutorDelegated.SwapParams memory p,
        uint256 amountOut,
        address feeAsset,
        uint256 feeBefore
    ) internal {
        uint256 feeReceived = IERC20(feeAsset).balanceOf(c.feeRecipient) - feeBefore;
        require(feeReceived == (p.grossAmountIn * FEE_BPS) / 10_000, "MPGR: fee not exact");
        require(feeReceived == p.expectedFeeAmount, "MPGR: fee != committed");
        require(amountOut >= p.amountOutMinimum, "MPGR: out below min");
        require(IERC20(p.tokenIn).balanceOf(address(c.dex)) == 0, "MPGR: executor retained sell token");
        require(IERC20(p.tokenOut).balanceOf(address(c.dex)) == 0, "MPGR: executor retained buy token");
        records.push(
            SwapRecord({
                kind: kind,
                intentId: p.intentId,
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                grossAmountIn: p.grossAmountIn,
                feeAmount: feeReceived,
                amountOut: amountOut
            })
        );
        console2.log(kind, "amountOut:", amountOut);
    }

    function _writeDeployment(Ctx memory c) internal {
        string memory json = "mpgr-executor-delegated";
        vm.serializeString(json, "contract", "MPGRExecutorDelegated");
        vm.serializeAddress(json, "address", address(c.dex));
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "owner", c.owner);
        vm.serializeAddress(json, "feeRecipient", c.feeRecipient);
        vm.serializeUint(json, "feeBps", FEE_BPS);
        vm.serializeAddress(json, "permit2", PERMIT2);
        vm.serializeAddress(json, "router", UNI_V3_SWAP_ROUTER02);
        vm.serializeAddress(json, "poolUsdStock", c.poolUsdStock);
        vm.serializeAddress(json, "poolWethUsd", c.poolWethUsd);
        vm.serializeUint(json, "deployedAtBlock", block.number);
        string memory out = vm.serializeAddress(json, "demoTaker", c.deployer);

        string memory swaps = "swaps";
        for (uint256 i = 0; i < records.length; i++) {
            string memory key = vm.toString(i);
            vm.serializeString(swaps, string.concat(key, ":kind"), records[i].kind);
            vm.serializeBytes32(swaps, string.concat(key, ":intentId"), records[i].intentId);
            vm.serializeAddress(swaps, string.concat(key, ":tokenIn"), records[i].tokenIn);
            vm.serializeAddress(swaps, string.concat(key, ":tokenOut"), records[i].tokenOut);
            vm.serializeUint(swaps, string.concat(key, ":grossAmountIn"), records[i].grossAmountIn);
            vm.serializeUint(swaps, string.concat(key, ":feeAmount"), records[i].feeAmount);
            out = vm.serializeUint(swaps, string.concat(key, ":amountOut"), records[i].amountOut);
        }
        out = vm.serializeString(json, "swaps", out);

        vm.createDir(OUT_DIR, true);
        vm.writeJson(out, OUT_FILE);
        console2.log("deployment record:", OUT_FILE);
    }
}
