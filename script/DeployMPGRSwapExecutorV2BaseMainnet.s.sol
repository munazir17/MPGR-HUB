// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MPGRSwapExecutorV2} from "../contracts/swap/MPGRSwapExecutorV2.sol";

/// @notice UNDEPLOYED V2 candidate. Independent, CLOSED gate. No v1 gate is read or modified.
/// @dev A nonzero, owner-reviewed deployer nonce is pinned to prevent duplicate CREATEs,
/// including retries after a receipt/sealing failure. Never writes a final manifest.
contract DeployMPGRSwapExecutorV2BaseMainnet is Script {
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
    address internal constant V4_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    string internal constant STAGING_MANIFEST = "./deployments/base-mainnet/mpgr-swap-executor-v2.staging.json";
    string internal constant FINAL_MANIFEST = "./deployments/base-mainnet/mpgr-swap-executor-v2.json";

    /// @notice Deployer-key and owner preflight, exposed for regression tests.
    ///         Reads the key ONLY to derive the address (vm.addr); enforces the
    ///         reviewed-nonce requirement and the multisig-owner requirement.
    ///         Reverts (fail closed) when any condition is unmet.
    function preflightDeployerAndOwner(address owner) public view {
        preflightCheck(vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY"), owner);
    }

    /// @notice Key-as-argument core of the preflight so regression tests are
    ///         deterministic (process env is shared across parallel tests).
    function preflightCheck(uint256 pk, address owner) public view {
        address deployer = vm.addr(pk);
        require(deployer != address(0), "preflight: deployer key invalid");
        string memory cfg = vm.readFile("./deployments/base-mainnet/deploy-v2-config.json");
        require(vm.getNonce(deployer) == vm.parseJsonUint(cfg, ".deployerNonce"), "preflight: reviewed nonce changed");
        require(owner == 0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B, "preflight: wrong Safe");
        require(deployer != FEE_RECIPIENT_PIN, "preflight: fee recipient cannot deploy");
        require(deployer.balance >= 0.003 ether, "preflight: insufficient deployer gas balance");
        require(owner != deployer, "preflight: owner must be the governance multisig, not the ephemeral deployer");
        require(owner.code.length > 0, "preflight: SWAP_EXECUTOR_OWNER must be a deployed multisig contract on Base");
    }

    /// @notice One venue entry; quoter == address(0) serialises as null.
    function venueEntry(string memory name, uint256 kind, address router, address factory, address quoter)
        internal
        pure
        returns (string memory)
    {
        string memory q = quoter == address(0) ? "null" : string(abi.encodePacked('"', vm.toString(quoter), '"'));
        return string(
            abi.encodePacked(
                '{"name":"',
                name,
                '","kind":',
                vm.toString(kind),
                ',"router":"',
                vm.toString(router),
                '","factory":"',
                vm.toString(factory),
                '","quoter":',
                q,
                "}"
            )
        );
    }

    /// @notice Static venue registry section of the manifest (mirrors
    ///         SWAP_PATH_VENUES in lib/swap/swap-executor-config.ts).
    function venuesJson() internal pure returns (string memory) {
        string memory a = venueEntry("uniswapV3", 2, UNI_V3_ROUTER, UNI_V3_FACTORY, UNI_V3_QUOTER);
        string memory b = venueEntry("slipstream", 1, SLIP_ROUTER, SLIP_FACTORY, SLIP_QUOTER);
        string memory c = venueEntry("uniswapV2", 3, V2_ROUTER, V2_FACTORY, address(0));
        string memory e = venueEntry("aerodromeClassic", 4, CLASSIC_ROUTER, CLASSIC_FACTORY, address(0));
        return string(
            abi.encodePacked(
                "[", a, ",", b, ",", c, ",", e, ",", venueEntry("uniswapV4", 7, V4_MANAGER, V4_MANAGER, address(0)), "]"
            )
        );
    }

    /// @notice Identity + constructor-pin section of the staging manifest,
    ///         split in two halves to keep the stack shallow.
    function headJsonA(address executor, address deployer, address owner) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                '{"manifestSchema":"mpgr-swap-executor/v2","chainId":8453,"executor":"',
                vm.toString(executor),
                '","deployer":"',
                vm.toString(deployer),
                '","owner":"',
                vm.toString(owner),
                '"'
            )
        );
    }

    function headJsonB() internal view returns (string memory) {
        string memory fees = string(
            abi.encodePacked(
                '"feeBps":',
                vm.toString(INITIAL_FEE_BPS),
                ',"maxFeeBps":',
                vm.toString(MAX_FEE_BPS_PIN),
                ',"feeTimelockSeconds":',
                vm.toString(FEE_TIMELOCK_PIN)
            )
        );
        return string(
            abi.encodePacked(
                ',"weth":"',
                vm.toString(WETH),
                '","permit2":"',
                vm.toString(PERMIT2),
                '",',
                fees,
                ',"feeRecipient":"',
                vm.toString(FEE_RECIPIENT_PIN),
                '","explorerUrl":"https://basescan.org","deployTx":"","deployBlock":0,"stagedAtBlock":',
                vm.toString(block.number)
            )
        );
    }

    function run() external {
        require(block.chainid == 8453, "chain: Base Mainnet only");
        require(
            keccak256(bytes(vm.envOr("MPGR_SWAP_EXECUTOR_V2_DEPLOY_ENABLED", string("false"))))
                == keccak256(bytes("true")),
            "gate: MPGR_SWAP_EXECUTOR_V2_DEPLOY_ENABLED=true required"
        );
        string memory cfg = vm.readFile("./deployments/base-mainnet/deploy-v2-config.json");
        require(
            vm.parseJsonBool(cfg, ".swapExecutorV2DeployEnabled"),
            "gate: deploy-v2-config.json swapExecutorV2DeployEnabled must be true"
        );
        require(!vm.exists(FINAL_MANIFEST), "gate: manifest already exists");
        require(!vm.exists(STAGING_MANIFEST), "gate: staging manifest already exists (unfinished run?)");
        address owner = vm.envAddress("SWAP_EXECUTOR_OWNER");
        require(owner != address(0), "gate: SWAP_EXECUTOR_OWNER required");
        preflightDeployerAndOwner(owner);

        MPGRSwapExecutorV2.RouterConfig[] memory routers = new MPGRSwapExecutorV2.RouterConfig[](5);
        routers[0] = MPGRSwapExecutorV2.RouterConfig(
            UNI_V3_ROUTER, MPGRSwapExecutorV2.RouterKind.UNISWAP_V3_ROUTER02, UNI_V3_FACTORY
        );
        routers[1] = MPGRSwapExecutorV2.RouterConfig(
            SLIP_ROUTER, MPGRSwapExecutorV2.RouterKind.AERODROME_SLIPSTREAM, SLIP_FACTORY
        );
        routers[2] =
            MPGRSwapExecutorV2.RouterConfig(V2_ROUTER, MPGRSwapExecutorV2.RouterKind.UNISWAP_V2_ROUTER02, V2_FACTORY);
        routers[3] = MPGRSwapExecutorV2.RouterConfig(
            CLASSIC_ROUTER, MPGRSwapExecutorV2.RouterKind.AERODROME_CLASSIC, CLASSIC_FACTORY
        );
        routers[4] = MPGRSwapExecutorV2.RouterConfig(V4_MANAGER, MPGRSwapExecutorV2.RouterKind.UNISWAP_V4, V4_MANAGER);
        // Tokens are permissionless by design: no token allowlist is deployed.

        address deployer = vm.addr(vm.envUint("BASE_MAINNET_DEPLOYER_PRIVATE_KEY"));
        vm.startBroadcast(deployer);
        MPGRSwapExecutorV2 executor =
            new MPGRSwapExecutorV2(owner, WETH, PERMIT2, routers, INITIAL_FEE_BPS, FEE_RECIPIENT_PIN);
        vm.stopBroadcast();

        require(executor.feeBps() == INITIAL_FEE_BPS, "fee pin");
        require(executor.feeRecipient() == FEE_RECIPIENT_PIN, "recipient pin");
        require(executor.MAX_FEE_BPS() == 100, "hard cap pin");
        require(executor.FEE_TIMELOCK_SECONDS() == 48 hours, "timelock pin");
        require(executor.pendingEffectiveAt() == 0, "no pending fee change at birth");
        require(executor.owner() == owner, "owner pin");
        console2.log("MPGRSwapExecutorV2 deployed at", address(executor));

        // Staging manifest: complete venue registry + constructor pins. The
        // deployTx hash and deployBlock are filled ONLY by finalize-manifest.sh
        // from the broadcast artifact + receipt (with on-chain re-verification);
        // the final manifest is never written with placeholders.
        string memory manifest = string(
            abi.encodePacked(
                headJsonA(address(executor), deployer, owner),
                headJsonB(),
                ',"venues":',
                venuesJson(),
                ',"disabledVenues":["pancakeV3","zerox"]}'
            )
        );
        vm.writeFile(STAGING_MANIFEST, manifest);
        console2.log(
            "Staging manifest written; run scripts/swap-deploy-v2/finalize-manifest.sh to seal it with the real tx receipt."
        );
    }
}
