#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描指定目录，生成静态文件清单 JSON，供 auto-docs.js 作「秒开 + 兜底」数据源。

用法：
    python tools/generate_docs_manifest.py                 # 用默认配置
    python tools/generate_docs_manifest.py --root .        # 指定站点根目录
    python tools/generate_docs_manifest.py --check         # 只检查是否需更新（CI 用，退出码 2 表示有变化）

输出：ie-conference/data/docs.json
    {
      "generated": "2026-09-02T01:40:00+08:00",
      "dirs": {
        "ie-conference/教学科研竞赛委员会": [ {name, path, size, date, type}, ... ],
        "ie-conference/政论": [...]
      }
    }

说明：
    - path 为「仓库根相对路径」，auto-docs.js 会按页面位置换算成相对链接
    - date 取 Git 中该文件的最后提交时间；取不到则回落到文件 mtime
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

ACCEPT_EXT = {".pdf", ".html", ".htm"}
CST = timezone(timedelta(hours=8))

# (站点根相对目录, 清单里的分组名) —— 新增栏目就在这里加一行
SECTIONS = [
    ("ie-conference/教学科研竞赛委员会", "教学科研竞赛委员会"),
    ("ie-conference/政论", "政论"),
]

OUT_REL = os.path.join("ie-conference", "data", "docs.json")
# 人工覆盖表（可选）。键 = 文件名，值可含 title / date / hidden。
# 用途：保留原有条目的正式标题与落款日期；hidden:true 可临时隐藏某个文件。
OVERRIDES_REL = os.path.join("ie-conference", "data", "overrides.json")


def git_date(root: str, rel_path: str):
    """取文件在 Git 中的最后提交时间（ISO 字符串），失败返回 None"""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cI", "--", rel_path],
            cwd=root, capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return None


def mtime_date(abs_path: str):
    try:
        ts = os.path.getmtime(abs_path)
        return datetime.fromtimestamp(ts, CST).isoformat()
    except Exception:
        return None


def load_overrides(root: str):
    path = os.path.join(root, OVERRIDES_REL)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        # 以 _ 开头的键视为注释
        return {k: v for k, v in data.items() if not str(k).startswith("_")}
    except Exception as e:
        print("[manifest] 覆盖表读取失败，已忽略：{}".format(e))
        return {}


def scan(root: str, rel_dir: str, overrides=None):
    overrides = overrides or {}
    abs_dir = os.path.join(root, rel_dir)
    if not os.path.isdir(abs_dir):
        return []
    items = []
    for name in os.listdir(abs_dir):
        full = os.path.join(abs_dir, name)
        if not os.path.isfile(full) or name.startswith("."):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in ACCEPT_EXT:
            continue
        rel_path = (rel_dir + "/" + name).replace("\\", "/")
        ov = overrides.get(name) or {}
        if ov.get("hidden"):
            continue
        try:
            size = os.path.getsize(full)
        except Exception:
            size = None
        items.append({
            "name": name,
            "path": rel_path,
            "size": size,
            "date": ov.get("date") or git_date(root, rel_path) or mtime_date(full) or "",
            "title": ov.get("title") or os.path.splitext(name)[0],
            "type": ext.lstrip("."),
        })
    # 日期倒序 → 同日期按名称
    items.sort(key=lambda x: (x["date"] or "", x["name"]), reverse=True)
    return items


def main():
    ap = argparse.ArgumentParser(description="生成文档目录静态清单")
    ap.add_argument("--root", default=None, help="站点根目录（默认：本脚本所在目录的上上级）")
    ap.add_argument("--check", action="store_true", help="只检查清单是否最新，有变化则退出码 2")
    args = ap.parse_args()

    root = os.path.abspath(args.root) if args.root else \
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    overrides = load_overrides(root)
    if overrides:
        print("[manifest] 已加载 {} 条覆盖规则".format(len(overrides)))

    dirs = {}
    for rel_dir, label in SECTIONS:
        items = scan(root, rel_dir, overrides)
        dirs[label] = items
        print("[manifest] {}: {} 个文件".format(rel_dir, len(items)))

    payload = {
        "generated": datetime.now(CST).isoformat(timespec="seconds"),
        "dirs": dirs,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

    out_path = os.path.join(root, OUT_REL)

    if args.check:
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            print("[manifest] 清单缺失或不可读，需要生成")
            sys.exit(2)
        if old.get("dirs") == payload["dirs"]:
            print("[manifest] 清单已是最新")
            sys.exit(0)
        print("[manifest] 清单需要更新")
        sys.exit(2)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("[manifest] 已写入 {}".format(out_path))


if __name__ == "__main__":
    main()
