// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {DeployMPGRExecutorBaseMainnet} from "../../script/DeployMPGRExecutorBaseMainnet.s.sol";

interface ISlipFactoryLite {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface ISlipQuoterLite {
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

/// Drives the REAL mainnet deploy script (same run()/preflight/postflight) on a fork.
/// Only the key/env hooks are replaced; the committed deploy-config.json pins are read as-is.
contract MainnetDeployHarness is DeployMPGRExecutorBaseMainnet {
    Config internal cfg;
    bool internal pinsOverridden;
    Pins internal pinsOverride;
    bool public recordExistsFlag;
    string internal constant FORK_OUT = "deployments/base-mainnet/.fork-dry-run.json";

    function setConfig(Config memory c) external {
        cfg = c;
    }

    function setPins(Pins memory p) external {
        pinsOverride = p;
        pinsOverridden = true;
    }

    function setRecordExists(bool v) external {
        recordExistsFlag = v;
    }

    function committedPins() external view returns (Pins memory) {
        return DeployMPGRExecutorBaseMainnet._readPins();
    }

    function _readConfig() internal view override returns (Config memory) {
        return cfg;
    }

    function _readPins() internal view override returns (Pins memory) {
        if (pinsOverridden) return pinsOverride;
        return DeployMPGRExecutorBaseMainnet._readPins();
    }

    function _recordExists() internal view override returns (bool) {
        return recordExistsFlag;
    }

    function _outFile() internal pure override returns (string memory) {
        return FORK_OUT;
    }
}

contract MPGRExecutorBaseMainnetDeployForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    address internal constant SEPOLIA_DEPLOYER = 0xb67FCDF437B5FeF64E4b32952dc6d172dc9ec56e;
    address internal constant SEPOLIA_TUSD = 0xc5C9F70A7F3EB18FC33406275Bffe31a922fcde5;

    MainnetDeployHarness internal h;
    bool internal forked;
    uint256 internal deployerKey = uint256(keccak256("mpgr-mainnet-deploy-fork-dry-run-v1"));
    address internal deployer;
    DeployMPGRExecutorBaseMainnet.Pins internal pins;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 pin = vm.envOr("BASE_FORK_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pin);
        require(block.chainid == 8453, "fork must be Base mainnet");
        forked = true;
        h = new MainnetDeployHarness();
        deployer = vm.addr(deployerKey);
        vm.etch(deployer, "");
        vm.setNonceUnsafe(deployer, 0);
        vm.deal(deployer, 0.01 ether);
        pins = h.committedPins();
        h.setConfig(_goodConfig());
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _goodConfig() internal view returns (DeployMPGRExecutorBaseMainnet.Config memory c) {
        c.pk = deployerKey;
        c.deployer = deployer;
        c.owner = pins.owner;
        c.feeRecipient = pins.feeRecipient;
        c.envEnabled = true;
    }

    // ------------------------------------------------------------------
    // Committed pins are the reviewed production values
    // ------------------------------------------------------------------

    function test_Fork_CommittedPins() public onlyFork {
        assertEq(pins.chainId, 8453);
        assertTrue(pins.enabled, "deploy-config.json must enable exactly this deployment");
        assertEq(pins.owner, 0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e, "owner pin");
        assertEq(pins.feeRecipient, 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4, "fee recipient pin");
        assertEq(pins.feeBps, 25);
        assertEq(pins.maxFeeBps, 100);
    }

    // ------------------------------------------------------------------
    // Full dry run of the real script + a real swap through the result
    // ------------------------------------------------------------------

    function test_Fork_MainnetDeployScript_DryRun_ThenRealSwap() public onlyFork {
        MPGRExecutor ex;
        try h.run() returns (MPGRExecutor e) {
            ex = e;
        } catch (bytes memory err) {
            revert(string.concat("deploy script run() reverted: ", _reason(err)));
        }
        vm.removeFile("deployments/base-mainnet/.fork-dry-run.json");

        assertEq(address(ex), vm.computeCreateAddress(deployer, 0), "CREATE(deployer, 0)");
        assertEq(ex.owner(), pins.owner);
        assertEq(ex.feeRecipient(), pins.feeRecipient);
        assertEq(ex.feeBps(), 25);
        assertEq(ex.MAX_FEE_BPS(), 100);
        assertEq(uint8(ex.routerKind(SLIP_ROUTER)), uint8(MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM));
        assertFalse(ex.isTokenAllowed(SEPOLIA_TUSD));

        // Fee cannot be raised above the 100 bps hard cap, even by the owner.
        vm.prank(pins.owner);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeBpsAboveCap.selector, uint16(101), uint16(100)));
        ex.setFeeBps(101);

        // Real USDC -> WETH/B20 swap on the production Slipstream router through the new executor.
        (address tokenOut, int24 tick, uint256 quoteOut) = _findPool(99_750_000);
        require(tokenOut != address(0), "no live USDC pool on the production Slipstream factory");
        address taker = makeAddr("mainnet-dry-run-taker");
        vm.etch(taker, "");
        uint256 gross = 100_000_000; // 100 USDC
        uint256 fee = (gross * 25) / 10_000;
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), gross);
        uint256 feeBefore = IERC20(USDC).balanceOf(pins.feeRecipient);
        MPGRExecutor.SwapParams memory p = MPGRExecutor.SwapParams({
            router: SLIP_ROUTER,
            tokenIn: USDC,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: fee,
            amountOutMinimum: (quoteOut * 99) / 100,
            recipient: taker,
            deadline: block.timestamp + 180,
            intentId: keccak256("mainnet-deploy-dry-run"),
            unwrapNativeOut: false
        });
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.APPROVAL;
        uint256 out;
        vm.prank(taker);
        try ex.swapSlipstreamExactInputSingle(p, tick, a) returns (uint256 o) {
            out = o;
        } catch (bytes memory err) {
            revert(string.concat("swap through the script-deployed executor reverted: ", _reason(err)));
        }
        assertEq(IERC20(USDC).balanceOf(pins.feeRecipient) - feeBefore, fee, "exact 25 bps USDC fee to the pinned recipient");
        assertEq(fee, 250_000);
        assertGe(out, p.amountOutMinimum);
        assertEq(IERC20(tokenOut).balanceOf(taker), out);
        assertEq(IERC20(USDC).balanceOf(address(ex)), 0);
        assertEq(IERC20(tokenOut).balanceOf(address(ex)), 0);
        assertEq(IERC20(USDC).allowance(address(ex), SLIP_ROUTER), 0);
        console2.log("dry-run swap out:", out);
    }

    function _reason(bytes memory err) internal pure returns (string memory) {
        if (err.length == 0) return "<empty revert data>";
        if (err.length >= 68 && bytes4(err) == bytes4(keccak256("Error(string)"))) {
            bytes memory body = new bytes(err.length - 4);
            for (uint256 i = 4; i < err.length; ++i) {
                body[i - 4] = err[i];
            }
            return abi.decode(body, (string));
        }
        return vm.toString(err);
    }

    /// USDC/WETH answer ERC-20 calls in the local EVM; every B20 stock has code + the 0xb2 prefix.
    /// (B20 are Base-native precompiles the local EVM cannot execute; the deploy workflow checks
    /// them with real-node eth_call.) Facts are surfaced in the failure reason.
    function test_Fork_ProductionTokens_Present() public onlyFork {
        (address[] memory tokens, string[] memory symbols) = h.productionTokens();
        string memory report;
        bool allOk = true;
        for (uint256 i = 0; i < tokens.length; ++i) {
            bool ok;
            string memory entry;
            if (i < 2) {
                (ok, entry) = _probe(tokens[i], symbols[i]);
                ok = ok && !h.isB20(tokens[i]);
            } else {
                ok = h.isB20(tokens[i]) && tokens[i].code.length > 0;
                entry = string.concat(symbols[i], ok ? "=b20" : "=MISSING", "(code ", vm.toString(tokens[i].code.length), ") ");
            }
            allOk = allOk && ok;
            report = string.concat(report, entry);
        }
        console2.log(report);
        assertTrue(allOk, report);
    }

    function _probe(address token, string memory symbol) internal view returns (bool ok, string memory entry) {
        (bool okDec, bytes memory dec) = token.staticcall{gas: 100_000}(abi.encodeWithSignature("decimals()"));
        (bool okSup, bytes memory sup) = token.staticcall{gas: 100_000}(abi.encodeWithSignature("totalSupply()"));
        (bool okBal, bytes memory bal) = token.staticcall{gas: 100_000}(abi.encodeWithSignature("balanceOf(address)", address(this)));
        ok = okDec && dec.length >= 32 && okSup && sup.length >= 32 && okBal && bal.length >= 32;
        string memory details = ok
            ? string.concat(", dec ", vm.toString(abi.decode(dec, (uint256))), ", supply ", vm.toString(abi.decode(sup, (uint256))))
            : "";
        entry = string.concat(symbol, ok ? "=ok" : "=NOT-ERC20", "(code ", vm.toString(token.code.length), details, ") ");
    }

    function _findPool(uint256 netIn) internal returns (address, int24, uint256) {
        (address[] memory tokens,) = h.productionTokens();
        int24[5] memory wethTicks = [int24(100), 50, 10, 200, 1];
        for (uint256 i = 2; i < tokens.length; ++i) {
            uint256 o = _quote(tokens[i], 10, netIn);
            if (o > 0) return (tokens[i], 10, o);
        }
        for (uint256 i = 0; i < wethTicks.length; ++i) {
            uint256 o = _quote(WETH, wethTicks[i], netIn);
            if (o > 0) return (WETH, wethTicks[i], o);
        }
        return (address(0), 0, 0);
    }

    function _quote(address token, int24 tick, uint256 netIn) internal returns (uint256) {
        if (ISlipFactoryLite(SLIP_FACTORY).getPool(USDC, token, tick) == address(0)) return 0;
        try ISlipQuoterLite(SLIP_QUOTER).quoteExactInputSingle{gas: 8_000_000}(
            ISlipQuoterLite.QuoteExactInputSingleParams(USDC, token, netIn, tick, 0)
        ) returns (uint256 o, uint160, uint32, uint256) {
            return o;
        } catch {
            return 0;
        }
    }

    // ------------------------------------------------------------------
    // Every preflight guard trips
    // ------------------------------------------------------------------

    function _expectPreflightRevert(DeployMPGRExecutorBaseMainnet.Config memory c, string memory reason) internal {
        vm.expectRevert(bytes(reason));
        h.preflight(c, pins);
    }

    function test_Fork_Preflight_Passes() public onlyFork {
        h.preflight(_goodConfig(), pins);
    }

    function test_Fork_Preflight_WrongChain() public onlyFork {
        vm.chainId(84532);
        _expectPreflightRevert(_goodConfig(), "MPGR: BASE MAINNET (8453) ONLY - refusing to run");
    }

    function test_Fork_Preflight_NotEnabled() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        c.envEnabled = false;
        _expectPreflightRevert(c, "MPGR: MPGR_MAINNET_DEPLOY_ENABLED != true - mainnet deploy not enabled");
    }

    function test_Fork_Preflight_PinDisabled() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Pins memory p = pins;
        p.enabled = false;
        vm.expectRevert(bytes("MPGR: deploy-config.json mainnetDeployEnabled != true"));
        h.preflight(_goodConfig(), p);
    }

    function test_Fork_Preflight_AlreadyDeployed() public onlyFork {
        h.setRecordExists(true);
        _expectPreflightRevert(_goodConfig(), "MPGR: deployments/base-mainnet/mpgr-executor.json exists - already deployed");
    }

    function test_Fork_Preflight_UsedDeployerKey() public onlyFork {
        vm.setNonce(deployer, 1);
        _expectPreflightRevert(_goodConfig(), "MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)");
    }

    function test_Fork_Preflight_OwnerMismatch() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        c.owner = makeAddr("someone-else");
        _expectPreflightRevert(c, "MPGR: MPGR_EXECUTOR_OWNER != deploy-config.json owner");
    }

    function test_Fork_Preflight_FeeRecipientMismatch() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        c.feeRecipient = makeAddr("someone-else");
        _expectPreflightRevert(c, "MPGR: MPGR_EXECUTOR_FEE_RECIPIENT != deploy-config.json feeRecipient");
    }

    function test_Fork_Preflight_FeeNot25() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Pins memory p = pins;
        p.feeBps = 30;
        vm.expectRevert(bytes("MPGR: deploy-config.json feeBps != 25"));
        h.preflight(_goodConfig(), p);
        p.feeBps = 25;
        p.maxFeeBps = 1000;
        vm.expectRevert(bytes("MPGR: deploy-config.json maxFeeBps != 100"));
        h.preflight(_goodConfig(), p);
    }

    function test_Fork_Preflight_DeployerIsOwner() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        c.deployer = pins.owner;
        vm.setNonceUnsafe(pins.owner, 0);
        vm.deal(pins.owner, 1 ether);
        _expectPreflightRevert(c, "MPGR: deployer must not be the owner");
    }

    function test_Fork_Preflight_SepoliaDeployerKey() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        c.deployer = SEPOLIA_DEPLOYER;
        vm.setNonceUnsafe(SEPOLIA_DEPLOYER, 0);
        vm.deal(SEPOLIA_DEPLOYER, 1 ether);
        _expectPreflightRevert(c, "MPGR: deployer is the Base Sepolia deployer - use a dedicated mainnet key");
    }

    function test_Fork_Preflight_Underfunded() public onlyFork {
        vm.deal(deployer, 0.0005 ether);
        _expectPreflightRevert(_goodConfig(), "MPGR: deployer needs >= 0.001 ETH on Base Mainnet");
    }

    function test_Fork_Preflight_SepoliaAddressAsFeeRecipient() public onlyFork {
        DeployMPGRExecutorBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorBaseMainnet.Pins memory p = pins;
        c.feeRecipient = SEPOLIA_TUSD;
        p.feeRecipient = SEPOLIA_TUSD;
        vm.expectRevert(bytes("MPGR: Base Sepolia/test address used as fee recipient"));
        h.preflight(c, p);
    }

    function test_Fork_Denylist_CoversEverySepoliaDeploymentAddress() public onlyFork {
        string memory json = vm.readFile("deployments/base-sepolia/mpgr-executor.json");
        address[5] memory fromRecord = [
            vm.parseJsonAddress(json, ".executor"),
            vm.parseJsonAddress(json, ".testTokenUSD"),
            vm.parseJsonAddress(json, ".testTokenStock"),
            vm.parseJsonAddress(json, ".uniswapV3SwapRouter02"),
            vm.parseJsonAddress(json, ".uniswapV3Factory")
        ];
        address[] memory d = h.sepoliaDenylist();
        for (uint256 i = 0; i < fromRecord.length; ++i) {
            bool found;
            for (uint256 j = 0; j < d.length; ++j) {
                if (d[j] == fromRecord[i]) found = true;
            }
            assertTrue(found, "Sepolia record address missing from the mainnet denylist");
        }
        (address[] memory tokens,) = h.productionTokens();
        MPGRExecutor.RouterConfig[] memory routers = h.productionRouters();
        for (uint256 j = 0; j < d.length; ++j) {
            for (uint256 i = 0; i < tokens.length; ++i) {
                assertTrue(tokens[i] != d[j], "Sepolia address in mainnet token set");
            }
            assertTrue(routers[0].router != d[j], "Sepolia address as mainnet router");
        }
    }
}
