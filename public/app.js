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

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    openaiApiKey: valueOf("openaiApiKey"),
    endpointUrl: valueOf("endpointUrl"),
    endpointApiKey: valueOf("endpointApiKey"),
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
  setStatus("Starting live evaluation stream...", "ok");

  try {
    await streamEvaluation(payload);
    if (!uiState.runCompleted) {
      throw new Error("Live stream ended before completion.");
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

async function streamEvaluation(payload) {
  const response = await fetch("/api/test/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const result = await safeJson(response);
    throw new Error(result.error || `Request failed (${response.status})`);
  }

  if (!response.body) {
    throw new Error("Streaming is not supported by this browser.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");

      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");

        if (!line) {
          continue;
        }

        let packet;
        try {
          packet = JSON.parse(line);
        } catch (_error) {
          appendProgress("Skipped malformed stream event.", "error");
          continue;
        }
        handleStreamPacket(packet);
      }
    }
  } catch (error) {
    if (looksLikeNetworkStreamDrop(error)) {
      throw new Error(
        "Stream connection dropped by network/proxy. Check Railway logs and endpoint latency."
      );
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const trailing = buffer.trim();
  if (trailing) {
    let packet;
    try {
      packet = JSON.parse(trailing);
    } catch (_error) {
      appendProgress("Skipped malformed trailing stream event.", "error");
      return;
    }
    handleStreamPacket(packet);
  }
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
    throw new Error(message);
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
      label: "Code Quality Assumption",
      value: `${formatScore(score.codeQualityScoreAssumed)} / 10`
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

function safeJson(response) {
  return response
    .json()
    .catch(() => ({ status: "error", error: "Server returned non-JSON response." }));
}

function looksLikeNetworkStreamDrop(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("terminated") ||
    message.includes("disconnect")
  );
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
