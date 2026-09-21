from __future__ import annotations

import argparse
import copy
import io
import json
import locale
import logging
import mimetypes
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from flask import Flask, Response, jsonify, render_template, request, send_file
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import LiteralScalarString, SingleQuotedScalarString
from werkzeug.exceptions import HTTPException


APP_ROOT = Path(__file__).resolve().parent
APP_NAME = "BlogManager"
CONFIG_DIR_OVERRIDE = os.environ.get("BLOG_MANAGER_CONFIG_DIR", "").strip()
SETTINGS_DIR = (
    Path(CONFIG_DIR_OVERRIDE).expanduser()
    if CONFIG_DIR_OVERRIDE
    else Path(os.environ.get("APPDATA") or Path.home()) / APP_NAME
)
CONFIG_FILE = SETTINGS_DIR / "config.json"
LEGACY_SETTINGS_FILE = SETTINGS_DIR / "settings.json"
BROWSER_PROFILE_DIR = SETTINGS_DIR / "browser-profile"
CLEANUP_REPORT_FILE = SETTINGS_DIR / "last-cleanup.json"
LOG_DIR = SETTINGS_DIR / "logs"
LOG_FILE = LOG_DIR / "blogmanager.log"
SITE_CONFIG_NAME = "_config.yml"
THEME_CONFIG_NAME = "_config.butterfly.yml"
THEME_BASE_CONFIG = Path("themes") / "butterfly" / "_config.yml"
THEME_RENDERER_DEPENDENCIES = ("hexo-renderer-pug", "hexo-renderer-stylus")
PREVIEW_URL = os.environ.get("BLOG_MANAGER_PREVIEW_URL", "http://localhost:4000")
DEFAULT_THEME_REPO = os.environ.get("BLOG_MANAGER_THEME_REPO", "https://github.com/jerryc127/hexo-theme-butterfly.git")
ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
DEFAULT_THEME_SOURCES = [
    {"id": "github", "label": "GitHub 官方源", "url": DEFAULT_THEME_REPO},
    {"id": "gitee", "label": "Gitee 镜像", "url": "https://gitee.com/jerryc127/hexo-theme-butterfly.git"},
    {"id": "ghproxy", "label": "GitHub 加速代理 ghproxy", "url": "https://ghproxy.com/https://github.com/jerryc127/hexo-theme-butterfly.git"},
    {"id": "moeyy", "label": "GitHub 加速代理 moeyy", "url": "https://github.moeyy.xyz/https://github.com/jerryc127/hexo-theme-butterfly.git"},
    {"id": "gh-proxy", "label": "GitHub 加速代理 gh-proxy", "url": "https://gh-proxy.com/https://github.com/jerryc127/hexo-theme-butterfly.git"},
]
PREVIEW_URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1):\d+(?:/[^\s]*)?")
FRONT_MATTER_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
POST_EXTENSIONS = {".md", ".markdown"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico"}
COVER_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
BROWSER_PIDS: list[int] = []
BROWSER_LOCK = threading.RLock()
CLIENT_STATE = {"last_seen": time.time(), "active": False, "goodbye_at": 0.0, "generation": 0}
CLIENT_LOCK = threading.RLock()
SHUTTING_DOWN = False


def default_runtime_config() -> dict[str, Any]:
    return {
        "config_version": 1,
        "onboarding_complete": False,
        "blog_dir": "",
        "recent_dirs": [],
        "remember_last": False,
        "autodeploy": {},
        "github": {
            "username": "",
            "repo_url": "",
            "branch": "main",
            "token": "",
            "remember": False,
        },
    }


def normalize_github_settings(value: Any) -> dict[str, Any]:
    github = default_runtime_config()["github"]
    if isinstance(value, Mapping):
        for key in ("username", "repo_url", "branch", "token"):
            github[key] = str(value.get(key, github[key]) or "")
        github["remember"] = bool(value.get("remember", github["remember"]))
    return github


def public_github_settings(value: Any) -> dict[str, Any]:
    github = normalize_github_settings(value)
    token = str(github.get("token", "") or "")
    return {
        "username": github.get("username", ""),
        "repo_url": github.get("repo_url", ""),
        "branch": github.get("branch", "main") or "main",
        "token_set": bool(token),
        "token_masked": "••••••••" if token else "",
        "remember": bool(github.get("remember", False)),
    }


class ApiError(Exception):
    def __init__(self, message: str, status_code: int = 400, details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


class SettingsStore:
    def __init__(self, path: Path, legacy_path: Path | None = None):
        self.path = path
        self.legacy_path = legacy_path
        self.lock = threading.RLock()
        self._migrate_legacy()
        self.settings = self._load()

    @staticmethod
    def _infer_onboarding_complete(payload: Mapping[str, Any]) -> bool:
        blog_dir = str(payload.get("blog_dir", "") or "").strip()
        return bool(blog_dir and (Path(blog_dir).expanduser() / SITE_CONFIG_NAME).is_file())

    def _migrate_legacy(self) -> None:
        if self.path.exists() or not self.legacy_path or not self.legacy_path.exists():
            return
        try:
            payload = json.loads(self.legacy_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return
            payload["config_version"] = int(payload.get("config_version", 1) or 1)
            if "onboarding_complete" not in payload:
                payload["onboarding_complete"] = self._infer_onboarding_complete(payload)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self.path.with_suffix(".tmp")
            temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp_path, self.path)
            try:
                self.legacy_path.unlink()
            except OSError:
                pass
        except (OSError, ValueError, TypeError):
            return

    def _load(self) -> dict[str, Any]:
        result = default_runtime_config()
        if not self.path.exists():
            return result
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return result
            result["config_version"] = int(payload.get("config_version", 1) or 1)
            result["onboarding_complete"] = bool(
                payload.get("onboarding_complete", self._infer_onboarding_complete(payload))
            )
            blog_dir = str(payload.get("blog_dir", "") or "").strip()
            result["blog_dir"] = str(Path(blog_dir).expanduser()) if blog_dir else ""
            recent = payload.get("recent_dirs", [])
            if isinstance(recent, list):
                result["recent_dirs"] = [str(item) for item in recent if str(item).strip()][:5]
            result["remember_last"] = bool(payload.get("remember_last", False))
            if isinstance(payload.get("autodeploy"), dict):
                result["autodeploy"] = copy.deepcopy(payload["autodeploy"])
            result["github"] = normalize_github_settings(payload.get("github"))
        except (OSError, ValueError, TypeError):
            return default_runtime_config()
        return result

    def get(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self.settings)

    def is_first_run(self) -> bool:
        with self.lock:
            return not bool(self.settings.get("onboarding_complete")) or not str(
                self.settings.get("blog_dir", "") or ""
            ).strip()

    def _save(self) -> None:
        self.settings["config_version"] = 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp_path, self.path)

    def set_blog_dir(self, blog_dir: str) -> Path:
        text = str(blog_dir or "").strip()
        if not text:
            raise ApiError("请选择博客文件夹。")
        path = Path(text).expanduser().resolve()
        if not path.exists() or not path.is_dir():
            raise ApiError("所选文件夹不存在或不是有效文件夹。", 404)
        with self.lock:
            self.settings["blog_dir"] = str(path)
            recent = [item for item in self.settings.get("recent_dirs", []) if item != str(path)]
            self.settings["recent_dirs"] = [str(path), *recent][:5]
            self._save()
        return path

    def set_section(self, name: str, values: Mapping[str, Any]) -> None:
        with self.lock:
            self.settings[name] = copy.deepcopy(dict(values))
            self._save()

    def update_github(self, values: Mapping[str, Any]) -> None:
        with self.lock:
            merged = normalize_github_settings(self.settings.get("github"))
            for key in ("username", "repo_url", "branch"):
                if key in values:
                    merged[key] = str(values.get(key, "") or "")
            if "token" in values:
                merged["token"] = str(values.get("token", "") or "")
            if "remember" in values:
                merged["remember"] = bool(values.get("remember"))
            self.settings["github"] = merged
            self._save()

    def set_remember_last(self, remember: bool) -> None:
        with self.lock:
            self.settings["remember_last"] = bool(remember)
            self._save()

    def mark_onboarding_complete(self) -> None:
        with self.lock:
            self.settings["onboarding_complete"] = True
            self._save()

    def reset(self) -> None:
        with self.lock:
            self.settings = default_runtime_config()
            for target in (self.path, self.legacy_path, CLEANUP_REPORT_FILE):
                if target:
                    try:
                        target.unlink(missing_ok=True)
                    except OSError:
                        pass
            shutil.rmtree(BROWSER_PROFILE_DIR, ignore_errors=True)


settings_store = SettingsStore(CONFIG_FILE, LEGACY_SETTINGS_FILE)
app = Flask(__name__)
app.json.ensure_ascii = False


def configure_application_logging() -> logging.Logger:
    logger = logging.getLogger("blogmanager")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        LOG_FILE,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
    logger.addHandler(handler)
    logger.propagate = False
    return logger


LOGGER = configure_application_logging()

def blog_directory() -> Path | None:
    value = str(settings_store.get().get("blog_dir", "") or "").strip()
    return Path(value).expanduser() if value else None


def require_blog_directory() -> Path:
    path = blog_directory()
    if path is None:
        raise ApiError("尚未选择博客目录，请先完成首次设置。", 409)
    if not path.exists() or not path.is_dir():
        raise ApiError(f"博客目录不存在：{path}", 404)
    return path


def site_config_path() -> Path:
    return require_blog_directory() / SITE_CONFIG_NAME


def theme_name() -> str:
    path = site_config_path()
    if path.exists():
        try:
            document = load_yaml_file(path)
            value = str(document.get("theme", "") or "").strip()
            if value:
                return value
        except ApiError:
            pass
    return "butterfly"


def theme_config_paths() -> tuple[Path, Path]:
    blog = require_blog_directory()
    base = blog / "themes" / theme_name() / "_config.yml"
    override = blog / THEME_CONFIG_NAME
    return base, override


def new_round_trip_yaml() -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.allow_unicode = True
    yaml.width = 4096
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def plain_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): plain_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [plain_value(item) for item in value]
    if isinstance(value, (datetime, Path)):
        return str(value)
    return value


def load_yaml_file(path: Path, allow_missing: bool = False) -> CommentedMap:
    if not path.exists():
        if allow_missing:
            return CommentedMap()
        raise ApiError(f"找不到配置文件：{path.name}", 404)

    yaml = new_round_trip_yaml()
    try:
        with path.open("r", encoding="utf-8") as handle:
            document = yaml.load(handle)
    except UnicodeDecodeError as exc:
        raise ApiError(f"{path.name} 不是有效的 UTF-8 文件。") from exc
    except Exception as exc:
        raise ApiError(f"读取 {path.name} 失败：{exc}") from exc

    if document is None:
        document = CommentedMap()
    if not isinstance(document, Mapping):
        raise ApiError(f"{path.name} 的根节点必须是 YAML 映射。")
    return document


def load_yaml_text(raw: str, label: str) -> CommentedMap:
    yaml = new_round_trip_yaml()
    try:
        document = yaml.load(raw)
    except Exception as exc:
        raise ApiError(f"{label} YAML 格式错误：{exc}") from exc
    if document is None:
        document = CommentedMap()
    if not isinstance(document, Mapping):
        raise ApiError(f"{label} 的根节点必须是 YAML 映射。")
    return document


def merge_documents(base: Any, override: Any) -> Any:
    if isinstance(base, Mapping) and isinstance(override, Mapping):
        result = copy.deepcopy(base)
        for key, value in override.items():
            if key in result:
                result[key] = merge_documents(result[key], value)
            else:
                result[key] = copy.deepcopy(value)
        return result
    return copy.deepcopy(override)


def get_path(document: Mapping[str, Any], path: str, default: Any = None) -> Any:
    current: Any = document
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


def _base_positions(base: Any) -> dict[str, int]:
    if not isinstance(base, Mapping):
        return {}
    return {str(key): index for index, key in enumerate(base.keys())}


def _take_comment(mapping: CommentedMap, key: str, index: int) -> Any:
    entry = mapping.ca.items.get(key)
    if not entry or index >= len(entry) or entry[index] is None:
        return None
    value = entry[index]
    entry[index] = None
    return value


def _set_comment(mapping: CommentedMap, key: str, index: int, value: Any) -> None:
    if value is None:
        return
    entry = mapping.ca.items.get(key)
    if entry is None:
        entry = [None, None, None, None]
        mapping.ca.items[key] = entry
    while len(entry) < 4:
        entry.append(None)
    entry[index] = value


def _insert_mapping_key(mapping: CommentedMap, key: str, value: Any, base: Any = None) -> None:
    if key in mapping:
        mapping[key] = copy.deepcopy(value)
        return
    keys = list(mapping.keys())
    index = len(keys)
    base_positions = _base_positions(base)
    if key in base_positions:
        current_position = base_positions[key]
        following = [
            item
            for item in keys
            if item in base_positions and base_positions[item] > current_position
        ]
        if following:
            index = keys.index(following[0])
    previous_key = keys[index - 1] if index > 0 else None
    post_comment = _take_comment(mapping, previous_key, 2) if previous_key is not None else None
    inserted = value if isinstance(value, (CommentedMap, CommentedSeq)) else copy.deepcopy(value)
    mapping.insert(index, key, inserted)
    if post_comment is not None:
        _set_comment(mapping, key, 2, post_comment)


def _coerce_config_value(value: Any, type_hint: str | None = None, base_value: Any = None) -> Any:
    kind = str(type_hint or "").strip().lower()
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        normalized = str(value).strip().lower()
        if normalized in {"", "0", "false", "no", "off", "否", "关闭"}:
            return False
        if normalized in {"1", "true", "yes", "on", "是", "开启"}:
            return True
        raise ApiError(f"布尔配置值格式不正确：{value}")
    if kind == "number":
        if value in (None, ""):
            return None
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return value
        number_text = str(value).strip()
        try:
            if re.fullmatch(r"[-+]?\d+", number_text):
                return int(number_text)
            return float(number_text)
        except ValueError as exc:
            raise ApiError(f"数字配置值格式不正确：{value}") from exc
    if kind in {"array", "list"}:
        if isinstance(value, list):
            return CommentedSeq(plain_value(item) for item in value)
        if value in (None, ""):
            return CommentedSeq()
        return CommentedSeq(
            item.strip() for item in re.split(r"[\n,，]+", str(value)) if item.strip()
        )
    if kind in {"yaml", "object", "map"}:
        if kind in {"object", "map"} and isinstance(value, Mapping):
            return _comment_map(plain_value(value))
        if kind in {"object", "map"} and isinstance(value, str):
            try:
                parsed = YAML(typ="safe").load(value)
            except Exception as exc:
                raise ApiError(f"YAML 对象解析失败：{exc}") from exc
            if parsed is None:
                return CommentedMap()
            if not isinstance(parsed, Mapping):
                raise ApiError("对象类型配置必须是 YAML 映射。")
            return _comment_map(plain_value(parsed))
        if kind == "yaml":
            if isinstance(value, str):
                try:
                    parsed = YAML(typ="safe").load(value)
                except Exception as exc:
                    raise ApiError(f"YAML 配置解析失败：{exc}") from exc
                return _comment_value(parsed)
            return _comment_value(value)
    if isinstance(base_value, bool) and isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "false"}:
            return normalized == "true"
    if isinstance(base_value, int) and not isinstance(base_value, bool) and isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            pass
    if isinstance(base_value, float) and isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            pass
    return value


def _comment_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return _comment_map(plain_value(value))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return CommentedSeq(_comment_value(item) for item in value)
    return copy.deepcopy(value)


def _comment_map(value: Mapping[str, Any]) -> CommentedMap:
    result = CommentedMap()
    for key, item in value.items():
        result[str(key)] = _comment_value(item)
    return result


def set_path(
    document: CommentedMap,
    path: str,
    value: Any,
    base_document: Mapping[str, Any] | None = None,
) -> None:
    parts = [part for part in path.split(".") if part]
    if not parts:
        raise ApiError("配置路径不能为空。")
    current: CommentedMap = document
    base_current: Any = base_document
    for part in parts[:-1]:
        child = current.get(part)
        base_child = base_current.get(part) if isinstance(base_current, Mapping) else None
        if not isinstance(child, CommentedMap):
            child = CommentedMap()
            _insert_mapping_key(current, part, child, base_current)
        current = child
        base_current = base_child
    _insert_mapping_key(current, parts[-1], value, base_current)


def _comment_text(value: Any) -> str:
    if value is None:
        return ""
    raw = getattr(value, "value", None)
    if raw is None:
        raw = str(value)
    lines = []
    for line in str(raw).strip().splitlines():
        cleaned = line.strip()
        if cleaned.startswith("#"):
            cleaned = cleaned[1:].lstrip()
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def _comment_texts(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        result: list[str] = []
        for item in value:
            result.extend(_comment_texts(item))
        return result
    text = _comment_text(value)
    return [text] if text else []


def collect_yaml_comments(document: Any, prefix: str = "", inherited: str = "") -> dict[str, str]:
    result: dict[str, str] = {}
    if not isinstance(document, Mapping):
        return result
    for key, value in document.items():
        text = str(key)
        path = f"{prefix}.{text}" if prefix else text
        own_description = ""
        if isinstance(document, CommentedMap):
            own_description = "\n".join(_comment_texts(document.ca.items.get(text))).strip()
        description = own_description or inherited
        if description:
            result[path] = description
        if isinstance(value, Mapping):
            result.update(collect_yaml_comments(value, path, description))
    return result


def delete_path(document: CommentedMap, path: str) -> bool:
    parts = [part for part in path.split(".") if part]
    if not parts:
        return False

    frames: list[tuple[CommentedMap, str]] = []
    current: Any = document
    for part in parts[:-1]:
        if not isinstance(current, Mapping) or part not in current:
            return False
        if isinstance(current, CommentedMap):
            frames.append((current, part))
        current = current[part]

    if not isinstance(current, CommentedMap) or parts[-1] not in current:
        return False

    mapping = current
    key = parts[-1]
    index = list(mapping.keys()).index(key)
    comments = [
        _take_comment(mapping, key, 0),
        _take_comment(mapping, key, 1),
        _take_comment(mapping, key, 2),
    ]
    mapping.pop(key, None)

    while True:
        remaining = list(mapping.keys())
        if remaining:
            comment_text = "\n".join(text for text in (_comment_text(item) for item in comments) if text)
            if comment_text:
                if index < len(remaining):
                    mapping.yaml_set_comment_before_after_key(remaining[index], before=comment_text)
                else:
                    mapping.yaml_set_comment_before_after_key(remaining[index - 1], after=comment_text)
            return True

        if not frames:
            return True

        parent_mapping, parent_key = frames.pop()
        parent_index = list(parent_mapping.keys()).index(parent_key)
        parent_comments = [
            _take_comment(parent_mapping, parent_key, 0),
            _take_comment(parent_mapping, parent_key, 1),
            _take_comment(parent_mapping, parent_key, 2),
        ]
        parent_mapping.pop(parent_key, None)
        mapping = parent_mapping
        index = parent_index
        comments = parent_comments + comments


def collect_explicit_paths(document: Any, prefix: str = "") -> set[str]:
    paths: set[str] = set()
    if isinstance(document, Mapping):
        if not document and prefix:
            paths.add(prefix)
            return paths
        for key, value in document.items():
            key_text = str(key)
            if "." in key_text:
                continue
            path = f"{prefix}.{key_text}" if prefix else key_text
            if isinstance(value, Mapping):
                paths.update(collect_explicit_paths(value, path))
            else:
                paths.add(path)
    elif prefix:
        paths.add(prefix)
    return paths


def apply_config_changes(
    document: CommentedMap,
    changes: Any,
    base_document: Mapping[str, Any] | None = None,
    reset_paths: Any = None,
) -> int:
    if changes is None:
        changes = {}
    if not isinstance(changes, Mapping):
        raise ApiError("changes 必须是 JSON 对象。")
    if reset_paths is not None and not isinstance(reset_paths, list):
        raise ApiError("reset_paths 必须是数组。")
    reset_values: list[str] = []
    seen_reset: set[str] = set()
    for item in reset_paths or []:
        path = str(item).strip()
        if path and path not in seen_reset:
            seen_reset.add(path)
            reset_values.append(path)
    changed = 0
    for path in reset_values:
        changed += int(delete_path(document, path))
    for path, change in changes.items():
        path_text = str(path).strip()
        if not path_text:
            continue
        if isinstance(change, Mapping) and "value" in change:
            raw_value = change.get("value")
            type_hint = str(change.get("type", "") or "")
        else:
            raw_value = change
            type_hint = ""
        normalized_type = type_hint.strip().lower()
        if normalized_type == "number" and raw_value in (None, ""):
            if path_text not in seen_reset:
                seen_reset.add(path_text)
                changed += int(delete_path(document, path_text))
            continue
        if normalized_type in {"yaml", "object", "map"} and raw_value in (None, ""):
            if path_text not in seen_reset:
                seen_reset.add(path_text)
                changed += int(delete_path(document, path_text))
            continue
        base_value = get_path(base_document, path_text) if isinstance(base_document, Mapping) else None
        typed_value = _coerce_config_value(raw_value, type_hint, base_value)
        set_path(document, path_text, typed_value, base_document)
        changed += 1
    return changed


def dump_yaml_value(value: Any) -> str:
    yaml = new_round_trip_yaml()
    stream = io.StringIO()
    yaml.dump(value, stream)
    return stream.getvalue().strip()


def write_yaml_file(path: Path, document: Mapping[str, Any]) -> Path:
    backup_path = path.with_suffix(path.suffix + ".blogmanager.bak")
    temp_path = path.with_suffix(path.suffix + ".blogmanager.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and not backup_path.exists():
            shutil.copy2(path, backup_path)
        yaml = new_round_trip_yaml()
        with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
            yaml.dump(document, handle)
        os.replace(temp_path, path)
    except Exception as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ApiError(f"保存 {path.name} 失败：{exc}") from exc
    return backup_path


def json_payload() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ApiError("请求内容必须是 JSON 对象。")
    return payload


def normalize_text(value: Any, field_name: str) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        raise ApiError(f"{field_name} 必须是文本值。")
    return str(value).strip()

def menu_items_from_mapping(menu: Mapping[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    items: list[dict[str, Any]] = []
    supported = True
    for name, value in menu.items():
        if not isinstance(value, str):
            supported = False
            break
        parts = [part.strip() for part in value.split("||")]
        items.append(
            {
                "name": str(name),
                "url": parts[0] if parts else "",
                "icon": parts[1] if len(parts) > 1 else "",
                "extra": parts[2:] if len(parts) > 2 else [],
                "value": value,
            }
        )
    return items, supported


def build_menu_mapping(items: Any) -> CommentedMap:
    if not isinstance(items, list):
        raise ApiError("menu_items 必须是数组。")
    menu = CommentedMap()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ApiError(f"第 {index} 个菜单项格式不正确。")
        name = normalize_text(item.get("name"), f"第 {index} 个菜单项名称")
        url = normalize_text(item.get("url"), f"第 {index} 个菜单项链接")
        icon = normalize_text(item.get("icon"), f"第 {index} 个菜单项图标")
        extra = item.get("extra", [])
        if not name or not url:
            raise ApiError(f"第 {index} 个菜单项必须填写名称和链接。")
        if name in menu:
            raise ApiError(f"菜单项名称重复：{name}")
        if extra is None:
            extra = []
        if not isinstance(extra, list):
            raise ApiError(f"第 {index} 个菜单项附加参数必须为数组。")
        extra_parts = [normalize_text(part, "菜单项附加参数") for part in extra]
        menu[name] = " || ".join([part for part in [url, icon, *extra_parts] if part])
    return menu


def social_items_from_mapping(social: Mapping[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    items: list[dict[str, Any]] = []
    supported = True
    for icon, value in social.items():
        if not isinstance(value, str):
            supported = False
            break
        parts = [part.strip() for part in value.split("||")]
        items.append(
            {
                "icon": str(icon),
                "url": parts[0] if parts else "",
                "description": parts[1] if len(parts) > 1 else "",
                "color": parts[2] if len(parts) > 2 else "",
                "value": value,
            }
        )
    return items, supported


def build_social_mapping(items: Any) -> CommentedMap:
    if not isinstance(items, list):
        raise ApiError("social_items 必须是数组。")
    social = CommentedMap()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ApiError(f"第 {index} 个社交链接格式不正确。")
        icon = normalize_text(item.get("icon"), f"第 {index} 个图标 Class")
        url = normalize_text(item.get("url"), f"第 {index} 个社交链接")
        description = normalize_text(item.get("description"), f"第 {index} 个描述")
        color = normalize_text(item.get("color"), f"第 {index} 个颜色")
        if not icon or not url:
            raise ApiError(f"第 {index} 个社交链接必须填写图标 Class 和链接。")
        if icon in social:
            raise ApiError(f"社交图标重复：{icon}")
        social[icon] = " || ".join([part for part in [url, description, color] if part])
    return social


def ensure_child_path(root: Path, relative: str) -> Path:
    if not relative:
        raise ApiError("文件路径不能为空。")
    candidate = (root / relative).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ApiError("文件路径超出允许的目录。", 403)
    return candidate


def list_files(root: Path, extensions: set[str]) -> list[Path]:
    if not root.exists():
        return []
    files: list[Path] = []
    for path in root.rglob("*"):
        try:
            if path.is_file() and path.suffix.lower() in extensions and ".blogmanager-trash" not in path.parts:
                files.append(path)
        except OSError:
            continue
    return files


from pathlib import Path

def read_post_frontmatter(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return {
            "valid": False,
            "has_delimiters": False,
            "has_closing": False,
            "metadata": CommentedMap(),
            "body": "",
            "text": "",
            "error": "文章不是有效的 UTF-8 文件。",
        }
    except OSError as exc:
        return {
            "valid": False,
            "has_delimiters": False,
            "has_closing": False,
            "metadata": CommentedMap(),
            "body": "",
            "text": "",
            "error": f"读取文章失败：{exc}",
        }

    has_delimiters = text.startswith("---")
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return {
            "valid": False,
            "has_delimiters": has_delimiters,
            "has_closing": False,
            "metadata": CommentedMap(),
            "body": text,
            "text": text,
            "error": "",
        }
    try:
        yaml = new_round_trip_yaml()
        metadata = yaml.load(match.group(1))
        if metadata is None:
            metadata = CommentedMap()
        if not isinstance(metadata, Mapping):
            raise ValueError("front-matter 根节点必须是 YAML 映射。")
        return {
            "valid": True,
            "has_delimiters": True,
            "has_closing": True,
            "metadata": metadata,
            "body": text[match.end():],
            "text": text,
            "error": "",
        }
    except Exception as exc:
        return {
            "valid": False,
            "has_delimiters": True,
            "has_closing": True,
            "metadata": CommentedMap(),
            "body": text[match.end():],
            "text": text,
            "error": f"front-matter YAML 格式错误：{exc}",
        }


def infer_frontmatter_type(key: str, value: Any) -> str:
    if isinstance(value, Mapping):
        return "yaml"
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    if isinstance(value, datetime) or key.lower() in {"date", "updated", "updated_at"}:
        return "date"
    return "text"


def frontmatter_properties(metadata: Mapping[str, Any]) -> list[dict[str, Any]]:
    properties: list[dict[str, Any]] = []
    for key, value in metadata.items():
        value_type = infer_frontmatter_type(str(key), value)
        display_value = dump_yaml_value(value) if value_type == "yaml" else plain_value(value)
        properties.append({"name": str(key), "type": value_type, "value": display_value})
    return properties

def coerce_frontmatter_value(value_type: str, value: Any) -> Any:
    kind = (value_type or "text").strip().lower()
    if kind == "array":
        items = value if isinstance(value, list) else re.split(r"[\n,，]+", str(value or ""))
        return CommentedSeq([str(item).strip() for item in items if str(item).strip()])
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on", "是"}
    if kind == "number":
        text = str(value).strip()
        if not text:
            raise ApiError("数字类型属性不能为空。")
        try:
            return int(text) if re.fullmatch(r"[-+]?\d+", text) else float(text)
        except ValueError as exc:
            raise ApiError(f"数字类型属性格式不正确：{value}") from exc
    if kind == "yaml":
        try:
            parsed = YAML(typ="safe").load(str(value or ""))
        except Exception as exc:
            raise ApiError(f"YAML 属性解析失败：{exc}") from exc
        return plain_value(parsed) if parsed is not None else ""
    if kind == "date":
        text = str(value or "").strip()
        matched = re.match(
            r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?",
            text,
        )
        if matched:
            normalized_date = f"{matched.group(1)}-{int(matched.group(2)):02d}-{int(matched.group(3)):02d}"
            if not matched.group(4):
                return normalized_date
            return (
                f"{normalized_date} {int(matched.group(4)):02d}:{int(matched.group(5)):02d}:"
                f"{int(matched.group(6) or 0):02d}"
            )
        return text
    return str(value or "").strip()


def frontmatter_metadata_from_properties(properties: Any) -> CommentedMap:
    if not isinstance(properties, list):
        raise ApiError("frontmatter 必须是属性数组。")
    metadata = CommentedMap()
    for item in properties:
        if not isinstance(item, Mapping):
            raise ApiError("front-matter 属性格式不正确。")
        name = normalize_text(item.get("name"), "属性名")
        if not name:
            continue
        if name in metadata:
            raise ApiError(f"属性名重复：{name}")
        value_type = normalize_text(item.get("type"), "属性类型") or "text"
        metadata[name] = coerce_frontmatter_value(value_type, item.get("value"))
    return metadata

def frontmatter_value_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(value)
    return True


def frontmatter_categories_valid(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(str(item).strip() for item in value)
    return False


def repair_post_frontmatter(path: Path, root: Path) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    info = read_post_frontmatter(path)
    invalid_existing = bool(info["has_delimiters"] and not info["valid"])
    if invalid_existing and not info.get("has_closing"):
        return {
            "relative_path": relative,
            "changed": False,
            "changes": [],
            "error": info["error"] or "front-matter 缺少结束分隔符，需手动修复。",
        }
    if info.get("error") and not info.get("text"):
        return {"relative_path": relative, "changed": False, "changes": [], "error": str(info["error"])}

    metadata = CommentedMap() if invalid_existing else (info["metadata"] if info["valid"] else CommentedMap())
    body = info["body"] if info["valid"] or invalid_existing else info["text"]
    changes: list[str] = ["front-matter"] if invalid_existing else []
    if not isinstance(metadata.get("title"), str) or not metadata.get("title", "").strip():
        metadata["title"] = path.stem
        changes.append("title")
    if not frontmatter_value_present(metadata.get("date")):
        metadata["date"] = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
        changes.append("date")
    if path.parent != root and not frontmatter_categories_valid(metadata.get("categories")):
        metadata["categories"] = CommentedSeq([path.parent.name])
        changes.append("categories")

    if not changes:
        return {"relative_path": relative, "changed": False, "changes": [], "error": ""}
    yaml = new_round_trip_yaml()
    stream = io.StringIO()
    yaml.dump(metadata, stream)
    prefix = f"---\n{stream.getvalue()}---\n"
    if body and not body.startswith("\n"):
        prefix += "\n"
    backup = path.with_suffix(path.suffix + ".blogmanager.bak")
    temp_path = path.with_suffix(path.suffix + ".blogmanager.tmp")
    try:
        if not backup.exists():
            shutil.copy2(path, backup)
        temp_path.write_text(prefix + body, encoding="utf-8", newline="\n")
        os.replace(temp_path, path)
    except OSError as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return {"relative_path": relative, "changed": False, "changes": [], "error": f"保存失败：{exc}"}
    return {"relative_path": relative, "changed": True, "changes": changes, "error": ""}


def batch_repair_post_frontmatter(root: Path, relative_paths: list[str] | None = None) -> dict[str, Any]:
    if relative_paths is None:
        paths = list_files(root, POST_EXTENSIONS)
    else:
        seen: set[str] = set()
        paths = []
        for relative in relative_paths:
            normalized = str(relative).strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            path = ensure_child_path(root, normalized)
            if path.suffix.lower() in POST_EXTENSIONS:
                paths.append(path)
    results: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists() or not path.is_file():
            results.append({"relative_path": path.name, "changed": False, "changes": [], "error": "文章不存在。"})
            continue
        results.append(repair_post_frontmatter(path, root))
    changed = sum(1 for item in results if item["changed"])
    errors = [item for item in results if item["error"]]
    return {
        "total": len(results),
        "changed": changed,
        "skipped": len(results) - changed - len(errors),
        "errors": len(errors),
        "results": results,
    }


def auto_complete_post_frontmatter(root: Path) -> dict[str, list[dict[str, str]]]:
    repaired: list[dict[str, str]] = []
    invalid: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    for path in list_files(root, POST_EXTENSIONS):
        relative = path.relative_to(root).as_posix()
        info = read_post_frontmatter(path)
        if info["valid"]:
            continue
        if info["has_delimiters"]:
            invalid.append({"relative_path": relative, "error": info["error"] or "front-matter 无效"})
            continue
        if info.get("error") and not info.get("text"):
            errors.append({"relative_path": relative, "error": str(info["error"])})
            continue
        backup = path.with_suffix(path.suffix + ".blogmanager.bak")
        temp_path = path.with_suffix(path.suffix + ".blogmanager.tmp")
        try:
            metadata = CommentedMap()
            metadata["title"] = path.stem
            metadata["date"] = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
            if path.parent != root:
                metadata["categories"] = CommentedSeq([path.parent.name])
            yaml = new_round_trip_yaml()
            stream = io.StringIO()
            yaml.dump(metadata, stream)
            body = info["text"]
            prefix = f"---\n{stream.getvalue()}---\n"
            if body and not body.startswith("\n"):
                prefix += "\n"
            new_content = prefix + body
            if not backup.exists():
                shutil.copy2(path, backup)
            temp_path.write_text(new_content, encoding="utf-8", newline="\n")
            os.replace(temp_path, path)
            app.logger.info("已为 %s 自动补全 front-matter", relative)
            repaired.append({"relative_path": relative})
        except OSError as exc:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            errors.append({"relative_path": relative, "error": str(exc)})
    return {"repaired": repaired, "invalid": invalid, "errors": errors}


def parse_post_metadata(path: Path) -> dict[str, Any]:
    info = read_post_frontmatter(path)
    title = path.stem
    date_value = ""
    cover_value = ""
    if info["valid"]:
        metadata = info["metadata"]
        title = str(metadata.get("title", "") or title)
        date_value = str(metadata.get("date", "") or "")
        cover_value = str(metadata.get("cover", "") or "")
    stat = path.stat()
    return {
        "title": title,
        "date": date_value,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "cover": cover_value,
        "frontmatter_valid": bool(info["valid"]),
        "frontmatter_missing": not bool(info["valid"]),
        "frontmatter_error": str(info.get("error", "") or ""),
    }


def open_with_default_app(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def safe_filename(title: str, filename: str = "") -> str:
    raw = normalize_text(filename, "文件名") or normalize_text(title, "标题") or "untitled"
    raw = Path(raw).name
    raw = re.sub(r'[\\/:*?"<>|]+', "-", raw).strip(" .")
    if not raw:
        raw = "untitled"
    if not raw.lower().endswith((".md", ".markdown")):
        raw += ".md"
    return raw

class Task:
    def __init__(self, kind: str, command: str, cwd: Path, port: int | None = None):
        self.id = uuid.uuid4().hex
        self.kind = kind
        self.command = command
        self.command_args: list[str] = []
        self.cwd = str(cwd)
        self.port = port
        self.local_only = False
        self.status = "running"
        self.exit_code: int | None = None
        self.started_at = datetime.now().isoformat(timespec="seconds")
        self.ended_at: str | None = None
        self.lines: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []
        self.steps: list[dict[str, Any]] = []
        self.process: subprocess.Popen[str] | None = None
        self.pid: int | None = None
        self.stop_requested = False
        self.options: dict[str, Any] = {}
        self.failed_step: str | None = None
        self.error_message: str = ""
        self.condition = threading.Condition()

    def set_steps(self, steps: list[dict[str, Any]]) -> None:
        with self.condition:
            self.steps = [
                {"id": item["id"], "title": item["title"], "status": "pending", "detail": ""}
                for item in steps
            ]
            self.condition.notify_all()

    def emit(self, text: str, level: str = "stdout") -> None:
        clean_text = ANSI_ESCAPE.sub("", str(text)).rstrip("\r\n")
        with self.condition:
            item = {
                "seq": len(self.events) + 1,
                "type": "log",
                "time": datetime.now().strftime("%H:%M:%S"),
                "level": level,
                "text": clean_text,
            }
            self.events.append(item)
            self.lines.append(item)
            self.condition.notify_all()

    def emit_step(self, step_id: str, status: str, detail: str = "") -> None:
        with self.condition:
            for step in self.steps:
                if step["id"] == step_id:
                    step["status"] = status
                    if detail:
                        step["detail"] = detail
                    break
            self.events.append(
                {
                    "seq": len(self.events) + 1,
                    "type": "step",
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "id": step_id,
                    "status": status,
                    "detail": detail,
                }
            )
            self.condition.notify_all()

    def finish(self, status: str, exit_code: int | None = None) -> None:
        with self.condition:
            if self.status != "running":
                return
            self.status = status
            self.exit_code = exit_code
            self.ended_at = datetime.now().isoformat(timespec="seconds")
            self.condition.notify_all()

    def snapshot(self) -> dict[str, Any]:
        with self.condition:
            return {
                "id": self.id,
                "kind": self.kind,
                "command": self.command,
                "cwd": self.cwd,
                "port": self.port,
                "pid": self.pid,
                "local_only": self.local_only,
                "failed_step": self.failed_step,
                "error_message": self.error_message,
                "steps": copy.deepcopy(self.steps),
                "status": self.status,
                "exit_code": self.exit_code,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
            }


class TaskManager:
    def __init__(self):
        self.tasks: dict[str, Task] = {}
        self.lock = threading.RLock()

    def create(self, kind: str, command: str, cwd: Path, port: int | None = None) -> Task:
        task = Task(kind, command, cwd, port)
        with self.lock:
            self.tasks[task.id] = task
            if len(self.tasks) > 30:
                completed = [item for item in self.tasks.values() if item.status != "running"]
                for old_task in completed[: max(0, len(self.tasks) - 30)]:
                    self.tasks.pop(old_task.id, None)
        return task

    def get(self, task_id: str) -> Task:
        with self.lock:
            task = self.tasks.get(task_id)
        if task is None:
            raise ApiError("找不到该任务。", 404)
        return task

    def running(self, kind: str) -> Task | None:
        with self.lock:
            for task in reversed(list(self.tasks.values())):
                if task.kind == kind and task.status == "running":
                    return task
        return None

    def latest(self, kind: str) -> Task | None:
        with self.lock:
            for task in reversed(list(self.tasks.values())):
                if task.kind == kind:
                    return task
        return None

    def stop_all(self) -> None:
        with self.lock:
            tasks = list(self.tasks.values())
        for task in tasks:
            if task.status == "running":
                stop_task(task, announce=False)


task_manager = TaskManager()


def validate_port(value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ApiError("预览端口必须是数字。") from exc
    if port < 1024 or port > 65535:
        raise ApiError("预览端口必须在 1024 到 65535 之间。")
    return port


def port_is_occupied(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def suggest_preview_port(start: int = 4000) -> int:
    for port in range(start + 1, 65536):
        if not port_is_occupied(port):
            return port
    for port in range(1024, start):
        if not port_is_occupied(port):
            return port
    return start


def command_for(kind: str, port: int | None = None) -> tuple[str, list[str]]:
    if kind == "deploy":
        command_text = "hexo clean && hexo deploy"
    elif kind == "preview":
        port = validate_port(port or 4000)
        command_text = f"hexo server -p {port}"
    else:
        raise ApiError(f"未知任务类型：{kind}")

    if os.name == "nt":
        return command_text, ["cmd.exe", "/d", "/s", "/c", command_text]
    return command_text, ["/bin/sh", "-lc", command_text]


def hexo_command(args: list[str]) -> list[str]:
    command_text = "hexo " + " ".join(args)
    if os.name == "nt":
        return ["cmd.exe", "/d", "/s", "/c", command_text]
    return ["/bin/sh", "-lc", command_text]


def run_process(task: Task) -> None:
    try:
        if task.stop_requested:
            task.emit("任务在启动前已停止。", "warning")
            task.finish("stopped", None)
            return
        display_command = f"hexo server -p {task.port}" if task.kind == "preview" else task.command
        LOGGER.info("task start | kind=%s | cwd=%s | command=%s", task.kind, task.cwd, display_command)
        task.emit(f"$ {display_command}", "system")
        task.emit(f"工作目录：{task.cwd}", "muted")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["NO_COLOR"] = "1"
        env["FORCE_COLOR"] = "0"
        popen_options: dict[str, Any] = {}
        if os.name != "nt":
            popen_options["start_new_session"] = True
        process = subprocess.Popen(
            task.command_args,
            cwd=task.cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
            creationflags=NO_WINDOW,
            **popen_options,
        )
        task.process = process
        with task.condition:
            task.pid = process.pid
            task.condition.notify_all()
        assert process.stdout is not None
        output_tail: list[str] = []
        logged_output = 0
        for raw_line in iter(process.stdout.readline, ""):
            task.emit(raw_line)
            cleaned = str(raw_line).strip()
            if cleaned:
                output_tail.append(cleaned)
                if len(output_tail) > 30:
                    output_tail.pop(0)
                if logged_output < 80:
                    LOGGER.info("command output | kind=%s | %s", task.kind, cleaned)
                    logged_output += 1
        exit_code = process.wait()
        if task.stop_requested:
            LOGGER.warning("task stopped | kind=%s | command=%s", task.kind, display_command)
            task.emit("任务已停止。", "warning")
            task.finish("stopped", exit_code)
        elif exit_code == 0:
            LOGGER.info("task complete | kind=%s | code=0 | command=%s", task.kind, display_command)
            task.emit("命令执行完成。", "success")
            task.finish("success", exit_code)
        else:
            LOGGER.error(
                "task failed | kind=%s | code=%s | command=%s | tail=%s",
                task.kind,
                exit_code,
                display_command,
                " | ".join(output_tail[-10:]),
            )
            task.emit(f"命令执行失败，退出码：{exit_code}", "error")
            task.finish("failed", exit_code)
    except FileNotFoundError as exc:
        task.emit(f"找不到命令或程序：{exc}", "error")
        task.finish("failed", -1)
    except Exception as exc:
        task.emit(f"任务运行异常：{exc}", "error")
        task.finish("failed", -1)


def task_output_since(task: Task, start: int) -> str:
    with task.condition:
        return "\n".join(item.get("text", "") for item in task.lines[start:])


def has_frontmatter_generation_error(output: str) -> bool:
    text = output.casefold()
    return any(
        token in text
        for token in (
            "yamlexception",
            "yaml exception",
            "front-matter",
            "frontmatter",
        )
    )


def run_generate_with_auto_repair(task: Task, target: Path) -> tuple[int, dict[str, Any]]:
    start = len(task.lines)
    code = run_task_command(task, hexo_command(["generate"]), target, "hexo generate")
    output = task_output_since(task, start)
    if not has_frontmatter_generation_error(output):
        return code, {"changed": 0, "errors": [], "results": []}

    root = target / "source" / "_posts"
    repair = batch_repair_post_frontmatter(root, None)
    if repair["changed"]:
        task.emit(
            f"检测到 {repair['changed']} 篇文章属性异常，已自动修复并重新生成。",
            "warning",
        )
        for item in repair["results"]:
            if item["changed"]:
                task.emit(f"  - {item['relative_path']}：补充 {', '.join(item['changes'])}", "success")
    for item in repair["results"]:
        if item["error"]:
            task.emit(f"  - 无法自动修复 {item['relative_path']}：{item['error']}", "error")

    if repair["changed"]:
        task.emit("清理缓存后重新生成...", "system")
        clean_code = run_task_command(task, hexo_command(["clean"]), target, "hexo clean")
        if clean_code != 0:
            return clean_code, repair
        code = run_task_command(task, hexo_command(["generate"]), target, "hexo generate")
    return code, repair


def run_preview_process(task: Task) -> None:
    target = Path(task.cwd)
    try:
        task.emit("========== 开始本地预览 ==========", "system")
        task.emit("[1/3] 清理缓存...", "system")
        code = run_task_command(task, hexo_command(["clean"]), target, "hexo clean")
        if task.stop_requested:
            task.emit("本地预览已停止。", "warning")
            task.finish("stopped", None)
            return
        if code != 0:
            raise AutodeployError("hexo clean 失败，请查看上方日志。")

        task.emit("[2/3] 生成静态文件...", "system")
        code, repair = run_generate_with_auto_repair(task, target)
        if task.stop_requested:
            task.emit("本地预览已停止。", "warning")
            task.finish("stopped", None)
            return
        if code != 0:
            manual = [item["relative_path"] for item in repair.get("results", []) if item.get("error")]
            if manual:
                raise AutodeployError(
                    "hexo generate 失败，以下文章属性无法自动修复，请手动处理：\n" + "\n".join(manual)
                )
            raise AutodeployError("hexo generate 失败，请检查文章 front-matter、主题依赖或上方日志。")

        output = emit_generated_output_status(task, target)
        if output["pug_count"]:
            raise AutodeployError(
                "检测到 Pug 模板未被渲染，可能缺少 hexo-renderer-pug。请先修复依赖再启动预览。"
            )

        task.emit("[3/3] 启动本地服务器...", "system")
        task.port = task.port or 4000
        task.command_args = command_for("preview", task.port)[1]
        run_process(task)
    except (AutodeployError, ApiError) as exc:
        message = str(exc)
        task.error_message = message
        if task.status == "running":
            task.emit(message, "error")
            task.finish("failed", -1)
    except Exception as exc:
        message = str(exc)
        task.error_message = message
        if task.status == "running":
            task.emit(f"本地预览启动异常：{message}", "error")
            task.finish("failed", -1)


def run_generate_process(task: Task) -> None:
    target = Path(task.cwd)
    try:
        task.emit("========== 开始强制重新生成 ==========", "system")
        task.emit("[1/2] 清理缓存...", "system")
        code = run_task_command(task, hexo_command(["clean"]), target, "hexo clean")
        if task.stop_requested:
            task.emit("重新生成已停止。", "warning")
            task.finish("stopped", None)
            return
        if code != 0:
            raise AutodeployError("hexo clean 失败，请查看上方日志。")

        task.emit("[2/2] 生成静态文件...", "system")
        code, repair = run_generate_with_auto_repair(task, target)
        if task.stop_requested:
            task.emit("重新生成已停止。", "warning")
            task.finish("stopped", None)
            return
        if code != 0:
            manual = [item["relative_path"] for item in repair.get("results", []) if item.get("error")]
            if manual:
                raise AutodeployError(
                    "hexo generate 失败，以下文章属性无法自动修复，请手动处理：\n" + "\n".join(manual)
                )
            raise AutodeployError("hexo generate 失败，请检查文章 front-matter、主题依赖或上方日志。")

        output = emit_generated_output_status(task, target)
        if output["pug_count"]:
            raise AutodeployError(
                "检测到 Pug 模板未被渲染，可能缺少 hexo-renderer-pug。请先修复依赖后再重新生成。"
            )
        task.emit("静态文件已重新生成。", "success")
        task.finish("success", 0)
    except (AutodeployError, ApiError) as exc:
        message = str(exc)
        task.error_message = message
        if task.status == "running":
            task.emit(message, "error")
            task.finish("failed", -1)
    except Exception as exc:
        message = str(exc)
        task.error_message = message
        if task.status == "running":
            task.emit(f"强制重新生成异常：{message}", "error")
            task.finish("failed", -1)


def start_process_task(kind: str, cwd: Path, port: int | None = None) -> Task:
    if kind == "preview":
        port = validate_port(port or 4000)
        command_text = f"hexo clean\nhexo generate\nhexo server -p {port}"
        task = task_manager.create(kind, command_text, cwd, port)
        task.command_args = command_for("preview", port)[1]
        threading.Thread(target=run_preview_process, args=(task,), daemon=True).start()
        return task
    command_text, command_args = command_for(kind, port)
    task = task_manager.create(kind, command_text, cwd, port)
    task.command_args = command_args
    threading.Thread(target=run_process, args=(task,), daemon=True).start()
    return task


def start_generate_task(cwd: Path) -> Task:
    task = task_manager.create("generate", "hexo clean && hexo generate", cwd)
    threading.Thread(target=run_generate_process, args=(task,), daemon=True).start()
    return task


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        result = subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=NO_WINDOW,
            check=False,
        )
        if result.returncode != 0:
            terminate_pid_tree(process.pid)
        try:
            process.wait(timeout=1.2)
        except subprocess.TimeoutExpired:
            process.kill()
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass


def wait_for_task_stopped(task: Task, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    port_cleanup_attempted = False
    while time.time() < deadline:
        if task.status != "running":
            return True
        process = task.process
        if task.port and port_is_occupied(task.port):
            if not port_cleanup_attempted:
                terminate_port_processes(task.port)
                port_cleanup_attempted = True
            time.sleep(0.25)
            continue
        if process is not None and process.poll() is None:
            time.sleep(0.2)
            continue
        exit_code = process.returncode if process and process.poll() is not None else None
        task.finish("stopped", exit_code)
        return True
    return task.status != "running"


def stop_task(task: Task, announce: bool = True) -> None:
    if task.status != "running":
        return
    task.stop_requested = True
    if announce:
        task.emit("正在停止任务...", "warning")
    if task.process is not None:
        terminate_process_tree(task.process)
    if task.port:
        terminate_port_processes(task.port)

def open_preview_when_ready(task: Task) -> None:
    deadline = time.time() + 45
    preview_url = f"http://localhost:{task.port or 4000}"
    while time.time() < deadline and task.status == "running":
        with task.condition:
            log_lines = [line["text"] for line in task.lines]
        for line in reversed(log_lines):
            match = PREVIEW_URL_RE.search(line)
            if match:
                preview_url = match.group(0).rstrip(".,)")
                break
        try:
            with urlopen(preview_url, timeout=0.8) as response:
                if response.status < 500:
                    break
        except (URLError, TimeoutError, OSError):
            time.sleep(0.6)

    if task.status != "running":
        return
    task.emit(f"预览服务已就绪，正在打开：{preview_url}", "success")
    try:
        webbrowser.open_new_tab(preview_url)
    except Exception as exc:
        task.emit(f"无法自动打开浏览器：{exc}", "warning")


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    return send_file(APP_ROOT / "static" / "favicon.svg", mimetype="image/svg+xml", max_age=86400)


def consume_cleanup_report() -> dict[str, Any] | None:
    if not CLEANUP_REPORT_FILE.exists():
        return None
    try:
        report = json.loads(CLEANUP_REPORT_FILE.read_text(encoding="utf-8"))
        CLEANUP_REPORT_FILE.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError):
        return None
    return None if report.get("ok") else report

def read_persistent_logs(limit: int = 200, offset: int = 0) -> dict[str, Any]:
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    if not LOG_FILE.exists():
        return {"lines": [], "total": 0, "offset": 0, "has_more": False}
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        raise ApiError(f"读取历史日志失败：{exc}") from exc
    total = len(lines)
    end = max(0, total - offset)
    start = max(0, end - limit)
    return {
        "lines": lines[start:end],
        "total": total,
        "offset": offset + (end - start),
        "has_more": start > 0,
    }


def truncate_persistent_logs() -> None:
    for handler in LOGGER.handlers:
        if not isinstance(handler, RotatingFileHandler):
            continue
        handler.acquire()
        try:
            handler.stream.seek(0)
            handler.stream.truncate(0)
            handler.flush()
        finally:
            handler.release()
    for index in range(1, 4):
        try:
            Path(f"{LOG_FILE}.{index}").unlink(missing_ok=True)
        except OSError:
            pass


@app.get("/api/logs")
def api_logs() -> Response:
    try:
        limit = int(request.args.get("limit", "200"))
    except ValueError:
        limit = 200
    try:
        offset = int(request.args.get("offset", "0"))
    except ValueError:
        offset = 0
    return jsonify(read_persistent_logs(limit, offset))


@app.get("/api/logs/download")
def api_download_logs() -> Response:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if not LOG_FILE.exists():
        LOG_FILE.touch()
    return send_file(LOG_FILE, as_attachment=True, download_name="blogmanager.log")


@app.delete("/api/logs")
def api_clear_logs() -> Response:
    try:
        truncate_persistent_logs()
    except OSError as exc:
        raise ApiError(f"清空历史日志失败：{exc}") from exc
    return jsonify({"ok": True})


@app.get("/api/status")
def api_status() -> Response:
    settings = settings_store.get()
    blog_dir = blog_directory()
    site_path = blog_dir / SITE_CONFIG_NAME if blog_dir else None
    base_path, override_path = None, None
    if blog_dir and blog_dir.exists() and site_path and site_path.exists():
        try:
            base_path, override_path = theme_config_paths()
        except ApiError:
            pass
    preview = task_manager.latest("preview")
    posts_root = blog_dir / "source" / "_posts" if blog_dir else None
    images_root = blog_dir / "source" / "img" if blog_dir else None
    exists = bool(blog_dir and blog_dir.exists() and blog_dir.is_dir())
    site_exists = bool(site_path and site_path.exists())
    first_run = settings_store.is_first_run()
    return jsonify(
        {
            "blog_dir": str(blog_dir) if blog_dir else "",
            "exists": exists,
            "site_config_exists": site_exists,
            "theme_config_exists": bool(
                (override_path and override_path.exists()) or (base_path and base_path.exists())
            ),
            "theme_base_path": str(base_path) if base_path else "",
            "theme_override_path": str(override_path) if override_path else "",
            "posts_exists": bool(posts_root and posts_root.exists()),
            "post_count": len(list_files(posts_root, POST_EXTENSIONS)) if posts_root else 0,
            "images_exists": bool(images_root and images_root.exists()),
            "image_count": len(list_files(images_root, IMAGE_EXTENSIONS)) if images_root else 0,
            "recent_dirs": [item for item in settings.get("recent_dirs", []) if Path(item).expanduser().exists()],
            "remember_last": bool(settings.get("remember_last", False)),
            "autodeploy": settings.get("autodeploy", {}),
            "github": public_github_settings(settings.get("github")),
            "first_run": first_run,
            "onboarding_complete": not first_run,
            "show_welcome": first_run or not bool(settings.get("remember_last", False)) or not site_exists,
            "cleanup_warning": consume_cleanup_report(),
            "local_only": bool(blog_dir and (blog_dir / ".blogmanager-local-only").exists()),
            "preview": preview.snapshot() if preview else None,
        }
    )


@app.post("/api/select-folder")
def api_select_folder() -> Response:
    current = blog_directory() or Path.home()
    selected = select_folder_dialog(current)
    if not selected:
        return jsonify({"cancelled": True})
    path = settings_store.set_blog_dir(selected)
    base_path, override_path = theme_config_paths()
    return jsonify(
        {
            "cancelled": False,
            "blog_dir": str(path),
            "site_config_exists": (path / SITE_CONFIG_NAME).exists(),
            "theme_config_exists": base_path.exists() or override_path.exists(),
        }
    )


@app.post("/api/blog-directory")
def api_set_blog_directory() -> Response:
    payload = json_payload()
    path = settings_store.set_blog_dir(str(payload.get("path", "")))
    base_path, override_path = theme_config_paths()
    return jsonify(
        {
            "blog_dir": str(path),
            "site_config_exists": (path / SITE_CONFIG_NAME).exists(),
            "theme_config_exists": base_path.exists() or override_path.exists(),
        }
    )


@app.post("/api/onboarding")
def api_complete_onboarding() -> Response:
    payload = json_payload()
    path = settings_store.set_blog_dir(str(payload.get("path", "")))
    if not (path / SITE_CONFIG_NAME).is_file():
        raise ApiError("所选文件夹不是 Hexo 博客根目录，请选择包含 _config.yml 的文件夹。", 409)
    github_values: dict[str, Any] = {}
    for source_key, target_key in (
        ("github_username", "username"),
        ("repo_url", "repo_url"),
        ("branch", "branch"),
    ):
        if source_key in payload:
            github_values[target_key] = str(payload.get(source_key, "") or "").strip()
    token = str(payload.get("github_token", "") or "").strip()
    if token and bool(payload.get("remember_token")):
        github_values["token"] = token
        github_values["remember"] = True
    elif bool(payload.get("remember_token")):
        github_values["remember"] = True
    if github_values:
        settings_store.update_github(github_values)
    if "remember_last" in payload:
        settings_store.set_remember_last(bool(payload.get("remember_last")))
    settings_store.mark_onboarding_complete()
    return api_status()


@app.post("/api/config/reset")
def api_reset_config() -> Response:
    settings_store.reset()
    return jsonify({"ok": True, "first_run": True})


@app.get("/api/settings")
def api_get_settings() -> Response:
    settings = settings_store.get()
    return jsonify(
        {
            "blog_dir": settings.get("blog_dir", ""),
            "recent_dirs": [item for item in settings.get("recent_dirs", []) if Path(item).expanduser().exists()],
            "remember_last": bool(settings.get("remember_last", False)),
            "autodeploy": settings.get("autodeploy", {}),
            "github": public_github_settings(settings.get("github")),
            "first_run": settings_store.is_first_run(),
        }
    )


@app.put("/api/settings")
def api_update_settings() -> Response:
    payload = json_payload()
    if "remember_last" in payload:
        settings_store.set_remember_last(bool(payload.get("remember_last")))
    if isinstance(payload.get("autodeploy"), dict):
        settings_store.set_section("autodeploy", payload["autodeploy"])
    if isinstance(payload.get("github"), dict):
        raw_github = payload["github"]
        github_values = {
            key: raw_github[key]
            for key in ("username", "repo_url", "branch", "token", "remember")
            if key in raw_github
        }
        if str(github_values.get("token", "") or "") == "••••••••":
            github_values.pop("token", None)
        settings_store.update_github(github_values)
    if payload.get("clear_token"):
        settings_store.update_github({"token": "", "remember": False})
    if payload.get("path"):
        settings_store.set_blog_dir(str(payload.get("path")))
    return api_get_settings()


@app.post("/api/open-folder")
def api_open_folder() -> Response:
    cwd = require_blog_directory()
    try:
        open_with_default_app(cwd)
    except Exception as exc:
        raise ApiError(f"无法打开文件夹：{exc}") from exc
    return jsonify({"ok": True})

@app.get("/api/site-config")
def api_get_site_config() -> Response:
    path = site_config_path()
    document = load_yaml_file(path)
    return jsonify(
        {
            "path": str(path),
            "values": plain_value(document),
            "raw_yaml": dump_yaml_value(document),
        }
    )


@app.put("/api/site-config")
def api_update_site_config() -> Response:
    path = site_config_path()
    payload = json_payload()
    mode = payload.get("mode", "fields")
    if mode == "raw":
        document = load_yaml_text(str(payload.get("raw_yaml", "")), "站点配置")
        backup = write_yaml_file(path, document)
        return jsonify({"ok": True, "path": str(path), "backup": str(backup), "changed": 1})
    if mode != "fields":
        raise ApiError("mode 必须为 fields 或 raw。")
    changes = payload.get("changes", {})
    document = load_yaml_file(path)
    changed = apply_config_changes(document, changes, None, payload.get("reset_paths", []))
    backup = None
    if changed:
        backup = write_yaml_file(path, document)
    return jsonify(
        {
            "ok": True,
            "path": str(path),
            "backup": str(backup) if backup else "",
            "changed": changed,
        }
    )


def load_effective_theme_document() -> tuple[CommentedMap, Path, Path]:
    base_path, override_path = theme_config_paths()
    base = load_yaml_file(base_path, allow_missing=True)
    override = load_yaml_file(override_path, allow_missing=True)
    effective = merge_documents(base, override)
    if not isinstance(effective, CommentedMap):
        effective = CommentedMap(plain_value(effective))
    return effective, base_path, override_path


@app.get("/api/theme-config")
def api_get_theme_config() -> Response:
    effective, base_path, override_path = load_effective_theme_document()
    if not base_path.exists() and not override_path.exists():
        raise ApiError("找不到 Butterfly 主题配置文件。", 404)
    base = load_yaml_file(base_path, allow_missing=True)
    override = load_yaml_file(override_path, allow_missing=True)
    warnings: list[dict[str, str]] = []
    menu = get_path(effective, "menu", CommentedMap())
    social = get_path(effective, "social", CommentedMap())
    if not isinstance(menu, Mapping):
        warnings.append({
            "path": "menu",
            "message": "menu 配置格式异常，当前使用空菜单以确保其他配置仍可正常加载。请检查 YAML 文件。",
        })
        menu = CommentedMap()
    if not isinstance(social, Mapping):
        warnings.append({
            "path": "social",
            "message": "social 配置格式异常，当前使用空社交链接以确保其他配置仍可正常加载。请检查 YAML 文件。",
        })
        social = CommentedMap()
    menu_items, menu_is_simple = menu_items_from_mapping(menu)
    social_items, social_is_simple = social_items_from_mapping(social)
    if any(item["path"] == "menu" for item in warnings):
        menu_is_simple = True
    if any(item["path"] == "social" for item in warnings):
        social_is_simple = True
    return jsonify(
        {
            "base_path": str(base_path),
            "override_path": str(override_path),
            "raw_target": "override",
            "values": plain_value(effective),
            "base_values": plain_value(base),
            "override_values": plain_value(override),
            "override_paths": sorted(collect_explicit_paths(override)),
            "raw_yaml": dump_yaml_value(override),
            "effective_raw_yaml": dump_yaml_value(effective),
            "field_descriptions": collect_yaml_comments(effective),
            "warnings": warnings,
            "menu_items": menu_items,
            "menu_is_simple": menu_is_simple,
            "social_items": social_items,
            "social_is_simple": social_is_simple,
        }
    )


@app.put("/api/theme-config")
def api_update_theme_config() -> Response:
    payload = json_payload()
    mode = payload.get("mode", "fields")
    base_path, override_path = theme_config_paths()
    if mode == "raw":
        document = load_yaml_text(str(payload.get("raw_yaml", "")), "主题配置")
        backup = write_yaml_file(override_path, document)
        return jsonify(
            {
                "ok": True,
                "path": str(override_path),
                "backup": str(backup),
                "changed": 1,
            }
        )

    if mode != "fields":
        raise ApiError("mode 必须为 fields 或 raw。")
    base = load_yaml_file(base_path, allow_missing=True)
    override = load_yaml_file(override_path, allow_missing=True)
    changes = copy.deepcopy(payload.get("changes", {}))
    if not isinstance(changes, Mapping):
        raise ApiError("changes 必须是 JSON 对象。")
    changes = dict(changes)
    if "menu_items" in payload:
        changes["menu"] = {"type": "yaml", "value": build_menu_mapping(payload.get("menu_items", []))}
    if "social_items" in payload:
        changes["social"] = {"type": "yaml", "value": build_social_mapping(payload.get("social_items", []))}
    changed = apply_config_changes(
        override,
        changes,
        base,
        payload.get("reset_paths", []),
    )
    backup = None
    if changed:
        backup = write_yaml_file(override_path, override)
    return jsonify(
        {
            "ok": True,
            "path": str(override_path),
            "backup": str(backup) if backup else "",
            "changed": changed,
        }
    )


def target_theme_name(target: Path) -> str:
    try:
        document = load_yaml_file(target / SITE_CONFIG_NAME, allow_missing=True)
    except ApiError:
        return ""
    return str(document.get("theme", "") or "").strip().lower()


def inspect_theme_dependencies(
    target: Path,
    expected_theme: str | None = None,
    check_public: bool = False,
) -> dict[str, Any]:
    actual_theme = target_theme_name(target)
    local_only = (target / ".blogmanager-local-only").exists()
    if expected_theme:
        expected = expected_theme.strip().lower()
    elif actual_theme == "landscape" and local_only:
        expected = "landscape"
    else:
        expected = "butterfly"

    requires_renderers = expected == "butterfly" or actual_theme == "butterfly"
    node_modules = target / "node_modules"
    try:
        missing_modules = [
            package for package in THEME_RENDERER_DEPENDENCIES if not (node_modules / package).is_dir()
        ]
    except OSError:
        missing_modules = list(THEME_RENDERER_DEPENDENCIES)

    package_path = target / "package.json"
    package_error = ""
    package_dependencies: dict[str, Any] = {}
    try:
        package_payload = json.loads(package_path.read_text(encoding="utf-8-sig"))
        dependencies = package_payload.get("dependencies", {})
        if isinstance(dependencies, Mapping):
            package_dependencies = dict(dependencies)
        else:
            package_error = "package.json 的 dependencies 不是对象。"
    except FileNotFoundError:
        package_error = "package.json 不存在。"
    except (OSError, UnicodeDecodeError, ValueError, TypeError) as exc:
        package_error = f"package.json 读取失败：{exc}"

    missing_package_dependencies = [
        package for package in THEME_RENDERER_DEPENDENCIES if package not in package_dependencies
    ]
    theme_ok = actual_theme == expected
    pug_files: list[str] = []
    if check_public:
        public_dir = target / "public"
        if public_dir.is_dir():
            try:
                pug_files = sorted(
                    path.relative_to(public_dir).as_posix()
                    for path in public_dir.rglob("*.pug")
                    if path.is_file()
                )
            except OSError:
                pug_files = []

    issues: list[str] = []
    warnings: list[str] = []
    if not theme_ok:
        message = f"_config.yml 的 theme 当前为“{actual_theme or '未设置'}”，预期为“{expected}”。"
        if expected == "landscape" and actual_theme != "landscape":
            issues.append(message)
        elif expected == "butterfly":
            issues.append(message)
        else:
            warnings.append(message)
    if requires_renderers:
        for package in missing_modules:
            issues.append(f"node_modules 缺少 {package}。")
        if package_error:
            issues.append(package_error)
        for package in missing_package_dependencies:
            issues.append(f"package.json dependencies 缺少 {package}。")
    else:
        if missing_modules:
            warnings.append(f"当前使用 {actual_theme or '非 Butterfly'} 主题，未强制要求：{'、'.join(missing_modules)}。")
        if package_error:
            warnings.append(package_error)
    if pug_files:
        preview = "、".join(pug_files[:5])
        suffix = " 等" if len(pug_files) > 5 else ""
        issues.append(f"public 目录存在 {len(pug_files)} 个未渲染的 .pug 文件：{preview}{suffix}。")

    return {
        "ok": not issues,
        "theme": actual_theme,
        "expected_theme": expected,
        "theme_ok": theme_ok,
        "requires_renderers": requires_renderers,
        "missing_modules": missing_modules,
        "missing_package_dependencies": missing_package_dependencies,
        "package_dependencies": sorted(package_dependencies.keys()),
        "package_error": package_error,
        "pug_files": pug_files,
        "pug_count": len(pug_files),
        "issues": issues,
        "warnings": warnings,
    }


def post_output_status(target: Path) -> dict[str, Any]:
    posts_root = target / "source" / "_posts"
    posts = list_files(posts_root, POST_EXTENSIONS)
    public_dir = target / "public"
    html_paths: list[Path] = []
    if public_dir.is_dir():
        try:
            html_paths = [path for path in public_dir.rglob("*.html") if path.is_file()]
        except OSError:
            html_paths = []
    html_names = {path.relative_to(public_dir).as_posix().casefold() for path in html_paths}
    html_stems = {path.stem.casefold() for path in html_paths}
    missing: list[str] = []
    for post in posts:
        try:
            relative = post.relative_to(posts_root).with_suffix("")
        except ValueError:
            continue
        expected = {
            (relative / "index.html").as_posix().casefold(),
            relative.with_suffix(".html").as_posix().casefold(),
        }
        if expected & html_names:
            continue
        if relative.stem.casefold() in html_stems:
            continue
        missing.append(relative.as_posix())
    return {"post_count": len(posts), "missing_posts": missing}


def inspect_generated_output(target: Path) -> dict[str, Any]:
    public_dir = target / "public"
    html_count = 0
    pug_files: list[str] = []
    if public_dir.is_dir():
        try:
            html_count = sum(1 for path in public_dir.rglob("*.html") if path.is_file())
            pug_files = sorted(
                path.relative_to(public_dir).as_posix()
                for path in public_dir.rglob("*.pug")
                if path.is_file()
            )
        except OSError:
            pass
    post_status = post_output_status(target)
    return {
        "public_exists": public_dir.is_dir(),
        "html_count": html_count,
        "pug_files": pug_files,
        "pug_count": len(pug_files),
        **post_status,
    }


def emit_dependency_status(task: Task, status: Mapping[str, Any]) -> None:
    required = bool(status.get("requires_renderers"))
    for package in THEME_RENDERER_DEPENDENCIES:
        if not required:
            task.emit(f"[跳过] node_modules/{package}（当前主题不强制要求）", "muted")
            task.emit(f"[跳过] package.json dependencies.{package}（当前主题不强制要求）", "muted")
            continue
        module_ok = package not in status.get("missing_modules", [])
        task.emit(f"[{'通过' if module_ok else '不通过'}] node_modules/{package}", "success" if module_ok else "error")
        dependency_ok = package not in status.get("missing_package_dependencies", [])
        task.emit(
            f"[{'通过' if dependency_ok else '不通过'}] package.json dependencies.{package}",
            "success" if dependency_ok else "error",
        )
    theme_ok = bool(status.get("theme_ok"))
    task.emit(
        f"[{'通过' if theme_ok else '不通过'}] _config.yml theme = {status.get('theme') or '未设置'}（预期 {status.get('expected_theme')}）",
        "success" if theme_ok else "error",
    )
    for warning in status.get("warnings", []):
        task.emit(str(warning), "warning")


@app.get("/api/preview/check")
def api_preview_check() -> Response:
    port = validate_port(request.args.get("port", "4000"))
    return jsonify(
        {
            "port": port,
            "occupied": port_is_occupied(port),
            "suggested_port": suggest_preview_port(port),
        }
    )


@app.get("/api/preview/dependencies")
def api_preview_dependencies() -> Response:
    return jsonify(inspect_theme_dependencies(require_blog_directory(), check_public=False))


@app.post("/api/commands/deploy")
def api_deploy() -> Response:
    cwd = require_blog_directory()
    if task_manager.running("deploy"):
        raise ApiError("已有部署任务正在运行。", 409)
    task = start_process_task("deploy", cwd)
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/commands/preview")
def api_preview() -> Response:
    cwd = require_blog_directory()
    running = task_manager.running("preview")
    if running:
        stop_task(running)
        if not wait_for_task_stopped(running):
            raise ApiError(
                "旧预览进程未能在预期时间内停止，请检查端口占用或手动结束进程后重试。",
                504,
                {"task": running.snapshot()},
            )
    dependency_status = inspect_theme_dependencies(cwd, check_public=False)
    if not dependency_status["ok"]:
        raise ApiError(
            "本地预览依赖检查未通过：请先修复渲染器依赖或重新生成静态文件。",
            409,
            {"dependency_issue": True, "dependency_status": dependency_status},
        )
    payload = request.get_json(silent=True) or {}
    port = validate_port(payload.get("port", 4000))
    if port_is_occupied(port):
        raise ApiError(
            f"预览端口 {port} 已被占用。",
            409,
            {"port": port, "suggested_port": suggest_preview_port(port)},
        )
    task = start_process_task("preview", cwd, port)
    threading.Thread(target=open_preview_when_ready, args=(task,), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/dependencies/repair")
def api_repair_dependencies() -> Response:
    cwd = require_blog_directory()
    running = task_manager.running("dependencies")
    if running:
        return jsonify({"task": running.snapshot(), "already_running": True}), 200
    task = task_manager.create(
        "dependencies",
        "npm install hexo-renderer-pug hexo-renderer-stylus --save && hexo clean && hexo generate",
        cwd,
    )
    task.options = {"target": cwd}
    threading.Thread(target=run_dependency_repair, args=(task, cwd), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/commands/generate")
def api_generate() -> Response:
    cwd = require_blog_directory()
    running = task_manager.running("generate")
    if running:
        return jsonify({"task": running.snapshot(), "already_running": True}), 200
    task = start_generate_task(cwd)
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/commands/<task_id>/stop")
def api_stop_task(task_id: str) -> Response:
    task = task_manager.get(task_id)
    if task.status != "running":
        return jsonify({"task": task.snapshot()})
    stop_task(task)
    stopped = wait_for_task_stopped(task)
    if not stopped:
        raise ApiError("预览进程未能在预期时间内停止，请检查端口占用或手动结束进程。", 504, {"task": task.snapshot()})
    return jsonify({"task": task.snapshot(), "message": "预览已停止。", "stopped": True})


@app.get("/api/tasks/<task_id>")
def api_task(task_id: str) -> Response:
    return jsonify({"task": task_manager.get(task_id).snapshot()})


def _event_stream(task: Task, cursor: int):
    while True:
        pending: list[dict[str, Any]] = []
        done = False
        with task.condition:
            pending = [item for item in task.events if item["seq"] > cursor]
            if not pending:
                if task.status != "running":
                    done = True
                else:
                    task.condition.wait(timeout=15)
        if pending:
            for item in pending:
                cursor = max(cursor, item["seq"])
                event_name = "step" if item.get("type") == "step" else "log"
                yield f"id: {item['seq']}\nevent: {event_name}\ndata: {json.dumps(item, ensure_ascii=False)}\n\n"
            continue
        if done:
            yield f"event: done\ndata: {json.dumps(task.snapshot(), ensure_ascii=False)}\n\n"
            return
        yield ": keep-alive\n\n"


@app.get("/api/tasks/<task_id>/events")
def api_task_events(task_id: str) -> Response:
    task = task_manager.get(task_id)
    try:
        cursor = int(request.headers.get("Last-Event-ID") or request.args.get("after", "0"))
    except ValueError:
        cursor = 0
    return Response(
        _event_stream(task, cursor),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/api/posts")
def api_posts() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    posts = []
    for path in list_files(root, POST_EXTENSIONS):
        metadata = parse_post_metadata(path)
        posts.append(
            {
                "name": path.name,
                "title": metadata["title"],
                "date": metadata["date"],
                "size": metadata["size"],
                "modified": metadata["modified"],
                "relative_path": path.relative_to(root).as_posix(),
                "cover": metadata["cover"],
                "frontmatter_valid": metadata["frontmatter_valid"],
                "frontmatter_missing": metadata["frontmatter_missing"],
                "frontmatter_error": metadata["frontmatter_error"],
            }
        )
    posts.sort(key=lambda item: item["modified"], reverse=True)
    return jsonify(
        {
            "path": str(root),
            "posts": posts,
            "frontmatter_repaired": [],
            "frontmatter_invalid": [],
            "frontmatter_errors": [],
        }
    )


@app.post("/api/posts/frontmatter/repair")
def api_repair_post_frontmatter() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    payload = json_payload()
    relative_paths = payload.get("relative_paths")
    if relative_paths is not None and not isinstance(relative_paths, list):
        raise ApiError("relative_paths 必须是数组。")
    if relative_paths == []:
        relative_paths = None
    result = batch_repair_post_frontmatter(root, relative_paths)
    for item in result["results"]:
        if item["changed"]:
            app.logger.info("已检查并修复 %s：%s", item["relative_path"], "、".join(item["changes"]))
    return jsonify(result)


@app.get("/api/posts/frontmatter")
def api_get_post_frontmatter() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    path = ensure_child_path(root, request.args.get("relative_path", ""))
    if not path.exists() or not path.is_file() or path.suffix.lower() not in POST_EXTENSIONS:
        raise ApiError("文章不存在或不是 Markdown 文件。", 404)
    info = read_post_frontmatter(path)
    message = ""
    if info["has_delimiters"] and not info["valid"]:
        message = info["error"] or "front-matter 格式无效。"
    elif not info["has_delimiters"]:
        message = "当前文章没有 front-matter，保存时会自动创建。"
    return jsonify(
        {
            "relative_path": path.relative_to(root).as_posix(),
            "valid": bool(info["valid"]),
            "has_frontmatter": bool(info["valid"]),
            "missing": not bool(info["has_delimiters"]),
            "invalid": bool(info["has_delimiters"] and not info["valid"]),
            "message": message,
            "properties": frontmatter_properties(info["metadata"]) if info["valid"] else [],
        }
    )


@app.post("/api/posts/frontmatter")
def api_update_post_frontmatter() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    payload = json_payload()
    path = ensure_child_path(root, str(payload.get("relative_path", "")))
    if not path.exists() or not path.is_file() or path.suffix.lower() not in POST_EXTENSIONS:
        raise ApiError("文章不存在或不是 Markdown 文件。", 404)
    info = read_post_frontmatter(path)
    if info["has_delimiters"] and not info["valid"]:
        raise ApiError(info["error"] or "front-matter YAML 格式错误，请先修复原文件。", 409)
    if info.get("error") and not info.get("text"):
        raise ApiError(str(info["error"]), 409)
    metadata = frontmatter_metadata_from_properties(payload.get("properties"))
    yaml = new_round_trip_yaml()
    stream = io.StringIO()
    yaml.dump(metadata, stream)
    body = info["body"] if info["valid"] else info["text"]
    prefix = f"---\n{stream.getvalue()}---\n"
    if body and not body.startswith("\n"):
        prefix += "\n"
    new_content = prefix + body
    backup = path.with_suffix(path.suffix + ".blogmanager.bak")
    temp_path = path.with_suffix(path.suffix + ".blogmanager.tmp")
    try:
        if not backup.exists():
            shutil.copy2(path, backup)
        temp_path.write_text(new_content, encoding="utf-8", newline="\n")
        os.replace(temp_path, path)
    except OSError as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ApiError(f"保存 front-matter 失败，文章文件可能被其他程序占用：{exc}") from exc
    return jsonify(
        {
            "ok": True,
            "relative_path": path.relative_to(root).as_posix(),
            "properties": frontmatter_properties(metadata),
        }
    )


@app.post("/api/posts")
def api_create_post() -> Response:
    payload = json_payload()
    title = normalize_text(payload.get("title"), "标题")
    if not title:
        raise ApiError("文章标题不能为空。")
    root = require_blog_directory() / "source" / "_posts"
    root.mkdir(parents=True, exist_ok=True)
    filename = safe_filename(title, str(payload.get("filename", "")))
    folder = normalize_text(payload.get("folder"), "文件夹")
    folder_path = ensure_child_path(root, folder) if folder else root
    folder_path.mkdir(parents=True, exist_ok=True)
    relative = (Path(folder) / filename).as_posix() if folder else filename
    path = ensure_child_path(root, relative)
    if path.exists():
        raise ApiError(f"文章已存在：{filename}", 409)

    tags = payload.get("tags", [])
    categories = payload.get("categories", [])
    if not isinstance(tags, list) or not isinstance(categories, list):
        raise ApiError("tags 和 categories 必须是数组。")
    metadata = CommentedMap()
    metadata["title"] = title
    metadata["date"] = datetime.now().strftime("%Y-%m-%d")
    metadata["tags"] = CommentedSeq([str(item).strip() for item in tags if str(item).strip()])
    metadata["categories"] = CommentedSeq(
        [str(item).strip() for item in categories if str(item).strip()]
    )
    yaml = new_round_trip_yaml()
    stream = io.StringIO()
    yaml.dump(metadata, stream)
    try:
        path.write_text(f"---\n{stream.getvalue()}---\n\n", encoding="utf-8", newline="\n")
    except OSError as exc:
        raise ApiError(f"无法创建文章，请检查目录写权限：{exc}") from exc
    return jsonify({"ok": True, "relative_path": path.relative_to(root).as_posix()}), 201


@app.get("/api/posts/content")
def api_get_post_content() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    path = ensure_child_path(root, request.args.get("relative_path", ""))
    if not path.exists() or not path.is_file():
        raise ApiError("文章不存在。", 404)
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ApiError("文章不是有效的 UTF-8 文件。") from exc
    except OSError as exc:
        raise ApiError(f"无法读取文章：{exc}") from exc
    return jsonify({"relative_path": path.relative_to(root).as_posix(), "content": content})


@app.put("/api/posts/content")
def api_update_post_content() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    payload = json_payload()
    path = ensure_child_path(root, str(payload.get("relative_path", "")))
    if not path.exists() or not path.is_file():
        raise ApiError("文章不存在。", 404)
    content = payload.get("content")
    if not isinstance(content, str):
        raise ApiError("content 必须是文本。")
    backup = path.with_suffix(path.suffix + ".blogmanager.bak")
    temp_path = path.with_suffix(path.suffix + ".blogmanager.tmp")
    try:
        if not backup.exists():
            shutil.copy2(path, backup)
        temp_path.write_text(content, encoding="utf-8", newline="\n")
        os.replace(temp_path, path)
    except OSError as exc:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ApiError(f"保存文章失败：{exc}") from exc
    return jsonify({"ok": True, "relative_path": path.relative_to(root).as_posix(), "backup": str(backup)})


@app.post("/api/posts/open")
def api_open_post() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    payload = json_payload()
    path = ensure_child_path(root, str(payload.get("relative_path", "")))
    if not path.exists() or not path.is_file():
        raise ApiError("文章不存在。", 404)
    try:
        open_with_default_app(path)
    except Exception as exc:
        raise ApiError(f"无法打开文章：{exc}") from exc
    return jsonify({"ok": True})


@app.delete("/api/posts")
def api_delete_post() -> Response:
    root = require_blog_directory() / "source" / "_posts"
    payload = json_payload()
    relative = str(payload.get("relative_path", ""))
    path = ensure_child_path(root, relative)
    if not path.exists() or not path.is_file():
        raise ApiError("文章不存在。", 404)
    trash = root / ".blogmanager-trash"
    trash.mkdir(parents=True, exist_ok=True)
    target = trash / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{path.name}"
    counter = 1
    while target.exists():
        target = trash / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{counter}-{path.name}"
        counter += 1
    try:
        shutil.move(str(path), str(target))
    except OSError as exc:
        raise ApiError(f"无法移动文章到回收目录：{exc}") from exc
    return jsonify({"ok": True, "moved_to": target.relative_to(root).as_posix()})


def safe_image_filename(
    filename: str,
    allowed_extensions: set[str] | None = None,
) -> str:
    allowed = allowed_extensions or COVER_IMAGE_EXTENSIONS
    raw = Path(str(filename or "")).name
    suffix = Path(raw).suffix.lower()
    if suffix not in allowed:
        labels = "、".join(sorted(item.lstrip(".").upper() for item in allowed))
        raise ApiError(f"只支持 {labels} 图片。")
    stem = re.sub(r'[\\/:*?"<>|]+', "-", Path(raw).stem).strip(" .") or "cover"
    return f"{stem}{suffix}"


def unique_image_target(root: Path, filename: str) -> Path:
    candidate = root / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    index = 1
    while True:
        candidate = root / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def image_payload(path: Path, root: Path) -> dict[str, Any]:
    stat = path.stat()
    relative = path.relative_to(root).as_posix()
    return {
        "name": path.name,
        "relative_path": relative,
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "url": f"/api/images/file?path={quote(relative)}",
    }


@app.get("/api/images")
def api_images() -> Response:
    root = require_blog_directory() / "source" / "img"
    images = [image_payload(path, root) for path in list_files(root, IMAGE_EXTENSIONS)]
    if request.args.get("sort") == "name":
        images.sort(key=lambda item: item["name"].casefold())
    else:
        images.sort(key=lambda item: item["modified"], reverse=True)
    return jsonify({"path": str(root), "images": images})


@app.post("/api/images/upload")
def api_upload_image() -> Response:
    root = require_blog_directory() / "source" / "img"
    root.mkdir(parents=True, exist_ok=True)
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError("请选择要上传的图片文件。")
    scope = str(request.form.get("scope", "cover") or "cover").strip().lower()
    allowed_extensions = IMAGE_EXTENSIONS if scope in {"config", "all"} else COVER_IMAGE_EXTENSIONS
    filename = safe_image_filename(upload.filename, allowed_extensions)
    target = unique_image_target(root, filename)
    try:
        upload.save(target)
    except OSError as exc:
        raise ApiError(f"保存上传图片失败：{exc}") from exc
    return jsonify({"ok": True, "image": image_payload(target, root)}), 201


@app.post("/api/images/from-url")
def api_image_from_url() -> Response:
    payload = json_payload()
    url = normalize_text(payload.get("url"), "图片 URL")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ApiError("请输入有效的 http 或 https 图片 URL。")
    request_obj = Request(url, headers={"User-Agent": "BlogManager/1.0", "Accept": "image/*"}, method="GET")
    try:
        with urlopen(request_obj, timeout=20) as response:
            content_type = response.headers.get_content_type()
            data = response.read(25 * 1024 * 1024 + 1)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise ApiError(
            f"图片下载失败：{exc}",
            502,
            {"url": url, "download_failed": True},
        ) from exc
    if len(data) > 25 * 1024 * 1024:
        raise ApiError("图片超过 25 MB，建议压缩后再上传。", 413, {"url": url, "download_failed": True})
    scope = str(payload.get("scope", "cover") or "cover").strip().lower()
    allowed_extensions = IMAGE_EXTENSIONS if scope in {"config", "all"} else COVER_IMAGE_EXTENSIONS
    mime_suffixes = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/bmp": ".bmp",
        "image/avif": ".avif",
        "image/x-icon": ".ico",
        "image/vnd.microsoft.icon": ".ico",
    }
    suffix = Path(parsed.path).suffix.lower()
    if suffix not in allowed_extensions:
        suffix = mime_suffixes.get(content_type, "")
    if suffix not in allowed_extensions:
        labels = "、".join(sorted(item.lstrip(".").upper() for item in allowed_extensions))
        raise ApiError(
            f"无法确认图片格式，仅支持 {labels}。",
            415,
            {"url": url, "download_failed": True},
        )
    filename = safe_image_filename(f"{Path(parsed.path).stem or 'cover'}{suffix}", allowed_extensions)
    root = require_blog_directory() / "source" / "img"
    root.mkdir(parents=True, exist_ok=True)
    target = unique_image_target(root, filename)
    try:
        target.write_bytes(data)
    except OSError as exc:
        raise ApiError(f"保存下载图片失败：{exc}") from exc
    return jsonify({"ok": True, "image": image_payload(target, root)}), 201


@app.get("/api/images/file")
def api_image_file() -> Response:
    root = require_blog_directory() / "source" / "img"
    path = ensure_child_path(root, request.args.get("path", ""))
    if not path.exists() or not path.is_file():
        raise ApiError("图片不存在。", 404)
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return send_file(path, mimetype=mime, conditional=True, max_age=0)


@app.post("/api/images/rename")
def api_rename_image() -> Response:
    root = require_blog_directory() / "source" / "img"
    payload = json_payload()
    source = ensure_child_path(root, str(payload.get("relative_path", "")))
    if not source.exists() or not source.is_file():
        raise ApiError("图片不存在。", 404)
    requested = normalize_text(payload.get("new_name"), "新文件名")
    if not requested:
        raise ApiError("新文件名不能为空。")
    requested = Path(requested).name
    requested = re.sub(r'[\\/:*?"<>|]+', "-", requested).strip(" .")
    if not requested:
        raise ApiError("新文件名无效。")
    original_suffix = source.suffix
    requested_path = Path(requested)
    new_stem = requested_path.stem if requested_path.suffix else requested
    requested = f"{new_stem}{original_suffix}"
    relative_directory = source.parent.relative_to(root)
    target = ensure_child_path(root, (relative_directory / requested).as_posix())
    if target == source:
        relative = source.relative_to(root).as_posix()
        return jsonify({"ok": True, "relative_path": relative, "name": source.name, "url": f"/api/images/file?path={quote(relative)}"})
    overwrite = bool(payload.get("overwrite"))
    if target.exists() and not overwrite:
        raise ApiError(f"文件已存在：{target.name}", 409, {"conflict": True, "relative_path": target.relative_to(root).as_posix()})
    try:
        os.replace(source, target)
    except OSError as exc:
        raise ApiError(f"重命名失败：{exc}") from exc
    relative = target.relative_to(root).as_posix()
    return jsonify({"ok": True, "relative_path": relative, "name": target.name, "url": f"/api/images/file?path={quote(relative)}"})


@app.post("/api/images/open-folder")
def api_open_image_folder() -> Response:
    root = require_blog_directory() / "source" / "img"
    payload = json_payload()
    path = ensure_child_path(root, str(payload.get("relative_path", "")))
    folder = path.parent if path.is_file() else path
    if not folder.exists():
        raise ApiError("图片所在文件夹不存在。", 404)
    try:
        open_with_default_app(folder)
    except Exception as exc:
        raise ApiError(f"无法打开图片文件夹：{exc}") from exc
    return jsonify({"ok": True})

class AutodeployError(Exception):
    pass


def command_executable(name: str, args: list[str]) -> list[str]:
    executable = shutil.which(name)
    if not executable:
        raise AutodeployError(f"找不到 {name}，请先安装并将其加入 PATH。")
    if os.name == "nt" and Path(executable).suffix.lower() in {".cmd", ".bat"}:
        return ["cmd.exe", "/d", "/s", "/c", "call", executable, *args]
    return [executable, *args]


def run_task_command(
    task: Task,
    args: list[str],
    cwd: Path,
    display_command: str | None = None,
) -> int:
    display = display_command or subprocess.list2cmdline(args)
    LOGGER.info("command start | cwd=%s | command=%s", cwd, display)
    task.emit(f"$ {display}", "system")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    options: dict[str, Any] = {}
    if os.name != "nt":
        options["start_new_session"] = True
    process = subprocess.Popen(
        args,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
        creationflags=NO_WINDOW,
        **options,
    )
    with task.condition:
        task.process = process
        task.pid = process.pid
        task.condition.notify_all()
    assert process.stdout is not None
    output_tail: list[str] = []
    logged_output = 0
    for line in iter(process.stdout.readline, ""):
        task.emit(line)
        cleaned = str(line).strip()
        if cleaned:
            output_tail.append(cleaned)
            if len(output_tail) > 30:
                output_tail.pop(0)
            if logged_output < 80:
                LOGGER.info("command output | command=%s | %s", display, cleaned)
                logged_output += 1
    exit_code = process.wait()
    if exit_code == 0:
        LOGGER.info("command complete | code=0 | cwd=%s | command=%s", cwd, display)
    else:
        LOGGER.error(
            "command failed | code=%s | cwd=%s | command=%s | tail=%s",
            exit_code,
            cwd,
            display,
            " | ".join(output_tail[-10:]),
        )
    return exit_code


def inspect_target_folder(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False, "empty": False, "hexo": False, "non_empty": False}
    if not path.is_dir():
        return {"exists": True, "empty": False, "hexo": False, "non_empty": True}
    try:
        entries = [item for item in path.iterdir() if item.name not in {".DS_Store", "Thumbs.db"}]
    except OSError:
        entries = []
    return {
        "exists": True,
        "empty": len(entries) == 0,
        "hexo": (path / "_config.yml").is_file(),
        "non_empty": len(entries) > 0,
    }


def decode_command_output(data: bytes) -> str:
    if not data:
        return ""
    encodings = ("utf-8-sig", "utf-8", "gb18030", "gbk", locale.getpreferredencoding(False))
    for encoding in dict.fromkeys(encodings):
        if not encoding:
            continue
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="ignore")


def tool_version(name: str) -> tuple[bool, str]:
    executable = shutil.which(name)
    if not executable:
        return False, ""
    try:
        command = command_executable(name, ["--version"])
        result = subprocess.run(
            command,
            capture_output=True,
            creationflags=NO_WINDOW,
            timeout=8,
            check=False,
        )
        output = decode_command_output(result.stdout or result.stderr or b"").strip()
        version = output.splitlines()[0] if output else ""
        return True, version
    except Exception:
        return True, ""


def infer_repo_url(site_url: str) -> str:
    if not site_url:
        return ""
    parsed = urlparse(site_url)
    host = (parsed.hostname or "").lower()
    if host.endswith(".github.io"):
        username = host[: -len(".github.io")]
        parts = [part for part in parsed.path.split("/") if part]
        repo_name = parts[0] if parts else f"{username}.github.io"
        if username and repo_name:
            return f"git@github.com:{username}/{repo_name}.git"
    if host == "github.com":
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2:
            return f"git@github.com:{parts[0]}/{parts[1].removesuffix('.git')}.git"
    return ""


def parse_github_repo(repo_url: str) -> tuple[str, str] | None:
    value = (repo_url or "").strip()
    match = re.match(r"git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$", value)
    if not match:
        match = re.match(r"https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", value)
    if not match:
        return None
    return match.group(1), match.group(2)


def github_api_json(method: str, url: str, token: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "BlogManager",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request_obj = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request_obj, timeout=20) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {"message": raw or str(exc)}
        return exc.code, body
    except (URLError, TimeoutError, OSError) as exc:
        raise ApiError(f"无法连接 GitHub API：{exc}", 502) from exc


def ensure_github_repository(repo_url: str, token: str, private: bool) -> dict[str, Any]:
    if not token:
        raise ApiError("未提供 GitHub Personal Access Token，请手动创建仓库，或填写已有仓库地址。", 400)
    parsed = parse_github_repo(repo_url)
    if not parsed:
        raise ApiError("无法从仓库地址解析 GitHub 用户名和仓库名，请填写 SSH 或 HTTPS GitHub 地址。")
    owner, repo_name = parsed
    status, existing = github_api_json("GET", f"https://api.github.com/repos/{owner}/{repo_name}", token)
    if status == 200:
        return {"exists": True, "created": False, "owner": owner, "repo": repo_name, "url": repo_url}
    if status not in {404, 401, 403, 422}:
        raise ApiError(f"GitHub 仓库检查失败（HTTP {status}）：{existing.get('message', existing)}", 502)
    if status in {401, 403}:
        raise ApiError("GitHub Token 无效、已过期或权限不足，请检查 token 的 repo 权限。", 401)
    status, created = github_api_json(
        "POST",
        "https://api.github.com/user/repos",
        token,
        {"name": repo_name, "private": bool(private), "auto_init": False, "description": "Hexo blog generated by Blog Manager"},
    )
    if status == 201:
        return {"exists": False, "created": True, "owner": owner, "repo": repo_name, "url": repo_url}
    if status == 422 and "already exists" in str(created.get("message", "")).lower():
        return {"exists": True, "created": False, "owner": owner, "repo": repo_name, "url": repo_url}
    if status == 401:
        raise ApiError("GitHub Token 无效或已过期，请重新生成 Personal Access Token。", 401)
    if status == 403:
        raise ApiError("GitHub Token 权限不足，请确认 token 具有 repo 权限。", 403)
    raise ApiError(f"GitHub 仓库创建失败（HTTP {status}）：{created.get('message', created)}", 502)


def autodeploy_defaults() -> dict[str, Any]:
    settings = settings_store.get()
    defaults = {
        "title": "",
        "author": "",
        "url": "",
        "repo_url": "",
        "branch": "main",
        "theme_repo": DEFAULT_THEME_REPO,
        "copy_content": False,
        "auto_create_repo": True,
        "local_only": False,
        "repo_private": False,
        "save_token": False,
        "github_token_set": False,
    }
    saved = settings.get("autodeploy", {})
    if isinstance(saved, Mapping):
        defaults.update({key: value for key, value in saved.items() if key in defaults and key != "local_only"})
    github = settings.get("github", {})
    if isinstance(github, Mapping):
        defaults["save_token"] = bool(github.get("remember", False))
        defaults["github_token_set"] = bool(github.get("token", "") or "")
        if not defaults["repo_url"]:
            defaults["repo_url"] = str(github.get("repo_url", "") or "")
        if not str(defaults.get("branch", "") or "").strip():
            defaults["branch"] = str(github.get("branch", "") or "main")
    try:
        document = load_yaml_file(site_config_path(), allow_missing=True)
        defaults["title"] = str(document.get("title", "") or defaults["title"])
        defaults["author"] = str(document.get("author", "") or defaults["author"])
        defaults["url"] = str(document.get("url", "") or defaults["url"])
        deploy = document.get("deploy")
        if isinstance(deploy, Mapping):
            defaults["repo_url"] = str(deploy.get("repo", "") or defaults["repo_url"])
            defaults["branch"] = str(deploy.get("branch", "") or defaults["branch"])
    except Exception:
        pass
    if not defaults["repo_url"] and defaults["url"]:
        defaults["repo_url"] = infer_repo_url(str(defaults["url"]))
    return defaults


@app.post("/api/autodeploy/check-theme-network")
def api_check_theme_network() -> Response:
    payload = json_payload()
    candidates = theme_source_candidates(normalize_text(payload.get("theme_repo"), "主题源地址"))
    if candidates:
        with ThreadPoolExecutor(max_workers=min(5, len(candidates))) as pool:
            futures = {
                source["url"]: pool.submit(check_theme_source, source["url"], 2.5)
                for source in candidates
            }
        results = []
        for source in candidates:
            try:
                reachable = bool(futures[source["url"]].result())
            except Exception:
                reachable = False
            results.append({**source, "reachable": reachable})
    else:
        results = []
    selected_id = candidates[0]["id"] if candidates else ""
    selected_reachable = bool(results and results[0]["reachable"])
    any_reachable = any(item["reachable"] for item in results)
    return jsonify(
        {
            "reachable": selected_reachable,
            "any_reachable": any_reachable,
            "selected_id": selected_id,
            "selected_reachable": selected_reachable,
            "sources": results,
        }
    )


@app.post("/api/autodeploy/select-folder")
def api_autodeploy_select_folder() -> Response:
    selected = select_folder_dialog(blog_directory() or Path.home())
    if not selected:
        return jsonify({"cancelled": True})
    path = Path(selected).expanduser().resolve()
    return jsonify({"cancelled": False, "path": str(path), "inspect": inspect_target_folder(path)})


@app.get("/api/autodeploy/preflight")
def api_autodeploy_preflight() -> Response:
    node = tool_version("node")
    npm = tool_version("npm")
    git = tool_version("git")
    return jsonify(
        {
            "node": {"available": node[0], "version": node[1]},
            "npm": {"available": npm[0], "version": npm[1]},
            "git": {"available": git[0], "version": git[1]},
        }
    )


@app.get("/api/autodeploy/defaults")
def api_autodeploy_defaults() -> Response:
    return jsonify(autodeploy_defaults())

@app.get("/api/autodeploy/infer-repo")
def api_infer_repo() -> Response:
    site_url = normalize_text(request.args.get("url", ""), "站点 URL")
    return jsonify({"site_url": site_url, "repo_url": infer_repo_url(site_url)})


@app.post("/api/github/ensure-repo")
def api_ensure_github_repo() -> Response:
    payload = json_payload()
    repo_url = normalize_text(payload.get("repo_url"), "仓库地址")
    token = normalize_text(payload.get("token"), "GitHub Token")
    if not token:
        token = str(settings_store.get().get("github", {}).get("token", "") or "")
    private = bool(payload.get("private"))
    if not repo_url:
        raise ApiError("请先填写或自动推导 GitHub 仓库地址。")
    return jsonify(ensure_github_repository(repo_url, token, private))


def validate_autodeploy_payload(payload: dict[str, Any]) -> dict[str, Any]:
    target_text = normalize_text(payload.get("target_dir"), "目标文件夹")
    if not target_text:
        raise ApiError("请先选择目标文件夹。")
    target = Path(target_text).expanduser().resolve()
    inspect = inspect_target_folder(target)
    if not inspect["exists"]:
        raise ApiError(f"目标文件夹不存在：{target}", 404)
    if inspect["non_empty"] and not inspect["hexo"]:
        raise ApiError("该文件夹非空，请选择一个空文件夹或已有 Hexo 项目的文件夹。", 409)
    mode = "update" if inspect["hexo"] else "create"
    if mode == "update" and payload.get("confirm_update") is not True:
        raise ApiError("目标文件夹已有 Hexo 项目，需要确认更新。", 409, {"requires_confirmation": True})


    local_only = bool(payload.get("local_only"))
    repo_url = normalize_text(payload.get("repo_url"), "仓库地址")
    if local_only and not repo_url:
        repo_url = infer_repo_url(normalize_text(payload.get("url"), "站点 URL"))
    github_token = normalize_text(payload.get("github_token"), "GitHub Token")
    if not github_token:
        github_token = str(settings_store.get().get("github", {}).get("token", "") or "")
    branch = normalize_text(payload.get("branch"), "分支") or "main"
    theme_repo = normalize_text(payload.get("theme_repo"), "主题仓库") or "https://github.com/jerryc127/hexo-theme-butterfly.git"
    for value, label in ((repo_url, "仓库地址"), (theme_repo, "主题仓库")):
        if value and any(char in value for char in ('\n', '\r', '&', '|', '<', '>')):
            raise ApiError(f"{label}包含不安全字符。")
    if not local_only and not repo_url:
        raise ApiError("请填写 GitHub 仓库地址。")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch):
        raise ApiError("Git 分支名称格式不正确。")
    return {
        "target": target,
        "mode": mode,
        "title": normalize_text(payload.get("title"), "站点标题"),
        "author": normalize_text(payload.get("author"), "作者"),
        "url": normalize_text(payload.get("url"), "站点 URL"),
        "repo_url": repo_url,
        "branch": branch,
        "theme_repo": theme_repo,
        "copy_content": bool(payload.get("copy_content")),
        "auto_create_repo": bool(payload.get("auto_create_repo", True)),
        "local_only": local_only,
        "skip_theme": bool(payload.get("skip_theme")),
        "repo_private": bool(payload.get("repo_private")),
        "save_token": bool(payload.get("save_token")),
        "github_token": github_token,
        "overwrite_config": mode == "create" or bool(payload.get("overwrite_config")),
    }


def apply_autodeploy_config(target: Path, options: dict[str, Any], task: Task) -> None:
    if not options["overwrite_config"]:
        task.emit("保留目标项目现有配置（更新模式未勾选覆盖配置）。", "warning")
        return

    task.emit("正在应用当前博客配置...", "system")
    if options.get("local_only"):
        target_site = load_yaml_file(target / SITE_CONFIG_NAME, allow_missing=True)
        target_site["theme"] = "landscape" if options.get("skip_theme") else "butterfly"
        target_site.pop("deploy", None)
        write_yaml_file(target / SITE_CONFIG_NAME, target_site)
        if options.get("skip_theme"):
            task.emit("仅本地模式：跳过 Butterfly 主题配置。", "warning")
        else:
            try:
                effective_theme, _, _ = load_effective_theme_document()
                write_yaml_file(target / THEME_CONFIG_NAME, effective_theme)
                task.emit("仅本地模式：已复制 Butterfly 主题配置，并跳过 deploy。", "success")
            except ApiError as exc:
                task.emit(f"主题配置复制失败：{exc}；将保留主题默认配置。", "warning")
        return

    try:
        current_site = load_yaml_file(site_config_path())
    except ApiError:
        current_site = load_yaml_file(target / SITE_CONFIG_NAME, allow_missing=True)
    current_site["title"] = options["title"] or current_site.get("title", "")
    current_site["author"] = options["author"] or current_site.get("author", "")
    if options["url"]:
        current_site["url"] = options["url"]
    current_site["theme"] = "landscape" if options.get("skip_theme") else "butterfly"
    deploy = current_site.get("deploy")
    if not isinstance(deploy, Mapping):
        deploy = CommentedMap()
        current_site["deploy"] = deploy
    deploy["type"] = "git"
    deploy["repo"] = options["repo_url"]
    deploy["branch"] = options["branch"]
    write_yaml_file(target / SITE_CONFIG_NAME, current_site)

    try:
        effective_theme, _, _ = load_effective_theme_document()
        write_yaml_file(target / THEME_CONFIG_NAME, effective_theme)
        task.emit("已写入 _config.yml 和 _config.butterfly.yml。", "success")
    except ApiError as exc:
        task.emit(f"主题配置复制失败：{exc}；将保留主题默认配置。", "warning")


def remove_conflicting_mathjax_plugin(target: Path, task: Task) -> None:
    package_path = target / "package.json"
    if package_path.exists():
        try:
            package_data = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError) as exc:
            task.emit(f"读取 package.json 失败，无法自动清理 hexo-filter-mathjax：{exc}", "warning")
            package_data = None
        if isinstance(package_data, dict):
            removed = False
            for section in ("dependencies", "devDependencies"):
                dependencies = package_data.get(section)
                if isinstance(dependencies, dict) and "hexo-filter-mathjax" in dependencies:
                    dependencies.pop("hexo-filter-mathjax", None)
                    removed = True
            if removed:
                package_path.write_text(
                    json.dumps(package_data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                task.emit("已从 package.json 移除冲突插件 hexo-filter-mathjax。", "success")

    module_path = ensure_child_path(target / "node_modules", "hexo-filter-mathjax")
    if module_path.exists():
        try:
            shutil.rmtree(module_path)
        except OSError as exc:
            raise AutodeployError(f"无法移除冲突插件目录 hexo-filter-mathjax：{exc}") from exc
        task.emit("已移除 node_modules/hexo-filter-mathjax。", "success")


def merge_latex_inject(override: CommentedMap, base: CommentedMap) -> int:
    base_inject = base.get("inject") if isinstance(base.get("inject"), Mapping) else None
    inject = override.get("inject")
    if inject is None:
        inject = CommentedMap()
        _insert_mapping_key(override, "inject", inject, base)
    elif not isinstance(inject, CommentedMap):
        if not isinstance(inject, Mapping):
            raise AutodeployError("根目录 _config.butterfly.yml 中的 inject 不是映射，无法安全合并。")
        new_inject = _comment_map(plain_value(inject))
        _insert_mapping_key(override, "inject", new_inject, base)
        inject = new_inject

    base_head = base_inject.get("head") if isinstance(base_inject, Mapping) else None
    head = inject.get("head")
    if head is None:
        inherited_head = base_head if isinstance(base_head, (list, tuple)) else []
        head = CommentedSeq(copy.deepcopy(inherited_head))
        _insert_mapping_key(inject, "head", head, base_inject)
    elif not isinstance(head, CommentedSeq):
        if not isinstance(head, Sequence) or isinstance(head, (str, bytes, bytearray)):
            raise AutodeployError("根目录 _config.butterfly.yml 中的 inject.head 不是数组，无法安全合并。")
        new_head = CommentedSeq(head)
        _insert_mapping_key(inject, "head", new_head, base_inject)
        head = new_head

    script_config = LiteralScalarString(r"""<script>
MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true
  },
  svg: {
    fontCache: 'global'
  }
};
</script>""")
    script_url = SingleQuotedScalarString(
        '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>'
    )
    style = LiteralScalarString(r"""<style>
mjx-container[display="false"] {
  overflow: hidden !important;
}
</style>""")
    additions = (
        ("MathJax = {", script_config),
        ("mathjax@3/es5/tex-mml-chtml.js", script_url),
        ('mjx-container[display="false"]', style),
    )
    existing = "\n".join(str(item) for item in head)
    added = 0
    for marker, value in additions:
        if marker in existing:
            continue
        head.append(copy.deepcopy(value))
        existing += "\n" + str(value)
        added += 1
    return added


def configure_latex_rendering(target: Path, task: Task) -> None:
    task.emit("正在配置 Butterfly MathJax 与冲突插件清理...", "system")
    remove_conflicting_mathjax_plugin(target, task)

    base_path = target / "themes" / "butterfly" / "_config.yml"
    override_path = target / THEME_CONFIG_NAME
    base = load_yaml_file(base_path, allow_missing=True)
    override = load_yaml_file(override_path, allow_missing=True)
    changes = {
        "math.use": {"type": "text", "value": "mathjax"},
        "math.per_page": {"type": "boolean", "value": False},
        "math.hide_scrollbar": {"type": "boolean", "value": False},
        "math.mathjax.enableMenu": {"type": "boolean", "value": True},
        "math.mathjax.tags": {"type": "text", "value": "none"},
    }
    changed = apply_config_changes(override, changes, base, [])
    changed += merge_latex_inject(override, base)
    if changed:
        write_yaml_file(override_path, override)
    task.emit("已启用 Butterfly 内置 MathJax，并合并 inject.head 注入内容。", "success")
    task.emit(
        "MathJax 默认使用 jsDelivr CDN；若本地预览或线上公式未显示，请检查网络，"
        "更换 CDN 地址，或手动下载 MathJax 到本地 source/ 后修改注入脚本。",
        "warning",
    )


def theme_source_candidates(theme_repo: str) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    preferred = (theme_repo or "").strip()
    known_urls = {item["url"] for item in DEFAULT_THEME_SOURCES}
    if preferred and preferred not in known_urls:
        candidates.append({"id": "custom", "label": "自定义源", "url": preferred})
    candidates.extend(copy.deepcopy(DEFAULT_THEME_SOURCES))
    if preferred:
        candidates = [item for item in candidates if item["url"] == preferred] + [
            item for item in candidates if item["url"] != preferred
        ]
    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        if item["url"] not in seen:
            seen.add(item["url"])
            deduped.append(item)
    return deduped


def theme_dir_is_usable(theme_dir: Path) -> bool:
    if not theme_dir.is_dir():
        return False
    required = (
        theme_dir / "layout",
        theme_dir / "layout" / "index.pug",
        theme_dir / "_config.yml",
    )
    return all(item.is_dir() if item.suffix == "" else item.is_file() for item in required)


def check_theme_source(url: str, timeout: float = 5.0) -> bool:
    if not url:
        return False
    request_obj = Request(url, headers={"User-Agent": "BlogManager/1.0"}, method="GET")
    try:
        with urlopen(request_obj, timeout=timeout) as response:
            return response.status < 500
    except HTTPError as exc:
        return exc.code < 500
    except (URLError, TimeoutError, OSError, ValueError):
        return False


def clone_theme_with_fallback(task: Task, target: Path, theme_dir: Path, options: dict[str, Any]) -> dict[str, str]:
    candidates = theme_source_candidates(options.get("theme_repo", ""))
    if not candidates:
        raise AutodeployError("没有可用的 Butterfly 主题源地址。")

    preferred = candidates[0]
    task.emit(f"检查首选主题源：{preferred['label']}...", "system")
    if not check_theme_source(preferred["url"], timeout=3.0):
        task.emit(
            f"首选源预检不可达：{preferred['label']}。将按回退顺序尝试其他源。",
            "warning",
        )

    errors: list[str] = []
    for index, source in enumerate(candidates, start=1):
        task.emit(f"正在尝试源 {index}/{len(candidates)}：{source['label']}...", "system")
        if theme_dir.exists():
            shutil.rmtree(theme_dir, ignore_errors=True)
        code = run_task_command(
            task,
            command_executable("git", ["clone", "--depth", "1", "--", source["url"], str(theme_dir)]),
            target,
        )
        if code == 0 and theme_dir_is_usable(theme_dir):
            task.emit(f"已从源 {index} 成功克隆主题：{source['label']}", "success")
            return source
        if code == 0:
            errors.append(f"{source['label']}：克隆命令完成，但主题目录缺少 layout、layout/index.pug 或 _config.yml（{source['url']}）")
            task.emit("克隆命令完成，但主题目录缺少 layout、layout/index.pug 或 _config.yml。", "warning")
        else:
            errors.append(f"{source['label']}：克隆失败，退出码 {code}（{source['url']}）")
        if index < len(candidates):
            task.emit(f"源 {index} 失败，切换到源 {index + 1}：{candidates[index]['label']}...", "warning")
    details = "\n".join(errors)
    raise AutodeployError(
        "所有主题源均克隆失败。请检查网络连接，确认能访问 GitHub 或 Gitee；可配置 Git 代理："
        "git config --global http.proxy http://127.0.0.1:端口。也可以手动下载 Butterfly 主题，"
        f"解压到 {theme_dir} 后点击“重试当前步骤”。\n{details}"
    )


def autodeploy_step_definitions(options: dict[str, Any]) -> list[dict[str, str]]:
    steps = [
        {"id": "environment", "title": "检查 Node.js / Git / npm 环境"},
        {"id": "init", "title": "初始化 Hexo 项目"},
        {"id": "theme", "title": "克隆 Butterfly 主题"},
    ]
    if not options.get("local_only") and options.get("auto_create_repo"):
        steps.append({"id": "repo", "title": "创建或配置远程仓库"})
    steps.extend(
        [
            {"id": "config", "title": "应用站点配置"},
            {"id": "latex", "title": "配置 LaTeX 渲染"},
            {"id": "deps", "title": "安装依赖"},
            {"id": "deps-check", "title": "检查主题渲染依赖"},
            {"id": "welcome", "title": "添加欢迎文章"},
            {"id": "generate", "title": "生成静态文件"},
        ]
    )
    return steps


def welcome_post_path(target: Path) -> Path:
    posts_dir = target / "source" / "_posts"
    try:
        config = load_yaml_file(target / SITE_CONFIG_NAME, allow_missing=True)
        auto_category = config.get("auto_category")
        if isinstance(auto_category, Mapping) and bool(auto_category.get("enable")):
            depth = auto_category.get("depth", 1)
            try:
                depth_value = int(depth)
            except (TypeError, ValueError):
                depth_value = 1
            if depth_value != 0:
                return posts_dir / "公告" / "welcome.md"
    except ApiError:
        pass
    return posts_dir / "welcome.md"


def create_welcome_post(target: Path, task: Task) -> bool:
    posts_dir = target / "source" / "_posts"
    posts_dir.mkdir(parents=True, exist_ok=True)
    welcome_path = welcome_post_path(target)
    legacy_welcome = posts_dir / "welcome.md"
    if welcome_path.exists() or (welcome_path != legacy_welcome and legacy_welcome.exists()):
        task.emit(f"welcome.md 已存在，跳过：{welcome_path.relative_to(target).as_posix()}", "warning")
        return False
    welcome_path.parent.mkdir(parents=True, exist_ok=True)
    metadata = CommentedMap()
    metadata["title"] = "欢迎来到我的博客"
    metadata["date"] = datetime.now().strftime("%Y-%m-%d")
    metadata["tags"] = CommentedSeq(["欢迎"])
    metadata["categories"] = CommentedSeq(["公告"])
    yaml = new_round_trip_yaml()
    stream = io.StringIO()
    yaml.dump(metadata, stream)
    body = '''欢迎来到我的博客。这里将用于记录技术学习、项目实践和日常思考。

## 开始探索

你可以从文章分类、标签或归档开始浏览。

### Markdown 示例

这是一段包含 **加粗文字** 和 *斜体文字* 的示例。

- 无序列表项一
- 无序列表项二
- 无序列表项三

1. 有序列表项一
2. 有序列表项二
3. 有序列表项三

这是行内代码：`示例代码`。

```python
def hello(name):
    print(f"Hello, {name}!")

hello("Hexo")
```

行内公式：$E = mc^2$。

块级公式：

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

> 这是一段引用内容，用于测试引用样式。

更多信息请访问 [Hexo 官网](https://hexo.io/)。
'''
    welcome_path.write_text(f"---\n{stream.getvalue()}---\n\n{body}", encoding="utf-8", newline="\n")
    task.emit("已创建欢迎文章 welcome.md", "success")
    return True


def emit_generated_output_status(task: Task, target: Path) -> dict[str, Any]:
    output = inspect_generated_output(target)
    task.emit(f"生成的 HTML 文件数量：{output['html_count']}", "success" if output["html_count"] else "warning")
    if not output["public_exists"]:
        task.emit("未找到 public 目录，静态文件可能没有生成。", "warning")
    if output["pug_files"]:
        preview = "、".join(output["pug_files"][:5])
        suffix = " 等" if output["pug_count"] > 5 else ""
        task.emit(f"检测到 {output['pug_count']} 个 .pug 文件被输出：{preview}{suffix}", "error")
    else:
        task.emit("public 目录未发现 .pug 文件。", "success")

    missing_posts = output.get("missing_posts", [])
    if missing_posts:
        preview = "、".join(missing_posts[:8])
        suffix = " 等" if len(missing_posts) > 8 else ""
        task.emit(
            f"警告：{len(missing_posts)} 篇文章未找到对应 HTML 输出：{preview}{suffix}",
            "warning",
        )
        task.emit("新文章可能未被正确编译，请检查 front-matter 或文件名。", "warning")
    elif output.get("post_count", 0):
        task.emit(f"已确认 {output['post_count']} 篇文章存在对应的 HTML 输出。", "success")
    return output


def run_dependency_repair(task: Task, target: Path) -> None:
    try:
        task.emit("开始修复 Hexo Butterfly 渲染器依赖。", "system")
        task.emit("安装渲染器包并写入 package.json...", "system")
        code = run_task_command(
            task,
            command_executable("npm", ["install", *THEME_RENDERER_DEPENDENCIES, "--save"]),
            target,
        )
        if code != 0:
            status = inspect_theme_dependencies(target, expected_theme="butterfly", check_public=False)
            if not status["ok"]:
                raise AutodeployError("渲染器安装失败，请检查网络、npm registry 配置或 package.json。")
            task.emit("渲染器安装命令失败，但当前渲染器依赖完整，继续使用已安装版本。", "warning")
        else:
            task.emit("已安装渲染器：hexo-renderer-pug, hexo-renderer-stylus", "success")

        actual_theme = target_theme_name(target)
        expected_theme = "landscape" if actual_theme == "landscape" and (target / ".blogmanager-local-only").exists() else "butterfly"
        status = inspect_theme_dependencies(target, expected_theme=expected_theme, check_public=False)
        emit_dependency_status(task, status)
        if not status["ok"]:
            raise AutodeployError(
                "依赖不完整，缺少 hexo-renderer-pug 或 hexo-renderer-stylus，或主题未正确设置。"
                "请检查上面的检查结果后重试。"
            )

        task.emit("正在清理并重新生成静态文件...", "system")
        code = run_task_command(task, command_executable("npx", ["--yes", "hexo", "clean"]), target)
        if code != 0:
            raise AutodeployError("hexo clean 失败，请查看上方日志。")
        code = run_task_command(task, command_executable("npx", ["--yes", "hexo", "generate"]), target)
        if code != 0:
            raise AutodeployError("hexo generate 失败，请查看上方日志。")
        output = emit_generated_output_status(task, target)
        if output["pug_count"]:
            raise AutodeployError("检测到 Pug 模板未被渲染，可能缺少 hexo-renderer-pug。请检查依赖安装。")
        task.emit("渲染器依赖修复完成，静态文件已重新生成。", "success")
        task.finish("success", 0)
    except (AutodeployError, ApiError) as exc:
        message = str(exc)
        task.error_message = message
        task.emit(message, "error")
        task.finish("failed", -1)
    except Exception as exc:
        message = str(exc)
        task.error_message = message
        task.emit(f"依赖修复异常：{message}", "error")
        task.finish("failed", -1)


def run_autodeploy(task: Task, options: dict[str, Any]) -> None:
    target: Path = options["target"]
    current_step: str | None = None
    try:
        task.emit("开始自动部署 Hexo + Butterfly。", "system")
        task.emit(f"目标目录：{target}", "muted")

        step_defs = autodeploy_step_definitions(options)
        step_ids = [step["id"] for step in step_defs]
        requested_resume = str(options.get("resume_from") or "").strip()
        start_index = step_ids.index(requested_resume) if requested_resume in step_ids else 0
        if start_index > 0:
            for skipped_step in step_defs[:start_index]:
                task.emit_step(skipped_step["id"], "success", "重试时跳过已完成步骤")
            task.emit(f"从步骤“{step_defs[start_index]['title']}”开始重试，之前步骤不会重复执行。", "system")

        def step_enabled(step_id: str) -> bool:
            return step_ids.index(step_id) >= start_index

        if step_enabled("environment"):
            current_step = "environment"
            task.emit_step(current_step, "running")
            task.emit("检查 Node.js、npm 和 Git 环境...", "system")
            checks = {name: tool_version(name) for name in ("node", "npm", "git")}
            missing = [name for name, info in checks.items() if not info[0]]
            for name, info in checks.items():
                task.emit(f"{name}: {info[1] or '未找到'}", "muted")
            if missing:
                raise AutodeployError(
                    f"缺少必要工具：{'、'.join(missing)}。请安装 Node.js（https://nodejs.org/zh-cn/download）和 Git（https://git-scm.com/download/win），并加入 PATH。"
                )
            task.emit_step(current_step, "success")

        if step_enabled("init"):
            current_step = "init"
            task.emit_step(current_step, "running")
            if options["mode"] == "create":
                code = run_task_command(task, command_executable("npx", ["--yes", "hexo-cli", "init", "."]), target)
                if code != 0:
                    raise AutodeployError("hexo init 失败，请检查网络和 npm registry 配置。")
                task.emit_step(current_step, "success")
            else:
                task.emit("检测到已有 Hexo 项目，跳过初始化。", "warning")
                task.emit_step(current_step, "success", "已有 Hexo 项目，跳过初始化")

        if step_enabled("theme"):
            current_step = "theme"
            task.emit_step(current_step, "running")
            theme_dir = target / "themes" / "butterfly"
            theme_dir.parent.mkdir(parents=True, exist_ok=True)
            if options.get("skip_theme"):
                task.emit("已选择跳过主题克隆，使用 Hexo 默认 landscape 主题。", "warning")
                task.emit_step(current_step, "success", "已跳过，使用 landscape 主题")
            elif theme_dir_is_usable(theme_dir):
                task.emit("themes/butterfly 已存在且内容完整，跳过主题克隆。", "warning")
                task.emit_step(current_step, "success", "主题目录已存在，已跳过")
            else:
                source = clone_theme_with_fallback(task, target, theme_dir, options)
                task.emit_step(current_step, "success", f"已从 {source['label']} 克隆")

        if not options.get("local_only") and options.get("auto_create_repo") and step_enabled("repo"):
            current_step = "repo"
            task.emit_step(current_step, "running")
            token = options.get("github_token", "")
            if token:
                repo_result = ensure_github_repository(options["repo_url"], token, options["repo_private"])
                if repo_result.get("created"):
                    task.emit(f"远程仓库已创建：{repo_result['owner']}/{repo_result['repo']}", "success")
                    task.emit_step(current_step, "success", "远程仓库已创建")
                else:
                    task.emit("远程仓库已存在，直接使用。", "success")
                    task.emit_step(current_step, "success", "仓库已存在，直接使用")
            elif options["repo_url"]:
                task.emit("未提供 GitHub Token，跳过自动创建并使用已有仓库地址。", "warning")
                task.emit_step(current_step, "success", "未提供 Token，跳过创建")
            else:
                raise AutodeployError("未提供 GitHub Token 且没有仓库地址。")

        if step_enabled("config"):
            current_step = "config"
            task.emit_step(current_step, "running")
            apply_autodeploy_config(target, options, task)
            task.emit_step(current_step, "success")

        if step_enabled("latex"):
            current_step = "latex"
            task.emit_step(current_step, "running")
            if options.get("skip_theme"):
                task.emit("使用 landscape 主题，跳过 Butterfly MathJax 配置。", "warning")
                task.emit_step(current_step, "success", "已跳过 Butterfly 主题")
            else:
                configure_latex_rendering(target, task)
                task.emit_step(current_step, "success", "MathJax 配置已写入根目录 _config.butterfly.yml")

        if step_enabled("deps"):
            current_step = "deps"
            task.emit_step(current_step, "running")
            task.emit("安装项目依赖：npm install", "system")
            code = run_task_command(task, command_executable("npm", ["install"]), target)
            if code != 0:
                raise AutodeployError("npm install 失败，请检查网络、Node.js 版本或 package.json。")
            task.emit("安装 Butterfly 渲染器：npm install hexo-renderer-pug hexo-renderer-stylus --save", "system")
            code = run_task_command(
                task,
                command_executable("npm", ["install", *THEME_RENDERER_DEPENDENCIES, "--save"]),
                target,
            )
            if code != 0:
                expected_theme = "landscape" if options.get("skip_theme") else "butterfly"
                status = inspect_theme_dependencies(target, expected_theme=expected_theme, check_public=False)
                if not status["ok"]:
                    raise AutodeployError("渲染器安装失败，请检查网络、npm registry 配置或 package.json。")
                task.emit("渲染器安装命令失败，但当前渲染器依赖完整，继续使用已安装版本。", "warning")
            else:
                task.emit("已安装渲染器：hexo-renderer-pug, hexo-renderer-stylus", "success")
            if not options.get("skip_theme"):
                remove_conflicting_mathjax_plugin(target, task)
            task.emit_step(current_step, "success", "项目依赖和 Butterfly 渲染器已安装")

        if step_enabled("deps-check"):
            current_step = "deps-check"
            task.emit_step(current_step, "running")
            expected_theme = "landscape" if options.get("skip_theme") else "butterfly"
            status = inspect_theme_dependencies(target, expected_theme=expected_theme, check_public=False)
            emit_dependency_status(task, status)
            if not status["ok"]:
                raise AutodeployError(
                    "依赖不完整，缺少 hexo-renderer-pug 或 hexo-renderer-stylus，或主题未正确设置。"
                    "请点击“修复依赖”重新安装。"
                )
            task.emit_step(current_step, "success", "渲染器依赖和主题配置检查通过")

        if step_enabled("welcome"):
            current_step = "welcome"
            task.emit_step(current_step, "running")
            if options.get("copy_content"):
                task.emit("已选择复制现有文章和图片，跳过欢迎文章。", "warning")
                task.emit_step(current_step, "success", "已复制现有内容，跳过")
            else:
                created = create_welcome_post(target, task)
                task.emit_step(current_step, "success", "已创建 welcome.md" if created else "welcome.md 已存在，跳过")

        if step_enabled("generate"):
            current_step = "generate"
            task.emit_step(current_step, "running")
            task.emit("先清理旧静态文件：hexo clean", "system")
            code = run_task_command(task, command_executable("npx", ["--yes", "hexo", "clean"]), target)
            if code != 0:
                raise AutodeployError("hexo clean 失败，请查看上方日志中的插件或配置错误。")
            code = run_task_command(task, command_executable("npx", ["--yes", "hexo", "generate"]), target)
            if code != 0:
                raise AutodeployError("hexo generate 失败，请查看上方日志中的插件或配置错误。")
            output = emit_generated_output_status(task, target)
            if output["pug_count"]:
                raise AutodeployError("检测到 Pug 模板未被渲染，可能缺少 hexo-renderer-pug。请检查依赖安装。")
            task.emit_step(current_step, "success", f"已生成 {output['html_count']} 个 HTML 文件")

        marker = target / ".blogmanager-local-only"
        if options.get("local_only"):
            marker.write_text("local-only", encoding="utf-8")
            task.emit("自动部署完成。仅本地模式已启用，可执行本地预览。", "success")
        else:
            marker.unlink(missing_ok=True)
            task.emit("自动部署完成。已切换到新博客目录，可执行一键部署。", "success")
        settings_store.set_blog_dir(str(target))
        settings_store.mark_onboarding_complete()
        task.finish("success", 0)
    except (AutodeployError, ApiError) as exc:
        message = str(exc)
        task.failed_step = current_step
        task.error_message = message
        if task.stop_requested:
            if current_step:
                task.emit_step(current_step, "failed", "用户取消部署")
            task.emit("自动部署已取消。", "warning")
            task.finish("stopped", None)
            return
        if current_step:
            task.emit_step(current_step, "failed", message)
        task.emit(message, "error")
        task.emit("解决建议：检查网络连接、Node.js/Git 环境和仓库权限；网络不稳定时可在自动部署弹窗更换主题源，或配置 Git 代理后重试。", "warning")
        task.finish("failed", -1)
    except Exception as exc:
        message = str(exc)
        task.failed_step = current_step
        task.error_message = message
        if task.stop_requested:
            if current_step:
                task.emit_step(current_step, "failed", "用户取消部署")
            task.emit("自动部署已取消。", "warning")
            task.finish("stopped", None)
            return
        if current_step:
            task.emit_step(current_step, "failed", message)
        task.emit(f"自动部署异常：{message}", "error")
        task.finish("failed", -1)


@app.post("/api/autodeploy")
def api_autodeploy() -> Response:
    payload = json_payload()
    options = validate_autodeploy_payload(payload)
    saved = {
        "title": options["title"],
        "author": options["author"],
        "url": options["url"],
        "repo_url": options["repo_url"],
        "branch": options["branch"],
        "theme_repo": options["theme_repo"],
        "copy_content": options["copy_content"],
        "auto_create_repo": options["auto_create_repo"],
        "repo_private": options["repo_private"],
        "save_token": options["save_token"],
    }
    settings_store.set_section("autodeploy", saved)
    github_updates: dict[str, Any] = {
        "repo_url": options["repo_url"],
        "branch": options["branch"],
    }
    if options["save_token"] and options["github_token"]:
        github_updates["token"] = options["github_token"]
        github_updates["remember"] = True
    elif options["save_token"]:
        github_updates["remember"] = True
    settings_store.update_github(github_updates)
    if options["auto_create_repo"] and options["github_token"] and not options["local_only"]:
        ensure_github_repository(options["repo_url"], options["github_token"], options["repo_private"])
    task = task_manager.create("autodeploy", "自动部署 Hexo + Butterfly", options["target"])
    task.local_only = bool(options.get("local_only"))
    task.options = copy.deepcopy(options)
    task.set_steps(autodeploy_step_definitions(options))
    threading.Thread(target=run_autodeploy, args=(task, options), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202

def port_owner_pids(port: int) -> list[int]:
    if not port:
        return []
    pids: set[int] = set()
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=NO_WINDOW,
            check=False,
        )
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING":
                if parts[1].rsplit(":", 1)[-1] == str(port):
                    try:
                        pids.add(int(parts[4]))
                    except ValueError:
                        pass
    else:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        for line in result.stdout.splitlines():
            try:
                pids.add(int(line.strip()))
            except ValueError:
                pass
    return sorted(pids)


def terminate_port_processes(port: int) -> list[int]:
    failed: list[int] = []
    for pid in port_owner_pids(port):
        if not terminate_pid_tree(pid):
            failed.append(pid)
    return failed


def terminate_pid_tree(pid: int) -> bool:
    if not pid:
        return True
    if os.name == "nt":
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=NO_WINDOW,
            check=False,
        )
        if result.returncode == 0:
            return True
        fallback = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", f"Stop-Process -Id {int(pid)} -Force -ErrorAction SilentlyContinue"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=NO_WINDOW,
            check=False,
        )
        return fallback.returncode == 0
    try:
        os.kill(pid, signal.SIGTERM)
        return True
    except ProcessLookupError:
        return True
    except OSError:
        return False


def cleanup_runtime() -> dict[str, Any]:
    global SHUTTING_DOWN
    with BROWSER_LOCK:
        if SHUTTING_DOWN:
            return {"ok": True, "already_cleaning": True}
        SHUTTING_DOWN = True
        browser_pids = list(BROWSER_PIDS)
    task_manager.stop_all()
    stopped_tasks: list[str] = []
    with task_manager.lock:
        tasks = list(task_manager.tasks.values())
    for task in tasks:
        if task.status == "running":
            wait_for_task_stopped(task, timeout=4)
        stopped_tasks.append(task.id)
    failed_browsers = [pid for pid in browser_pids if not terminate_pid_tree(pid)]
    report = {
        "ok": not failed_browsers,
        "tasks": stopped_tasks,
        "browsers": browser_pids,
        "failed_browsers": failed_browsers,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
    }
    try:
        SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
        CLEANUP_REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return report


@app.post("/api/client/ping")
def api_client_ping() -> Response:
    with CLIENT_LOCK:
        CLIENT_STATE["last_seen"] = time.time()
        CLIENT_STATE["active"] = True
        CLIENT_STATE["goodbye_at"] = 0.0
        CLIENT_STATE["generation"] = int(CLIENT_STATE.get("generation", 0)) + 1
    return jsonify({"ok": True})


@app.post("/api/client/goodbye")
def api_client_goodbye() -> Response:
    with CLIENT_LOCK:
        CLIENT_STATE["goodbye_at"] = time.time()
        CLIENT_STATE["generation"] = int(CLIENT_STATE.get("generation", 0)) + 1
        generation = CLIENT_STATE["generation"]

    def delayed_cleanup() -> None:
        time.sleep(5.0)
        with CLIENT_LOCK:
            should_exit = (
                CLIENT_STATE.get("active")
                and CLIENT_STATE.get("generation") == generation
                and float(CLIENT_STATE.get("goodbye_at", 0)) > 0
            )
            if should_exit:
                CLIENT_STATE["goodbye_at"] = 0.0
        if should_exit:
            cleanup_runtime()
            time.sleep(0.3)
            os._exit(0)

    threading.Thread(target=delayed_cleanup, daemon=True).start()
    return jsonify({"ok": True})


def run_clone_blog(task: Task, target: Path, repo_url: str, branch: str) -> None:
    try:
        task.emit("开始克隆远程博客。", "system")
        task.emit(f"仓库：{repo_url}", "muted")
        task.emit(f"目标：{target}", "muted")
        clone_args = ["clone"]
        if branch:
            clone_args.extend(["--branch", branch])
        clone_args.extend([repo_url, str(target)])
        code = run_task_command(task, command_executable("git", clone_args), target.parent)
        if code != 0:
            raise AutodeployError("Git 克隆失败，请检查仓库地址、分支、网络和访问权限。")
        if not (target / "_config.yml").exists():
            task.emit("警告：仓库根目录没有 _config.yml，可能不是 Hexo 博客。", "warning")
        task.emit("正在安装项目依赖...", "system")
        code = run_task_command(task, command_executable("npm", ["install"]), target)
        if code != 0:
            raise AutodeployError("npm install 失败，请检查 Node.js 版本和 package.json。")
        settings_store.set_blog_dir(str(target))
        settings_store.mark_onboarding_complete()
        task.emit("远程博客克隆完成，已切换到该目录。", "success")
        task.finish("success", 0)
    except (AutodeployError, ApiError) as exc:
        task.emit(str(exc), "error")
        task.finish("failed", -1)
    except Exception as exc:
        task.emit(f"克隆异常：{exc}", "error")
        task.finish("failed", -1)


@app.post("/api/blog/clone")
def api_clone_blog() -> Response:
    payload = json_payload()
    target = Path(normalize_text(payload.get("target_dir"), "目标文件夹")).expanduser().resolve()
    repo_url = normalize_text(payload.get("repo_url"), "仓库地址")
    branch = normalize_text(payload.get("branch"), "分支")
    if not repo_url or any(char in repo_url for char in ('\n', '\r', '&', '|', '<', '>')):
        raise ApiError("请填写有效的 Git 仓库地址。")
    inspect = inspect_target_folder(target)
    if inspect["exists"] and not inspect["empty"]:
        raise ApiError("克隆目标文件夹必须为空或不存在。", 409)
    preflight = api_autodeploy_preflight().get_json()
    missing = [name for name, info in preflight.items() if not info.get("available")]
    if missing:
        raise ApiError(f"缺少必要工具：{'、'.join(missing)}。", 412, {"missing": missing, "preflight": preflight})
    target.parent.mkdir(parents=True, exist_ok=True)
    task = task_manager.create("clone", f"git clone {repo_url}", target)
    threading.Thread(target=run_clone_blog, args=(task, target, repo_url, branch), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/autodeploy/<task_id>/retry")
def api_retry_autodeploy(task_id: str) -> Response:
    previous = task_manager.get(task_id)
    previous_options = getattr(previous, "options", None)
    if not isinstance(previous_options, Mapping) or not previous_options:
        raise ApiError("找不到该自动部署任务的可重试参数。", 404)
    options = copy.deepcopy(dict(previous_options))
    payload = request.get_json(silent=True) or {}
    if isinstance(payload.get("theme_repo"), str) and payload["theme_repo"].strip():
        options["theme_repo"] = payload["theme_repo"].strip()
    if "skip_theme" in payload:
        options["skip_theme"] = bool(payload["skip_theme"])
    failed_step = payload.get("resume_from") or getattr(previous, "failed_step", None)
    if failed_step in {step["id"] for step in autodeploy_step_definitions(options)}:
        options["resume_from"] = failed_step
    else:
        options.pop("resume_from", None)
    saved_autodeploy = settings_store.get().get("autodeploy", {})
    if isinstance(saved_autodeploy, Mapping):
        saved_autodeploy = dict(saved_autodeploy)
        saved_autodeploy["theme_repo"] = options["theme_repo"]
        settings_store.set_section("autodeploy", saved_autodeploy)
    task = task_manager.create("autodeploy", "自动部署 Hexo + Butterfly（重试）", options["target"])
    task.local_only = bool(options.get("local_only"))
    task.options = copy.deepcopy(options)
    task.set_steps(autodeploy_step_definitions(options))
    threading.Thread(target=run_autodeploy, args=(task, options), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/autodeploy/<task_id>/repair-dependencies")
def api_repair_autodeploy_dependencies(task_id: str) -> Response:
    previous = task_manager.get(task_id)
    previous_options = getattr(previous, "options", None)
    if not isinstance(previous_options, Mapping) or not previous_options:
        raise ApiError("找不到该自动部署任务的可修复参数。", 404)
    options = copy.deepcopy(dict(previous_options))
    options["resume_from"] = "deps"
    task = task_manager.create("autodeploy", "自动部署 Hexo + Butterfly（修复依赖）", options["target"])
    task.local_only = bool(options.get("local_only"))
    task.options = copy.deepcopy(options)
    task.set_steps(autodeploy_step_definitions(options))
    threading.Thread(target=run_autodeploy, args=(task, options), daemon=True).start()
    return jsonify({"task": task.snapshot()}), 202


@app.post("/api/autodeploy/<task_id>/open-theme-dir")
def api_open_autodeploy_theme_dir(task_id: str) -> Response:
    task = task_manager.get(task_id)
    options = getattr(task, "options", {})
    target_text = str(options.get("target", "")).strip()
    if not target_text:
        raise ApiError("找不到该任务的目标博客目录。", 404)
    target = Path(target_text).expanduser()
    if not target.exists():
        raise ApiError("目标博客目录不存在。", 404)
    theme_dir = target / "themes"
    theme_dir.mkdir(parents=True, exist_ok=True)
    open_with_default_app(theme_dir)
    return jsonify({"ok": True, "path": str(theme_dir)})


@app.post("/api/app/exit")
def api_exit_app() -> Response:
    def delayed_exit() -> None:
        time.sleep(0.15)
        cleanup_runtime()
        time.sleep(0.35)
        os._exit(0)

    threading.Thread(target=delayed_exit, daemon=True).start()
    return jsonify({"ok": True, "message": "正在清理相关进程..."})


@app.errorhandler(ApiError)
def handle_api_error(error: ApiError) -> tuple[Response, int]:
    return jsonify({"error": str(error), "details": error.details}), error.status_code


@app.errorhandler(Exception)
def handle_unexpected_error(error: Exception) -> tuple[Response, int]:
    if isinstance(error, ApiError):
        return jsonify({"error": str(error), "details": error.details}), error.status_code
    if isinstance(error, HTTPException):
        return jsonify({"error": error.description, "details": None}), error.code or 500
    LOGGER.exception("Unhandled request error")
    return jsonify({"error": f"服务器内部错误：{error}", "details": None}), 500


def select_folder_dialog(initial_dir: Path) -> str:
    python_exe = Path(sys.executable)
    if python_exe.name.lower() == "pythonw.exe":
        console_python = python_exe.with_name("python.exe")
        if console_python.exists():
            python_exe = console_python
    try:
        completed = subprocess.run(
            [str(python_exe), str(APP_ROOT / "app.py"), "--pick-folder", str(initial_dir)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=NO_WINDOW,
            check=False,
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines:
            return ""
        payload = json.loads(lines[-1])
        if payload.get("error"):
            raise RuntimeError(payload["error"])
        return str(payload.get("path", "") or "")
    except Exception:
        return pick_folder_dialog(initial_dir)


def pick_folder_dialog(initial_dir: Path) -> str:
    try:
        return pick_folder_with_tk(initial_dir)
    except Exception:
        return pick_folder_with_powershell(initial_dir)


def pick_folder_with_tk(initial_dir: Path) -> str:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    root.update()
    selected = filedialog.askdirectory(
        title="选择 Hexo 博客文件夹",
        initialdir=str(initial_dir if initial_dir.exists() else Path.home()),
        mustexist=True,
    )
    root.destroy()
    return str(Path(selected).resolve()) if selected else ""


def pick_folder_with_powershell(initial_dir: Path) -> str:
    if os.name != "nt":
        return ""
    initial = str(initial_dir if initial_dir.exists() else Path.home()).replace("'", "''")
    script = f"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Hexo 博客文件夹'
$dialog.ShowNewFolderButton = $false
$dialog.SelectedPath = '{initial}'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.SelectedPath
}}
"""
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=NO_WINDOW,
            check=False,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def picker_subprocess_main(initial_dir: str) -> int:
    try:
        selected = pick_folder_dialog(Path(initial_dir) if initial_dir else Path.home())
        print(json.dumps({"path": selected}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
    return 0

def find_free_port(preferred: int = 5000) -> int:
    for port in [*range(preferred, min(preferred + 20, 65536)), 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return int(sock.getsockname()[1])
            except OSError:
                continue
    raise RuntimeError("无法找到可用端口。")


def find_browser() -> Path | None:
    candidates: list[Path] = []
    if os.name == "nt":
        for env_name in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env_name)
            if not base:
                continue
            candidates.extend(
                [
                    Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                    Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe",
                ]
            )
    for command_name in ("msedge", "microsoft-edge", "google-chrome", "chrome"):
        found = shutil.which(command_name)
        if found:
            candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def open_app_window_when_ready(url: str, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    health_url = f"{url.rstrip('/')}/api/status"
    while time.time() < deadline:
        try:
            with urlopen(health_url, timeout=0.8) as response:
                if response.status < 500:
                    break
        except (URLError, TimeoutError, OSError, ValueError):
            time.sleep(0.25)
    open_app_window(url)


def open_app_window(url: str) -> None:
    browser = find_browser()
    if browser:
        try:
            process = subprocess.Popen(
                [str(browser), f"--app={url}", f"--user-data-dir={BROWSER_PROFILE_DIR}", "--window-size=1420,920"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            with BROWSER_LOCK:
                BROWSER_PIDS.append(process.pid)
            LOGGER.info("browser app window opened | pid=%s | url=%s | browser=%s", process.pid, url, browser)
            return
        except OSError:
            pass
    webbrowser.open_new_tab(url)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地 Hexo 博客控制面板")
    parser.add_argument("--port", type=int, default=int(os.environ.get("BLOG_MANAGER_PORT", "5000")))
    parser.add_argument(
        "--no-browser",
        action="store_true",
        default=os.environ.get("BLOG_MANAGER_NO_BROWSER") == "1",
        help="启动服务器时不打开应用窗口",
    )
    parser.add_argument("--pick-folder", nargs="?", const="", help=argparse.SUPPRESS)
    return parser.parse_args()


def start_client_watchdog() -> None:
    time.sleep(35)
    while True:
        with CLIENT_LOCK:
            active = bool(CLIENT_STATE["active"])
            last_seen = float(CLIENT_STATE["last_seen"])
        if active and time.time() - last_seen > 30:
            cleanup_runtime()
            time.sleep(0.3)
            os._exit(0)
        time.sleep(4)


def main() -> int:
    args = parse_args()
    if args.pick_folder is not None:
        return picker_subprocess_main(args.pick_folder)
    port = find_free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    LOGGER.info("Blog Manager starting | port=%s | browser=%s", port, not args.no_browser)
    if not args.no_browser:
        threading.Thread(target=open_app_window_when_ready, args=(url,), daemon=True).start()
        threading.Thread(target=start_client_watchdog, daemon=True).start()
    try:
        app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False, debug=False)
    except KeyboardInterrupt:
        LOGGER.info("Blog Manager interrupted by user")
    finally:
        task_manager.stop_all()
        LOGGER.info("Blog Manager stopped | port=%s", port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())





























































