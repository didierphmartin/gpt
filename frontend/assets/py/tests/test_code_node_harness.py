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


def run(source, input=None, exits=("next",), servers=(), transport=None, timeout_s=5, threaded=True, args=None):
    transport = transport or (lambda s, t, a: ok_result({}))
    return h.execute(source, input, list(exits), list(servers), transport, timeout_s, threaded=threaded, args=args)


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

    def test_route_without_exits_is_ignored(self):
        # The no-exit state behaves like any node: a route the code still returns is ignored, its output passed on.
        r = run("def run(i, c):\n    return {'route': 'job', 'output': {'a': 1}}", exits=("next",))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["route"], "next")
        self.assertEqual(json.loads(r["output_text"]), {"a": 1})

    def test_unserialisable_output_fails(self):
        r = run("def run(i, c):\n    return object()")
        self.assertFalse(r["ok"])
        self.assertIn("JSON", r["error"])


class CallTool(unittest.TestCase):
    SRC = "def run(i, call_tool):\n    return call_tool('servicenow', 'poll_jobs', {'tag': 'x'})"

    def test_declared_tool_returns_structured_content(self):
        seen = []
        r = run(self.SRC, servers=("servicenow",),
                transport=lambda s, t, a: seen.append((s, t, a)) or ok_result({"job": None}))
        self.assertEqual(json.loads(r["output_text"]), {"job": None})
        self.assertEqual(seen, [("servicenow", "poll_jobs", {"tag": "x"})])
        self.assertEqual([(c["server"], c["tool"], c["ok"]) for c in r["tool_calls"]], [("servicenow", "poll_jobs", True)])

    def test_text_result_decoded_when_json(self):
        r = run(self.SRC, servers=("servicenow",),
                transport=lambda s, t, a: {"content": [{"type": "text", "text": '{"a": 2}'}]})
        self.assertEqual(json.loads(r["output_text"]), {"a": 2})

    def test_unchecked_server_is_refused_without_calling(self):
        seen = []
        r = run(self.SRC, servers=("okta",), transport=lambda s, t, a: seen.append(1) or ok_result({}))
        self.assertFalse(r["ok"])
        self.assertIn("ToolError", r["error"])
        self.assertIn("MCP server servicenow is not checked on this node", r["error"])
        self.assertEqual(seen, [])

    def test_any_tool_of_a_checked_server_is_allowed(self):
        src = "def run(i, call_tool):\n    return [call_tool('servicenow', 'poll_jobs'), call_tool('servicenow', 'claim_job', {'task': 't'})]"
        r = run(src, servers=("servicenow",), transport=lambda s, t, a: ok_result({"t": t}))
        self.assertTrue(r["ok"], r)
        self.assertEqual(json.loads(r["output_text"]), [{"t": "poll_jobs"}, {"t": "claim_job"}])

    def test_is_error_raises_tool_error(self):   # review focus 3
        r = run(self.SRC, servers=("servicenow",),
                transport=lambda s, t, a: {"isError": True, "content": [{"type": "text", "text": "not_claimable: closed"}]})
        self.assertFalse(r["ok"])
        self.assertIn("not_claimable: closed", r["error"])
        self.assertFalse(r["tool_calls"][0]["ok"])

    def test_transport_exception_becomes_tool_error(self):
        def boom(s, t, a):
            raise OSError("connection refused")
        r = run(self.SRC, servers=("servicenow",), transport=boom)
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


class PollOutlookTemplate(unittest.TestCase):
    """The shipped template, read from code-node.js, under a fake call_tool."""

    @classmethod
    def setUpClass(cls):
        import re
        js = (Path(__file__).resolve().parents[2] / "js" / "code-node.js").read_text()
        block = js[js.index("poll_outlook:"):]
        lines = re.findall(r"^\s*'(.*)',$", block[:block.index("].join")], re.M)
        cls.source = "\n".join(l.replace("\\'", "'") for l in lines) + "\n"

    def run_with(self, poll_result):
        calls = []

        def transport(server, tool, args):
            calls.append(tool)
            return ok_result(poll_result)
        res = run(self.source, input="", exits=("new_mail", "no_mail", "error"), servers=("outlook",), transport=transport)
        return res, calls

    def test_new_mail_passes_metadata_only_and_never_opens_attachments(self):
        mail = {"id": "m1", "subject": "Invoice", "attachments": [{"id": "a1", "name": "x.pdf", "content_type": "application/pdf", "size": 9}]}
        res, calls = self.run_with({"mail": mail})
        self.assertEqual(res["route"], "new_mail")
        self.assertEqual(json.loads(res["output_text"]), mail)
        self.assertEqual(calls, ["poll_new_mail"])

    def test_no_mail_and_error(self):
        self.assertEqual(self.run_with({"mail": None})[0]["route"], "no_mail")
        for code in ("not_connected", "reconnect_needed", "network_error", "throttled"):
            with self.subTest(code=code):
                res, calls = self.run_with({"error": code, "message": "m"})
                self.assertEqual(res["route"], "error")
                self.assertEqual(calls, ["poll_new_mail"])



class NodeName(unittest.TestCase):
    """NODE_NAME: the node's name on the canvas, e.g. for a branch filing mail into the folder named like it."""

    SRC = "def run(input, call_tool):\n    return 'Inbox/' + NODE_NAME\n"

    def test_the_code_reads_its_node_name(self):
        for threaded in (True, False):
            with self.subTest(threaded=threaded):
                res = h.execute(self.SRC, None, ["next"], [], None, 5, threaded=threaded, node_name="claims")
                self.assertEqual(res["output_text"], "Inbox/claims")

    def test_without_a_name_it_is_empty(self):
        self.assertEqual(run(self.SRC)["output_text"], "Inbox/")


if __name__ == "__main__":
    unittest.main()


class ArgsGlobal(unittest.TestCase):
    """ARGS: the node's start/component arguments as a module global; {} when none."""
    SRC = "def run(input, call_tool):\n    return ARGS.get('tag')\n"

    def test_args_are_readable_and_keep_their_json_types(self):
        r = run(self.SRC, args={"tag": "okta-reset", "version": 2})
        self.assertEqual((r["ok"], r["output_text"]), (True, "okta-reset"))
        r = run("def run(i, c):\n    return type(ARGS['version']).__name__\n", args={"version": 2})
        self.assertEqual(r["output_text"], "int")

    def test_no_args_is_an_empty_dict(self):
        self.assertEqual(run(self.SRC)["output_text"], "null")
        self.assertEqual(run("def run(i, c):\n    return ARGS == {}\n", args=[])["output_text"], "true")
        self.assertEqual(run("def run(i, c):\n    return ARGS == {}\n", args=None, threaded=False)["output_text"], "true")
