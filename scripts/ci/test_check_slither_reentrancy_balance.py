"""Unit tests for check-slither-reentrancy-balance.py.

Fixtures in testdata/ are trimmed real Slither 0.11.6 JSON reports (the parent-contract
blocks, presentation fields and source text are removed; the fields the checker reads
are unchanged). Malformed cases are derived from the real accepted report by changing
one property at a time.

Run: python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
"""
import copy
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "checker", os.path.join(HERE, "check-slither-reentrancy-balance.py")
)
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

FILE = "contracts/executor/MPGRExecutorDelegated.sol"
FUNC = "swapOnBehalfOfTypedModule"


def load(name):
    with open(os.path.join(HERE, "testdata", name), encoding="utf-8") as fh:
        return json.load(fh)


ACCEPT = load("slither-rb-accept-b32426e.json")  # real: one finding, function + 3 nodes
EMPTY = load("slither-rb-empty.json")  # real: no findings (no "detectors" key)
HELPER = load("slither-rb-helper-extra-finding.json")  # real: extra finding in _inner


def finding(report=ACCEPT):
    return copy.deepcopy(report["results"]["detectors"][0])


def func_element(f):
    return next(e for e in f["elements"] if e["type"] == "function")


def node_elements(f):
    return [e for e in f["elements"] if e["type"] == "node"]


class AcceptedCases(unittest.TestCase):
    def test_real_b32426e_report_is_accepted(self):
        self.assertEqual(checker.check_report(copy.deepcopy(ACCEPT)), 1)

    def test_real_empty_report_is_accepted(self):
        self.assertEqual(checker.check_report(copy.deepcopy(EMPTY)), 0)

    def test_real_report_has_function_and_nodes_in_the_allowed_file(self):
        f = finding()
        self.assertEqual(func_element(f)["name"], FUNC)
        self.assertEqual(func_element(f)["source_mapping"]["filename_relative"], FILE)
        self.assertTrue(node_elements(f))
        for n in node_elements(f):
            self.assertEqual(n["source_mapping"]["filename_relative"], FILE)

    def test_node_lines_inside_function_range_are_accepted(self):
        report = copy.deepcopy(ACCEPT)
        f = report["results"]["detectors"][0]
        f["elements"].append(copy.deepcopy(node_elements(f)[0]))  # a further node, same lines
        self.assertEqual(checker.check_report(report), 1)

    def test_extra_key_on_finding_is_ignored(self):
        report = copy.deepcopy(ACCEPT)
        report["results"]["detectors"][0]["markdown"] = "anything"
        self.assertEqual(checker.check_report(report), 1)


class RejectedFindingShape(unittest.TestCase):
    def assertRejected(self, report, fragment=None):
        with self.assertRaises(checker.Rejected) as cm:
            checker.check_report(report)
        if fragment:
            self.assertIn(fragment, str(cm.exception))

    def report_with(self, f):
        report = copy.deepcopy(ACCEPT)
        report["results"]["detectors"] = [f]
        return report

    def test_real_helper_report_with_extra_function_is_rejected(self):
        # Real Slither output: a second, unreviewed reentrancy-balance finding in _inner.
        self.assertRejected(copy.deepcopy(HELPER), "expected at most one")

    def test_second_function_element_in_same_finding_is_rejected(self):
        f = finding()
        extra = copy.deepcopy(func_element(f))
        extra["name"] = "withdrawAll"
        f["elements"].append(extra)
        self.assertRejected(self.report_with(f), "expected exactly one function element")

    def test_no_function_element_is_rejected(self):
        f = finding()
        f["elements"] = node_elements(f)
        self.assertRejected(self.report_with(f), "found 0")

    def test_function_element_with_other_name_is_rejected(self):
        f = finding()
        func_element(f)["name"] = "swapOnBehalfOfTypedModuleX"
        self.assertRejected(self.report_with(f), "expected 'swapOnBehalfOfTypedModule'")

    def test_function_element_in_other_file_is_rejected(self):
        f = finding()
        func_element(f)["source_mapping"]["filename_relative"] = "contracts/MPGRStaking.sol"
        self.assertRejected(self.report_with(f), "filename_relative")

    def test_allowed_function_with_node_in_other_file_is_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"]["filename_relative"] = "contracts/executor/MPGRExecutor.sol"
        self.assertRejected(self.report_with(f), "filename_relative")

    def test_allowed_function_with_node_lines_outside_function_is_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"]["lines"] = [600]
        self.assertRejected(self.report_with(f), "fall outside function lines")

    def test_node_missing_source_mapping_is_rejected(self):
        f = finding()
        del node_elements(f)[0]["source_mapping"]
        self.assertRejected(self.report_with(f), "missing or non-object source_mapping")

    def test_node_source_mapping_not_object_is_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"] = "contracts/executor/MPGRExecutorDelegated.sol#L421"
        self.assertRejected(self.report_with(f), "missing or non-object source_mapping")

    def test_node_missing_filename_is_rejected(self):
        f = finding()
        del node_elements(f)[0]["source_mapping"]["filename_relative"]
        self.assertRejected(self.report_with(f), "filename_relative")

    def test_node_missing_lines_is_rejected(self):
        f = finding()
        del node_elements(f)[0]["source_mapping"]["lines"]
        self.assertRejected(self.report_with(f), "lines must be")

    def test_empty_lines_is_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"]["lines"] = []
        self.assertRejected(self.report_with(f), "lines must be")

    def test_string_lines_are_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"]["lines"] = ["421"]
        self.assertRejected(self.report_with(f), "lines must be")

    def test_boolean_lines_are_rejected(self):
        f = finding()
        node_elements(f)[0]["source_mapping"]["lines"] = [True]
        self.assertRejected(self.report_with(f), "lines must be")

    def test_dependency_flag_true_is_rejected(self):
        f = finding()
        func_element(f)["source_mapping"]["is_dependency"] = True
        self.assertRejected(self.report_with(f), "is_dependency")

    def test_dependency_flag_missing_is_rejected(self):
        f = finding()
        del func_element(f)["source_mapping"]["is_dependency"]
        self.assertRejected(self.report_with(f), "is_dependency")

    def test_unknown_element_type_is_rejected(self):
        f = finding()
        f["elements"].append({"type": "variable", "name": "x", "source_mapping": {}})
        self.assertRejected(self.report_with(f), "unexpected type")

    def test_element_not_object_is_rejected(self):
        f = finding()
        f["elements"].append("swapOnBehalfOfTypedModule")
        self.assertRejected(self.report_with(f), "not an object")

    def test_empty_elements_is_rejected(self):
        f = finding()
        f["elements"] = []
        self.assertRejected(self.report_with(f), "elements missing or empty")

    def test_missing_elements_is_rejected(self):
        f = finding()
        del f["elements"]
        self.assertRejected(self.report_with(f), "elements missing or empty")

    def test_impact_other_than_high_is_rejected(self):
        f = finding()
        f["impact"] = "Medium"
        self.assertRejected(self.report_with(f), "impact")

    def test_missing_check_is_rejected(self):
        f = finding()
        del f["check"]
        self.assertRejected(self.report_with(f), "unexpected detector")

    def test_finding_not_object_is_rejected(self):
        self.assertRejected(self.report_with("reentrancy-balance"), "not an object")


class RejectedReportShape(unittest.TestCase):
    def test_two_findings_for_the_allowed_function_are_rejected(self):
        report = copy.deepcopy(ACCEPT)
        report["results"]["detectors"].append(copy.deepcopy(report["results"]["detectors"][0]))
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_other_detector_in_report_is_rejected(self):
        report = copy.deepcopy(ACCEPT)
        other = copy.deepcopy(report["results"]["detectors"][0])
        other["check"] = "arbitrary-send-eth"
        report["results"]["detectors"].append(other)
        with self.assertRaises(checker.Rejected) as cm:
            checker.check_report(report)
        self.assertIn("at most one", str(cm.exception))

    def test_other_detector_alone_is_rejected(self):
        report = copy.deepcopy(ACCEPT)
        report["results"]["detectors"][0]["check"] = "arbitrary-send-eth"
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_success_false_is_rejected(self):
        report = copy.deepcopy(EMPTY)
        report["success"] = False
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_success_missing_is_rejected(self):
        report = copy.deepcopy(EMPTY)
        del report["success"]
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_error_present_is_rejected(self):
        report = copy.deepcopy(EMPTY)
        report["error"] = "compilation failed"
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_unexpected_results_key_is_rejected(self):
        report = copy.deepcopy(EMPTY)
        report["results"]["printers"] = []
        with self.assertRaises(checker.Rejected):
            checker.check_report(report)

    def test_detectors_not_a_list_is_malformed(self):
        report = copy.deepcopy(ACCEPT)
        report["results"]["detectors"] = {}
        with self.assertRaises(checker.InputError):
            checker.check_report(report)

    def test_results_missing_is_malformed(self):
        with self.assertRaises(checker.InputError):
            checker.check_report({"success": True, "error": None})

    def test_top_level_not_object_is_malformed(self):
        with self.assertRaises(checker.InputError):
            checker.check_report([])


class CommandLine(unittest.TestCase):
    def run_main(self, payload):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            fh.write(payload if isinstance(payload, str) else json.dumps(payload))
            path = fh.name
        try:
            return checker.main(["check", path])
        finally:
            os.unlink(path)

    def test_accepted_report_exit_0(self):
        self.assertEqual(self.run_main(ACCEPT), 0)

    def test_empty_report_exit_0(self):
        self.assertEqual(self.run_main(EMPTY), 0)

    def test_helper_report_exit_1(self):
        self.assertEqual(self.run_main(HELPER), 1)

    def test_truncated_json_exit_2(self):
        self.assertEqual(self.run_main('{"success": true, "results": {"detectors": ['), 2)

    def test_missing_file_exit_2(self):
        self.assertEqual(checker.main(["check", "/nonexistent/slither.json"]), 2)

    def test_wrong_arg_count_exit_2(self):
        self.assertEqual(checker.main(["check"]), 2)

    def test_malformed_top_level_exit_2(self):
        self.assertEqual(self.run_main("[]"), 2)


if __name__ == "__main__":
    unittest.main()
