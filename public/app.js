const form = document.getElementById("tester-form");
const runButton = document.getElementById("runButton");
const pauseButton = document.getElementById("pauseButton");
const statusBox = document.getElementById("status");
const emptyState = document.getElementById("emptyState");
const reportContainer = document.getElementById("report");
const summaryEl = document.getElementById("summary");
const progressLogEl = document.getElementById("progressLog");
const transcriptEl = document.getElementById("transcript");
const scorecardEl = document.getElementById("scorecard");
const intelEl = document.getElementById("intel");
const finalOutputEl = document.getElementById("finalOutput");
const rawJsonEl = document.getElementById("rawJson");
const callbackUrlEl = document.getElementById("callbackUrl");
const copyCallbackUrlButton = document.getElementById("copyCallbackUrlButton");
const refreshCallbackLogsButton = document.getElementById("refreshCallbackLogsButton");
const callbackStatusEl = document.getElementById("callbackStatus");
const callbackLogsEl = document.getElementById("callbackLogs");
const CALLBACK_LOG_POLL_MS = 5000;

const uiState = {
  runId: "",
  running: false,
  paused: false,
  scenariosTotal: 0,
  scenariosCompleted: 0,
  turnsCompleted: 0,
  expectedTurns: 0,
  latencyTotalMs: 0,
  latencyCount: 0,
  scenarioNodes: new Map(),
  runCompleted: false
};

initCallbackViewer();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    openaiApiKey: valueOf("openaiApiKey"),
    endpointUrl: valueOf("endpointUrl"),
    endpointApiKey: valueOf("endpointApiKey"),
    githubRepoUrl: valueOf("githubRepoUrl"),
    scenarioId: valueOf("scenarioId"),
    runAllScenarios: valueOf("scenarioId") === "all_15",
    model: valueOf("model"),
    maxTurns: 10
  };

  if (!payload.openaiApiKey || !payload.endpointUrl) {
    setStatus("OpenAI key and endpoint URL are required.", "error");
    return;
  }

  resetUiForRun();
  setLoading(true);
  setStatus("Starting background evaluation run...", "ok");

  try {
    const start = await startAsyncRun(payload);
    uiState.runId = start.runId || "";
    uiState.running = true;
    updatePauseButton();
    await pollRunEvents({
      runId: start.runId,
      initialCursor: Number(start.nextCursor) || 0
    });
    if (!uiState.runCompleted) {
      throw new Error("Run ended before completion.");
    }
  } catch (error) {
    setStatus(error.message || "Run failed.", "error");
    appendProgress(error.message || "Run failed.", "error");
  } finally {
    uiState.running = false;
    uiState.paused = false;
    updatePauseButton();
    setLoading(false);
  }
});

pauseButton.addEventListener("click", async () => {
  if (!uiState.runId || !uiState.running) {
    return;
  }

  const action = uiState.paused ? "resume" : "pause";
  pauseButton.disabled = true;

  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(uiState.runId)}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });

    const result = await safeJson(response);
    if (!response.ok || result.status === "error") {
      throw new Error(result.error || `Control request failed (${response.status})`);
    }

    uiState.paused = Boolean(result.paused);
    updatePauseButton();
    setStatus(
      uiState.paused
        ? "Endpoint calls paused. Click resume to continue."
        : "Endpoint calls resumed.",
      "ok"
    );
    appendProgress(
      uiState.paused ? "Endpoint calls paused by user." : "Endpoint calls resumed by user.",
      "ok"
    );
    renderLiveSummary();
  } catch (error) {
    setStatus(error.message || "Failed to control run.", "error");
  } finally {
    if (uiState.running) {
      pauseButton.disabled = false;
    }
  }
});

if (copyCallbackUrlButton) {
  copyCallbackUrlButton.addEventListener("click", async () => {
    const callbackUrl = buildCallbackUrl();
    try {
      await copyToClipboard(callbackUrl);
      setCallbackStatus("Callback URL copied.", "ok");
    } catch (_error) {
      setCallbackStatus("Unable to copy URL automatically. Please copy it manually.", "error");
    }
  });
}

if (refreshCallbackLogsButton) {
  refreshCallbackLogsButton.addEventListener("click", () => {
    void refreshCallbackLogs({ manual: true });
  });
}

async function startAsyncRun(payload) {
  const response = await fetch("/api/test/async", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const result = await safeJson(response);
    throw new Error(result.error || `Request failed (${response.status})`);
  }

  const result = await safeJson(response);
  if (result.status !== "accepted") {
    throw new Error(result.error || "Run was not accepted.");
  }
  return result;
}

async function pollRunEvents({ runId, initialCursor = 0 }) {
  let cursor = initialCursor;
  let failureCount = 0;
  const maxFailures = 8;
  const pollIntervalMs = 1000;

  while (true) {
    let payload;
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events?cursor=${cursor}`,
        { cache: "no-store" }
      );
      payload = await safeJson(response);
      if (!response.ok || payload.status === "error") {
        throw new Error(payload.error || `Polling failed (${response.status})`);
      }
      failureCount = 0;
    } catch (error) {
      failureCount += 1;
      const message = error?.message || "Polling network error.";
      appendProgress(`Polling issue (${failureCount}/${maxFailures}): ${message}`, "error");
      if (failureCount >= maxFailures) {
        throw new Error("Lost connection while polling run progress.");
      }
      await sleep(Math.min(3500, pollIntervalMs * failureCount));
      continue;
    }

    const effectiveCursor = Number(payload.cursor);
    if (Number.isFinite(effectiveCursor) && effectiveCursor > cursor) {
      appendProgress("Some early events were trimmed while run continued.", "error");
    }

    for (const event of payload.events || []) {
      handleStreamPacket(event);
    }

    if (Number.isFinite(Number(payload.nextCursor))) {
      cursor = Number(payload.nextCursor);
    }

    if (payload.finished) {
      if (!uiState.runCompleted && payload.result) {
        uiState.runCompleted = true;
        uiState.running = false;
        renderFinalReport(payload.result);
      }
      if (!uiState.runCompleted && payload.error) {
        throw new Error(payload.error);
      }
      break;
    }

    await sleep(pollIntervalMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleStreamPacket(packet) {
  const type = packet?.type;
  const data = packet?.data || {};

  if (type === "heartbeat") {
    return;
  }

  if (type === "stream_ready") {
    return;
  }

  if (type === "run_registered") {
    uiState.runId = data.runId || "";
    uiState.running = true;
    uiState.paused = false;
    updatePauseButton();
    appendProgress(`Run registered: ${uiState.runId}`, "ok");
    return;
  }

  if (type === "run_started") {
    uiState.scenariosTotal = Number(data.scenariosTotal) || 0;
    uiState.expectedTurns = uiState.scenariosTotal * (Number(data.maxTurns) || 0);
    renderLiveSummary();
    appendProgress(
      `Run started. ${uiState.scenariosTotal} scenarios x ${data.maxTurns} turns.`,
      "ok"
    );
    return;
  }

  if (type === "scenario_started") {
    const scenario = data.scenario || {};
    ensureScenarioNode({
      id: scenario.id || `scenario-${data.scenarioIndex}`,
      label: scenario.label || `Scenario ${data.scenarioIndex}`
    });
    appendProgress(
      `Scenario ${data.scenarioIndex}/${data.scenariosTotal} started: ${scenario.id}.`,
      "ok"
    );
    return;
  }

  if (type === "code_quality_evaluated") {
    const quality = data.codeQuality || {};
    const repoLabel =
      quality.repository?.fullName || data.githubRepoUrl || "no repository provided";
    appendProgress(
      `GitHub code quality evaluated for ${repoLabel}: ${formatScore(quality.score)} / ${quality.maxPoints || 10}.`,
      quality.status === "evaluated" ? "ok" : "error"
    );
    return;
  }

  if (type === "turn_completed") {
    const scenarioId = data.scenarioId;
    const scenarioLabel = data.scenarioLabel;
    const node = ensureScenarioNode({
      id: scenarioId || `scenario-${data.scenarioIndex}`,
      label: scenarioLabel || `Scenario ${data.scenarioIndex}`
    });
    appendTurn(node.turns, data.turn || {});
    node.meta.textContent = `${data.turnsCompleted || 0}/${data.maxTurns || 10} turns`;

    uiState.turnsCompleted += 1;
    if (Number.isFinite(data.turn?.endpointLatencyMs)) {
      uiState.latencyTotalMs += data.turn.endpointLatencyMs;
      uiState.latencyCount += 1;
    }

    appendProgress(
      `${scenarioId || "scenario"} turn ${data.turn?.turn || "?"} done (${data.turn?.endpointStatus ?? "ERR"} | ${data.turn?.endpointLatencyMs ?? 0} ms).`,
      data.turn?.error ? "error" : "ok"
    );
    renderLiveSummary();
    return;
  }

  if (type === "scenario_completed") {
    uiState.scenariosCompleted += 1;
    const scenario = data.scenario || {};
    const node = ensureScenarioNode({
      id: scenario.id || `scenario-${data.scenarioIndex}`,
      label: scenario.label || `Scenario ${data.scenarioIndex}`
    });
    node.score.textContent = `Score: ${formatScore(data.score?.total)} / 100`;
    appendProgress(
      `Scenario ${data.scenarioIndex}/${data.scenariosTotal} completed (${scenario.id}) score ${formatScore(data.score?.total)}.`,
      data.status === "partial" ? "error" : "ok"
    );
    renderLiveSummary();
    return;
  }

  if (type === "run_stopped") {
    appendProgress("Run stopped by user request.", "error");
    setStatus("Run stopped.", "error");
    return;
  }

  if (type === "run_error") {
    const message = data.error || "Run failed.";
    appendProgress(message, "error");
    setStatus(message, "error");
    uiState.running = false;
    uiState.runCompleted = false;
    updatePauseButton();
    return;
  }

  if (type === "run_completed") {
    uiState.runCompleted = true;
    uiState.running = false;
    renderFinalReport(data);
    return;
  }
}

function renderFinalReport(result) {
  const isPartial = result.status === "partial";
  const isStopped = result.status === "stopped";

  renderSummaryCards([
    { label: "Status", value: result.status.toUpperCase() },
    {
      label: "Scenarios",
      value: `${result.scenariosCompleted}/${result.scenariosTotal}`
    },
    {
      label: "Turns",
      value: `${result.turnsCompleted}/${result.expectedTotalTurns}`
    },
    {
      label: "Avg Latency",
      value: `${result.metrics?.averageEndpointLatencyMs || 0} ms`
    },
    {
      label: "Weighted Scenario Score",
      value: `${formatScore(result.score?.weightedScenarioScore)} / 100`
    },
    {
      label: "Projected Final Score",
      value: `${formatScore(result.score?.projectedFinalScore)} / 100`
    },
    {
      label: "Code Quality (GitHub)",
      value: `${formatScore(result.score?.codeQualityScoreGithub)} / 10`
    },
    {
      label: "Questions Asked",
      value: `${result.metrics?.honeypotQuestionCount || 0}`
    },
    {
      label: "Duration",
      value: `${result.metrics?.engagementDurationSeconds || 0}s`
    }
  ]);

  renderScorecard(result.score || {});
  renderIntel(result.aggregateExtractedIntelligence || {});

  finalOutputEl.textContent = JSON.stringify(result.finalOutputPreview || {}, null, 2);
  rawJsonEl.textContent = JSON.stringify(result, null, 2);

  if (isStopped) {
    setStatus("Run stopped before all scenarios finished.", "error");
  } else if (isPartial) {
    setStatus("Run completed with partial failures. Check scenario transcript.", "error");
  } else {
    setStatus("Run completed successfully.", "ok");
  }
}

function renderLiveSummary() {
  const avgLatency =
    uiState.latencyCount > 0 ? Math.round(uiState.latencyTotalMs / uiState.latencyCount) : 0;
  renderSummaryCards([
    {
      label: "Status",
      value: uiState.paused ? "PAUSED" : "RUNNING"
    },
    {
      label: "Scenarios",
      value: `${uiState.scenariosCompleted}/${uiState.scenariosTotal || "?"}`
    },
    {
      label: "Turns",
      value: `${uiState.turnsCompleted}/${uiState.expectedTurns || "?"}`
    },
    {
      label: "Avg Latency",
      value: `${avgLatency} ms`
    },
    {
      label: "Run ID",
      value: uiState.runId ? uiState.runId.slice(0, 8) : "-"
    }
  ]);
}

function renderScorecard(score) {
  scorecardEl.innerHTML = "";
  const cards = [
    {
      label: "Weighted Scenario Score",
      value: `${formatScore(score.weightedScenarioScore)} / 100`
    },
    {
      label: "Scenario Contribution (90%)",
      value: `${formatScore(score.scenarioContributionOutOf90)} / 90`
    },
    {
      label: "Code Quality (GitHub)",
      value: `${formatScore(score.codeQualityScoreGithub)} / 10`
    },
    {
      label: "GitHub Repository",
      value:
        score.codeQualityDetails?.repository?.fullName ||
        score.codeQualityDetails?.reason ||
        "Not provided"
    },
    {
      label: "Projected Final Score",
      value: `${formatScore(score.projectedFinalScore)} / 100`
    },
    {
      label: "Scam Detection (Weighted)",
      value: `${formatScore(score.weightedBreakdown?.scamDetection)} / 20`
    },
    {
      label: "Intelligence (Weighted)",
      value: `${formatScore(score.weightedBreakdown?.extractedIntelligence)} / 30`
    },
    {
      label: "Conversation (Weighted)",
      value: `${formatScore(score.weightedBreakdown?.conversationQuality)} / 30`
    },
    {
      label: "Response Structure (Weighted)",
      value: `${formatScore(score.weightedBreakdown?.responseStructure)} / 10`
    }
  ];

  for (const card of cards) {
    const node = document.createElement("div");
    node.className = "metric";
    node.innerHTML = `
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="value">${escapeHtml(String(card.value))}</div>
    `;
    scorecardEl.appendChild(node);
  }
}

function renderSummaryCards(cards) {
  summaryEl.innerHTML = "";
  for (const card of cards) {
    const node = document.createElement("div");
    node.className = "metric";
    node.innerHTML = `
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="value">${escapeHtml(String(card.value))}</div>
    `;
    summaryEl.appendChild(node);
  }
}

function appendTurn(container, turn) {
  const wrapper = document.createElement("article");
  wrapper.className = "turn";

  const statusLabel =
    typeof turn.endpointStatus === "number" ? `HTTP ${turn.endpointStatus}` : "No status";
  const latencyLabel = `${turn.endpointLatencyMs ?? 0} ms`;

  wrapper.innerHTML = `
    <div class="turn-head">
      <div><strong>Turn ${turn.turn || "?"}</strong></div>
      <div>${escapeHtml(statusLabel)} | ${escapeHtml(latencyLabel)}</div>
    </div>
    <div class="msg scammer">
      <strong>Scammer</strong>
      ${escapeHtml(turn.scammerMessage || "(missing)")}
    </div>
    ${
      turn.honeypotMessage
        ? `<div class="msg honeypot">
             <strong>Honeypot</strong>
             ${escapeHtml(turn.honeypotMessage)}
           </div>`
        : ""
    }
    ${
      turn.error
        ? `<div class="msg error">
             <strong>Error</strong>
             ${escapeHtml(turn.error)}
           </div>`
        : ""
    }
  `;

  container.appendChild(wrapper);
}

function ensureScenarioNode(scenario) {
  const key = scenario.id || scenario.label;
  if (uiState.scenarioNodes.has(key)) {
    return uiState.scenarioNodes.get(key);
  }

  const section = document.createElement("section");
  section.className = "scenario-block";

  const head = document.createElement("div");
  head.className = "scenario-head";

  const title = document.createElement("h4");
  title.textContent = scenario.label || scenario.id;

  const meta = document.createElement("span");
  meta.className = "scenario-meta";
  meta.textContent = "0/10 turns";

  const score = document.createElement("div");
  score.className = "scenario-score";
  score.textContent = "Score: pending";

  const turns = document.createElement("div");
  turns.className = "transcript";

  head.appendChild(title);
  head.appendChild(meta);
  section.appendChild(head);
  section.appendChild(score);
  section.appendChild(turns);
  transcriptEl.appendChild(section);

  const node = { section, meta, score, turns };
  uiState.scenarioNodes.set(key, node);
  return node;
}

function appendProgress(message, type = "") {
  const line = document.createElement("div");
  line.className = "progress-line";
  if (type) {
    line.classList.add(type);
  }
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${message}`;
  progressLogEl.appendChild(line);
  progressLogEl.scrollTop = progressLogEl.scrollHeight;

  if (progressLogEl.childElementCount > 280) {
    progressLogEl.removeChild(progressLogEl.firstElementChild);
  }
}

function renderIntel(extracted) {
  intelEl.innerHTML = "";
  const keys = Object.keys(extracted);
  if (!keys.length) {
    intelEl.innerHTML = "<p>No intelligence extracted.</p>";
    return;
  }

  for (const key of keys) {
    const values = Array.isArray(extracted[key]) ? extracted[key] : [];
    const section = document.createElement("section");
    section.className = "intel-group";

    const title = document.createElement("h4");
    title.textContent = humanizeKey(key);
    section.appendChild(title);

    if (!values.length) {
      const empty = document.createElement("span");
      empty.className = "chip";
      empty.textContent = "none";
      section.appendChild(empty);
    } else {
      for (const value of values) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = value;
        section.appendChild(chip);
      }
    }

    intelEl.appendChild(section);
  }
}

function initCallbackViewer() {
  if (!callbackUrlEl || !callbackLogsEl) {
    return;
  }

  callbackUrlEl.textContent = buildCallbackUrl();
  setCallbackStatus("Waiting for incoming callback logs...", "ok");
  void refreshCallbackLogs({ manual: false });
  setInterval(() => {
    void refreshCallbackLogs({ manual: false });
  }, CALLBACK_LOG_POLL_MS);
}

function buildCallbackUrl() {
  return `${window.location.origin}/api/callback`;
}

async function refreshCallbackLogs({ manual }) {
  try {
    const response = await fetch("/api/callback/logs?limit=120", { cache: "no-store" });
    const result = await safeJson(response);
    if (!response.ok || result.status === "error") {
      throw new Error(result.error || `Could not load callback logs (${response.status}).`);
    }

    const logs = Array.isArray(result.logs) ? result.logs : [];
    renderCallbackLogs(logs);
    if (manual) {
      setCallbackStatus(`Loaded ${logs.length} callback logs.`, "ok");
    }
  } catch (error) {
    if (manual) {
      setCallbackStatus(error.message || "Failed to fetch callback logs.", "error");
    }
  }
}

function renderCallbackLogs(logs) {
  if (!callbackLogsEl) {
    return;
  }

  callbackLogsEl.innerHTML = "";
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "progress-line";
    empty.textContent = "No callback logs yet. Send GET or POST to the callback URL.";
    callbackLogsEl.appendChild(empty);
    return;
  }

  for (const log of logs) {
    const block = document.createElement("article");
    block.className = "callback-log";
    const payload = formatLogPayload(log.payload);
    const query = formatLogPayload(log.query);
    block.innerHTML = `
      <div class="callback-log-head">
        <span>${escapeHtml(`${log.method || "?"} ${log.path || "/api/callback"}`)}</span>
        <span>${escapeHtml(formatTimestamp(log.receivedAt))}</span>
      </div>
      <div class="callback-log-meta">IP: ${escapeHtml(log.ip || "-")}</div>
      <div class="callback-log-meta">Query: ${escapeHtml(query)}</div>
      <pre class="callback-log-payload">${escapeHtml(payload)}</pre>
    `;
    callbackLogsEl.appendChild(block);
  }
}

function formatLogPayload(payload) {
  if (payload == null) {
    return "{}";
  }
  if (typeof payload === "string") {
    return payload || "{}";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch (_error) {
    return String(payload);
  }
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function resetUiForRun() {
  uiState.runId = "";
  uiState.running = false;
  uiState.paused = false;
  uiState.scenariosTotal = 0;
  uiState.scenariosCompleted = 0;
  uiState.turnsCompleted = 0;
  uiState.expectedTurns = 0;
  uiState.latencyTotalMs = 0;
  uiState.latencyCount = 0;
  uiState.scenarioNodes.clear();
  uiState.runCompleted = false;

  emptyState.classList.add("hidden");
  reportContainer.classList.remove("hidden");
  summaryEl.innerHTML = "";
  progressLogEl.innerHTML = "";
  transcriptEl.innerHTML = "";
  scorecardEl.innerHTML = "";
  intelEl.innerHTML = "";
  finalOutputEl.textContent = "";
  rawJsonEl.textContent = "";
  updatePauseButton();
}

function updatePauseButton() {
  pauseButton.textContent = uiState.paused
    ? "Resume Endpoint Calls"
    : "Pause Endpoint Calls";
  pauseButton.disabled = !uiState.running || !uiState.runId;
}

function valueOf(id) {
  return document.getElementById(id)?.value?.trim() || "";
}

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading
    ? "Running Live Evaluation..."
    : "Start Live 15x10 Evaluation";
  if (!isLoading) {
    pauseButton.disabled = true;
  }
}

function setStatus(message, type) {
  statusBox.textContent = message || "";
  statusBox.className = "status";
  if (type) {
    statusBox.classList.add(type);
  }
}

function setCallbackStatus(message, type) {
  if (!callbackStatusEl) {
    return;
  }
  callbackStatusEl.textContent = message || "";
  callbackStatusEl.className = "status";
  if (type) {
    callbackStatusEl.classList.add(type);
  }
}

async function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.focus();
  helper.select();
  document.execCommand("copy");
  document.body.removeChild(helper);
}

function safeJson(response) {
  return response
    .json()
    .catch(() => ({ status: "error", error: "Server returned non-JSON response." }));
}

function humanizeKey(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatScore(value) {
  if (!Number.isFinite(Number(value))) {
    return "0";
  }
  return Number(value).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
