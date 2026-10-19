#!/usr/bin/env python3
"""Fail closed: absence, skips, unexpected suites and incomplete coverage are not proof.

The reviewed fork suite must use real Base pools and record the pinned fee event.
This verifies test results, not test honesty; the suite itself requires owner review.
"""
import json
import sys

REQUIRED = {
    "testForkUSDCToWETHFeeAndMinimum()",
    "testForkDirectNonMajorPairFeeAndNoHop()",
    "testForkMPGRV4FeeAndMinimum()",
    "testForkAerodromeNonMajorPairFee()",
    "testForkFallbackMultihopSingleGrossFee()",
    "testForkNoRouteNoSend()",
    "testForkFeeForgeryAndTimelock()",
    "testForkAllEntriesChargeFee()",
    "testForkUnprovenVenuesDisabled()",
}
SUITE = "test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol:MPGRSwapExecutorV2BaseForkTest"


def check(report):
    suites = [v for k, v in report.items() if k == SUITE]
    if len(suites) != 1:
        raise ValueError("required real-Base V2 suite absent (mock tests are not fork proof)")
    tests = suites[0].get("test_results", {})
    if not REQUIRED.issubset(tests):
        raise ValueError("fork coverage incomplete: " + ", ".join(sorted(REQUIRED - tests.keys())))
    if any(v.get("status") != "Success" for v in tests.values()):
        raise ValueError("fork proof contains failures/skips")


if __name__ == "__main__":
    try:
        with open(sys.argv[1], encoding="utf8") as source:
            check(json.load(source))
    except (ValueError, KeyError, IndexError, OSError) as error:
        raise SystemExit("V2 FORK PROOF REJECTED: " + str(error))
    print("V2 required fork proofs passed")
