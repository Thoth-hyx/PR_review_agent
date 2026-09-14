import unittest

from evoagent.diff_parser import parse_unified_diff
from evoagent.reviewer import LocalRuleReviewer, SecurityRuleReviewer, ReliabilityRuleReviewer


class LocalReviewerTests(unittest.TestCase):
    def test_detects_security_findings_only_on_added_lines(self):
        diff = """--- a/app.py
+++ b/app.py
@@ -1,2 +1,3 @@
-eval(old_input)
+password = "super-secret"
+eval(user_input)
 safe = True
"""
        findings = LocalRuleReviewer().review(diff, parse_unified_diff(diff))
        self.assertEqual({"SEC-EVAL", "SEC-HARDCODED-SECRET"}, {item.rule_id for item in findings})
        self.assertTrue(all(item.line in {1, 2} for item in findings))

    def test_domain_scanners_keep_rules_order_and_evidence(self):
        diff = '''--- a/app.py
+++ b/app.py
@@ -0,0 +1,6 @@
+eval(user_input)
+subprocess.run(command, shell=True)
+password = "super-secret"
+db.execute(f"SELECT {user_input}")
+except Exception: pass
+print(user_input)
--- a/bundle.min.js
+++ b/bundle.min.js
@@ -0,0 +1 @@
+eval(user_input)
'''
        parsed = parse_unified_diff(diff)
        parsed.added_lines.append(parsed.added_lines[0])  # Duplicate evidence stays deduplicated.
        findings = LocalRuleReviewer().review(diff, parsed)
        expected_ids = ["SEC-EVAL", "SEC-SUBPROCESS-SHELL", "SEC-HARDCODED-SECRET",
                        "SEC-SQL-CONCAT", "REL-EMPTY-EXCEPT", "REL-DEBUG-PRINT"]
        self.assertEqual(expected_ids, [item.rule_id for item in findings])
        for reviewer, expected in ((SecurityRuleReviewer(), findings[:4]),
                                   (ReliabilityRuleReviewer(), findings[4:])):
            self.assertEqual([item.to_dict() for item in expected],
                             [item.to_dict() for item in reviewer.review(diff, parsed)])
        reviewer = SecurityRuleReviewer()
        reviewer.rule_ids = {"REL-DEBUG-PRINT"}
        self.assertEqual([findings[-1].to_dict()],
                         [item.to_dict() for item in reviewer.review(diff, parsed)])


if __name__ == "__main__":
    unittest.main()
