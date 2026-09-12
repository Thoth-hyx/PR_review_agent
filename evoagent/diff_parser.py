# 不依赖LLM的diff解析器，主要用于解析git diff输出

import re
from dataclasses import dataclass
from typing import List

from .models import ChangedLine


@dataclass
class ParsedDiff:
    files: List[str]
    added_lines: List[ChangedLine]


HUNK = re.compile(r"^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def parse_unified_diff(diff: str) -> ParsedDiff:
    files: List[str] = []
    added: List[ChangedLine] = []
    current_path = ""                # 当前正在处理的文件
    new_line = 0                     # 当前处于新文件的第几行
    in_hunk = False                  # 是否处于 @@hunk@@ 中

    for raw in diff.splitlines():
        # 匹配 diff 文件头
        if raw.startswith("+++ "):
            current_path = raw[4:].strip()
            if current_path.startswith("b/"):
                current_path = current_path[2:]
            if current_path != "/dev/null" and current_path not in files:
                files.append(current_path)
            in_hunk = False
            continue
        # 匹配 @@hunk@@ 标记
        match = HUNK.match(raw)
        if match:
            new_line = int(match.group(1))
            in_hunk = True
            continue
        if not in_hunk:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            added.append(ChangedLine(current_path or "unknown", new_line, raw[1:]))
            new_line += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        elif raw.startswith("\\ No newline"):
            continue
        else:
            new_line += 1

    return ParsedDiff(files=files, added_lines=added)

