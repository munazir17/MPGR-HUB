// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MPGRExecutorDelegated} from "../contracts/executor/MPGRExecutorDelegated.sol";

/// @title RecordMPGRExecutorDelegatedBaseMainnet
/// @notice Read-only post-broadcast recorder. Run ONLY after a mined Base Mainnet deployment.
///         Unlike the deploy script, this executes after Forge has a receipt, so the artifact
///         contains the actual transaction hash, success status and mined block number.
///         It does not sign, broadcast, activate, register modules or perform swaps.
///
/// Usage (after independently confirming the deployment receipt):
///   MPGR_MAINNET_DELEGATED_EXECUTOR=0x... \
///   MPGR_MAINNET_DELEGATED_DEPLOYER_ADDRESS=0x... \
///   forge script script/RecordMPGRExecutorDelegatedBaseMainnet.s.sol \
///     --rpc-url "$BASE_MAINNET_RPC_URL"
///
/// MPGR_MAINNET_DELEGATED_DEPLOYER_ADDRESS is public and must be the address derived from
/// BASE_MAINNET_DEPLOYER_PRIVATE_KEY used by the deployment script. No private key is read here.
contract RecordMPGRExecutorDelegatedBaseMainnet is Script {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    uint256 internal constant EXPECTED_FEE_BPS = 25;
    uint256 internal constant EXPECTED_MAX_FEE_BPS = 100;
    uint256 internal constant TOKEN_COUNT = 15;
    uint256 internal constant ROUTER_COUNT = 2;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SLIPSTREAM_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant UNISWAP_V3_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    string internal constant CONFIG_FILE = "deployments/base-mainnet/delegated-deploy-config.json";
    string internal constant OUT_FILE = "deployments/base-mainnet/mpgr-executor-delegated.json";
    string internal constant EXPECTED_WITNESS_TYPE_STRING =
        "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";

    function run() external {
        require(block.chainid == BASE_MAINNET_CHAIN_ID, "MPGR: BASE MAINNET (8453) ONLY");
        require(!vm.exists(OUT_FILE), "MPGR: deployment artifact already exists; refusing to overwrite");

        string memory config = vm.readFile(CONFIG_FILE);
        address executor = vm.envAddress("MPGR_MAINNET_DELEGATED_EXECUTOR");
        address deployer = vm.envAddress("MPGR_MAINNET_DELEGATED_DEPLOYER_ADDRESS");
        require(executor != address(0) && deployer != address(0), "MPGR: executor/deployer address unset");
        require(vm.computeCreateAddress(deployer, 0) == executor, "MPGR: executor != CREATE(deployer, 0)");
        require(executor.code.length > 0, "MPGR: executor has no deployed runtime code");

        VmSafe.BroadcastTxSummary memory deployment = _deploymentSummary(executor);
        require(deployment.success, "MPGR: deployment receipt status is not successful");
        require(deployment.txHash != bytes32(0), "MPGR: deployment transaction hash missing");
        require(deployment.blockNumber != 0, "MPGR: deployment block number missing");

        MPGRExecutorDelegated dex = MPGRExecutorDelegated(payable(executor));
        _verifyLivePosture(config, dex, executor);
        _writeArtifact(config, dex, deployer, deployment);

        console2.log("deployment record:", OUT_FILE);
        console2.log("deployment transaction:", vm.toString(deployment.txHash));
        console2.log("deployment block:", deployment.blockNumber);
        console2.log("source verification remains pending until independently confirmed");
    }

    function _deploymentSummary(address executor) internal view returns (VmSafe.BroadcastTxSummary memory summary) {
        (bool found, VmSafe.BroadcastTxSummary memory match_) = _findBroadcast("MPGRExecutorDelegated", executor);
        if (!found) {
            (found, match_) = _findBroadcast("DeployMPGRExecutorDelegatedBaseMainnet", executor);
        }
        require(found, "MPGR: matching mined deployment summary not found; refusing to fabricate artifact");
        return match_;
    }

    function _findBroadcast(string memory contractName, address executor)
        internal
        view
        returns (bool found, VmSafe.BroadcastTxSummary memory match_)
    {
        VmSafe.BroadcastTxSummary[] memory broadcasts =
            vm.getBroadcasts(contractName, uint64(block.chainid), VmSafe.BroadcastTxType.Create);
        for (uint256 i = 0; i < broadcasts.length; ++i) {
            if (broadcasts[i].contractAddress == executor) return (true, broadcasts[i]);
        }
    }

    function _verifyLivePosture(string memory config, MPGRExecutorDelegated dex, address executor) internal view {
        require(vm.parseJsonUint(config, ".chainId") == BASE_MAINNET_CHAIN_ID, "MPGR: config chainId != 8453");
        require(vm.parseJsonUint(config, ".moduleRegistrySchemaVersion") == 1, "MPGR: unsupported module-registry schema");
        require(vm.parseJsonUint(config, ".feeBps") == EXPECTED_FEE_BPS, "MPGR: config feeBps != 25");
        require(vm.parseJsonUint(config, ".maxFeeBps") == EXPECTED_MAX_FEE_BPS, "MPGR: config maxFeeBps != 100");
        require(vm.parseJsonAddress(config, ".permit2") == PERMIT2, "MPGR: config Permit2 mismatch");
        require(vm.parseJsonAddress(config, ".weth") == WETH, "MPGR: config WETH mismatch");

        require(dex.owner() == vm.parseJsonAddress(config, ".owner"), "MPGR: owner mismatch");
        require(dex.pendingOwner() == address(0), "MPGR: unexpected pending owner");
        require(dex.feeRecipient() == vm.parseJsonAddress(config, ".feeRecipient"), "MPGR: fee recipient mismatch");
        require(dex.feeBps() == EXPECTED_FEE_BPS, "MPGR: feeBps mismatch");
        require(dex.MAX_FEE_BPS() == EXPECTED_MAX_FEE_BPS, "MPGR: max fee mismatch");
        require(address(dex.PERMIT2()) == PERMIT2 && address(dex.WETH()) == WETH, "MPGR: immutable dependency mismatch");
        require(!dex.paused(), "MPGR: executor is paused");
        require(
            keccak256(bytes(dex.WITNESS_TYPE_STRING())) == keccak256(bytes(EXPECTED_WITNESS_TYPE_STRING)),
            "MPGR: witness type string mismatch"
        );
        require(address(dex).balance == 0, "MPGR: executor holds native ETH");

        address[] memory configuredModules = vm.parseJsonAddressArray(config, ".typedModules");
        require(configuredModules.length == 0, "MPGR: initial typed-module registry config is not empty");
        require(!vm.keyExistsJson(config, ".tokens[15].address"), "MPGR: unexpected extra token in deployment config");
        require(!vm.keyExistsJson(config, ".routers[2].router"), "MPGR: unexpected extra router in deployment config");
        _verifyRouters(config, dex);
        _verifyTokens(config, dex, executor);
        _verifyDeniedAddresses(config, dex);
    }

    function _verifyRouters(string memory config, MPGRExecutorDelegated dex) internal view {
        address slipstream = vm.parseJsonAddress(config, ".routers[0].router");
        address uniswap = vm.parseJsonAddress(config, ".routers[1].router");
        require(slipstream == SLIPSTREAM_ROUTER, "MPGR: configured Slipstream router mismatch");
        require(uniswap == UNISWAP_V3_ROUTER02, "MPGR: configured Uniswap V3 router mismatch");
        require(
            vm.parseJsonUint(config, ".routers[0].kind") == uint256(MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM),
            "MPGR: configured Slipstream kind mismatch"
        );
        require(
            vm.parseJsonUint(config, ".routers[1].kind") == uint256(MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02),
            "MPGR: configured Uniswap V3 kind mismatch"
        );
        require(dex.routerKind(slipstream) == MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM, "MPGR: Slipstream posture mismatch");
        require(dex.routerKind(uniswap) == MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02, "MPGR: Uniswap V3 posture mismatch");
        for (uint256 i = 0; i < ROUTER_COUNT; ++i) {
            address router = vm.parseJsonAddress(config, string.concat(".routers[", vm.toString(i), "].router"));
            require(dex.swapModuleForRouter(router) == address(0), "MPGR: initial router unexpectedly uses a module");
            require(dex.swapModuleCodeHash(router) == bytes32(0), "MPGR: initial router has unexpected module code hash");
        }
    }

    function _verifyTokens(string memory config, MPGRExecutorDelegated dex, address executor) internal view {
        address[] memory seen = new address[](TOKEN_COUNT);
        for (uint256 i = 0; i < TOKEN_COUNT; ++i) {
            address token = vm.parseJsonAddress(config, string.concat(".tokens[", vm.toString(i), "].address"));
            for (uint256 j = 0; j < i; ++j) require(token != seen[j], "MPGR: duplicate token in deployment config");
            seen[i] = token;
            require(dex.isTokenAllowed(token), "MPGR: configured production token not allowlisted");
            require(IERC20(token).balanceOf(executor) == 0, "MPGR: executor holds a token balance");
        }
    }

    function _verifyDeniedAddresses(string memory config, MPGRExecutorDelegated dex) internal view {
        address[] memory sepolia = vm.parseJsonAddressArray(config, ".denied.sepolia");
        _requireDenied(config, dex, ".denied.canaryWallet");
        _requireDenied(config, dex, ".denied.v1MainnetExecutor");
        for (uint256 i = 0; i < sepolia.length; ++i) {
            _requireNotAllowlisted(dex, sepolia[i]);
        }
    }

    function _requireDenied(string memory config, MPGRExecutorDelegated dex, string memory path) internal view {
        _requireNotAllowlisted(dex, vm.parseJsonAddress(config, path));
    }

    function _requireNotAllowlisted(MPGRExecutorDelegated dex, address denied) internal view {
        require(dex.routerKind(denied) == MPGRExecutorDelegated.RouterKind.NONE, "MPGR: denied address is an allowed router");
        require(dex.swapModuleForRouter(denied) == address(0), "MPGR: denied address has a registered module");
        require(!dex.isTokenAllowed(denied), "MPGR: denied address is an allowed token");
    }

    function _writeArtifact(
        string memory config,
        MPGRExecutorDelegated dex,
        address deployer,
        VmSafe.BroadcastTxSummary memory deployment
    ) internal {
        string memory k = "deployment";
        _writeIdentityAndReceipt(k, dex, deployer, deployment);
        _writeRuntimePosture(k, dex);
        _writeAllowlistArtifact(k, config);
        string memory out = vm.serializeString(k, "configFile", CONFIG_FILE);
        vm.createDir("deployments/base-mainnet", true);
        vm.writeJson(out, OUT_FILE);
    }

    function _writeIdentityAndReceipt(
        string memory k,
        MPGRExecutorDelegated dex,
        address deployer,
        VmSafe.BroadcastTxSummary memory deployment
    ) internal {
        vm.serializeUint(k, "artifactSchemaVersion", 1);
        vm.serializeString(k, "contract", "MPGRExecutorDelegated");
        vm.serializeString(k, "network", "base");
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "executor", address(dex));
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeBytes32(k, "deployTx", deployment.txHash);
        vm.serializeUint(k, "deployedAtBlock", deployment.blockNumber);
        vm.serializeBool(k, "deploymentReceiptSuccess", deployment.success);
        vm.serializeBytes32(k, "runtimeCodeHash", address(dex).codehash);
        vm.serializeString(k, "proxy", "none");
        vm.serializeString(k, "implementation", "none");
        vm.serializeString(k, "upgradeAuthority", "none");
    }

    function _writeRuntimePosture(string memory k, MPGRExecutorDelegated dex) internal {
        vm.serializeAddress(k, "owner", dex.owner());
        vm.serializeAddress(k, "feeRecipient", dex.feeRecipient());
        vm.serializeUint(k, "feeBps", dex.feeBps());
        vm.serializeUint(k, "maxFeeBps", dex.MAX_FEE_BPS());
        vm.serializeBool(k, "paused", dex.paused());
        vm.serializeAddress(k, "weth", address(dex.WETH()));
        vm.serializeAddress(k, "permit2", address(dex.PERMIT2()));
        vm.serializeString(k, "witnessTypeString", dex.WITNESS_TYPE_STRING());
        vm.serializeString(k, "sourceVerificationStatus", "PENDING_EXTERNAL_VERIFICATION");
        vm.serializeString(k, "sourceVerificationUrl", string.concat("https://basescan.org/address/", vm.toString(address(dex))));
    }

    function _writeAllowlistArtifact(string memory k, string memory config) internal {
        address[] memory modules = vm.parseJsonAddressArray(config, ".typedModules");
        address[] memory routers = new address[](ROUTER_COUNT);
        address[] memory tokens = new address[](TOKEN_COUNT);
        string[] memory symbols = new string[](TOKEN_COUNT);
        uint256[] memory kinds = new uint256[](ROUTER_COUNT);

        for (uint256 i = 0; i < ROUTER_COUNT; ++i) {
            string memory path = string.concat(".routers[", vm.toString(i), "]");
            routers[i] = vm.parseJsonAddress(config, string.concat(path, ".router"));
            kinds[i] = vm.parseJsonUint(config, string.concat(path, ".kind"));
        }
        for (uint256 i = 0; i < TOKEN_COUNT; ++i) {
            string memory path = string.concat(".tokens[", vm.toString(i), "]");
            tokens[i] = vm.parseJsonAddress(config, string.concat(path, ".address"));
            symbols[i] = vm.parseJsonString(config, string.concat(path, ".symbol"));
        }
        vm.serializeAddress(k, "routerAllowlist", routers);
        vm.serializeUint(k, "routerKinds", kinds);
        vm.serializeAddress(k, "allowedTokenAddresses", tokens);
        vm.serializeString(k, "allowedTokenSymbols", symbols);
        vm.serializeUint(k, "moduleRegistrySchemaVersion", vm.parseJsonUint(config, ".moduleRegistrySchemaVersion"));
        vm.serializeString(k, "typedModuleRegistryStatus", "EMPTY_AT_DEPLOYMENT");
        vm.serializeAddress(k, "registeredTypedModules", modules);
    }
}
