// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MPGRExecutor} from "../contracts/executor/MPGRExecutor.sol";
import {IWETH9} from "../contracts/executor/interfaces/IMPGRExecutorRouters.sol";
import {MPGRTestnetToken} from "../contracts/testnet/MPGRTestnetToken.sol";

interface INonfungiblePositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IUniswapV3QuoterV2 {
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

interface IDomainSeparator {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface INonces {
    function nonces(address owner) external view returns (uint256);
}

/// @title DeployMPGRExecutorBaseSepolia
/// @notice BASE SEPOLIA ONLY (chainId 84532). Deploys the MPGR Executor with
///         ownership assigned DIRECTLY to the designated owner wallet (the
///         deployer never holds admin rights), seeds real Uniswap V3 pools with
///         testnet tokens, then runs REAL on-chain swaps through the executor
///         covering every authorization mode:
///           1. APPROVAL   tUSD  -> tSTOCK
///           2. APPROVAL   tSTOCK -> tUSD   (fee taken in tSTOCK = sell token)
///           3. EIP-2612   tUSD  -> tSTOCK  (permit + fee + swap in ONE tx)
///           4. PERMIT2    tUSD  -> tSTOCK  (SignatureTransfer, ONE tx)
///           5. NATIVE IN  ETH   -> tUSD    (fee paid in native ETH)
///           6. NATIVE OUT tUSD  -> ETH     (WETH unwrapped to the taker)
///         Each swap asserts the fee recipient received EXACTLY
///         floor(gross * 25 / 10000) of the sell token and that the executor
///         retained nothing.
///
/// Env (supplied by the GitHub Actions workflow from repo secrets/variables —
/// never pasted in chat, never committed):
///   BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY  (secret)  pays gas; acts as the test taker
///   MPGR_EXECUTOR_OWNER                (var)     REQUIRED final owner/admin
///   MPGR_EXECUTOR_FEE_RECIPIENT        (var)     optional; defaults to owner
///
/// Usage:
///   forge script script/DeployMPGRExecutorBaseSepolia.s.sol \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow
contract DeployMPGRExecutorBaseSepolia is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    // Canonical addresses on Base Sepolia (Uniswap V3 deployments page; OP-stack WETH predeploy).
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNI_V3_FACTORY = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant UNI_V3_NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address internal constant UNI_V3_QUOTER_V2 = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27;
    address internal constant UNI_V3_SWAP_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;

    uint16 internal constant FEE_BPS = 25;
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant FULL_RANGE_LOWER = -887220; // MIN_TICK rounded to tickSpacing 60
    int24 internal constant FULL_RANGE_UPPER = 887220;

    // Liquidity seeding (kept small; the deployer only needs faucet ETH).
    uint256 internal constant WETH_LIQUIDITY = 0.003 ether;
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.008 ether;

    string internal constant OUT_DIR = "deployments/base-sepolia";
    string internal constant OUT_FILE = "deployments/base-sepolia/mpgr-executor.json";

    /// @dev External infrastructure. Production = canonical Base Sepolia
    ///      addresses (hard-coded below). Overridden ONLY by the local test
    ///      harness in test/script/, which deploys real Uniswap V3 + Permit2
    ///      bytecode into a local EVM to dry-run this exact script.
    struct Infra {
        address weth;
        address permit2;
        address factory;
        address npm;
        address quoter;
        address router;
    }

    function _infra() internal view virtual returns (Infra memory) {
        return Infra({
            weth: WETH,
            permit2: PERMIT2,
            factory: UNI_V3_FACTORY,
            npm: UNI_V3_NPM,
            quoter: UNI_V3_QUOTER_V2,
            router: UNI_V3_SWAP_ROUTER02
        });
    }

    /// @dev Production reads the environment (populated by the workflow from
    ///      repo secrets/variables). The local harness injects values instead.
    function _readConfig() internal view virtual returns (uint256 pk, address owner, address feeRecipient) {
        pk = vm.envUint("BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY");
        owner = vm.envAddress("MPGR_EXECUTOR_OWNER");
        feeRecipient = vm.envOr("MPGR_EXECUTOR_FEE_RECIPIENT", owner);
    }

    function _outDir() internal view virtual returns (string memory) {
        return OUT_DIR;
    }

    function _outFile() internal view virtual returns (string memory) {
        return OUT_FILE;
    }

    struct Ctx {
        Infra infra;
        uint256 pk;
        address deployer;
        address owner;
        address feeRecipient;
        MPGRExecutor ex;
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
        c.infra = _infra();
        (c.pk, c.owner, c.feeRecipient) = _readConfig();
        c.deployer = vm.addr(c.pk);
        require(c.owner != address(0), "MPGR: MPGR_EXECUTOR_OWNER unset");
        require(c.feeRecipient != address(0), "MPGR: fee recipient unset");
        // The deployer is also the test taker; the executor forbids taker == feeRecipient.
        require(c.feeRecipient != c.deployer, "MPGR: fee recipient must differ from the deployer/test taker");
        require(c.deployer.balance >= MIN_DEPLOYER_BALANCE, "MPGR: deployer needs >= 0.008 Base Sepolia ETH");
        require(c.infra.router.code.length > 0 && c.infra.npm.code.length > 0, "MPGR: Uniswap V3 missing");

        console2.log("deployer (gas payer / test taker):", c.deployer);
        console2.log("owner (admin):", c.owner);
        console2.log("fee recipient:", c.feeRecipient);

        _deployTokensAndPools(c);
        _deployExecutor(c);

        _swapApprovalBuy(c);
        _swapApprovalSell(c);
        _swapEip2612(c);
        _swapPermit2(c);
        _swapNativeIn(c);
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
        IWETH9(c.infra.weth).deposit{value: WETH_LIQUIDITY}();
        IERC20(address(c.tUSD)).approve(c.infra.npm, type(uint256).max);
        IERC20(address(c.tSTOCK)).approve(c.infra.npm, type(uint256).max);
        IERC20(c.infra.weth).approve(c.infra.npm, WETH_LIQUIDITY);
        // 1 tSTOCK = 100 tUSD ; 1 WETH = 2000 tUSD
        c.poolUsdStock = _createFullRangePool(c.infra.npm, c.deployer, address(c.tUSD), 50_000e6, address(c.tSTOCK), 500e18);
        c.poolWethUsd = _createFullRangePool(c.infra.npm, c.deployer, c.infra.weth, WETH_LIQUIDITY, address(c.tUSD), 6e6);
        vm.stopBroadcast();
    }

    function _createFullRangePool(address npm, address to, address tokenA, uint256 amountA, address tokenB, uint256 amountB)
        internal
        returns (address pool)
    {
        (address t0, address t1, uint256 a0, uint256 a1) =
            tokenA < tokenB ? (tokenA, tokenB, amountA, amountB) : (tokenB, tokenA, amountB, amountA);
        // sqrtPriceX96 = sqrt(a1 / a0) * 2^96 = sqrt(a1 * 2^192 / a0)
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(a1, 1 << 192, a0)));
        pool = INonfungiblePositionManager(npm).createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, sqrtPriceX96);
        INonfungiblePositionManager(npm).mint(
            INonfungiblePositionManager.MintParams({
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
        MPGRExecutor.RouterConfig[] memory routers = new MPGRExecutor.RouterConfig[](1);
        routers[0] = MPGRExecutor.RouterConfig(c.infra.router, MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory tokens = new address[](3);
        tokens[0] = c.infra.weth;
        tokens[1] = address(c.tUSD);
        tokens[2] = address(c.tSTOCK);

        vm.startBroadcast(c.pk);
        c.ex = new MPGRExecutor(c.owner, c.feeRecipient, FEE_BPS, c.infra.weth, c.infra.permit2, routers, tokens);
        vm.stopBroadcast();

        require(c.ex.owner() == c.owner, "MPGR: owner mismatch");
        require(c.ex.pendingOwner() == address(0), "MPGR: unexpected pending owner");
        require(c.ex.feeBps() == FEE_BPS, "MPGR: feeBps mismatch");
        require(c.ex.feeRecipient() == c.feeRecipient, "MPGR: fee recipient mismatch");
        console2.log("MPGRExecutor:", address(c.ex));
    }

    // ------------------------------------------------------------------
    // Real swaps
    // ------------------------------------------------------------------

    function _quote(address quoter, address tokenIn, address tokenOut, uint256 netIn) internal returns (uint256 minOut) {
        (uint256 out,,,) = IUniswapV3QuoterV2(quoter).quoteExactInputSingle(
            IUniswapV3QuoterV2.QuoteExactInputSingleParams(tokenIn, tokenOut, netIn, POOL_FEE, 0)
        );
        require(out > 0, "MPGR: zero quote");
        minOut = (out * 99) / 100; // 1% slippage guard
    }

    function _params(Ctx memory c, string memory tag, address tokenIn, address tokenOut, uint256 gross, bool unwrap)
        internal
        returns (MPGRExecutor.SwapParams memory p)
    {
        (uint256 fee, uint256 net) = c.ex.quoteFee(gross);
        p = MPGRExecutor.SwapParams({
            router: c.infra.router,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: fee,
            amountOutMinimum: _quote(c.infra.quoter, tokenIn, tokenOut, net),
            recipient: c.deployer,
            deadline: block.timestamp + 1800,
            intentId: keccak256(abi.encode("mpgr-base-sepolia", tag, block.number, gross)),
            unwrapNativeOut: unwrap
        });
    }

    function _balance(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
    }

    function _record(
        Ctx memory c,
        string memory kind,
        MPGRExecutor.SwapParams memory p,
        uint256 amountOut,
        address feeAsset,
        uint256 feeBefore
    ) internal {
        uint256 feeReceived = _balance(feeAsset, c.feeRecipient) - feeBefore;
        require(feeReceived == (p.grossAmountIn * FEE_BPS) / 10_000, "MPGR: fee not exact");
        require(feeReceived == p.expectedFeeAmount, "MPGR: fee != committed");
        require(amountOut >= p.amountOutMinimum, "MPGR: minOut");
        require(IERC20(p.tokenIn).balanceOf(address(c.ex)) == 0, "MPGR: executor kept sell token");
        require(IERC20(p.tokenOut).balanceOf(address(c.ex)) == 0, "MPGR: executor kept buy token");
        require(address(c.ex).balance == 0, "MPGR: executor kept ETH");
        require(IERC20(p.tokenIn).allowance(address(c.ex), p.router) == 0, "MPGR: dangling allowance");
        records.push(SwapRecord(kind, p.intentId, p.tokenIn, p.tokenOut, p.grossAmountIn, feeReceived, amountOut));
        console2.log(kind, "fee:", feeReceived);
        console2.log(kind, "out:", amountOut);
    }

    function _approvalAuth() internal pure returns (MPGRExecutor.Authorization memory a) {
        a.kind = MPGRExecutor.AuthKind.APPROVAL;
    }

    function _swapApprovalBuy(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "approval-buy", address(c.tUSD), address(c.tSTOCK), 100e6, false);
        uint256 feeBefore = _balance(address(c.tUSD), c.feeRecipient);
        vm.startBroadcast(c.pk);
        IERC20(address(c.tUSD)).approve(address(c.ex), p.grossAmountIn); // exact, not unlimited
        uint256 out = c.ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, _approvalAuth());
        vm.stopBroadcast();
        _record(c, "APPROVAL tUSD->tSTOCK", p, out, address(c.tUSD), feeBefore);
    }

    function _swapApprovalSell(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "approval-sell", address(c.tSTOCK), address(c.tUSD), 0.5e18, false);
        uint256 feeBefore = _balance(address(c.tSTOCK), c.feeRecipient);
        vm.startBroadcast(c.pk);
        IERC20(address(c.tSTOCK)).approve(address(c.ex), p.grossAmountIn);
        uint256 out = c.ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, _approvalAuth());
        vm.stopBroadcast();
        _record(c, "APPROVAL tSTOCK->tUSD", p, out, address(c.tSTOCK), feeBefore);
    }

    function _swapEip2612(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "eip2612", address(c.tUSD), address(c.tSTOCK), 50e6, false);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        a.deadline = block.timestamp + 1800;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                c.deployer,
                address(c.ex),
                p.grossAmountIn,
                INonces(address(c.tUSD)).nonces(c.deployer),
                a.deadline
            )
        );
        (a.v, a.r, a.s) = vm.sign(
            c.pk, keccak256(abi.encodePacked("\x19\x01", IDomainSeparator(address(c.tUSD)).DOMAIN_SEPARATOR(), structHash))
        );
        uint256 feeBefore = _balance(address(c.tUSD), c.feeRecipient);
        vm.startBroadcast(c.pk);
        uint256 out = c.ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, a); // permit + fee + swap: one tx
        vm.stopBroadcast();
        _record(c, "EIP2612 tUSD->tSTOCK", p, out, address(c.tUSD), feeBefore);
    }

    function _swapPermit2(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "permit2", address(c.tUSD), address(c.tSTOCK), 25e6, false);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.PERMIT2;
        a.nonce = uint256(keccak256(abi.encode("mpgr-permit2", address(c.ex), block.number)));
        a.deadline = block.timestamp + 1800;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), p.tokenIn, p.grossAmountIn)),
                address(c.ex),
                a.nonce,
                a.deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(c.pk, keccak256(abi.encodePacked("\x19\x01", IDomainSeparator(c.infra.permit2).DOMAIN_SEPARATOR(), structHash)));
        a.signature = abi.encodePacked(r, s, v);
        uint256 feeBefore = _balance(address(c.tUSD), c.feeRecipient);
        vm.startBroadcast(c.pk);
        IERC20(address(c.tUSD)).approve(c.infra.permit2, type(uint256).max); // one-time Permit2 approval (standard)
        uint256 out = c.ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, a);
        vm.stopBroadcast();
        _record(c, "PERMIT2 tUSD->tSTOCK", p, out, address(c.tUSD), feeBefore);
    }

    function _swapNativeIn(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "native-in", c.infra.weth, address(c.tUSD), 0.0001 ether, false);
        uint256 feeBefore = c.feeRecipient.balance;
        vm.startBroadcast(c.pk);
        uint256 out = c.ex.swapUniswapV3ExactInputSingle{value: p.grossAmountIn}(p, POOL_FEE, _approvalAuth());
        vm.stopBroadcast();
        _record(c, "NATIVE_IN ETH->tUSD", p, out, address(0), feeBefore);
    }

    function _swapNativeOut(Ctx memory c) internal {
        MPGRExecutor.SwapParams memory p = _params(c, "native-out", address(c.tUSD), c.infra.weth, 0.2e6, true);
        uint256 feeBefore = _balance(address(c.tUSD), c.feeRecipient);
        vm.startBroadcast(c.pk);
        IERC20(address(c.tUSD)).approve(address(c.ex), p.grossAmountIn);
        uint256 out = c.ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, _approvalAuth());
        vm.stopBroadcast();
        _record(c, "NATIVE_OUT tUSD->ETH", p, out, address(c.tUSD), feeBefore);
    }

    // ------------------------------------------------------------------
    // Output (tx hashes + blocks are merged in by the workflow from broadcast/)
    // ------------------------------------------------------------------

    function _writeDeployment(Ctx memory c) internal {
        string memory swaps = "[";
        for (uint256 i = 0; i < records.length; ++i) {
            SwapRecord memory r = records[i];
            string memory k = string.concat("swap", vm.toString(i));
            vm.serializeString(k, "kind", r.kind);
            vm.serializeBytes32(k, "intentId", r.intentId);
            vm.serializeAddress(k, "tokenIn", r.tokenIn);
            vm.serializeAddress(k, "tokenOut", r.tokenOut);
            vm.serializeString(k, "grossAmountIn", vm.toString(r.grossAmountIn));
            vm.serializeString(k, "feeAmount", vm.toString(r.feeAmount));
            string memory obj = vm.serializeString(k, "amountOut", vm.toString(r.amountOut));
            swaps = string.concat(swaps, i == 0 ? "" : ",", obj);
        }
        swaps = string.concat(swaps, "]");

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "network", "base-sepolia");
        vm.serializeAddress(root, "executor", address(c.ex));
        vm.serializeAddress(root, "owner", c.ex.owner());
        vm.serializeAddress(root, "feeRecipient", c.ex.feeRecipient());
        vm.serializeUint(root, "feeBps", c.ex.feeBps());
        vm.serializeUint(root, "maxFeeBps", c.ex.MAX_FEE_BPS());
        vm.serializeAddress(root, "weth", c.infra.weth);
        vm.serializeAddress(root, "permit2", c.infra.permit2);
        vm.serializeAddress(root, "uniswapV3SwapRouter02", c.infra.router);
        vm.serializeAddress(root, "uniswapV3Factory", c.infra.factory);
        vm.serializeAddress(root, "uniswapV3QuoterV2", c.infra.quoter);
        vm.serializeAddress(root, "testTokenUSD", address(c.tUSD));
        vm.serializeAddress(root, "testTokenStock", address(c.tSTOCK));
        vm.serializeAddress(root, "poolUsdStock", c.poolUsdStock);
        vm.serializeAddress(root, "poolWethUsd", c.poolWethUsd);
        vm.serializeAddress(root, "deployer", c.deployer);
        string memory json = vm.serializeString(root, "swapsJson", swaps);
                vm.createDir(_outDir(), true);
        vm.writeJson(json, _outFile());
        console2.log("wrote", _outFile());
    }
}
