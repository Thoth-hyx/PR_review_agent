from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

# 任务的生命周期状态机
class TaskState(str, Enum):
    PENDING = "PENDING"
    PLANNING = "PLANNING"
    EXECUTING = "EXECUTING"
    REVIEWING = "REVIEWING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

# finding 严重级
class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

# 产品组件分类，用于评测归因（哪些告警来自 LLM Agent、规则扫描器还是门禁）
class ComponentKind(str, Enum):
    """Product-level component taxonomy; names describe behavior, not branding."""

    LLM_AGENT = "llm-agent"
    TOOL_SCANNER = "tool-scanner"
    GATE = "gate"

# diff 中一行新增代码
@dataclass
class ChangedLine:
    path: str
    line: int
    content: str

# 审查发现
@dataclass
class Finding:
    rule_id: str            # 规则/发现者的内部编号
    severity: Severity      # 发现的严重级别
    title: str              # 发现标题
    explanation: str        # 发现的详细解释
    path: str               # 发现的文件路径
    line: int               # 发现的行号
    evidence: str           # 发现的证据内容,代码原文引用
    fix: str                # 修复建议
    test: str               # 回归测试建议
    confidence: float = 0.8 # 置信度
    evidence_refs: List[Dict[str, Any]] = field(default_factory=list)  # 机器可验证证据
    call_chain: List[Dict[str, Any]] = field(default_factory=list)     # 调用链
    source: str = "unknown"     # 归因标签
    gate: Dict[str, Any] = field(default_factory=dict)   # 门禁评审结果戳
    # Canonical taxonomy used for evaluation.  rule_id remains an internal or
    # reviewer-specific label and is not required to be stable across models.
    cwe: Optional[str] = None     # 规范弱点编号

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["severity"] = self.severity.value
        return value

# 最终审查报告
@dataclass
class ReviewReport:
    repository: str
    pull_request: Optional[int]
    summary: str
    risk: str
    findings: List[Finding] = field(default_factory=list)
    files_reviewed: List[str] = field(default_factory=list)
    reviewer: str = "local-rules"
    collaboration: Dict[str, Any] = field(default_factory=dict)
    run_mode: Dict[str, Any] = field(default_factory=dict)
    components: List[Dict[str, Any]] = field(default_factory=list)
    execution: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "repository": self.repository,
            "pull_request": self.pull_request,
            "summary": self.summary,
            "risk": self.risk,
            "findings": [item.to_dict() for item in self.findings],
            "files_reviewed": self.files_reviewed,
            "reviewer": self.reviewer,
            "collaboration": self.collaboration,
            "run_mode": self.run_mode,
            "components": self.components,
            "execution": self.execution,
        }

#  任务轨迹中的一条事件
@dataclass
class TraceEvent:
    step: int
    state: TaskState
    message: str
    created_at: str

    def to_dict(self) -> Dict[str, Any]:
        value = asdict(self)
        value["state"] = self.state.value
        return value
