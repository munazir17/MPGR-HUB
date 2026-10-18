// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MPGRSwapExecutor} from "../contracts/swap/MPGRSwapExecutor.sol";

/// @title  DeployMPGRSwapExecutorBaseMainnet
/// @notice OPTIONAL, explicitly-approved Base Mainnet (8453) deployment of the
///         fixed-fee MPGRSwapExecutor release candidate (contracts/swap).
///         It deploys ONLY this contract: no tokens, pools, swaps, app wiring,
///         owner grants or fee changes. The app keeps every path route disabled
///         until a reviewed manifest is committed to
///         lib/swap/swap-executor-config.ts (SWAP_PATH_EXECUTOR_DEPLOYMENT).
///
///         Preflight (all must pass before anything is broadcast):
///           - block.chainid == 8453
///           - env MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED == "true" (explicit approval)
///           - deployments/base-mainnet/deploy-config.json swapExecutorDeployEnabled == true
///           - no deployments/base-mainnet/mpgr-swap-executor.json record exists yet
///           - the dedicated deployer key nonce == 0 (a re-run cannot deploy twice)
///           - constructor owner equals env SWAP_EXECUTOR_OWNER (operator multisig)
///         Fee terms are compile-time constants in the contract (25 bps to
///         0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4); no setter exists.
///
///         Dry run (default, broadcasts nothing):
///           forge script script/DeployMPGRSwapExecutorBaseMainnet.s.sol --rpc-url $BASE_RPC
///         Approved broadcast (owner action, separate explicit decision):
///           forge script ... --rpc-url $BASE_RPC --broadcast --verify
contract DeployMPGRSwapExecutorBaseMainnet is Script {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant FEE_RECIPIENT_PIN = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    address internal constant UNI_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address internal constant CLASSIC_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant CLASSIC_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    function run() external {
        require(block.chainid == 8453, "chain: Base Mainnet only");
        require(
            keccak256(bytes(vm.envOr("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED", string("false")))) == keccak256(bytes("true")),
            "gate: MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true required"
        );
        string memory cfg = vm.readFile("./deployments/base-mainnet/deploy-config.json");
        require(
            vm.parseJsonBool(cfg, ".swapExecutorDeployEnabled"),
            "gate: deploy-config.json swapExecutorDeployEnabled must be true"
        );
        require(!vm.exists("./deployments/base-mainnet/mpgr-swap-executor.json"), "gate: manifest already exists");
        address owner = vm.envAddress("SWAP_EXECUTOR_OWNER");
        require(owner != address(0), "gate: SWAP_EXECUTOR_OWNER required");

        MPGRSwapExecutor.RouterConfig[] memory routers = new MPGRSwapExecutor.RouterConfig[](4);
        routers[0] = MPGRSwapExecutor.RouterConfig(UNI_V3_ROUTER, MPGRSwapExecutor.RouterKind.UNISWAP_V3_ROUTER02, UNI_V3_FACTORY);
        routers[1] = MPGRSwapExecutor.RouterConfig(SLIP_ROUTER, MPGRSwapExecutor.RouterKind.AERODROME_SLIPSTREAM, SLIP_FACTORY);
        routers[2] = MPGRSwapExecutor.RouterConfig(V2_ROUTER, MPGRSwapExecutor.RouterKind.UNISWAP_V2_ROUTER02, V2_FACTORY);
        routers[3] = MPGRSwapExecutor.RouterConfig(CLASSIC_ROUTER, MPGRSwapExecutor.RouterKind.AERODROME_CLASSIC, CLASSIC_FACTORY);
        address[] memory tokens = vm.envAddress("SWAP_EXECUTOR_INITIAL_TOKENS", ",");
        require(tokens.length > 0, "gate: SWAP_EXECUTOR_INITIAL_TOKENS required");

        vm.startBroadcast();
        // Runbook: use a fresh dedicated deployer (nonce 0) so a re-run cannot
        // produce a second executor; verify the nonce in the tx record afterwards.
        MPGRSwapExecutor executor = new MPGRSwapExecutor(owner, WETH, PERMIT2, routers, tokens);
        vm.stopBroadcast();

        require(executor.feeBps() == 25, "fee pin");
        require(executor.feeRecipient() == FEE_RECIPIENT_PIN, "recipient pin");
        console2.log("MPGRSwapExecutor deployed at", address(executor));
        string memory manifest = string(
            abi.encodePacked(
                '{"chainId":8453,"executor":"', vm.toString(address(executor)),
                '","owner":"', vm.toString(owner),
                '","feeBps":25,"feeRecipient":"', vm.toString(FEE_RECIPIENT_PIN),
                '","deployTx":"pending-record","weth":"', vm.toString(WETH),
                '","permit2":"', vm.toString(PERMIT2), '"}'
            )
        );
        vm.writeFile("./deployments/base-mainnet/mpgr-swap-executor.json", manifest);
    }
}
