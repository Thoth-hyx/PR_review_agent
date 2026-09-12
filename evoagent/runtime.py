"""EvoAgent's dependency-free durable workflow runtime and tool registry.

The runtime deliberately separates orchestration from agent behaviour:

* ``AgentRuntime`` executes named nodes with budgets, retry policy, cancellation
  checks and application-owned checkpoints.
Tool-using model loops live in ``agentic_core.BoundedRole``. Persistence remains
in the application store so a worker restart does not depend on a
framework-owned checkpoint format.
"""
from contextlib import nullcontext
from dataclasses import dataclass, field
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# 步数或时间预算耗尽(guard 检查)
class RuntimeBudgetExceeded(RuntimeError):
    """The configured step or wall-clock budget was exhausted."""

# 任务被请求取消(cancel_check 返回 True)
class RuntimeCancelled(RuntimeError):
    """The owning task requested cancellation."""

# 工具调用不符合注册契约(未知工具/参数错)
class ToolProtocolError(RuntimeError):
    """A tool request does not match the registered tool contract."""

# AgentTool 数据类, 不可变的数据类
@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    parameters: Dict[str, Any]
    handler: Callable[..., Any]

    # 只导出 name/description/parameters 三项——handler 绝不进入目录
    def catalog_entry(self) -> Dict[str, Any]:
        return {
            "name": self.name, "description": self.description,
            "parameters": self.parameters,
        }

# ToolRegistry 工具注册表
class ToolRegistry:
    """Explicit tool catalog with JSON-schema-like argument validation."""

    def __init__(self, tools: Iterable[AgentTool] = ()):
        self._tools: Dict[str, AgentTool] = {}
        for tool in tools:
            self.register(tool)
    # 注册工具, name 必须唯一且非空
    def register(self, tool: AgentTool) -> None:
        if not tool.name or tool.name in self._tools:
            raise ValueError("tool names must be non-empty and unique")
        self._tools[tool.name] = tool
    # 获取已注册工具的名称列表, 按字母顺序排序
    def names(self) -> List[str]:
        return sorted(self._tools)
    # 获取已注册工具的description列表, 按字母顺序排序
    def catalog(self) -> List[Dict[str, Any]]:
        return [self._tools[name].catalog_entry() for name in self.names()]
    # 调用已注册工具, name 必须存在, arguments 必须符合参数契约
    def invoke(self, name: str, arguments: Dict[str, Any]) -> Any:
        tool = self._tools.get(name)
        if tool is None:
            raise ToolProtocolError("unknown agent tool: %s" % name)
        self._validate(tool.parameters, arguments)
        return tool.handler(**arguments)
    # 校验工具参数是否符合契约, 不符合则抛出 ToolProtocolError
    @staticmethod
    def _validate(schema: Dict[str, Any], arguments: Dict[str, Any]) -> None:
        if not isinstance(arguments, dict):         # 参数不是对象
            raise ToolProtocolError("tool arguments must be an object")
        properties = dict(schema.get("properties") or {})
        required = set(schema.get("required") or [])
        missing = required.difference(arguments)
        if missing:         # 缺少必需参数
            raise ToolProtocolError(
                "missing required tool arguments: %s" % ", ".join(sorted(missing))
            )
        if schema.get("additionalProperties", False) is False:
            unknown = set(arguments).difference(properties)
            if unknown:     # 存在未知参数
                raise ToolProtocolError(
                    "unknown tool arguments: %s" % ", ".join(sorted(unknown))
                )
        expected_types = {
            "string": str, "integer": int, "number": (int, float),
            "boolean": bool, "object": dict, "array": list,
        }
        for key, value in arguments.items():        # 逐参数检查类型
            spec = properties.get(key) or {}
            expected = expected_types.get(spec.get("type"))
            if expected and (not isinstance(value, expected) or (
                spec.get("type") in {"integer", "number"} and isinstance(value, bool)
            )): 
                raise ToolProtocolError(
                    "tool argument %s must be %s" % (key, spec.get("type"))
                )
            if isinstance(value, (int, float)):
                if "minimum" in spec and value < spec["minimum"]:
                    raise ToolProtocolError("tool argument %s is below minimum" % key)
                if "maximum" in spec and value > spec["maximum"]:
                    raise ToolProtocolError("tool argument %s exceeds maximum" % key)

# RuntimeNode 数据类, 不可变的数据类
@dataclass(frozen=True)
class RuntimeNode:
    name: str                         # 节点名称, 必须唯一且非空
    handler: Callable[[Dict[str, Any]], Dict[str, Any]]  # 节点逻辑, 接收状态字典并返回状态字典
    retries: Optional[int] = None     # 可选, 默认重试次数
    checkpoint: bool = True           # 默认启用检查点, 可选, 用于持久化节点状态 

# RuntimeEvent 数据类, 不可变的数据类
@dataclass(frozen=True)
class RuntimeEvent:
    kind: str                   # 事件类型
    node: str                   # 事件发生的节点名称
    step: int                   # 事件发生的全局步数快照
    attempt: int = 0
    detail: Dict[str, Any] = field(default_factory=dict)

# AgentRuntime 执行有界节点图, 不依赖第三方编排引擎
# 不需要知道任何业务,只会"按序执行节点、每个节点成功后存档、失败重试、每步前查取消和预算, 更新节点状态"
class AgentRuntime:
    """Execute a bounded node graph without a third-party orchestration engine."""

    def __init__(
        self, max_steps: int = 8, timeout_seconds: int = 120,
        node_retries: int = 0,
    ):
        if max_steps < 1:
            raise ValueError("runtime max_steps must be at least 1")
        if timeout_seconds < 1:
            raise ValueError("runtime timeout_seconds must be at least 1")
        if node_retries < 0:
            raise ValueError("runtime node_retries cannot be negative")
        self.max_steps = max_steps
        self.timeout_seconds = timeout_seconds
        self.node_retries = node_retries

    # 执行节点图, 返回最终状态字典
    def execute(
        self, 
        initial_state: Dict[str, Any],              # 初始状态字典, 作为节点执行的输入
        nodes: Iterable[RuntimeNode],               # 按序执行的节点列表
        task_id: str = "", 
        checkpoint_store=None,
        cancel_check: Optional[Callable[[], bool]] = None,
        event_sink: Optional[Callable[[RuntimeEvent], None]] = None,   # 事件流出口
        span_factory: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
        non_retryable: Tuple[type, ...] = (ValueError, RuntimeCancelled, RuntimeBudgetExceeded),
    ) -> Dict[str, Any]:
        state = dict(initial_state)                 # 浅拷贝
        started = time.monotonic()                  # 单调时钟
        steps = 0
        checkpoints = (
            checkpoint_store.load_checkpoints(task_id)
            if checkpoint_store is not None and task_id else {}
        )       # 读取所有检查点, 以便在节点执行前恢复状态

        # 把事件发送到 event_sink, 如果 event_sink 不为 None
        def emit(kind: str, node: str, attempt: int = 0, **detail) -> None:
            if event_sink:
                event_sink(RuntimeEvent(kind, node, steps, attempt, detail))

        # 检查是否超出步数或时间预算, 或者任务被取消
        def guard(node: str) -> None:
            if cancel_check and cancel_check():
                emit("cancelled", node)
                raise RuntimeCancelled("Task was cancelled")
            if steps >= self.max_steps or time.monotonic() - started > self.timeout_seconds:
                emit("budget_exhausted", node)
                raise RuntimeBudgetExceeded("task execution budget exceeded")

        for node in nodes:
            cached = checkpoints.get(node.name) if node.checkpoint else None  # 若启用检查点, 尝试获取已保存的状态
            if cached and cached.get("status") == "completed":
                output = dict(cached.get("state") or {})
                state.update(output)            # 恢复状态,把之前已完成的节点状态合并到当前状态
                emit("checkpoint_restored", node.name, int(cached.get("attempt", 0)))
                continue                        # 跳过已完成的节点
            # 确定节点的重试次数, 优先使用节点自身的 retries, 否则使用全局默认值
            retries = self.node_retries if node.retries is None else node.retries
            previous_attempt = int((cached or {}).get("attempt", 0))
            last_error: Optional[Exception] = None
            for offset in range(1, retries + 2):    # retries是允许的重试次数, 所以循环次数是 retries + 1, 再加上第一次尝试, 总共是 retries + 2
                guard(node.name)
                steps += 1                # 失败或成功都算作一次步数消耗
                attempt = previous_attempt + offset    # 当前尝试次数 = 上次尝试次数 + 当前偏移量
                emit("node_started", node.name, attempt)
                try:
                    attrs = {
                        "task_id": task_id, "node": node.name,
                        "attempt": attempt, "runtime_step": steps,
                    }
                    context = (
                        span_factory("runtime.%s" % node.name, attrs)
                        if span_factory else nullcontext()
                    )
                    with context:
                        output = node.handler(state) or {}     # 执行节点逻辑, 返回状态字典
                    if not isinstance(output, dict):
                        raise TypeError("runtime node %s must return a dict" % node.name)
                    state.update(output)
                    if checkpoint_store is not None and task_id and node.checkpoint:
                        checkpoint_store.save_checkpoint(
                            task_id, node.name, output, "completed", attempt
                        )           # 节点执行成功, 保存检查点
                    emit("node_completed", node.name, attempt, output_keys=sorted(output))
                    last_error = None
                    break
                except non_retryable:
                    raise
                except Exception as exc:
                    last_error = exc
                    if checkpoint_store is not None and task_id and node.checkpoint:
                        checkpoint_store.save_checkpoint(
                            task_id, node.name, {}, "failed", attempt, str(exc)
                        )
                    emit(
                        "node_failed", node.name, attempt,
                        error=str(exc)[:1000], will_retry=offset <= retries,
                    )
            if last_error is not None:
                raise last_error
        return state
