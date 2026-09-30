// TEMPORARY debug reproduction of the fuzz counterexample — DO NOT KEEP.
// testFuzz_Equivalence_V1Permit2_vs_Delegated failed with panic 0x11 at
// calldata args [2592000, 1999, 1538]; this pins it as a unit test so the
// debug workflow's -vvvv trace shows the exact failing line.
import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {MPGRExecutorDelegated} from "../../contracts/executor/MPGRExecutorDelegated.sol";
import {MPGRExecutorDelegatedTest} from "../MPGRExecutorDelegated.t.sol";

contract DEBUGCounterexampleTest is MPGRExecutorDelegatedTest {
    function test_DEBUG_fuzzCounterexample() public {
        uint256 gross = 2_592_000;
        uint256 num = 1999;
        uint256 den = 1538;
        _setRates(num, den);
        uint256 expectedOut = _expectedOut(gross, num, den);
        assertTrue(expectedOut > 0);
        usdc.mint(ownerAddr, gross);
        _equivalenceCheck(gross, expectedOut);
    }
}
