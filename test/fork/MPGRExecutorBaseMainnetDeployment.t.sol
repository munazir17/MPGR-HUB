// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {DeployMPGRExecutorBaseMainnet} from "../../script/DeployMPGRExecutorBaseMainnet.s.sol";

interface ISlipFactoryView {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface ISlipQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        int24 tickSpacing;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// @notice Proves the COMMITTED Base Mainnet deployment record (deployments/base-mainnet/
///         mpgr-executor.json) describes the LIVE contract: repository bytecode, owner, fee
///         recipient, fee policy, router + token allowlist, and that app routing stays OFF.
///         Record checks always run; on-chain checks run on a Base mainnet fork
///         (BASE_MAINNET_RPC_URL). Read-only: nothing is broadcast.
contract MPGRExecutorBaseMainnetDeploymentTest is Test {
    string internal constant RECORD = "deployments/base-mainnet/mpgr-executor.json";
    string internal constant PINS = "deployments/base-mainnet/deploy-config.json";
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    address internal constant UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    string internal json;
    MPGRExecutor internal ex;
    address internal owner;
    address internal feeRecipient;
    address internal deployer;
    DeployMPGRExecutorBaseMainnet internal script;
    bool internal forked;

    function setUp() public {
        json = vm.readFile(RECORD);
        ex = MPGRExecutor(payable(vm.parseJsonAddress(json, ".executor")));
        owner = vm.parseJsonAddress(json, ".owner");
        feeRecipient = vm.parseJsonAddress(json, ".feeRecipient");
        deployer = vm.parseJsonAddress(json, ".deployer");
        script = new DeployMPGRExecutorBaseMainnet();
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 8453, "fork must be Base mainnet");
        forked = true;
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ------------------------------------------------------------------ record (always)

    function test_Record_IsConsistent() public view {
        string memory pins = vm.readFile(PINS);
        assertEq(vm.parseJsonUint(json, ".chainId"), 8453, "chainId");
        assertEq(vm.parseJsonString(json, ".network"), "base");
        assertEq(vm.parseJsonUint(json, ".feeBps"), 25, "feeBps");
        assertEq(vm.parseJsonUint(json, ".maxFeeBps"), 100, "maxFeeBps");
        assertFalse(vm.parseJsonBool(json, ".paused"), "paused");
        assertFalse(vm.parseJsonBool(json, ".appRoutingEnabled"), "app routing must stay OFF");
        assertEq(vm.parseJsonString(json, ".deployTxStatus"), "0x1", "deploy tx status");
        assertEq(vm.parseJsonUint(json, ".transactionCount"), 1, "exactly one tx");
        assertEq(owner, vm.parseJsonAddress(pins, ".owner"), "owner != pin");
        assertEq(feeRecipient, vm.parseJsonAddress(pins, ".feeRecipient"), "fee recipient != pin");
        assertFalse(vm.parseJsonBool(pins, ".mainnetDeployEnabled"), "one-time enablement must be switched off after deploy");
        assertEq(address(ex), vm.computeCreateAddress(deployer, 0), "executor == CREATE(dedicated deployer, 0)");
        assertTrue(deployer != owner && deployer != feeRecipient, "deployer is dedicated");
        assertEq(vm.parseJsonAddress(json, ".weth"), WETH);
        assertEq(vm.parseJsonAddress(json, ".permit2"), PERMIT2);
        address[] memory routers = vm.parseJsonAddressArray(json, ".routerAllowlist");
        assertEq(routers.length, 1);
        assertEq(routers[0], SLIP_ROUTER);
        assertEq(vm.parseJsonAddress(json, ".router.factory"), SLIP_FACTORY);
        assertEq(vm.parseJsonAddress(json, ".router.quoterV2"), SLIP_QUOTER);
        (address[] memory tokens, string[] memory symbols) = script.productionTokens();
        assertEq(vm.parseJsonKeys(json, ".allowedTokens").length, tokens.length, "token count");
        for (uint256 i = 0; i < tokens.length; ++i) {
            assertEq(vm.parseJsonAddress(json, string.concat(".allowedTokens.", symbols[i])), tokens[i], symbols[i]);
        }
    }

    // ------------------------------------------------------------------ on-chain (fork)

    /// The address runs EXACTLY this repo's MPGRExecutor: a fresh deployment with the same
    /// constructor arguments yields byte-identical runtime code (incl. metadata hash).
    function test_Fork_Code_MatchesRepositorySource() public onlyFork {
        assertGt(address(ex).code.length, 0, "no code at executor");
        (address[] memory tokens,) = script.productionTokens();
        MPGRExecutor fresh = new MPGRExecutor(owner, feeRecipient, 25, WETH, PERMIT2, script.productionRouters(), tokens);
        console2.log("deployed runtime size", address(ex).code.length);
        assertEq(keccak256(address(ex).code), keccak256(address(fresh).code), "runtime bytecode differs from repo source");
    }

    function test_Fork_Config_MatchesRecord() public onlyFork {
        assertEq(ex.owner(), owner, "owner");
        assertEq(ex.pendingOwner(), address(0), "pendingOwner");
        assertEq(ex.feeRecipient(), feeRecipient, "feeRecipient");
        assertEq(ex.feeBps(), 25, "feeBps");
        assertEq(ex.MAX_FEE_BPS(), 100, "MAX_FEE_BPS");
        assertFalse(ex.paused(), "paused");
        assertEq(address(ex.WETH()), WETH, "WETH");
        assertEq(address(ex.PERMIT2()), PERMIT2, "PERMIT2");
        assertEq(uint8(ex.routerKind(SLIP_ROUTER)), uint8(MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM), "Slipstream router");
        assertEq(uint8(ex.routerKind(UNI_ROUTER02)), uint8(MPGRExecutor.RouterKind.NONE), "Uniswap V3 must not be allowlisted");
        (address[] memory tokens,) = script.productionTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            assertTrue(ex.isTokenAllowed(tokens[i]), "production token not allowlisted");
        }
        address[] memory denied = script.sepoliaDenylist();
        for (uint256 i = 0; i < denied.length; ++i) {
            assertFalse(ex.isTokenAllowed(denied[i]), "Sepolia address allowlisted as token");
            assertEq(uint8(ex.routerKind(denied[i])), 0, "Sepolia address allowlisted as router");
        }
        assertEq(address(ex).balance, 0, "executor holds ETH");
        assertEq(IERC20(USDC).balanceOf(address(ex)), 0, "executor holds USDC");
        assertEq(IERC20(WETH).balanceOf(address(ex)), 0, "executor holds WETH");
    }

    /// Fee cap is enforced on the live contract even for the owner.
    function test_Fork_FeeCap_EnforcedOnLiveContract() public onlyFork {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeBpsAboveCap.selector, uint16(101), uint16(100)));
        ex.setFeeBps(101);
        vm.prank(deployer);
        vm.expectRevert();
        ex.setFeeBps(10);
    }

    /// Fork-only simulation of a USDC -> WETH trade through the LIVE executor on the production
    /// Slipstream router: exact 25 bps USDC fee to the recorded fee recipient, output to the taker,
    /// no custody. (Nothing is broadcast; app routing is unchanged.)
    function test_Fork_DeployedExecutor_ExactFeeSwap() public onlyFork {
        int24[5] memory ticks = [int24(100), 50, 10, 200, 1];
        uint256 gross = 100_000_000; // 100 USDC
        uint256 fee = (gross * 25) / 10_000;
        int24 tick;
        uint256 quoteOut;
        for (uint256 i = 0; i < ticks.length && quoteOut == 0; ++i) {
            if (ISlipFactoryView(SLIP_FACTORY).getPool(USDC, WETH, ticks[i]) == address(0)) continue;
            try ISlipQuoterV2(SLIP_QUOTER).quoteExactInputSingle{gas: 8_000_000}(
                ISlipQuoterV2.QuoteExactInputSingleParams(USDC, WETH, gross - fee, ticks[i], 0)
            ) returns (uint256 o, uint160, uint32, uint256) {
                (tick, quoteOut) = (ticks[i], o);
            } catch {}
        }
        require(quoteOut > 0, "no live USDC/WETH Slipstream pool");
        address taker = makeAddr("mainnet-live-executor-verify-taker");
        vm.etch(taker, "");
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), gross);
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        MPGRExecutor.SwapParams memory p = MPGRExecutor.SwapParams({
            router: SLIP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            grossAmountIn: gross,
            expectedFeeAmount: fee,
            amountOutMinimum: (quoteOut * 99) / 100,
            recipient: taker,
            deadline: block.timestamp + 180,
            intentId: keccak256("mainnet-live-executor-verify"),
            unwrapNativeOut: false
        });
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.APPROVAL;
        vm.prank(taker);
        uint256 out = ex.swapSlipstreamExactInputSingle(p, tick, a);
        assertEq(IERC20(USDC).balanceOf(feeRecipient) - feeBefore, fee, "exact 25 bps to the recorded fee recipient");
        assertEq(fee, 250_000);
        assertGe(out, p.amountOutMinimum, "minOut");
        assertEq(IERC20(WETH).balanceOf(taker), out, "output to taker");
        assertEq(IERC20(USDC).balanceOf(address(ex)), 0, "no USDC custody");
        assertEq(IERC20(WETH).balanceOf(address(ex)), 0, "no WETH custody");
        assertEq(IERC20(USDC).allowance(address(ex), SLIP_ROUTER), 0, "no dangling allowance");
        console2.log("live executor fork swap out (wei WETH):", out);
    }
}
