const form = document.getElementById("tester-form");
const runButton = document.getElementById("runButton");
const statusBox = document.getElementById("status");
const emptyState = document.getElementById("emptyState");
const reportContainer = document.getElementById("report");
const summaryEl = document.getElementById("summary");
const transcriptEl = document.getElementById("transcript");
const intelEl = document.getElementById("intel");
const finalOutputEl = document.getElementById("finalOutput");
const rawJsonEl = document.getElementById("rawJson");

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    openaiApiKey: valueOf("openaiApiKey"),
    endpointUrl: valueOf("endpointUrl"),
    endpointApiKey: valueOf("endpointApiKey"),
    scenarioId: valueOf("scenarioId"),
    model: valueOf("model"),
    maxTurns: 10
  };

  if (!payload.openaiApiKey || !payload.endpointUrl) {
    setStatus("OpenAI key and endpoint URL are required.", "error");
    return;
  }

  setLoading(true);
  setStatus("Running scammer simulation...", "ok");

  try {
    const response = await fetch("/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    let result = null;
    try {
      result = await response.json();
    } catch (_error) {
      throw new Error("Server returned non-JSON response.");
    }

    if (!response.ok || result.status === "error") {
      throw new Error(result.error || `Request failed (${response.status})`);
    }

    renderReport(result);
    const isPartial = result.status === "partial";
    setStatus(
      isPartial
        ? "Run finished with partial failure. Check transcript for the exact turn."
        : "Run completed.",
      isPartial ? "error" : "ok"
    );
  } catch (error) {
    setStatus(error.message || "Run failed.", "error");
  } finally {
    setLoading(false);
  }
});

function renderReport(result) {
  emptyState.classList.add("hidden");
  reportContainer.classList.remove("hidden");

  renderSummary(result);
  renderTranscript(result.transcript || []);
  renderIntel(result.extractedIntelligence || {});
  finalOutputEl.textContent = JSON.stringify(result.finalOutputPreview || {}, null, 2);
  rawJsonEl.textContent = JSON.stringify(result, null, 2);
}

function renderSummary(result) {
  const m = result.metrics || {};
  const summaryCards = [
    { label: "Status", value: result.status.toUpperCase() },
    { label: "Scenario", value: `${result.scenario?.id || "unknown"}` },
    {
      label: "Turns",
      value: `${result.turnsCompleted}/${result.maxTurns}`
    },
    {
      label: "Avg Latency",
      value: `${m.averageEndpointLatencyMs || 0} ms`
    },
    {
      label: "Questions Asked",
      value: `${m.honeypotQuestionCount || 0}`
    },
    {
      label: "Probe Topics",
      value: `${m.relevantProbeCount || 0}`
    },
    {
      label: "Messages",
      value: `${m.totalMessagesExchanged || 0}`
    },
    {
      label: "Duration",
      value: `${m.engagementDurationSeconds || 0}s`
    }
  ];

  summaryEl.innerHTML = "";
  for (const card of summaryCards) {
    const node = document.createElement("div");
    node.className = "metric";
    node.innerHTML = `
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="value">${escapeHtml(String(card.value))}</div>
    `;
    summaryEl.appendChild(node);
  }
}

function renderTranscript(transcript) {
  transcriptEl.innerHTML = "";
  if (!transcript.length) {
    transcriptEl.innerHTML = "<p>No turns were completed.</p>";
    return;
  }

  for (const turn of transcript) {
    const wrapper = document.createElement("article");
    wrapper.className = "turn";

    const statusLabel =
      typeof turn.endpointStatus === "number"
        ? `HTTP ${turn.endpointStatus}`
        : "No status";
    const latencyLabel = `${turn.endpointLatencyMs ?? 0} ms`;

    wrapper.innerHTML = `
      <div class="turn-head">
        <div><strong>Turn ${turn.turn}</strong></div>
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

    transcriptEl.appendChild(wrapper);
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

function valueOf(id) {
  return document.getElementById(id)?.value?.trim() || "";
}

function setLoading(isLoading) {
  runButton.disabled = isLoading;
  runButton.textContent = isLoading ? "Running..." : "Run 10-Turn Test";
}

function setStatus(message, type) {
  statusBox.textContent = message || "";
  statusBox.className = "status";
  if (type) {
    statusBox.classList.add(type);
  }
}

function humanizeKey(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
