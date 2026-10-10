#!/usr/bin/env python3
"""Fail-closed gate for the single reviewed Slither `reentrancy-balance` exception.

CI runs Slither twice on the same project:
  1. `slither . --exclude reentrancy-balance --fail-high` (every other High still fails).
  2. `slither . --detect reentrancy-balance --fail-none --json <file>`, then this script.

Pass 2 only runs `reentrancy-balance`, so this script decides whether that detector's
output is acceptable. It accepts only:
  - no findings at all, or
  - exactly one `reentrancy-balance` finding whose every element is attributable to
    contracts/executor/MPGRExecutorDelegated.sol::swapOnBehalfOfTypedModule:
      * exactly one `function` element, named swapOnBehalfOfTypedModule, in that file;
      * every other element is a `node` in that same file, with source lines inside
        the function's line range.

Anything else fails closed: unreadable or malformed JSON, Slither reporting a failure,
an unexpected detector, a finding without a function element, an extra or foreign
function element, a missing or malformed source mapping, or more than one finding.

Exit codes: 0 accepted, 1 rejected, 2 input unreadable or malformed at the top level.
"""
import json
import sys

DETECTOR = "reentrancy-balance"
ALLOWED_FILE = "contracts/executor/MPGRExecutorDelegated.sol"
ALLOWED_FUNCTION = "swapOnBehalfOfTypedModule"
ALLOWED_ELEMENT_TYPES = {"function", "node"}


class Rejected(Exception):
    """A finding or the report does not match the reviewed exception."""


class InputError(Exception):
    """The report cannot be read as a Slither JSON report."""


def _function_range(lines):
    return min(lines), max(lines)


def _check_source_mapping(element, where):
    sm = element.get("source_mapping")
    if not isinstance(sm, dict):
        raise Rejected(f"{where}: missing or non-object source_mapping")
    if sm.get("filename_relative") != ALLOWED_FILE:
        raise Rejected(f"{where}: filename_relative is {sm.get('filename_relative')!r}, expected {ALLOWED_FILE!r}")
    if sm.get("is_dependency") is not False:
        raise Rejected(f"{where}: is_dependency must be exactly false")
    lines = sm.get("lines")
    if (
        not isinstance(lines, list)
        or not lines
        or not all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in lines)
    ):
        raise Rejected(f"{where}: lines must be a non-empty list of positive integers")
    return lines


def check_finding(finding, index):
    where = f"finding #{index}"
    if not isinstance(finding, dict):
        raise Rejected(f"{where}: not an object")
    if finding.get("check") != DETECTOR:
        raise Rejected(f"{where}: unexpected detector {finding.get('check')!r}")
    if finding.get("impact") != "High":
        raise Rejected(f"{where}: impact is {finding.get('impact')!r}, expected 'High'")
    elements = finding.get("elements")
    if not isinstance(elements, list) or not elements:
        raise Rejected(f"{where}: elements missing or empty")

    for n, element in enumerate(elements):
        if not isinstance(element, dict):
            raise Rejected(f"{where} element {n}: not an object")
        if element.get("type") not in ALLOWED_ELEMENT_TYPES:
            raise Rejected(f"{where} element {n}: unexpected type {element.get('type')!r}")

    functions = [e for e in elements if e["type"] == "function"]
    if len(functions) != 1:
        raise Rejected(f"{where}: expected exactly one function element, found {len(functions)}")
    func = functions[0]
    if func.get("name") != ALLOWED_FUNCTION:
        raise Rejected(f"{where}: function element is {func.get('name')!r}, expected {ALLOWED_FUNCTION!r}")
    func_lines = _check_source_mapping(func, f"{where} function")
    low, high = _function_range(func_lines)

    for n, element in enumerate(elements):
        if element is func:
            continue
        lines = _check_source_mapping(element, f"{where} element {n}")
        if not all(low <= line <= high for line in lines):
            raise Rejected(f"{where} element {n}: lines {lines} fall outside function lines {low}-{high}")


def check_report(report):
    if not isinstance(report, dict):
        raise InputError("top-level JSON is not an object")
    if report.get("success") is not True:
        raise Rejected(f"slither reported success={report.get('success')!r}")
    if report.get("error") is not None:
        raise Rejected(f"slither reported error: {report.get('error')!r}")

    results = report.get("results")
    if not isinstance(results, dict):
        raise InputError("'results' is missing or not an object")
    unexpected_keys = set(results) - {"detectors"}
    if unexpected_keys:
        raise Rejected(f"unexpected keys in results: {sorted(unexpected_keys)}")
    # Slither omits the 'detectors' key entirely when there are no findings.
    detectors = results.get("detectors", [])
    if not isinstance(detectors, list):
        raise InputError("'results.detectors' is not a list")

    if len(detectors) > 1:
        raise Rejected(f"expected at most one {DETECTOR} finding, found {len(detectors)}")
    for index, finding in enumerate(detectors):
        check_finding(finding, index)
    return len(detectors)


def main(argv):
    if len(argv) != 2:
        print("usage: check-slither-reentrancy-balance.py <slither-json>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as fh:
            report = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"ERROR: cannot read Slither JSON {argv[1]!r}: {exc}", file=sys.stderr)
        return 2
    try:
        count = check_report(report)
    except InputError as exc:
        print(f"ERROR: malformed Slither JSON: {exc}", file=sys.stderr)
        return 2
    except Rejected as exc:
        print(f"FAIL: {exc}")
        return 1
    print(
        f"PASS: {count} {DETECTOR} finding(s); allowed only as "
        f"{ALLOWED_FILE}::{ALLOWED_FUNCTION}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
