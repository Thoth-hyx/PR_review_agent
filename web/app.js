const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const titles = {
  overview: "运行总览",
  review: "发起审查",
  tasks: "任务中心",
  skills: "Skill 注册中心",
  evolution: "评测实验室",
};

const stateLabels = {
  PENDING: "等待中",
  PLANNING: "规划中",
  EXECUTING: "执行中",
  REVIEWING: "汇总中",
  SUCCESS: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

let selectedTask = null;
let selectedTaskData = null;
let accessToken = localStorage.getItem("evoagent_token") || "";
let toastTimer = null;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function formatTime(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(date);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await response.json() : await response.text();

  if (response.status === 401) {
    $("#login-overlay").classList.remove("hidden");
    $("#logout").classList.add("hidden");
  }
  if (!response.ok) {
    const plainText = typeof data === "string" && !/<[a-z][\s\S]*>/i.test(data) ? data.trim() : "";
    const message = typeof data === "object"
      ? data.error || data.detail
      : plainText || `请求失败 (${response.status})`;
    throw new Error(message || response.statusText || "请求失败");
  }
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  button.setAttribute("aria-busy", String(busy));
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

function show(view, updateHash = true) {
  if (!titles[view]) {
    view = "overview";
    history.replaceState(null, "", "#overview");
  }
  $$(".view").forEach((element) => element.classList.remove("active"));
  $$(".nav-item").forEach((element) => {
    const active = element.dataset.view === view;
    element.classList.toggle("active", active);
    element.setAttribute("aria-current", active ? "page" : "false");
  });
  $(`#view-${view}`).classList.add("active");
  $("#page-title").textContent = titles[view];
  document.title = `${titles[view]} · AI Review`;
  if (updateHash) history.replaceState(null, "", `#${view}`);

  if (view === "tasks") loadTasks();
  if (view === "skills") loadSkills();
  if (view === "evolution") loadFailures();
  window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => show(button.dataset.view)));
$$("[data-jump]").forEach((button) => button.addEventListener("click", () => show(button.dataset.jump)));
window.addEventListener("hashchange", () => show(location.hash.slice(1), false));

function taskRows(tasks) {
  if (!tasks?.length) {
    return '<div class="empty-state"><span><b>还没有审查任务</b>提交一个 Diff 开始首次审查</span></div>';
  }
  return tasks.map((task) => {
    const state = String(task.state || "PENDING").toUpperCase();
    const repository = escapeHtml(task.repository || "未命名仓库");
    const pr = task.pull_request ? `PR #${escapeHtml(task.pull_request)}` : "手动审查";
    return `
      <button class="task-row" data-task="${escapeHtml(task.id)}" type="button">
        <span class="task-main">
          <span class="task-glyph">PR</span>
          <span class="task-copy">
            <span class="task-name">${repository}</span>
            <span class="task-meta"><span>${pr}</span><span>${escapeHtml(formatTime(task.created_at))}</span></span>
          </span>
        </span>
        <span class="status state-${state.toLowerCase()}">${stateLabels[state] || escapeHtml(state)}</span>
      </button>`;
  }).join("");
}

function bindTasks(root) {
  $$("[data-task]", root).forEach((row) => row.addEventListener("click", () => openTask(row.dataset.task)));
}

function statCard(label, value, note, style, icon) {
  return `<article class="stat ${style}">
    <div class="stat-head"><span>${label}</span><i>${icon}</i></div>
    <b>${value}</b><small>${note}</small>
  </article>`;
}

function renderLlmRuntime(llm = {}, runMode = {}) {
  const enabled = Boolean(llm.enabled);
  const failed = Boolean(llm.error);
  const provider = String(llm.provider || "local");
  const model = String(llm.model || "");
  const detail = failed
    ? "暂时无法读取模型配置"
    : enabled
      ? `${provider} / ${model || "默认模型"}，参与上下文审查与风险判断`
      : "未配置模型；agentic 审查暂不可用";
  const state = failed ? "读取失败" : enabled ? "已启用" : "待配置";
  const runtime = failed
    ? "运行时状态未知"
    : enabled
      ? `${provider} / ${model || "模型已配置"}`
      : "agentic / 需要模型配置";

  const chain = $("#execution-chain");
  if (chain) {
    const scanner = '<div class="agent-step"><b>01</b><span><strong>Tool / Scanner</strong><small>规则、AST 与代码搜索提供事实</small></span><em>事实</em></div>';
    const gate = '<i class="flow-line"></i><div class="agent-step"><b>03</b><span><strong>Gate</strong><small>格式、证据、置信度与发布门禁</small></span><em class="done">门禁</em></div>';
    const llmStep = `<i class="flow-line"></i><div class="agent-step is-active" id="llm-agent-step"><b>02</b><span><strong>4-role LLM Agents</strong><small id="llm-agent-detail">${escapeHtml(detail)}</small></span><em id="llm-agent-state">${escapeHtml(state)}</em></div>`;
    chain.innerHTML = scanner + llmStep + gate;
  }

  const step = $("#llm-agent-step");
  if (step) {
    step.classList.remove("is-pending");
    step.classList.toggle("is-active", enabled);
    step.classList.toggle("is-disabled", !enabled && !failed);
    step.classList.toggle("is-error", failed);
    const detailNode = $("#llm-agent-detail");
    const stateNode = $("#llm-agent-state");
    if (detailNode) detailNode.textContent = detail;
    if (stateNode) stateNode.textContent = state;
  }

  const status = $("#llm-runtime-status");
  status.className = `runtime-status ${failed ? "is-error" : enabled ? "is-active" : "is-disabled"}`;
  status.textContent = state;
  const capability = $("#llm-capability");
  capability.classList.toggle("is-active", enabled);
  capability.classList.toggle("is-disabled", !enabled && !failed);
  capability.classList.toggle("is-error", failed);
  $("#llm-capability-detail").textContent = detail;
  $("#llm-runtime-model").textContent = runtime;
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    renderLlmRuntime(data.llm, data.run_mode);
    const modeSelect = $("#review-mode");
    if (modeSelect) {
      modeSelect.value = "agentic";
      modeSelect.disabled = !data.llm?.enabled;
    }
    $("#system-status").textContent = `${data.queue} · ${data.orchestrator}`;
    const stats = data.stats || {};
    const rate = Math.round(Number(stats.success_rate || 0) * 100);
    $("#stats").innerHTML = [
      statCard("总任务", stats.tasks_total ?? 0, "累计审查任务", "", "ALL"),
      statCard("已完成", stats.tasks_success ?? 0, "通过质量门禁", "success", "OK"),
      statCard("失败", stats.tasks_failed ?? 0, "需要进一步处理", "failed", "ERR"),
      statCard("成功率", `${rate}%`, "全部任务成功率", "rate", "RATE"),
      statCard("待处理案例", stats.unresolved_failure_cases ?? 0, "未解决反馈", "feedback", "OPEN"),
      statCard("活跃 Skills", stats.active_skill_versions ?? 0, "当前生效版本", "skills", "SK"),
    ].join("");
    $("#recent-tasks").innerHTML = taskRows((data.tasks || []).slice(0, 5));
    bindTasks($("#recent-tasks"));
  } catch (error) {
    renderLlmRuntime({ error: true }, {});
    $("#system-status").textContent = "服务连接异常";
    $("#stats").innerHTML = '<div class="empty-state"><span><b>暂时无法读取数据</b>请检查服务状态后重试</span></div>';
    $("#recent-tasks").innerHTML = '<div class="empty-state"><span>数据加载失败</span></div>';
    toast(error.message);
  }
}

async function loadTasks() {
  const root = $("#all-tasks");
  root.innerHTML = '<div class="list-loading"></div><div class="list-loading"></div>';
  try {
    const data = await api("/api/tasks");
    root.innerHTML = taskRows(data.tasks || []);
    bindTasks(root);
  } catch (error) {
    root.innerHTML = '<div class="empty-state"><span>任务加载失败</span></div>';
    toast(error.message);
  }
}

async function openTask(id) {
  show("tasks");
  $("#task-report").textContent = "正在加载任务报告…";
  $("#feedback-panel").classList.add("hidden");
  try {
    const task = await api(`/v1/tasks/${encodeURIComponent(id)}`);
    selectedTask = id;
    selectedTaskData = task;
    renderDiffReport($("#task-report"), task);
    $("#create-fix").classList.toggle("hidden", !(task.report && task.pull_request));
    const feedbackReady = task.state === "SUCCESS" && task.report;
    $("#feedback-panel").classList.toggle("hidden", !feedbackReady);
    if (feedbackReady) {
      populateFeedbackFindings(task.report.findings || []);
      await loadTaskFeedback(id);
    }
  } catch (error) {
    $("#task-report").textContent = error.message;
    selectedTaskData = null;
  }
}

const feedbackLabels = {
  false_positive: "误报",
  missed_issue: "漏报",
  bad_fix: "坏修复",
  accepted: "已接受",
};

function populateFeedbackFindings(findings) {
  const select = $("#feedback-finding");
  select.innerHTML = '<option value="">不关联已有结论</option>' + findings.map((finding, index) => {
    const identity = `${finding.rule_id || "未命名规则"} · ${finding.path || "未知文件"}:${finding.line || "?"}`;
    return `<option value="${index}">${escapeHtml(identity)}</option>`;
  }).join("");
  $("#feedback-result").textContent = "";
}

function renderTaskFeedback(cases) {
  const root = $("#task-feedback-history");
  if (!cases.length) {
    root.innerHTML = '<p class="feedback-empty">尚无反馈。提交后在这里保留，需在评测实验室手动发起候选生成。</p>';
    return;
  }
  root.innerHTML = `<p class="list-section-label">本任务反馈</p>${cases.map((item) => {
    const payload = item.payload || {};
    const finding = payload.finding || {};
    const reference = finding.rule_id
      ? `${finding.rule_id}${finding.path ? ` · ${finding.path}:${finding.line || "?"}` : ""}`
      : "未关联审查结论";
    return `<div class="feedback-case">
      <span class="feedback-case-type">${escapeHtml(feedbackLabels[item.category] || item.category)}</span>
      <span class="feedback-case-copy"><b>${escapeHtml(reference)}</b><small>${escapeHtml(payload.note || "未填写说明")}</small></span>
      <span class="status ${item.resolved ? "state-success" : "state-pending"}">${item.resolved ? "已解决" : "待处理"}</span>
    </div>`;
  }).join("")}`;
}

async function loadTaskFeedback(taskId) {
  const root = $("#task-feedback-history");
  root.innerHTML = '<p class="feedback-empty">正在读取本任务反馈…</p>';
  try {
    const data = await api(`/v1/tasks/${encodeURIComponent(taskId)}/feedback`);
    if (selectedTask === taskId) renderTaskFeedback(data.cases || []);
  } catch (error) {
    root.innerHTML = `<p class="feedback-empty">无法读取反馈历史：${escapeHtml(error.message)}</p>`;
  }
}

async function loadSkills() {
  const root = $("#skill-list");
  root.innerHTML = '<div class="skill-card loading"></div><div class="skill-card loading"></div>';
  try {
    const data = await api("/api/skills");
    renderLlmRuntime(data.llm);
    const skills = (data.skills || []).filter((skill) => skill.name !== "llm-review");
    root.innerHTML = skills.length ? skills.map((skill) => `
      <article class="skill-card">
        <span class="skill-label">${skill.sandboxed ? "SANDBOXED SKILL" : "ACTIVE SKILL"}</span>
        <h3>${escapeHtml(skill.name)}</h3>
        <p>${escapeHtml(skill.description || "暂无能力描述")}</p>
        <span class="skill-meta">v${escapeHtml(skill.version)} · ${escapeHtml(skill.source)}</span>
      </article>`).join("") : '<div class="empty-state"><span><b>尚未加载 Skill</b>扫描目录以加载可用能力</span></div>';
  } catch (error) {
    renderLlmRuntime({ error: true });
    root.innerHTML = '<div class="empty-state"><span>Skills 加载失败</span></div>';
    toast(error.message);
  }
}

const evolutionDecisions = { activated: "评测通过，已激活过", shadow_ready: "评测通过，待激活", rejected: "未通过", deferred: "暂缓评测" };

function renderEvolutionRuns(runs, kind, status = {}) {
  return runs.length ? runs.map(run => `<details class="evolution-run">
    <summary>${escapeHtml(run.skill_name)} · V${escapeHtml(run.candidate_version)} · ${escapeHtml((kind === "prompt" ? run.skill_name === "llm-review" : run.skill_name === status.skill_name) && run.candidate_version === status.active_version ? "当前激活" : (evolutionDecisions[run.decision] || run.decision))}
      <small>${escapeHtml(formatTime(run.created_at))} · 新 ${Number(run.candidate_score).toFixed(3)} / 旧 ${Number(run.baseline_score).toFixed(3)}</small>
    </summary>
    <p>${escapeHtml(run.metrics?.reason || "")}</p>
    ${kind === "prompt" && run.skill_name === "llm-review" && run.decision === "shadow_ready" && run.candidate_version !== status.active_version ? `<button class="button" data-activate-prompt="${escapeHtml(run.candidate_version)}">激活此 Prompt 版本</button>` : ""}
    <pre>${escapeHtml(formatJson(run))}</pre>
  </details>`).join("") : '<p class="empty-state">暂无评测记录</p>';
}

const evolutionVersions = {prompt: [], skill: []};

function renderVersionChoices(kind, versions, name) {
  evolutionVersions[kind] = versions;
  const select = $(`#${kind}-rollback-version`);
  const previous = select.dataset.skillName === name ? select.value : "";
  select.dataset.skillName = name;
  select.innerHTML = '<option value="">选择历史版本</option>' + versions.map(v =>
    `<option value="${Number(v.version)}">V${Number(v.version)} · ${v.active ? "当前激活" : "历史版本"} · 评测分数 ${Number(v.score).toFixed(3)}</option>`
  ).join("");
  select.value = versions.some(v => String(v.version) === previous) ? previous : "";
  const selected = versions.find(v => String(v.version) === select.value);
  $(`#${kind}-version-detail`).textContent = selected ? formatJson(selected) : versions.length ? "请选择版本（当前版本也可查看）" : "没有已保存版本，无法回滚";
}

["prompt", "skill"].forEach(kind => {
  $(`#${kind}-rollback-version`).addEventListener("change", event => {
    const version = evolutionVersions[kind].find(v => String(v.version) === event.target.value);
    $(`#${kind}-version-detail`).textContent = version ? formatJson(version) : "请选择版本";
  });
  $(`#${kind}-rollback-form`).addEventListener("submit", async event => {
    event.preventDefault();
    const select = $(`#${kind}-rollback-version`);
    if (!select.value) return;
    const button = $('button[type="submit"]', event.currentTarget);
    const output = $(`#${kind}-rollback-result`);
    const name = select.dataset.skillName;
    const selected = evolutionVersions[kind].find(v => String(v.version) === select.value);
    if (!selected) { output.textContent = "所选版本已不可用，请刷新后重试。"; return; }
    if (selected.active) { output.textContent = "所选版本已经激活，无需重复切换。"; return; }
    if (kind === "skill" && name !== $('#skill-evolution-form [name="skill_name"]').value.trim()) {
      output.textContent = "Skill 名称已变更，请刷新版本列表后重试。"; return;
    }
    setButtonBusy(button, true, "正在切换…");
    try {
      const base = kind === "prompt" ? "/v1/skills" : "/v1/skill-evolution";
      const version = select.value;
      const data = await api(`${base}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/activate`, {method:"POST", body:"{}"});
      if (!data.activated) throw new Error("版本未激活");
      output.textContent = `${name} 已切换到 V${version}，后续审查使用此版本。`;
      await loadFailures();
    } catch (error) { output.textContent = `切换失败：${error.message}`; }
    finally { setButtonBusy(button, false); }
  });
});

async function loadFailures() {
  // Load each panel independently so a Skill permission error cannot hide Prompt history.
  await Promise.all(["prompt", "skill"].map(async kind => {
    const statusNode = $(kind === "prompt" ? "#evolution-status" : "#skill-evolution-status");
    const historyNode = $(`#${kind}-history`);
    const base = kind === "prompt" ? "/v1/evolution" : "/v1/skill-evolution";
    const name = $('#skill-evolution-form [name="skill_name"]').value.trim();
    const results = await Promise.allSettled([
      api(`${base}/status${kind === "skill" ? `?skill_name=${encodeURIComponent(name)}` : ""}`),
      api(`${base}/runs?limit=50`),
      api(kind === "prompt" ? "/v1/skills/llm-review/versions" : `/v1/skill-evolution/${encodeURIComponent(name)}/versions`),
    ]);
    const [status, data, versions] = results;
    statusNode.textContent = status.status === "fulfilled" ? formatJson(status.value) : `读取失败：${status.reason.message}`;
    historyNode.innerHTML = data.status === "fulfilled" ? renderEvolutionRuns(data.value.runs || [], kind, status.status === "fulfilled" ? status.value : {}) : "";
    if (data.status === "rejected") historyNode.textContent = `无法读取评测记录：${data.reason.message}`;
    renderVersionChoices(kind, versions.status === "fulfilled" ? versions.value.versions || [] : [], kind === "prompt" ? "llm-review" : name);
    if (versions.status === "rejected") $(`#${kind}-version-detail`).textContent = `版本列表读取失败：${versions.reason.message}。请确认后端已重启且账号具有管理权限。`;

  }));
}

$$("[data-evolution-tab]").forEach(button => {
  button.addEventListener("click", () => {
    $$("[data-evolution-tab]").forEach(tab => {
      const active = tab === button;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle("secondary", !active);
      $(`#${tab.dataset.evolutionTab}-panel`).hidden = !active;
    });
  });
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$("[data-evolution-tab]");
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs.find(tab => tab !== button);
    next.click(); next.focus();
  });
});

$("#prompt-history").addEventListener("click", async event => {
  const button = event.target.closest("[data-activate-prompt]");
  if (!button) return;
  setButtonBusy(button, true, "正在激活…");
  try {
    const version = button.dataset.activatePrompt;
    if (!/^\d+$/.test(version)) throw new Error("无效的候选版本号");
    const result = await api(`/v1/skills/llm-review/versions/${version}/activate`, {method: "POST", body: "{}"});
    if (!result.activated) throw new Error("版本未激活");
    $("#evolution-result").classList.remove("empty");
    $("#evolution-result").textContent = `Prompt V${version} 已激活，后续审查将使用此版本。历史评测状态保留原始结论。`;
    await loadFailures();
    toast(`Prompt V${version} 已激活`);
  } catch (error) { toast(error.message); }
  finally { setButtonBusy(button, false); }
});

$('#skill-evolution-form [name="skill_name"]').addEventListener("change", loadFailures);
$("#skill-evolution-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  setButtonBusy(button, true, "正在评测…");
  try {
    const values = new FormData(form);
    const raw = values.get("supporting_files").trim();
    const files = raw ? JSON.parse(raw) : {};
    if (!files || Array.isArray(files) || typeof files !== "object" || Object.values(files).some(value => typeof value !== "string")) {
      throw new Error("配套文件必须是文件路径到文本内容的 JSON 对象");
    }
    if (Object.hasOwn(files, "SKILL.md")) throw new Error("请在完整 SKILL.md 输入框中填写主文件");
    const result = await api("/v1/skill-evolution/propose", {method: "POST", body: JSON.stringify({
      skill_name: values.get("skill_name").trim(), skill_md: values.get("skill_md"), supporting_files: files,
    })});
    $("#skill-evolution-result").classList.remove("empty");
    $("#skill-evolution-result").textContent = formatJson(result);
    await loadFailures();
    toast(result.decision === "activated" ? "Skill 已激活，后续任务选中后生效" : (evolutionDecisions[result.decision] || "候选处理完成"));
  } catch (error) {
    $("#skill-evolution-result").textContent = `提交失败：${error.message}`;
    toast(error.message);
  } finally { setButtonBusy(button, false); }
});

$("#auto-evolve-skill").addEventListener("click", async () => {
  const input = $('#skill-evolution-form [name="skill_name"]');
  if (!input.reportValidity()) return;
  const button = $("#auto-evolve-skill");
  setButtonBusy(button, true, "正在生成并评测…");
  const output = $("#skill-evolution-result");
  output.classList.remove("empty");
  output.textContent = "正在从反馈生成候选并评测…";
  try {
    const data = await api("/v1/skill-evolution/auto", {
      method: "POST", body: JSON.stringify({skill_name: input.value.trim()}),
    });
    output.textContent = formatJson(data);
    await loadFailures();
    toast(data.decision === "activated" ? "Skill 已激活，后续任务选中后生效" : (evolutionDecisions[data.decision] || "候选处理完成"));
  } catch (error) {
    output.textContent = `生成失败：${error.message}`;
    toast(error.message);
  } finally { setButtonBusy(button, false); }
});

let reviewBusy = false;
const submittedReviews = new Map();

function renderDiffReport(root, task, retry = null) {
  const report = task.report;
  const terminal = ["SUCCESS", "FAILED", "CANCELLED"].includes(task.state);
  const workers = [...(report?.collaboration?.worker_results || []), ...(report?.collaboration?.revision_results || [])];
  const incomplete = report?.execution?.review_completeness?.status === "incomplete" || workers.some(w => w.status !== "completed");
  const failed = task.state === "FAILED" || task.state === "CANCELLED";
  const findings = report?.findings || [];
  const labels = {critical:"严重", high:"高", medium:"中", low:"低", unknown:"未确定"};
  const risk = failed || !report || (incomplete && report.risk !== "high") ? "unknown" : report.risk;
  const status = failed ? stateLabels[task.state] : !terminal ? (stateLabels[task.state] || "处理中") : incomplete ? "审查不完整" : !report ? "报告不可用" : "审查已完成";
  const retryAction = retry || (submittedReviews.has(task.id) ? () => submitDiffReview(submittedReviews.get(task.id)) : null);
  root.innerHTML = `<div class="diff-heading"><h3>Diff 审查报告</h3>${terminal && retryAction ? '<button type="button" class="button retry-review">重新审查</button>' : ''}</div>
    <div class="diff-summary"><strong>风险：${escapeHtml(labels[risk] || "未确定")}</strong><span>${escapeHtml(status)}</span><span>${report ? `${report.files_reviewed?.length || 0} 个文件 · ${findings.length} 个问题` : '正在分析提交的修改'}</span></div>
    <p class="muted">审查范围：${report?.execution?.repository_context?.available ? '提交的 diff 及可用仓库上下文' : '提交的 diff'}</p>
    ${failed || incomplete ? `<p class="review-warning" role="alert">${escapeHtml(task.error || '部分审查未完成，以下问题不代表完整结论。')} ${escapeHtml([...new Set(workers.filter(w => w.error).map(w => w.error))].join('；'))}</p>` : ''}
    <div class="finding-filters" role="group" aria-label="按问题等级筛选"></div><div class="finding-list"></div>
    <details class="technical-details"><summary>技术详情 · 完整任务 JSON</summary><pre>${escapeHtml(formatJson(task))}</pre></details>`;
  const list = $(".finding-list", root);
  const draw = (level) => {
    const visible = findings.filter(f => level === "all" || f.severity === level);
    list.innerHTML = visible.map(f => `<article class="finding-card">
      <div class="finding-title"><span class="severity severity-${Object.hasOwn(labels, f.severity) ? f.severity : 'unknown'}">${escapeHtml(labels[f.severity] || f.severity)}</span><h4>${escapeHtml(f.title)}</h4></div>
      <p class="finding-location">${escapeHtml(f.path)}:${escapeHtml(f.line)}</p>
      <div class="finding-copy"><strong>原因</strong><p>${escapeHtml(f.explanation || '未提供说明')}</p><strong>修复建议</strong><p>${escapeHtml(f.fix || '未提供修复建议')}</p></div>
      <button type="button" class="copy-toggle" aria-expanded="false">展开原因与建议</button>
      <details><summary>代码证据与验证方法</summary><pre>${escapeHtml(f.evidence || '未提供代码证据')}</pre><strong>验证方法</strong><p>${escapeHtml(f.test || '未提供验证方法')}</p></details>
    </article>`).join('') || `<p class="report-empty">${findings.length ? '此等级没有问题。' : !terminal ? '审查进行中，完成后自动更新。' : failed || incomplete || !report ? '暂时没有可发布的问题，不能据此判断修改安全。' : '本次审查未发现可报告的问题。'}</p>`;
    $$(".copy-toggle", list).forEach(button => button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      button.previousElementSibling.classList.toggle("expanded", expanded);
      button.textContent = expanded ? "收起原因与建议" : "展开原因与建议";
    }));
  };
  if (findings.length) {
    const filters = $(".finding-filters", root);
    filters.innerHTML = ['all', 'critical', 'high', 'medium', 'low'].map(level => `<button type="button" data-level="${level}" aria-pressed="${level === 'all'}">${level === 'all' ? '全部' : labels[level]} (${findings.filter(f => level === 'all' || f.severity === level).length})</button>`).join('');
    $$('button', filters).forEach(button => button.addEventListener('click', () => {
      $$('button', filters).forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      draw(button.dataset.level);
    }));
  }
  draw('all');
  const retryButton = $('.retry-review', root);
  if (retryButton) retryButton.addEventListener('click', () => { if (!reviewBusy) retryAction(); });
}

async function submitDiffReview(body) {
  if (reviewBusy) return;
  reviewBusy = true;
  const output = $('#review-result');
  const button = $('button[type="submit"]', $('#review-form'));
  show('review');
  output.textContent = '正在提交审查任务…';
  setButtonBusy(button, true, '审查中…');
  let taskId;
  try {
    const result = await api('/v1/reviews?async=true', {method:'POST', body:JSON.stringify(body)});
    taskId = result.task_id;
    submittedReviews.set(taskId, {...body});
    while (true) {
      const task = await api(`/v1/tasks/${encodeURIComponent(taskId)}`);
      renderDiffReport(output, task, () => submitDiffReview({...body}));
      if (['SUCCESS','FAILED','CANCELLED'].includes(task.state)) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (error) {
    output.textContent = `无法获取审查结果：${error.message}${taskId ? '。任务可能仍在运行，请到任务中心查看，避免重复提交。' : ''}`;
  } finally {
    reviewBusy = false;
    setButtonBusy(button, false);
  }
}

$('#review-form').addEventListener('submit', event => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const body = {repository:values.get('repository'), diff:values.get('diff'), mode:values.get('mode')};
  if (values.get('pull_request')) body.pull_request = Number(values.get('pull_request'));
  submitDiffReview(body);
});

$("#create-fix").addEventListener("click", async () => {
  if (!selectedTask) return;
  const button = $("#create-fix");
  setButtonBusy(button, true, "正在创建…");
  try {
    const data = await api(`/v1/tasks/${encodeURIComponent(selectedTask)}/fix`, {
      method: "POST",
      body: "{}",
    });
    $("#task-report").textContent = formatJson(data);
    toast(data.branch ? "修复分支已创建" : data.status === "blocked" ? "修复未通过验证，未创建分支" : "已生成修复建议，未创建分支");
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy(button, false);
  }
});

$("#feedback-category").addEventListener("change", (event) => {
  const missed = event.target.value === "missed_issue";
  $("#feedback-missed-fields").classList.toggle("hidden", !missed);
  $("#feedback-hint").textContent = missed
    ? "补充规则和位置可让候选评测学习更精确的检查点。"
    : "提交后可在本任务查看反馈，在评测实验室手动发起候选生成。";
});

$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedTask || !selectedTaskData?.report) return;
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const values = new FormData(form);
  const category = String(values.get("category"));
  const selectedIndex = values.get("finding_index");
  const findings = selectedTaskData.report.findings || [];
  const finding = selectedIndex === "" ? {} : { ...(findings[Number(selectedIndex)] || {}) };
  if (category === "missed_issue") {
    const ruleId = String(values.get("rule_id") || "").trim();
    const path = String(values.get("path") || "").trim();
    const line = Number(values.get("line"));
    if (ruleId) finding.rule_id = ruleId;
    if (path) finding.path = path;
    if (Number.isInteger(line) && line > 0) finding.line = line;
  }
  const output = $("#feedback-result");
  output.textContent = "正在保存反馈…";
  setButtonBusy(button, true, "正在提交…");
  try {
    const data = await api(`/v1/tasks/${encodeURIComponent(selectedTask)}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        category,
        finding: Object.keys(finding).length ? finding : null,
        note: String(values.get("note") || "").trim(),
      }),
    });
    output.textContent = `${feedbackLabels[data.category] || data.category}已记录；请在评测实验室点击“从反馈生成候选”发起评测。`;
    form.reset();
    $("#feedback-missed-fields").classList.add("hidden");
    $("#feedback-hint").textContent = "提交后可在本任务查看反馈，在评测实验室手动发起候选生成。";
    await Promise.all([loadTaskFeedback(selectedTask), loadDashboard()]);
    toast("反馈已记录");
  } catch (error) {
    output.textContent = `提交失败：${error.message}`;
  } finally {
    setButtonBusy(button, false);
  }
});

$("#reload-skills").addEventListener("click", async () => {
  const button = $("#reload-skills");
  setButtonBusy(button, true, "正在扫描…");
  try {
    await api("/v1/skills/reload", {
      method: "POST",
      body: "{}",
    });
    await loadSkills();
    toast("Skills 已重新加载");
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy(button, false);
  }
});

$("#evolution-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const values = new FormData(form);
  setButtonBusy(button, true, "正在评测…");
  try {
    const data = await api("/v1/evolution/propose", {
      method: "POST",
      body: JSON.stringify({ skill_name: values.get("skill_name"), prompt: values.get("prompt") }),
    });
    $("#evolution-result").classList.remove("empty");
    $("#evolution-result").textContent = formatJson(data);
    toast(data.decision === "deferred" ? "候选已返回，暂未执行评测" : "候选处理已完成");
    loadFailures();
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy(button, false);
  }
});

$("#auto-evolve").addEventListener("click", async () => {
  const button = $("#auto-evolve");
  setButtonBusy(button, true, "正在生成…");
  try {
    const data = await api("/v1/evolution/auto", {
      method: "POST",
      body: JSON.stringify({ skill_name: "llm-review" }),
    });
    $("#evolution-result").classList.remove("empty");
    $("#evolution-result").textContent = formatJson(data);
    toast(data.decision === "deferred" ? "候选已返回，暂未执行评测" : "反馈候选处理已完成");
    loadFailures();
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonBusy(button, false);
  }
});

$("#refresh").addEventListener("click", async () => {
  const view = location.hash.slice(1) || "overview";
  if (view === "overview") await loadDashboard();
  else if (view === "tasks") await loadTasks();
  else if (view === "skills") await loadSkills();
  else if (view === "evolution") await loadFailures();
  else await loadDashboard();
  toast("刷新请求已完成，请查看各区域状态");
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const values = new FormData(form);
  setButtonBusy(button, true, "正在登录…");
  try {
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: values.get("username"),
        password: values.get("password"),
        tenant_id: values.get("tenant_id"),
      }),
    });
    accessToken = data.access_token;
    localStorage.setItem("evoagent_token", accessToken);
    $("#login-overlay").classList.add("hidden");
    $("#logout").classList.remove("hidden");
    $("#login-error").textContent = "";
    await loadDashboard();
    show(location.hash.slice(1) || "overview", false);
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    setButtonBusy(button, false);
  }
});

$("#logout").addEventListener("click", () => {
  accessToken = "";
  localStorage.removeItem("evoagent_token");
  $("#login-overlay").classList.remove("hidden");
  $("#logout").classList.add("hidden");
});

const diffInput = $('textarea[name="diff"]', $("#review-form"));
const diffStats = $("#diff-stats");
function updateDiffStats() {
  const value = diffInput.value;
  const lines = value ? value.split(/\r?\n/).length : 0;
  diffStats.textContent = `${lines} 行，${value.length} 字符`;
}
diffInput.addEventListener("input", updateDiffStats);
updateDiffStats();

if (accessToken) $("#logout").classList.remove("hidden");
show(location.hash.slice(1) || "overview", false);
loadDashboard();
