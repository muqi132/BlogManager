from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "dist"
OUTPUT_NAME = "BlogManager-release.zip"
ROOT_FILES = ("app.py", "start.bat", "requirements.txt", "README.md", ".gitignore", "build_release.py")
INCLUDE_DIRS = ("templates", "static")
EXCLUDED_DIR_NAMES = {".git", ".venv", ".deps", ".userdata", "__pycache__", "node_modules", "dist"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".log", ".bak", ".tmp"}
EXCLUDED_FILE_NAMES = {"config.json", "settings.json"}


def iter_release_files():
    for name in ROOT_FILES:
        path = ROOT / name
        if path.is_file():
            yield path, path.relative_to(ROOT)
    for directory in INCLUDE_DIRS:
        base = ROOT / directory
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            parts = set(path.relative_to(ROOT).parts[:-1])
            if parts & EXCLUDED_DIR_NAMES:
                continue
            if path.name in EXCLUDED_FILE_NAMES or path.suffix.lower() in EXCLUDED_SUFFIXES:
                continue
            yield path, path.relative_to(ROOT)


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    archive = OUTPUT_DIR / OUTPUT_NAME
    files = sorted(iter_release_files(), key=lambda item: item[1].as_posix())
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for source, relative in files:
            bundle.write(source, Path("BlogManager") / relative)
    print(f"已生成：{archive}")
    print(f"已打包 {len(files)} 个文件；未包含 .venv、用户配置、日志和测试目录。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
