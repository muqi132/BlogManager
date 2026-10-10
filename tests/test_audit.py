"""Security and data-preservation regressions; runs against temporary blogs only."""
import base64
import io
import logging
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
RUNTIME = tempfile.TemporaryDirectory(prefix="blogmanager-audit-")
os.environ["BLOG_MANAGER_CONFIG_DIR"] = RUNTIME.name
import app as backend

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK0cAAAAASUVORK5CYII=")


def tearDownModule():
    logging.shutdown()
    RUNTIME.cleanup()


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="博客 audit ")
        self.root = Path(self.temp.name)
        (self.root / "source/_posts").mkdir(parents=True)
        (self.root / "source/img").mkdir(parents=True)
        (self.root / "themes/butterfly").mkdir(parents=True)
        (self.root / "_config.yml").write_text("# site comment\ntitle: '旧标题' # keep\ntheme: butterfly\n", encoding="utf-8")
        (self.root / "themes/butterfly/_config.yml").write_text("# default\nfeature:\n  enable: true # boolean\n  text: hello\n", encoding="utf-8")
        backend.settings_store = backend.SettingsStore(self.root / "runtime.json")
        backend.settings_store.set_blog_dir(str(self.root))
        backend.task_manager = backend.TaskManager()
        self.client = backend.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def post(self, name, text):
        path = self.root / "source/_posts" / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_home_and_assets(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        for asset in ("js/app.js", "css/app.css", "vendor/katex/katex.min.js", "vendor/markdown-it/markdown-it.min.js"):
            response = self.client.get("/static/" + asset)
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_host_and_csrf(self):
        for method in ("get", "post"):
            result = getattr(self.client, method)("/api/status", headers={"Host": "attacker.example:5000"})
            self.assertEqual(result.status_code, 403)
        for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Referer": "http://localhost:9999/x"}):
            self.assertEqual(self.client.post("/api/client/ping", headers=headers).status_code, 403)
        self.assertEqual(self.client.post("/api/client/ping", headers={"Origin": "http://localhost"}).status_code, 200)

    def test_site_comments_and_boolean_merge(self):
        result = self.client.put("/api/site-config", json={"changes": {"title": "新标题"}})
        self.assertEqual(result.status_code, 200, result.json)
        text = (self.root / "_config.yml").read_text(encoding="utf-8")
        self.assertIn("# site comment", text)
        self.assertIn("# keep", text)
        result = self.client.put("/api/theme-config", json={"changes": {"feature.enable": False}})
        self.assertEqual(result.status_code, 200, result.json)
        effective, _, _ = backend.load_effective_theme_document()
        self.assertIs(effective["feature"]["enable"], False)
        self.assertEqual(effective["feature"]["text"], "hello")

    def test_empty_and_invalid_yaml(self):
        self.assertEqual(backend.load_yaml_text("", "test"), {})
        for raw in ("- list", "bad: [", "a: &a [*a]"):
            with self.assertRaises(backend.ApiError):
                backend.load_yaml_text(raw, "test")
        original = (self.root / "_config.yml").read_bytes()
        self.assertEqual(self.client.put("/api/site-config", json={"mode": "raw", "raw_yaml": "bad: ["}).status_code, 400)
        self.assertEqual((self.root / "_config.yml").read_bytes(), original)

    def test_corrupt_settings_load(self):
        config = self.root / "bad.json"
        config.write_text("{broken", encoding="utf-8")
        self.assertEqual(backend.SettingsStore(config).get()["blog_dir"], "")
        self.assertEqual(config.read_text(encoding="utf-8"), "{broken")

    def test_post_crud_and_bom(self):
        result = self.client.post("/api/posts", json={"title": "中文标题", "folder": "有 空格"})
        self.assertEqual(result.status_code, 201, result.json)
        self.assertEqual(self.client.get("/api/posts").json["posts"][0]["title"], "中文标题")
        path = self.post("bom.md", "\ufeff---\ntitle: test\n---\n正文")
        self.assertFalse(self.client.get("/api/posts/content?relative_path=bom.md").json["content"].startswith("\ufeff"))
        result = self.client.put("/api/posts/content", json={"relative_path": "bom.md", "content": "edited"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(path.read_text(encoding="utf-8"), "edited")
        self.assertEqual(self.client.delete("/api/posts", json={"relative_path": "bom.md"}).status_code, 200)
        self.assertFalse(path.exists())

    def test_file_types_and_traversal(self):
        self.post("secret.txt", "sensitive")
        (self.root / "source/img/secret.txt").write_text("sensitive", encoding="utf-8")
        for url in ("/api/posts/content?relative_path=secret.txt", "/api/images/file?path=secret.txt", "/api/posts/content?relative_path=../../runtime.json", "/api/images/file?path=../../runtime.json"):
            self.assertIn(self.client.get(url).status_code, (403, 404))
        for method, url, payload in (("put", "/api/posts/content", {"relative_path": "secret.txt", "content": "x"}), ("delete", "/api/posts", {"relative_path": "secret.txt"})):
            self.assertEqual(getattr(self.client, method)(url, json=payload).status_code, 404)

    def test_date_seconds_and_year_change(self):
        self.assertEqual(backend.plain_value(datetime(2026, 1, 1)), "2026-01-01 00:00:00")
        self.assertEqual(backend.merge_date_time("2027-02-03", "2026-01-01 12:34:56"), "2027-02-03 12:34:56")
        self.post("date.md", "---\ntitle: test\ndate: 2026-01-01 12:34:56\n---\n正文")
        props = self.client.get("/api/posts/frontmatter?relative_path=date.md").json["properties"]
        for prop in props:
            if prop["name"] == "date":
                prop["value"] = "2027-02-03"
        result = self.client.post("/api/posts/frontmatter", json={"relative_path": "date.md", "properties": props})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertIn("12:34:56", (self.root / "source/_posts/date.md").read_text(encoding="utf-8"))
        self.assertEqual(backend.merge_date_time("2027-02-03", "2026-01-01 12:34:56.123+08:00"), "2027-02-03 12:34:56.123+08:00")
        with self.assertRaises(backend.ApiError):
            backend.merge_date_time("2026-02-30", "")

    def test_invalid_frontmatter_never_discarded(self):
        path = self.post("broken.md", "---\ntitle: [broken\ncustom: important\n---\n正文")
        original = path.read_bytes()
        result = backend.repair_post_frontmatter(path, path.parent)
        self.assertFalse(result["changed"])
        self.assertTrue(result["error"])
        self.assertEqual(path.read_bytes(), original)

    def upload(self, files):
        with backend.app.test_client() as client:
            response = client.post("/api/images/upload", data={"scope": "all", "files": [(io.BytesIO(data), name) for name, data in files]}, content_type="multipart/form-data")
            response.get_data()
            response.request.environ["wsgi.input"].close()
            return response

    def test_upload_batch_content_case_and_empty(self):
        result = self.upload([("图片.PNG", PNG), ("empty.jpg", b""), ("fake.png", b"<script>bad</script>"), ("note.txt", b"text")])
        self.assertEqual(result.status_code, 201, result.json)
        self.assertEqual(result.json["succeeded"], 1)
        self.assertEqual(result.json["failed"], 3)
        response = self.client.get(result.json["images"][0]["url"])
        self.assertEqual(response.data, PNG)
        self.assertIn("sandbox", response.headers["Content-Security-Policy"])
        response.close()

    def test_upload_parallel_conflicts(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.upload([("same.PNG", PNG)]), range(8)))
        names = [result.json["images"][0]["name"] for result in results]
        self.assertEqual(len(set(names)), 8)
        self.assertEqual(len(list((self.root / "source/img").glob("*.png"))), 8)

    def test_upload_limit(self):
        with patch.dict(os.environ, {"BLOG_MANAGER_MAX_IMAGE_MB": "1"}):
            result = self.upload([("big.png", PNG + b"x" * (1024 * 1024))])
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json["details"]["failed"], 1)

    def test_reserved_names(self):
        for name in ("CON.png", "NUL.md", "COM1.jpg"):
            with self.assertRaises(backend.ApiError):
                backend.validate_filename(name)

    def test_ssrf_and_redirect(self):
        for url in ("http://127.0.0.1/x.png", "http://[::1]/x", "file:///etc/passwd", "http://169.254.169.254/latest"):
            with self.assertRaises(backend.ApiError):
                backend.assert_public_http_url(url)
        handler = backend.PublicImageRedirectHandler()
        with self.assertRaises(backend.ApiError):
            handler.redirect_request(None, None, 302, "", {}, "http://127.0.0.1/private")
        with patch.object(backend, "build_opener") as opener:
            self.assertFalse(backend.check_theme_source("http://127.0.0.1/private"))
            self.assertFalse(backend.check_theme_source("file:///private"))
            opener.assert_not_called()

    def test_task_exclusion_and_logs(self):
        task, created = backend.task_manager.create_if_idle("generate", "generate", self.root)
        self.assertTrue(created)
        other, created = backend.task_manager.create_if_idle("deploy", "deploy", self.root)
        self.assertFalse(created)
        self.assertIs(task, other)
        task.emit("https://user:secret@github.com/x token=secret ghp_abc123")
        self.assertNotIn("secret", task.lines[0]["text"])
        record = logging.LogRecord("x", 20, "", 1, "token=%s", ("private",), None)
        self.assertNotIn("private", backend.RedactingFormatter().format(record))

    def test_no_unowned_process_kill(self):
        task = backend.Task("preview", "server", self.root, 4000)
        with patch.object(backend, "port_owner_pids", return_value=[12345]), patch.object(backend, "terminate_pid_tree") as kill:
            self.assertEqual(backend.terminate_port_processes(4000, task), ([], [12345]))
            kill.assert_not_called()

    def test_fallback_browser_not_registered_for_kill(self):
        with patch.object(backend, "BROWSER_PIDS", []), patch.object(backend, "browser_process_snapshot", return_value={12345}):
            self.assertEqual(backend.track_fallback_browser_processes(set()), [])
            self.assertEqual(backend.BROWSER_PIDS, [])

    def test_repository_validation(self):
        for value in ("--upload-pack=bad", "https://token@github.com/u/r", "https://github.com/u/r%PATH%", "https://github.com/u/r\n"):
            with self.assertRaises(backend.ApiError):
                backend.validate_repo_address(value)
        for value in ("https://github.com/u/r.git", "git@github.com:u/r.git", "ssh://git@github.com/u/r.git"):
            backend.validate_repo_address(value)

    def test_atomic_failure_preserves_original(self):
        path = self.post("atomic.md", "original")
        with patch.object(backend.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(backend.ApiError):
                backend.atomic_write_text(path, "changed")
        self.assertEqual(path.read_text(encoding="utf-8"), "original")
        self.assertEqual(list(path.parent.glob("*.blogmanager.tmp")), [])

    def test_settings_recent_and_token_mask(self):
        result = self.client.put("/api/settings", json={"remember_last": True, "github": {"token": "ghp_testprivate", "remember": True}})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json["remember_last"])
        self.assertTrue(result.json["github"]["token_set"])
        self.assertNotIn("ghp_testprivate", result.get_data(as_text=True))
        self.assertIn(str(self.root), result.json["recent_dirs"])
        self.client.put("/api/settings", json={"github": {"token": "ghp_sessiononly", "remember": False}})
        self.assertNotIn("ghp_sessiononly", (self.root / "runtime.json").read_text(encoding="utf-8"))
        self.assertTrue(self.client.get("/api/settings").json["github"]["token_set"])

    def test_image_rename_and_conflict(self):
        result = self.upload([("a.png", PNG), ("b.png", PNG)])
        self.assertEqual(result.status_code, 201)
        result = self.client.post("/api/images/rename", json={"relative_path": "a.png", "new_name": "b.png"})
        self.assertEqual(result.status_code, 409)
        result = self.client.post("/api/images/rename", json={"relative_path": "a.png", "new_name": "中文 新名"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["name"], "中文 新名.png")

    def test_auto_complete_and_comments(self):
        path = self.post("no-front.md", "正文不丢失")
        report = backend.auto_complete_post_frontmatter(path.parent)
        self.assertEqual(len(report["repaired"]), 1)
        self.assertIn("正文不丢失", path.read_text(encoding="utf-8"))
        path = self.post("comments.md", "---\n# title comment\ntitle: old # inline\ndate: 2026-10-09\n---\n正文")
        props = self.client.get("/api/posts/frontmatter?relative_path=comments.md").json["properties"]
        props[0]["value"] = "new"
        result = self.client.post("/api/posts/frontmatter", json={"relative_path": "comments.md", "properties": props})
        self.assertEqual(result.status_code, 200)
        self.assertIn("# title comment", path.read_text(encoding="utf-8"))
        self.assertIn("# inline", path.read_text(encoding="utf-8"))

    def test_preview_order_and_cancellation(self):
        task = backend.Task("preview", "preview", self.root, 4000)
        with patch.object(backend, "hexo_command", side_effect=lambda root, args: args), patch.object(backend, "run_task_command", return_value=0) as command, patch.object(backend, "emit_generated_output_status", return_value={"pug_count": 0}), patch.object(backend, "command_for", return_value=("server", ["server"])), patch.object(backend, "run_process") as server:
            backend.run_preview_process(task)
            self.assertEqual([call.args[1] for call in command.call_args_list], [["clean"], ["generate"]])
            server.assert_called_once()
        task.stop_requested = True
        with patch.object(backend.subprocess, "Popen") as process:
            with self.assertRaises(backend.AutodeployError):
                backend.run_task_command(task, ["npm"], self.root)
            process.assert_not_called()

    def test_deploy_generates_before_publish(self):
        task = backend.Task("deploy", "deploy", self.root)
        with patch.object(backend, "hexo_command", side_effect=lambda root, args: args), patch.object(backend, "run_task_command", return_value=0) as command, patch.object(backend, "emit_generated_output_status", return_value={"pug_count": 0}):
            backend.run_deploy_process(task)
            self.assertEqual([call.args[1] for call in command.call_args_list], [["clean"], ["generate"], ["deploy"]])
            self.assertEqual(task.status, "success")
        task = backend.Task("deploy", "deploy", self.root)
        with patch.object(backend, "hexo_command", side_effect=lambda root, args: args), patch.object(backend, "run_task_command", return_value=0) as command, patch.object(backend, "run_generate_with_auto_repair", return_value=(1, {})):
            backend.run_deploy_process(task)
            self.assertEqual([call.args[1] for call in command.call_args_list], [["clean"]])
            self.assertEqual(task.status, "failed")

    def test_welcome_and_latex_idempotence(self):
        task = backend.Task("autodeploy", "deploy", self.root)
        backend.create_welcome_post(self.root, task)
        welcome = backend.welcome_post_path(self.root)
        self.assertTrue(welcome.exists())
        original = welcome.read_bytes()
        backend.create_welcome_post(self.root, task)
        self.assertEqual(welcome.read_bytes(), original)
        doc = backend.load_yaml_text("inject:\n  head:\n    - '<meta name=custom>'\n", "test")
        backend.merge_latex_inject(doc, backend.load_yaml_text("", "base"))
        count = len(doc["inject"]["head"])
        backend.merge_latex_inject(doc, backend.load_yaml_text("", "base"))
        self.assertEqual(len(doc["inject"]["head"]), count)
        self.assertIn("<meta name=custom>", doc["inject"]["head"])

    def test_local_only_site_details_are_applied(self):
        task = backend.Task("autodeploy", "local", self.root)
        backend.apply_autodeploy_config(self.root, {"overwrite_config": True, "local_only": True, "skip_theme": True, "title": "Local title", "author": "Local author", "url": "https://example.com"}, task)
        config = backend.load_yaml_file(self.root / "_config.yml")
        self.assertEqual(config["title"], "Local title")
        self.assertEqual(config["author"], "Local author")
        self.assertEqual(config["url"], "https://example.com")
        self.assertNotIn("deploy", config)

    def test_port_and_bad_payload(self):
        for port in (0, 1023, 65536, "bad"):
            with self.assertRaises(backend.ApiError):
                backend.validate_port(port)
        self.assertEqual(backend.validate_port("4000"), 4000)
        self.assertEqual(self.client.post("/api/commands/preview", json=[1]).status_code, 400)

    def test_step_events_do_not_erase_log_tail(self):
        task = backend.Task("autodeploy", "deploy", self.root)
        with patch.object(backend, "MAX_TASK_LINES", 5):
            task.emit("keep this log")
            for _ in range(10):
                task.emit_step("a", "running", "token=private")
        self.assertEqual(task.lines[0]["text"], "keep this log")
        self.assertEqual(len(task.events), 5)
        self.assertNotIn("private", task.events[-1]["detail"])

    def test_large_article_preserved(self):
        path = self.post("large.md", "x" * 20)
        with patch.object(backend, "MAX_TEXT_FILE_BYTES", 10):
            self.assertEqual(self.client.get("/api/posts/content?relative_path=large.md").status_code, 413)
            self.assertEqual(self.client.put("/api/posts/content", json={"relative_path": "large.md", "content": "z" * 20}).status_code, 413)
        self.assertEqual(path.read_text(encoding="utf-8"), "x" * 20)

    def test_subprocess_timeout(self):
        task = backend.Task("generate", "timeout-test", self.root)
        with patch.dict(os.environ, {"BLOG_MANAGER_COMMAND_TIMEOUT": "1"}):
            result = backend.run_task_command(task, [sys.executable, "-c", "import time; time.sleep(10)"], self.root)
        self.assertNotEqual(result, 0)
        self.assertIsNotNone(task.process.poll())
        self.assertTrue(any("超过" in line["text"] for line in task.lines))

    def test_rotated_history_and_download_redaction(self):
        log = self.root / "sample.log"
        log.write_text("newest\ntoken=private\n", encoding="utf-8")
        Path(str(log) + ".1").write_text("oldest\n", encoding="utf-8")
        with patch.object(backend, "LOG_FILE", log):
            result = self.client.get("/api/logs?limit=2")
            self.assertEqual(result.json["total"], 3)
            self.assertTrue(result.json["has_more"])
            self.assertNotIn("private", result.get_data(as_text=True))
            result = self.client.get("/api/logs/download")
            self.assertIn(b"oldest", result.data)
            self.assertNotIn(b"private", result.data)
            result.close()


if __name__ == "__main__":
    unittest.main()
