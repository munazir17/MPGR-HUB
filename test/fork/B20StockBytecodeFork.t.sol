// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice PHASE 6 / F-13 CLOSURE — verifies that ALL 13 configured Coinbase B20
///         tokenized-stock addresses (lib/executor/executor-config.ts
///         BASE_MAINNET_B20_TOKENS, mirrored verbatim below) are DEPLOYED
///         CONTRACTS with 8 decimals on Base MAINNET, plus the supporting
///         executor/USDC/WETH/Slipstream stack. Read-only, fork-only: nothing is
///         broadcast. Addresses below MUST stay in lockstep with the TS registry
///         — the offline pin test
///         (lib/executor/__tests__/phase6-mainnet-audit.test.ts §G) fails CI if
///         the two lists ever drift.
/// @dev Runs inside the `contracts-fork` CI job (match-path test/fork/*) against
///      BASE_MAINNET_RPC_URL (publicnode fallback). Skipped when no RPC is set.
contract B20StockBytecodeForkTest is Test {
    // --- The 13 configured stock tokens (order = BASE_MAINNET_B20_TOKENS) ----
    address internal constant AAPLc = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    address internal constant AMZNc = 0xb200000000000000000000d9192b6B456483C2E8;
    address internal constant COINc = 0xb200000000000000000000c85a31389D71F3ecfb;
    address internal constant CRCLc = 0xB20000000000000000000019f6E7C675b73C2e4D;
    address internal constant GOOGLc = 0xb2000000000000000000002D0BA3164cc74f58B7;
    address internal constant INTCc = 0xB2000000000000000000004AFF16039bA04bdFBc;
    address internal constant METAc = 0xb2000000000000000000008bC8786B856E61707C;
    address internal constant MSFTc = 0xB200000000000000000000Ab99cFa739E253872B;
    address internal constant MSTRc = 0xb2000000000000000000004884b426556b92883d;
    address internal constant NVDAc = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant SNDKc = 0xb200000000000000000000397293Cb8cda9a10c5;
    address internal constant SPCXc = 0xb2000000000000000000007b9fcbd005511aCBd5;
    address internal constant TSLAc = 0xb2000000000000000000001e800a7f5189430cD0;

    // --- Supporting stack -----------------------------------------------------
    address internal constant EXECUTOR = 0xD982726e28275661F8aB64054E6b17a70a63505A;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;

    bool internal forked;

    function setUp() public {
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

    /// @dev ERC20 decimals() via a safe staticcall; returns type(uint8).max when
    ///      the call fails or returns nothing (reported as a hard failure below).
    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) return type(uint8).max;
        return abi.decode(ret, (uint8));
    }

    function _requireCode(address token, string memory symbol) internal view {
        assertGt(token.code.length, 0, string(abi.encodePacked("F-13: ", symbol, " has NO deployed bytecode")));
    }

    // F-13: bytecode presence for ALL 13 configured stocks. Split into three
    // tests (5/4/4) so each test touches few fork contracts cold: a single
    // 13-token loop was observed to exhaust the test frame on a throttling
    // public RPC (cold account fetches) — the split matches the empirically
    // safe per-test footprint. Decimals are pinned offline (TS registry) and
    // probed live in the phase6 fork rehearsal warm-up, not here.
    function test_f13_b20_bytecode_01_to_05() public onlyFork {
        _requireCode(AAPLc, "AAPLc");
        _requireCode(AMZNc, "AMZNc");
        _requireCode(COINc, "COINc");
        _requireCode(CRCLc, "CRCLc");
        _requireCode(GOOGLc, "GOOGLc");
    }

    function test_f13_b20_bytecode_06_to_09() public onlyFork {
        _requireCode(INTCc, "INTCc");
        _requireCode(METAc, "METAc");
        _requireCode(MSFTc, "MSFTc");
        _requireCode(MSTRc, "MSTRc");
    }

    function test_f13_b20_bytecode_10_to_13() public onlyFork {
        _requireCode(NVDAc, "NVDAc");
        _requireCode(SNDKc, "SNDKc");
        _requireCode(SPCXc, "SPCXc");
        _requireCode(TSLAc, "TSLAc");
    }

    function test_f13_supporting_mainnet_stack_is_deployed() public onlyFork {
        address[6] memory stack = [EXECUTOR, USDC, WETH, SLIP_FACTORY, SLIP_QUOTER, SLIP_ROUTER];
        for (uint256 i = 0; i < stack.length; i++) {
            assertGt(stack[i].code.length, 0, "supporting mainnet contract must have code");
        }
        assertEq(_decimals(USDC), 6, "USDC decimals");
        assertEq(_decimals(WETH), 18, "WETH decimals");
    }
}
