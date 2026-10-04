"""The code node contract (spec §3), shared by the editor (Pyodide) and compiled LangGraph (CPython)."""
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import code_node_harness as h  # noqa: E402


def ok_result(data):
    return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


def run(source, input=None, exits=("next",), tools=(), transport=None, timeout_s=5, threaded=True):
    transport = transport or (lambda s, t, a: ok_result({}))
    return h.execute(source, input, list(exits), list(tools), transport, timeout_s, threaded=threaded)


class DecodeInput(unittest.TestCase):
    def test_no_parent_is_the_prompt(self):
        self.assertEqual(h.decode_input([], "hello"), "hello")

    def test_start_parent_stays_text_even_if_json(self):
        self.assertEqual(h.decode_input([{"name": "start", "text": "[1, 2]", "start": True}], "p"), "[1, 2]")

    def test_one_parent_json_is_decoded_else_text(self):
        self.assertEqual(h.decode_input([{"name": "A", "text": '{"a": 1}', "start": False}], "p"), {"a": 1})
        self.assertEqual(h.decode_input([{"name": "A", "text": "42", "start": False}], "p"), 42)
        self.assertEqual(h.decode_input([{"name": "A", "text": "plain words", "start": False}], "p"), "plain words")

    def test_several_parents_by_name_with_duplicates(self):
        got = h.decode_input([{"name": "A", "text": "1", "start": False},
                              {"name": "A", "text": "x", "start": False},
                              {"name": "B", "text": "null", "start": False}], "p")
        self.assertEqual(got, {"A": 1, "A (2)": "x", "B": None})


class ReturnRules(unittest.TestCase):
    def test_single_exit_any_value(self):
        r = run("def run(input, call_tool):\n    return {'n': input}", input=3)
        self.assertEqual((r["ok"], r["route"], r["output_text"]), (True, "next", '{"n": 3}'))

    def test_string_output_unchanged_and_none_is_null(self):
        self.assertEqual(run("def run(i, c):\n    return 'héllo'")["output_text"], "héllo")
        self.assertEqual(run("def run(i, c):\n    return None")["output_text"], "null")

    def test_multi_exit_needs_route(self):
        src = "def run(i, c):\n    return {'route': 'job', 'output': [1]}"
        r = run(src, exits=("job", "no_job"))
        self.assertEqual((r["route"], r["output_text"]), ("job", "[1]"))
        bad = run("def run(i, c):\n    return {'output': 1}", exits=("job", "no_job"))
        self.assertFalse(bad["ok"])
        self.assertIn("route", bad["error"])
        wrong = run("def run(i, c):\n    return {'route': 'nope', 'output': 1}", exits=("job", "no_job"))
        self.assertFalse(wrong["ok"])

    def test_single_exit_route_dict_accepted(self):
        r = run("def run(i, c):\n    return {'route': 'next', 'output': 'x'}")
        self.assertEqual((r["route"], r["output_text"]), ("next", "x"))

    def test_unserialisable_output_fails(self):
        r = run("def run(i, c):\n    return object()")
        self.assertFalse(r["ok"])
        self.assertIn("JSON", r["error"])


class CallTool(unittest.TestCase):
    SRC = "def run(i, call_tool):\n    return call_tool('servicenow', 'poll_jobs', {'tag': 'x'})"

    def test_declared_tool_returns_structured_content(self):
        seen = []
        r = run(self.SRC, tools=("servicenow.poll_jobs",),
                transport=lambda s, t, a: seen.append((s, t, a)) or ok_result({"job": None}))
        self.assertEqual(json.loads(r["output_text"]), {"job": None})
        self.assertEqual(seen, [("servicenow", "poll_jobs", {"tag": "x"})])
        self.assertEqual([(c["server"], c["tool"], c["ok"]) for c in r["tool_calls"]], [("servicenow", "poll_jobs", True)])

    def test_text_result_decoded_when_json(self):
        r = run(self.SRC, tools=("servicenow.poll_jobs",),
                transport=lambda s, t, a: {"content": [{"type": "text", "text": '{"a": 2}'}]})
        self.assertEqual(json.loads(r["output_text"]), {"a": 2})

    def test_undeclared_tool_is_refused_without_calling(self):
        seen = []
        r = run(self.SRC, tools=(), transport=lambda s, t, a: seen.append(1) or ok_result({}))
        self.assertFalse(r["ok"])
        self.assertIn("ToolError", r["error"])
        self.assertIn("not declared", r["error"])
        self.assertEqual(seen, [])

    def test_is_error_raises_tool_error(self):   # review focus 3
        r = run(self.SRC, tools=("servicenow.poll_jobs",),
                transport=lambda s, t, a: {"isError": True, "content": [{"type": "text", "text": "not_claimable: closed"}]})
        self.assertFalse(r["ok"])
        self.assertIn("not_claimable: closed", r["error"])
        self.assertFalse(r["tool_calls"][0]["ok"])

    def test_transport_exception_becomes_tool_error(self):
        def boom(s, t, a):
            raise OSError("connection refused")
        r = run(self.SRC, tools=("servicenow.poll_jobs",), transport=boom)
        self.assertIn("ToolError", r["error"])
        self.assertIn("connection refused", r["error"])


class ErrorsAndLimits(unittest.TestCase):
    def test_error_exit_takes_exceptions(self):
        r = run("def run(i, c):\n    raise ValueError('boom')", exits=("job", "error"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["route"], "error")
        self.assertEqual(json.loads(r["output_text"]), {"error": "ValueError: boom"})

    def test_without_error_exit_the_node_fails(self):
        r = run("def run(i, c):\n    raise ValueError('boom')")
        self.assertEqual((r["ok"], r["error"]), (False, "ValueError: boom"))

    def test_missing_run_and_syntax_error(self):
        self.assertIn("run(input, call_tool)", run("x = 1")["error"])
        self.assertIn("syntax error", run("def run(:\n")["error"])

    def test_imports_are_checked(self):
        self.assertTrue(run("import json, re\ndef run(i, c):\n    return json.dumps([1])")["ok"])
        for mod in ("requests", "subprocess", "socket", "urllib.request", "threading"):
            r = run(f"import {mod}\ndef run(i, c):\n    return 1")
            self.assertFalse(r["ok"], mod)
            self.assertIn(mod.split(".")[0], r["error"])
        self.assertFalse(run("from http import client\ndef run(i, c):\n    return 1")["ok"])

    def test_stdout_is_captured_and_capped(self):
        r = run("def run(i, c):\n    print('x' * 30000)\n    return 1")
        self.assertEqual(len(r["stdout"]), h.STDOUT_LIMIT)

    def test_threaded_timeout_stops_waiting(self):   # review focus 4
        t0 = time.monotonic()
        r = run("def run(i, c):\n    while True:\n        pass", timeout_s=1)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertFalse(r["ok"])
        self.assertIn("timed out", r["error"])

    def test_unthreaded_deadline_checked_after_run(self):
        r = run("import time\ndef run(i, c):\n    time.sleep(1.2)\n    return 1", timeout_s=1, threaded=False)
        self.assertFalse(r["ok"])
        self.assertIn("timed out", r["error"])

    def test_system_exit_without_error_exit_fails(self):
        r = run("def run(i, c):\n    import sys\n    sys.exit(3)")
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"].startswith("SystemExit"))

    def test_system_exit_with_error_exit_routes_to_error(self):
        r = run("def run(i, c):\n    import sys\n    sys.exit(3)", exits=("next", "error"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["route"], "error")
        self.assertIn("SystemExit", json.loads(r["output_text"])["error"])

    def test_print_is_captured_per_call(self):
        r = run("def run(i, c):\n    print('hello')\n    return 'ok'")
        self.assertTrue(r["ok"])
        self.assertEqual(r["stdout"], "hello\n")

    def test_concurrent_print_isolation(self):
        """Two code nodes running in parallel threads should each capture only their own prints."""
        import threading as th
        results = [None, None]

        def run_node(idx, marker):
            r = run(f"def run(i, c):\n    import time\n    for _ in range(20):\n        print('{marker}')\n        time.sleep(0.001)\n    return 'ok'")
            results[idx] = r

        t1 = th.Thread(target=run_node, args=(0, "A"))
        t2 = th.Thread(target=run_node, args=(1, "B"))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # Each should have 20 lines of their own marker, no mixing
        self.assertEqual(results[0]["stdout"].count("A\n"), 20)
        self.assertEqual(results[1]["stdout"].count("B\n"), 20)
        self.assertNotIn("B", results[0]["stdout"])
        self.assertNotIn("A", results[1]["stdout"])


if __name__ == "__main__":
    unittest.main()
