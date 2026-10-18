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
///         DEPLOYER KEY FLOW (explicit and identical everywhere):
///           GitHub environment `base-mainnet` secret
///             SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY
///           -> step env BASE_MAINNET_DEPLOYER_PRIVATE_KEY (auto-masked)
///           -> `forge script --private-key "$BASE_MAINNET_DEPLOYER_PRIVATE_KEY"`
///              AND this script's `vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY")`
///              (used only to derive the deployer address via vm.addr for
///              preflight; the key itself is never logged, written or returned).
///           The local Anvil rehearsal (scripts/swap-deploy/rehearse.sh) runs
///           this exact script through the same env/flag flow with a GENERATED
///           TEST-ONLY key that never touches a public chain.
///
///         Preflight (all must pass before anything is broadcast; fail closed):
///           - block.chainid == 8453
///           - env MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED == "true" (explicit approval)
///           - deployments/base-mainnet/deploy-config.json swapExecutorDeployEnabled == true
///           - no final or staging manifest record exists yet
///           - env BASE_MAINNET_DEPLOYER_PRIVATE_KEY present
///           - the dedicated deployer nonce == 0 (fresh key; a re-run cannot deploy twice)
///           - constructor owner == env SWAP_EXECUTOR_OWNER, is NOT the deployer,
///             and is a deployed contract (governance multisig) on this chain
///         Fee terms are governance-bounded in the contract: initialised here to
///         25 bps / 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4 (both pinned and
///         re-verified post-deploy), hard-capped at 100 bps on-chain and mutable
///         only via propose -> 48h timelock -> apply by the owner multisig.
///
///         MANIFEST: this script writes ONLY the staging record
///         deployments/base-mainnet/mpgr-swap-executor.staging.json with the
///         full venue registry and constructor pins. The REAL deploy tx hash
///         and block number cannot be known inside the script, so
///         scripts/swap-deploy/finalize-manifest.sh reads the Foundry broadcast
///         artifact + the tx receipt, re-reads every pin ON-CHAIN, and only
///         then writes the final mpgr-swap-executor.json. A final manifest can
///         therefore never contain a placeholder ("pending-record" does not
///         exist anywhere in this pipeline).
///
///         Dry run (default, broadcasts nothing; preflight still enforced):
///           BASE_MAINNET_DEPLOYER_PRIVATE_KEY=... MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true \
///           SWAP_EXECUTOR_OWNER=... forge script script/DeployMPGRSwapExecutorBaseMainnet.s.sol --rpc-url $BASE_RPC
///         Approved broadcast (owner action, separate explicit decision):
///           forge script ... --rpc-url $BASE_RPC --private-key "$BASE_MAINNET_DEPLOYER_PRIVATE_KEY" --broadcast
contract DeployMPGRSwapExecutorBaseMainnet is Script {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant FEE_RECIPIENT_PIN = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    uint16 internal constant INITIAL_FEE_BPS = 25;
    uint16 internal constant MAX_FEE_BPS_PIN = 100;
    uint48 internal constant FEE_TIMELOCK_PIN = 48 hours;
    address internal constant UNI_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNI_V3_QUOTER = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    address internal constant V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address internal constant CLASSIC_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant CLASSIC_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address internal constant PANCAKE_V3_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address internal constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant ZEROX_SETTLER_DEPLOYER = 0x00000000000004533Fe15556B1E086BB1A72cEae;
    address internal constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;

    string internal constant STAGING_MANIFEST = "./deployments/base-mainnet/mpgr-swap-executor.staging.json";
    string internal constant FINAL_MANIFEST = "./deployments/base-mainnet/mpgr-swap-executor.json";

    /// @notice Deployer-key and owner preflight, exposed for regression tests.
    ///         Reads the key ONLY to derive the address (vm.addr); enforces the
    ///         fresh nonce-0 requirement and the multisig-owner requirement.
    ///         Reverts (fail closed) when any condition is unmet.
    function preflightDeployerAndOwner(address owner) public view {
        preflightCheck(vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY"), owner);
    }

    /// @notice Key-as-argument core of the preflight so regression tests are
    ///         deterministic (process env is shared across parallel tests).
    function preflightCheck(uint256 pk, address owner) public view {
        address deployer = vm.addr(pk);
        require(deployer != address(0), "preflight: deployer key invalid");
        require(vm.getNonce(deployer) == 0, "preflight: deployer nonce must be 0 (fresh dedicated key)");
        require(owner != deployer, "preflight: owner must be the governance multisig, not the ephemeral deployer");
        require(owner.code.length > 0, "preflight: SWAP_EXECUTOR_OWNER must be a deployed multisig contract on Base");
    }

    /// @notice One venue entry; quoter == address(0) serialises as null.
    function venueEntry(string memory name, uint256 kind, address router, address factory, address quoter)
        internal pure returns (string memory)
    {
        string memory q = quoter == address(0) ? "null" : string(abi.encodePacked('"', vm.toString(quoter), '"'));
        return string(abi.encodePacked(
            '{"name":"', name, '","kind":', vm.toString(kind),
            ',"router":"', vm.toString(router), '","factory":"', vm.toString(factory), '","quoter":', q, '}'
        ));
    }

    /// @notice Static venue registry section of the manifest (mirrors
    ///         SWAP_PATH_VENUES in lib/swap/swap-executor-config.ts).
    function venuesJson() internal pure returns (string memory) {
        string memory a = venueEntry("uniswapV3", 2, UNI_V3_ROUTER, UNI_V3_FACTORY, UNI_V3_QUOTER);
        string memory b = venueEntry("slipstream", 1, SLIP_ROUTER, SLIP_FACTORY, SLIP_QUOTER);
        string memory c = venueEntry("uniswapV2", 3, V2_ROUTER, V2_FACTORY, address(0));
        string memory e = venueEntry("aerodromeClassic", 4, CLASSIC_ROUTER, CLASSIC_FACTORY, address(0));
        return string(abi.encodePacked(
            "[", a, ",", b, ",", c, ",", e, ",",
            venueEntry("pancakeV3", 5, PANCAKE_V3_ROUTER, PANCAKE_V3_FACTORY, address(0)), "]"
        ));
    }

    /// @notice Identity + constructor-pin section of the staging manifest,
    ///         split in two halves to keep the stack shallow.
    function headJsonA(address executor, address deployer, address owner) internal pure returns (string memory) {
        return string(abi.encodePacked(
            '{"manifestSchema":"mpgr-swap-executor/v1","chainId":8453,"executor":"', vm.toString(executor),
            '","deployer":"', vm.toString(deployer),
            '","owner":"', vm.toString(owner), '"'
        ));
    }

    function headJsonB() internal view returns (string memory) {
        string memory fees = string(abi.encodePacked(
            '"feeBps":', vm.toString(INITIAL_FEE_BPS),
            ',"maxFeeBps":', vm.toString(MAX_FEE_BPS_PIN),
            ',"feeTimelockSeconds":', vm.toString(FEE_TIMELOCK_PIN)
        ));
        return string(abi.encodePacked(
            ',"weth":"', vm.toString(WETH),
            '","permit2":"', vm.toString(PERMIT2),
            '",', fees, ',"feeRecipient":"', vm.toString(FEE_RECIPIENT_PIN),
            '","explorerUrl":"https://basescan.org","deployTx":"","deployBlock":0,"stagedAtBlock":', vm.toString(block.number)
        ));
    }

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
        require(!vm.exists(FINAL_MANIFEST), "gate: manifest already exists");
        require(!vm.exists(STAGING_MANIFEST), "gate: staging manifest already exists (unfinished run?)");
        address owner = vm.envAddress("SWAP_EXECUTOR_OWNER");
        require(owner != address(0), "gate: SWAP_EXECUTOR_OWNER required");
        preflightDeployerAndOwner(owner);

        MPGRSwapExecutor.RouterConfig[] memory routers = new MPGRSwapExecutor.RouterConfig[](5);
        routers[0] = MPGRSwapExecutor.RouterConfig(UNI_V3_ROUTER, MPGRSwapExecutor.RouterKind.UNISWAP_V3_ROUTER02, UNI_V3_FACTORY);
        routers[1] = MPGRSwapExecutor.RouterConfig(SLIP_ROUTER, MPGRSwapExecutor.RouterKind.AERODROME_SLIPSTREAM, SLIP_FACTORY);
        routers[2] = MPGRSwapExecutor.RouterConfig(V2_ROUTER, MPGRSwapExecutor.RouterKind.UNISWAP_V2_ROUTER02, V2_FACTORY);
        routers[3] = MPGRSwapExecutor.RouterConfig(CLASSIC_ROUTER, MPGRSwapExecutor.RouterKind.AERODROME_CLASSIC, CLASSIC_FACTORY);
        routers[4] = MPGRSwapExecutor.RouterConfig(PANCAKE_V3_ROUTER, MPGRSwapExecutor.RouterKind.PANCAKE_V3, PANCAKE_V3_FACTORY);
        // Tokens are permissionless by design: no token allowlist is deployed.

        address deployer = vm.addr(vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY"));
        vm.startBroadcast();
        MPGRSwapExecutor executor = new MPGRSwapExecutor(owner, WETH, PERMIT2, routers, INITIAL_FEE_BPS, FEE_RECIPIENT_PIN);
        vm.stopBroadcast();

        require(executor.feeBps() == INITIAL_FEE_BPS, "fee pin");
        require(executor.feeRecipient() == FEE_RECIPIENT_PIN, "recipient pin");
        require(executor.MAX_FEE_BPS() == 100, "hard cap pin");
        require(executor.FEE_TIMELOCK_SECONDS() == 48 hours, "timelock pin");
        require(executor.pendingEffectiveAt() == 0, "no pending fee change at birth");
        require(executor.owner() == owner, "owner pin");
        console2.log("MPGRSwapExecutor deployed at", address(executor));

// Staging manifest: complete venue registry + constructor pins. The
        // deployTx hash and deployBlock are filled ONLY by finalize-manifest.sh
        // from the broadcast artifact + receipt (with on-chain re-verification);
        // the final manifest is never written with placeholders.
        string memory manifest = string(abi.encodePacked(
            headJsonA(address(executor), deployer, owner),
            headJsonB(),
            ',"venues":', venuesJson(),
            ',"aggregator":{"zeroxSettlerDeployer":"', vm.toString(ZEROX_SETTLER_DEPLOYER),
            '","zeroxAllowanceHolder":"', vm.toString(ZEROX_ALLOWANCE_HOLDER), '"}}'
        ));
                vm.writeFile(STAGING_MANIFEST, manifest);
        console2.log("Staging manifest written; run scripts/swap-deploy/finalize-manifest.sh to seal it with the real tx receipt.");
    }
}
