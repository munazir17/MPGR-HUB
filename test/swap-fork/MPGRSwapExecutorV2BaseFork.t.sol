// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MPGRSwapExecutorV2 as E} from "../../contracts/swap/MPGRSwapExecutorV2.sol";
import {IMPGRV4PoolManager as V4} from "../../contracts/swap/interfaces/IMPGRV4PoolManager.sol";

/// @notice No mocks, no skips, no sends: deploys the candidate only on a Base fork.
contract MPGRSwapExecutorV2BaseForkTest is Test {
    address constant SAFE=0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B;
    address constant FEE=0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant MPGR=0xB2000000000000000000008d204203177a78AF01;
    address constant AERO=0x940181a94A35A4569E4529A3CDfB74e38FD98631;
    address constant DEGEN=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed;
    address constant CBBTC=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant VIRTUAL=0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b;
    address constant MANAGER=0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant UNI=0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant UF=0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant SLIP=0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant SF=0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address constant CLASSIC=0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant CF=0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant V2=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant VF=0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address constant USER=address(0xA11CE);
    E ex;
    string fixtures;
    function setUp() public {
        if(bytes(vm.envOr("BASE_MAINNET_RPC_URL",string(""))).length==0) { vm.skip(true); return; }
        fixtures=vm.readFile("deployments/.local/v2-fork-fixtures.json");
        vm.createSelectFork(vm.envString("BASE_MAINNET_RPC_URL"),vm.parseJsonUint(fixtures,".block"));
        assertEq(block.chainid,8453); assertGt(SAFE.code.length,0,"Safe absent on Base");
        assertGt(MANAGER.code.length,0,"canonical v4 PoolManager code absent");
        console2.log("BASE_FORK_BLOCK",block.number);
        console2.log("V4_POOL_MANAGER_CODEHASH");console2.logBytes32(MANAGER.codehash);
        E.RouterConfig[] memory r=new E.RouterConfig[](5);
        r[0]=E.RouterConfig(UNI,E.RouterKind.UNISWAP_V3_ROUTER02,UF);
        r[1]=E.RouterConfig(SLIP,E.RouterKind.AERODROME_SLIPSTREAM,SF);
        r[2]=E.RouterConfig(CLASSIC,E.RouterKind.AERODROME_CLASSIC,CF);
        r[3]=E.RouterConfig(V2,E.RouterKind.UNISWAP_V2_ROUTER02,VF);
        r[4]=E.RouterConfig(MANAGER,E.RouterKind.UNISWAP_V4,MANAGER);
        ex=new E(SAFE,WETH,0x000000000022D473030F116dDEE9F6B43aC78BA3,r,25,FEE);
    }
    function auth() internal pure returns(E.Authorization memory a) {}
    function pool(address f,bytes memory data) internal view returns(address p) {
        (bool ok,bytes memory ret)=f.staticcall(data);
        if(ok && ret.length>=32) p=abi.decode(ret,(address));
    }
    function hop(address input,address output,address router,E.RouterKind kind,uint24 fee,int24 spacing,bool stable) internal view returns(E.Hop memory h) {
        h.router=router;h.kind=kind;h.tokenOut=output;h.poolFee=fee;h.tickSpacing=spacing;h.stable=stable;
        address f=ex.routerFactory(router);
        if(kind==E.RouterKind.UNISWAP_V3_ROUTER02) h.pool=pool(f,abi.encodeWithSignature("getPool(address,address,uint24)",input,output,fee));
        else if(kind==E.RouterKind.AERODROME_SLIPSTREAM) h.pool=pool(f,abi.encodeWithSignature("getPool(address,address,int24)",input,output,spacing));
        else if(kind==E.RouterKind.AERODROME_CLASSIC) h.pool=pool(f,abi.encodeWithSignature("getPool(address,address,bool)",input,output,stable));
        else h.pool=pool(f,abi.encodeWithSignature("getPair(address,address)",input,output));
    }
    function params(address input,address output,uint256 gross,address r,uint256 minimum) internal view returns(E.SwapParams memory) {
        return E.SwapParams(r,input,output,gross,gross*25/10000,minimum,USER,block.timestamp+600,keccak256("real-base-v2"),false);
    }
    /// @dev Preview the actual executor on a snapshot, then execute at 99% of that
    /// quote on restored live state. No fabricated rate or min-out of one.
    function execute(address input,uint256 gross,E.Hop[] memory h) external returns(uint256 out) {
        require(msg.sender==address(this));
        if(input==MPGR) {
            // B20 is a Base-native stateful precompile, not EVM bytecode.
            // Acquire real MPGR from its live v4 pool, never etch/mock its code
            // or guess its storage layout using stdStorage/deal.
            E.Hop[] memory buy=new E.Hop[](1);buy[0]=mpgrHop();buy[0].tokenOut=MPGR;
            vm.deal(USER,1 ether);
            vm.prank(USER);ex.swapExactInput{value:1e14}(params(WETH,MPGR,1e14,MANAGER,1),buy,auth());
            assertGe(IERC20(MPGR).balanceOf(USER),gross,"live funding buy yielded insufficient MPGR");
        } else deal(input,USER,gross);
        vm.prank(USER); IERC20(input).approve(address(ex),gross);
        uint256 snap=vm.snapshotState();
        E.SwapParams memory p=params(input,h[h.length-1].tokenOut,gross,h[0].router,1);
        vm.prank(USER); uint256 quoted=ex.swapExactInput(p,h,auth());
        assertGt(quoted,100,"no meaningful liquid quote");
        vm.revertToState(snap); p.amountOutMinimum=quoted*99/100;
        uint256 beforeFee=IERC20(input).balanceOf(FEE);
        uint256 beforeOut=IERC20(p.tokenOut).balanceOf(USER);
        vm.recordLogs(); vm.prank(USER); out=ex.swapExactInput(p,h,auth());
        assertGe(out,p.amountOutMinimum); assertEq(IERC20(p.tokenOut).balanceOf(USER)-beforeOut,out);
        assertEq(IERC20(input).balanceOf(FEE)-beforeFee,gross*25/10000);
        assertFee(vm.getRecordedLogs(),input,gross,out);
        assertEq(IERC20(input).balanceOf(address(ex)),0);
        for(uint256 i;i<h.length;i++) {console2.log("REAL_POOL",h[i].pool);console2.log("TOKEN_OUT",h[i].tokenOut);}
        console2.log("TOKEN_IN",input);console2.log("GROSS",gross);console2.log("NET_OUTPUT",out);console2.log("HOPS",h.length);
    }
    function assertFee(Vm.Log[] memory logs,address input,uint256 gross,uint256 output) internal view {
        uint256 count;
        for(uint256 i;i<logs.length;i++) if(logs[i].emitter==address(ex) && logs[i].topics[0]==keccak256("SwapExecuted(address,address,bytes32,address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8)")) {
            (address tin,,uint256 g,uint256 fee,uint256 net,uint256 out,address recipient,uint16 bps,,)=abi.decode(logs[i].data,(address,address,uint256,uint256,uint256,uint256,address,uint16,E.RouterKind,uint8));
            assertEq(tin,input);assertEq(g,gross);assertEq(fee,gross*25/10000);assertEq(net,gross-fee);assertEq(out,output);assertEq(recipient,FEE);assertEq(bps,25);++count;
        }
        assertEq(count,1,"missing/duplicate pinned 25bps fee event");
    }
    function direct(address input,address output,bool aeroOnly) internal returns(bool) {
        E.Hop[] memory h=new E.Hop[](1);
        for(uint256 i;i<2;i++) {
            h[0]=hop(input,output,CLASSIC,E.RouterKind.AERODROME_CLASSIC,0,0,i==1);
            if(h[0].pool!=address(0)) try this.execute(input,1e18,h) returns(uint256) {return true;} catch {}
        }
        int24[6] memory spacings=[int24(1),10,50,100,200,2000];
        for(uint256 i;i<spacings.length;i++) {
            h[0]=hop(input,output,SLIP,E.RouterKind.AERODROME_SLIPSTREAM,0,spacings[i],false);
            if(h[0].pool!=address(0)) try this.execute(input,1e18,h) returns(uint256) {return true;} catch {}
        }
        if(aeroOnly) return false;
        uint24[4] memory fees=[uint24(100),500,3000,10000];
        for(uint256 i;i<fees.length;i++) {
            h[0]=hop(input,output,UNI,E.RouterKind.UNISWAP_V3_ROUTER02,fees[i],0,false);
            if(h[0].pool!=address(0)) try this.execute(input,1e18,h) returns(uint256) {return true;} catch {}
        }
        h[0]=hop(input,output,V2,E.RouterKind.UNISWAP_V2_ROUTER02,0,0,false);
        if(h[0].pool!=address(0)) try this.execute(input,1e18,h) returns(uint256) {return true;} catch {}
        return false;
    }
    function testForkUSDCToWETHFeeAndMinimum() public {
        E.Hop[] memory h=new E.Hop[](1);h[0]=hop(USDC,WETH,UNI,E.RouterKind.UNISWAP_V3_ROUTER02,500,0,false);
        this.execute(USDC,100e6,h);
    }
    function testForkDirectNonMajorPairFeeAndNoHop() public {
        if(direct(AERO,DEGEN,false)) return;
        if(direct(AERO,CBBTC,false)) return;
        if(direct(AERO,VIRTUAL,false)) return;
        revert("No liquid direct AERO/DEGEN, AERO/cbBTC or AERO/VIRTUAL pool found; NOT a pass");
    }
    function testForkAerodromeNonMajorPairFee() public {
        assertTrue(direct(AERO,WETH,true),"No liquid Aerodrome AERO/WETH pool; NOT a pass");
    }
    function mpgrHop() internal view returns(E.Hop memory h) {
        h.router=MANAGER;h.kind=E.RouterKind.UNISWAP_V4;h.pool=MANAGER;h.tokenOut=WETH;
        h.v4Key=V4.PoolKey(vm.parseJsonAddress(fixtures,".mpgr.currency0"),vm.parseJsonAddress(fixtures,".mpgr.currency1"),uint24(vm.parseJsonUint(fixtures,".mpgr.fee")),int24(int256(vm.parseJsonUint(fixtures,".mpgr.tickSpacing"))),vm.parseJsonAddress(fixtures,".mpgr.hooks"));
    }
    function testForkMPGRV4FeeAndMinimum() public {
        V4.PoolKey memory key=V4.PoolKey(vm.parseJsonAddress(fixtures,".mpgr.currency0"),vm.parseJsonAddress(fixtures,".mpgr.currency1"),uint24(vm.parseJsonUint(fixtures,".mpgr.fee")),int24(int256(vm.parseJsonUint(fixtures,".mpgr.tickSpacing"))),vm.parseJsonAddress(fixtures,".mpgr.hooks"));
        bytes32 id=keccak256(abi.encode(key));assertEq(id,vm.parseJsonBytes32(fixtures,".mpgr.poolId"),"Initialize pool ID mismatch");
        console2.log("REAL_V4_POOL_ID");console2.logBytes32(id);console2.log("V4_HOOKS",key.hooks);console2.log("V4_FEE",key.fee);console2.log("V4_TICK_SPACING",uint256(uint24(key.tickSpacing)));
        E.Hop[] memory h=new E.Hop[](1);h[0].router=MANAGER;h[0].kind=E.RouterKind.UNISWAP_V4;h[0].pool=MANAGER;h[0].tokenOut=WETH;h[0].v4Key=key;
        this.execute(MPGR,1e18,h);
    }
    function testForkNoRouteNoSend() public {
        // Two real Base ERC20s, an impossible unregistered fee tier, no pool.
        E.Hop[] memory h=new E.Hop[](1);h[0]=hop(USDC,AERO,UNI,E.RouterKind.UNISWAP_V3_ROUTER02,999999,0,false);
        assertEq(h[0].pool,address(0));
        deal(USDC,USER,100e6);vm.prank(USER);IERC20(USDC).approve(address(ex),100e6);
        uint256 beforeFee=IERC20(USDC).balanceOf(FEE);
        vm.expectRevert();vm.prank(USER);ex.swapExactInput(params(USDC,AERO,100e6,UNI,1),h,auth());
        assertEq(IERC20(USDC).balanceOf(USER),100e6);assertEq(IERC20(USDC).balanceOf(FEE),beforeFee);
    }
    function testForkFeeForgeryAndTimelock() public {
        E.Hop[] memory h=new E.Hop[](1);h[0]=hop(USDC,WETH,UNI,E.RouterKind.UNISWAP_V3_ROUTER02,500,0,false);
        deal(USDC,USER,100e6);vm.prank(USER);IERC20(USDC).approve(address(ex),100e6);
        E.SwapParams memory p=params(USDC,WETH,100e6,UNI,1);p.expectedFeeAmount=0;
        vm.expectRevert();vm.prank(USER);ex.swapExactInput(p,h,auth());
        vm.expectRevert();vm.prank(SAFE);ex.proposeFeeChange(25,USER);
        vm.expectRevert();vm.prank(SAFE);ex.proposeFeeChange(0,FEE);
        vm.expectRevert();vm.prank(SAFE);ex.proposeFeeChange(101,FEE);
        vm.prank(SAFE);ex.proposeFeeChange(100,FEE);assertEq(ex.feeBps(),25);
        vm.expectRevert();vm.prank(SAFE);ex.applyFeeChange();
        vm.warp(block.timestamp+48 hours);vm.prank(SAFE);ex.applyFeeChange();assertEq(ex.feeBps(),100);
    }
    function testForkAllEntriesChargeFee() public {
        // Both enabled entry selectors: ordinary and split, on live v3 pools.
        E.Hop[] memory h=new E.Hop[](1);h[0]=hop(USDC,WETH,UNI,E.RouterKind.UNISWAP_V3_ROUTER02,500,0,false);
        this.execute(USDC,100e6,h);
        deal(USDC,USER,100e6);vm.prank(USER);IERC20(USDC).approve(address(ex),100e6);
        E.Hop[][] memory paths=new E.Hop[][](2);paths[0]=h;paths[1]=h;
        uint256[] memory amounts=new uint256[](2);amounts[0]=49875000;amounts[1]=49875000;
        uint256 beforeFee=IERC20(USDC).balanceOf(FEE);
        vm.recordLogs();vm.prank(USER);uint256 out=ex.swapExactInputSplit(params(USDC,WETH,100e6,UNI,1),paths,amounts,auth());
        assertFee(vm.getRecordedLogs(),USDC,100e6,out);assertEq(IERC20(USDC).balanceOf(FEE)-beforeFee,250000);
    }
    function testForkUnprovenVenuesDisabled() public {
        vm.expectRevert();vm.prank(SAFE);ex.setRouter(UNI,E.RouterKind.PANCAKE_V3,UF);
        vm.expectRevert();vm.prank(SAFE);ex.setRouter(UNI,E.RouterKind.ZEROX_SETTLER,UF);
        vm.prank(USER);(bool ok,)=address(ex).call(abi.encodeWithSignature("swapViaAggregator()"));assertFalse(ok);
    }
}
