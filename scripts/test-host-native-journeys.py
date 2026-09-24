import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('journeys', Path(__file__).with_name('host-native-journeys.py'))
journeys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journeys)

class IncidentAcceptanceProof(unittest.TestCase):
    failure = '<testsuites><testsuite><testcase><failure>Assertion is false: "Synthetic lost spare key", id: case-detail-title is visible</failure></testcase></testsuite></testsuites>'
    event = '{"event":"synthetic.incident_rejected","kind":"submission"}'

    def test_exact_assertion_and_fault_required(self):
        journeys.verify_rejection(self.failure, self.event, 'submission')
        journeys.verify_rejection(self.failure, self.event.replace('submission', 'readback'), 'readback')

    def test_driver_or_unrelated_assertion_is_not_accepted(self):
        for message in ['Driver unavailable', 'Assertion is false: Submit incident for review is visible', 'Assertion is false: Synthetic lost spare key is visible']:
            with self.assertRaises(AssertionError):
                journeys.verify_rejection(self.failure.replace('Assertion is false: "Synthetic lost spare key", id: case-detail-title is visible', message), self.event, 'submission')

    def test_missing_wrong_or_old_fault_is_not_accepted(self):
        for telemetry in ['', self.event.replace('submission', 'readback'), '{"event":"mobile.request","status":503}']:
            with self.assertRaises(AssertionError):
                journeys.verify_rejection(self.failure, telemetry, 'submission')

    def test_success_or_multiple_failures_is_not_accepted(self):
        for report in ['<testsuites><testsuite><testcase /></testsuite></testsuites>', self.failure.replace('</testcase>', '<failure>Other failure</failure></testcase>'), self.failure.replace('</testcase>', '</testcase><testcase />')]:
            with self.assertRaises(AssertionError):
                journeys.verify_rejection(report, self.event, 'submission')

if __name__ == '__main__':
    unittest.main()
