import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || 8080);
const TURN_CAP = 10;
const ENDPOINT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const RUN_CONTROL_TTL_MS = 2 * 60 * 60_000;
const CODE_QUALITY_MAX = 10;
const SCORE_PRECISION = 2;
const STREAM_HEARTBEAT_MS = 5_000;
const HEARTBEAT_PAD = "h".repeat(1024);
const RUN_EVENT_LIMIT = 8_000;
const GITHUB_QUALITY_CACHE_TTL_MS = 30 * 60_000;

const ACTIVE_RUNS = new Map();
const GITHUB_QUALITY_CACHE = new Map();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "scammer-mirror-tester" });
});

app.post("/api/test", async (req, res) => {
  const parsed = parseAndValidateInput(req.body ?? {});
  if (!parsed.ok) {
    res.status(400).json({ status: "error", error: parsed.error });
    return;
  }

  try {
    const result = await executeEvaluationRun({
      input: parsed.value,
      runId: crypto.randomUUID()
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error?.message || "Failed to execute evaluation run."
    });
  }
});

app.post("/api/test/async", (req, res) => {
  const parsed = parseAndValidateInput(req.body ?? {});
  if (!parsed.ok) {
    res.status(400).json({ status: "error", error: parsed.error });
    return;
  }

  const runId = crypto.randomUUID();
  const runControl = createRunControl(runId);
  appendRunEvent(runControl, "run_registered", { runId });
  startBackgroundRun({
    input: parsed.value,
    runId,
    runControl
  });

  res.status(202).json({
    status: "accepted",
    runId,
    nextCursor: 0
  });
});

app.get("/api/runs/:runId/events", (req, res) => {
  const runId = asTrimmedString(req.params.runId);
  const runControl = ACTIVE_RUNS.get(runId);

  if (!runControl) {
    res.status(404).json({ status: "error", error: "Run not found or expired." });
    return;
  }

  const cursorValue = Number(req.query.cursor);
  const cursor = Number.isFinite(cursorValue) && cursorValue >= 0 ? Math.floor(cursorValue) : 0;
  const effectiveCursor = Math.max(cursor, runControl.eventOffset);
  const startIndex = effectiveCursor - runControl.eventOffset;
  const events = runControl.events.slice(startIndex);

  res.json({
    status: "ok",
    runId,
    cursor: effectiveCursor,
    nextCursor: runControl.nextEventSeq,
    eventOffset: runControl.eventOffset,
    events,
    finished: runControl.finished,
    result: runControl.finished ? runControl.result : null,
    error: runControl.error || null
  });
});

app.get("/api/runs/:runId", (req, res) => {
  const runId = asTrimmedString(req.params.runId);
  const runControl = ACTIVE_RUNS.get(runId);

  if (!runControl) {
    res.status(404).json({ status: "error", error: "Run not found or expired." });
    return;
  }

  res.json({
    status: "ok",
    runId,
    paused: runControl.paused,
    stopped: runControl.stopped,
    finished: runControl.finished,
    nextCursor: runControl.nextEventSeq,
    eventOffset: runControl.eventOffset,
    result: runControl.finished ? runControl.result : null,
    error: runControl.error || null
  });
});

app.post("/api/test/stream", async (req, res) => {
  const parsed = parseAndValidateInput(req.body ?? {});
  if (!parsed.ok) {
    res.status(400).json({ status: "error", error: parsed.error });
    return;
  }

  const runId = crypto.randomUUID();
  const runControl = createRunControl(runId);
  initializeNdjsonStream(res);
  writeStreamEvent(res, "stream_ready", { runId, pad: HEARTBEAT_PAD });
  writeStreamEvent(res, "run_registered", { runId });

  const heartbeat = setInterval(() => {
    writeStreamEvent(res, "heartbeat", {
      runId,
      ts: new Date().toISOString(),
      pad: HEARTBEAT_PAD
    });
  }, STREAM_HEARTBEAT_MS);

  res.on("close", () => {
    if (!runControl.finished && !res.writableEnded) {
      runControl.stopped = true;
      releaseRunWaiters(runControl);
    }
  });

  try {
    const result = await executeEvaluationRun({
      input: parsed.value,
      runId,
      runControl,
      onEvent: (type, data) => writeStreamEvent(res, type, data)
    });
    writeStreamEvent(res, "run_completed", result);
  } catch (error) {
    writeStreamEvent(res, "run_error", {
      runId,
      error: error?.message || "Failed to execute evaluation run."
    });
  } finally {
    clearInterval(heartbeat);
    runControl.finished = true;
    releaseRunWaiters(runControl);
    scheduleRunControlCleanup(runControl);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/api/runs/:runId/control", (req, res) => {
  const runId = asTrimmedString(req.params.runId);
  const action = asTrimmedString(req.body?.action).toLowerCase();
  const runControl = ACTIVE_RUNS.get(runId);

  if (!runControl) {
    res.status(404).json({ status: "error", error: "Run not found or already finished." });
    return;
  }

  if (!["pause", "resume", "stop"].includes(action)) {
    res.status(400).json({ status: "error", error: "Action must be pause, resume, or stop." });
    return;
  }

  if (runControl.finished) {
    res.status(409).json({ status: "error", error: "Run is already finished." });
    return;
  }

  if (action === "pause") {
    runControl.paused = true;
  } else if (action === "resume") {
    runControl.paused = false;
    releaseRunWaiters(runControl);
  } else if (action === "stop") {
    runControl.stopped = true;
    runControl.paused = false;
    releaseRunWaiters(runControl);
  }

  res.json({
    status: "ok",
    runId,
    action,
    paused: runControl.paused,
    stopped: runControl.stopped
  });
});

app.listen(PORT, () => {
  console.log(`Scammer tester running on http://localhost:${PORT}`);
});

function parseAndValidateInput(body) {
  const openaiApiKey = asTrimmedString(body.openaiApiKey);
  const endpointUrl = asTrimmedString(body.endpointUrl);
  const endpointApiKey = asTrimmedString(body.endpointApiKey);
  const githubRepoUrl = asTrimmedString(body.githubRepoUrl);
  const scenarioId = asTrimmedString(body.scenarioId) || "all_15";
  const model = asTrimmedString(body.model) || DEFAULT_MODEL;
  const explicitRunAll = body.runAllScenarios;

  if (!openaiApiKey) {
    return { ok: false, error: "OpenAI API key is required." };
  }

  if (!endpointUrl) {
    return { ok: false, error: "Endpoint URL is required." };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(endpointUrl);
  } catch (_error) {
    return { ok: false, error: "Endpoint URL is not valid." };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "Endpoint URL must use http or https protocol."
    };
  }

  let maxTurns = Number(body.maxTurns);
  if (!Number.isFinite(maxTurns)) {
    maxTurns = TURN_CAP;
  }
  maxTurns = Math.min(TURN_CAP, Math.max(1, Math.floor(maxTurns)));

  const normalizedGithubRef = githubRepoUrl
    ? normalizeGithubRepoRef(githubRepoUrl)
    : null;
  if (githubRepoUrl && !normalizedGithubRef) {
    return {
      ok: false,
      error:
        "GitHub URL must be a valid repository link (for example: https://github.com/owner/repo)."
    };
  }

  const runAllScenarios =
    typeof explicitRunAll === "boolean"
      ? explicitRunAll
      : ["all_15", "all", "auto", ""].includes(scenarioId);

  const metadata = {
    channel: asTrimmedString(body?.metadata?.channel),
    language: asTrimmedString(body?.metadata?.language),
    locale: asTrimmedString(body?.metadata?.locale)
  };

  return {
    ok: true,
    value: {
      openaiApiKey,
      endpointUrl: parsedUrl.toString(),
      endpointApiKey,
      githubRepoUrl: normalizedGithubRef?.htmlUrl || "",
      scenarioId,
      runAllScenarios,
      model,
      maxTurns,
      metadata
    }
  };
}

class RunStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunStoppedError";
  }
}

function initializeNdjsonStream(res) {
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.socket?.setNoDelay(true);
  res.socket?.setKeepAlive(true, 10_000);
  res.flushHeaders?.();
}

function writeStreamEvent(res, type, data) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  const payload = createPublicEvent(type, data);
  res.write(`${JSON.stringify(payload)}\n`);
  res.flush?.();
}

function createRunControl(runId) {
  const runControl = {
    runId,
    createdAt: Date.now(),
    paused: false,
    stopped: false,
    finished: false,
    waiters: new Set(),
    cleanupTimeout: null,
    events: [],
    eventOffset: 0,
    nextEventSeq: 0,
    result: null,
    error: null,
    runner: null
  };
  ACTIVE_RUNS.set(runId, runControl);
  return runControl;
}

function createPublicEvent(type, data) {
  return {
    type,
    ts: new Date().toISOString(),
    data
  };
}

function appendRunEvent(runControl, type, data) {
  const event = {
    seq: runControl.nextEventSeq,
    ...createPublicEvent(type, data)
  };
  runControl.events.push(event);
  runControl.nextEventSeq += 1;

  if (runControl.events.length > RUN_EVENT_LIMIT) {
    const dropped = runControl.events.length - RUN_EVENT_LIMIT;
    runControl.events.splice(0, dropped);
    runControl.eventOffset += dropped;
  }
}

function startBackgroundRun({ input, runId, runControl }) {
  runControl.runner = executeEvaluationRun({
    input,
    runId,
    runControl,
    onEvent: (type, data) => appendRunEvent(runControl, type, data)
  })
    .then((result) => {
      runControl.result = result;
      appendRunEvent(runControl, "run_completed", result);
    })
    .catch((error) => {
      const message = error?.message || "Failed to execute evaluation run.";
      runControl.error = message;
      appendRunEvent(runControl, "run_error", { runId, error: message });
    })
    .finally(() => {
      runControl.finished = true;
      releaseRunWaiters(runControl);
      scheduleRunControlCleanup(runControl);
    });
}

function releaseRunWaiters(runControl) {
  for (const resolve of runControl.waiters) {
    resolve();
  }
  runControl.waiters.clear();
}

function scheduleRunControlCleanup(runControl) {
  if (runControl.cleanupTimeout) {
    clearTimeout(runControl.cleanupTimeout);
  }
  runControl.cleanupTimeout = setTimeout(() => {
    ACTIVE_RUNS.delete(runControl.runId);
  }, RUN_CONTROL_TTL_MS);
}

async function waitForRunAvailability(runControl) {
  if (!runControl) {
    return;
  }

  while (runControl.paused && !runControl.stopped) {
    await new Promise((resolve) => runControl.waiters.add(resolve));
  }

  if (runControl.stopped) {
    throw new RunStoppedError("Run stopped by user.");
  }
}

async function executeEvaluationRun({ input, runId, runControl = null, onEvent = () => {} }) {
  const client = new OpenAI({ apiKey: input.openaiApiKey });
  const scenarios = selectScenariosForInput(input);
  const startedAt = Date.now();
  const scenarioResults = [];
  let stoppedByUser = false;

  onEvent("run_started", {
    runId,
    scenariosTotal: scenarios.length,
    maxTurns: input.maxTurns,
    endpoint: {
      url: input.endpointUrl,
      timeoutMs: ENDPOINT_TIMEOUT_MS
    },
    githubRepoUrl: input.githubRepoUrl || null,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
      weight: scenario.weight
    }))
  });

  const codeQualityPromise = evaluateGithubCodeQuality(input.githubRepoUrl)
    .then((codeQualityEvaluation) => {
      onEvent("code_quality_evaluated", {
        runId,
        githubRepoUrl: input.githubRepoUrl || null,
        codeQuality: codeQualityEvaluation
      });
      return codeQualityEvaluation;
    })
    .catch((error) => {
      const fallback = {
        score: 0,
        maxPoints: CODE_QUALITY_MAX,
        status: "error",
        reason:
          error?.message || "Unable to evaluate GitHub repository for code quality score.",
        repository: null,
        checks: []
      };
      onEvent("code_quality_evaluated", {
        runId,
        githubRepoUrl: input.githubRepoUrl || null,
        codeQuality: fallback
      });
      return fallback;
    });

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    try {
      await waitForRunAvailability(runControl);
    } catch (error) {
      if (error instanceof RunStoppedError) {
        stoppedByUser = true;
        break;
      }
      throw error;
    }

    onEvent("scenario_started", {
      runId,
      scenarioIndex: index + 1,
      scenariosTotal: scenarios.length,
      scenario: {
        id: scenario.id,
        label: scenario.label,
        objective: scenario.objective,
        weight: scenario.weight
      }
    });

    let scenarioResult;
    try {
      scenarioResult = await executeScenarioRun({
        client,
        input,
        scenario,
        scenarioIndex: index + 1,
        scenariosTotal: scenarios.length,
        runControl,
        onEvent,
        runId
      });
    } catch (error) {
      if (error instanceof RunStoppedError) {
        stoppedByUser = true;
        break;
      }
      throw error;
    }

    scenarioResults.push(scenarioResult);

    onEvent("scenario_completed", {
      runId,
      scenarioIndex: index + 1,
      scenariosTotal: scenarios.length,
      scenario: {
        id: scenario.id,
        label: scenario.label,
        weight: scenario.weight
      },
      status: scenarioResult.status,
      turnsCompleted: scenarioResult.turnsCompleted,
      maxTurns: scenarioResult.maxTurns,
      metrics: scenarioResult.metrics,
      score: scenarioResult.score,
      failure: scenarioResult.failure
    });
  }

  if (runControl?.stopped) {
    stoppedByUser = true;
  }

  const endedAt = Date.now();
  const aggregateMetrics = buildAggregateMetrics({
    scenarioResults,
    durationMs: endedAt - startedAt
  });
  const aggregateExtractedIntelligence = mergeExtractedIntelligence(scenarioResults);
  const codeQualityEvaluation = await codeQualityPromise;
  const score = buildRunScoreSummary({
    scenarioResults,
    codeQualityEvaluation
  });
  const finalOutputPreview = buildRunFinalOutputPreview({
    runId,
    aggregateMetrics,
    aggregateExtractedIntelligence
  });

  const status = stoppedByUser
    ? "stopped"
    : scenarioResults.some((scenario) => scenario.status === "partial")
      ? "partial"
      : "success";

  if (stoppedByUser) {
    onEvent("run_stopped", {
      runId,
      completedScenarios: scenarioResults.length,
      totalScenarios: scenarios.length
    });
  }

  return {
    status,
    runId,
    maxTurnsPerScenario: input.maxTurns,
    turnCap: TURN_CAP,
    scenariosTotal: scenarios.length,
    scenariosCompleted: scenarioResults.length,
    expectedTotalTurns: scenarios.length * input.maxTurns,
    turnsCompleted: scenarioResults.reduce((sum, scenario) => sum + scenario.turnsCompleted, 0),
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    endpoint: {
      url: input.endpointUrl,
      timeoutMs: ENDPOINT_TIMEOUT_MS
    },
    metrics: aggregateMetrics,
    aggregateExtractedIntelligence,
    codeQualityEvaluation,
    score,
    finalOutputPreview,
    scenarioResults
  };
}

async function executeScenarioRun({
  client,
  input,
  scenario,
  scenarioIndex,
  scenariosTotal,
  runControl,
  onEvent,
  runId
}) {
  const syntheticIntel = createSyntheticIntel(scenario);
  const sessionId = crypto.randomUUID();
  const metadata = buildMetadata(input.metadata, scenario);

  const startedAt = Date.now();
  const conversationHistory = [];
  const transcriptForModel = [];
  const turnLogs = [];
  let failure = null;

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    await waitForRunAvailability(runControl);
    const latestHoneypotMessage = getLatestHoneypotMessage(transcriptForModel);

    const generatedTurn = await generateScammerMessage({
      client,
      model: input.model,
      scenario,
      syntheticIntel,
      turn,
      maxTurns: input.maxTurns,
      transcript: transcriptForModel,
      latestHoneypotMessage
    });

    await waitForRunAvailability(runControl);
    const scammerMessage = generatedTurn.message;
    const scammerEpoch = Date.now();
    const requestPayload = {
      sessionId,
      message: {
        sender: "scammer",
        text: scammerMessage,
        timestamp: new Date(scammerEpoch).toISOString()
      },
      conversationHistory: [...conversationHistory],
      metadata
    };

    const endpointResult = await callTargetEndpoint({
      endpointUrl: input.endpointUrl,
      endpointApiKey: input.endpointApiKey,
      payload: requestPayload
    });

    conversationHistory.push({
      sender: "scammer",
      text: scammerMessage,
      timestamp: scammerEpoch
    });
    transcriptForModel.push({
      sender: "scammer",
      text: scammerMessage,
      timestamp: scammerEpoch
    });

    if (!endpointResult.ok) {
      failure = {
        turn,
        reason: endpointResult.error,
        endpointStatus: endpointResult.status
      };
      const failedTurn = {
        turn,
        scammerMessage,
        honeypotMessage: null,
        endpointStatus: endpointResult.status,
        endpointLatencyMs: endpointResult.durationMs,
        usedFallback: generatedTurn.usedFallback,
        error: endpointResult.error
      };
      turnLogs.push(failedTurn);
      onEvent("turn_completed", {
        runId,
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        scenarioIndex,
        scenariosTotal,
        turnsCompleted: turnLogs.length,
        maxTurns: input.maxTurns,
        turn: failedTurn
      });
      break;
    }

    const honeypotMessage = readHoneypotReply(endpointResult.body);
    if (!honeypotMessage) {
      const missingReplyError =
        "Endpoint response did not include reply, message, or text in JSON body.";
      failure = {
        turn,
        reason: missingReplyError,
        endpointStatus: endpointResult.status
      };
      const failedTurn = {
        turn,
        scammerMessage,
        honeypotMessage: null,
        endpointStatus: endpointResult.status,
        endpointLatencyMs: endpointResult.durationMs,
        usedFallback: generatedTurn.usedFallback,
        error: missingReplyError
      };
      turnLogs.push(failedTurn);
      onEvent("turn_completed", {
        runId,
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        scenarioIndex,
        scenariosTotal,
        turnsCompleted: turnLogs.length,
        maxTurns: input.maxTurns,
        turn: failedTurn
      });
      break;
    }

    const honeypotEpoch = Date.now();
    conversationHistory.push({
      sender: "user",
      text: honeypotMessage,
      timestamp: honeypotEpoch
    });
    transcriptForModel.push({
      sender: "user",
      text: honeypotMessage,
      timestamp: honeypotEpoch
    });

    const completedTurn = {
      turn,
      scammerMessage,
      honeypotMessage,
      endpointStatus: endpointResult.status,
      endpointLatencyMs: endpointResult.durationMs,
      usedFallback: generatedTurn.usedFallback
    };
    turnLogs.push(completedTurn);

    onEvent("turn_completed", {
      runId,
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      scenarioIndex,
      scenariosTotal,
      turnsCompleted: turnLogs.length,
      maxTurns: input.maxTurns,
      turn: completedTurn
    });
  }

  const endedAt = Date.now();
  const scammerMessages = turnLogs
    .map((turn) => turn.scammerMessage)
    .filter(Boolean);
  const honeypotMessages = turnLogs
    .map((turn) => turn.honeypotMessage)
    .filter(Boolean);

  const plantedIntelligence = extractIntelligence(scammerMessages);
  const extractedIntelligence = extractIntelligence(scammerMessages);
  const metrics = buildConversationMetrics({
    turnLogs,
    honeypotMessages,
    durationMs: endedAt - startedAt
  });
  const finalOutputPreview = buildFinalOutputPreview({
    sessionId,
    extractedIntelligence,
    metrics,
    scenario
  });
  const score = evaluateScenarioScore({
    finalOutputPreview,
    extractedIntelligence,
    plantedIntelligence,
    metrics
  });

  return {
    status: failure ? "partial" : "success",
    sessionId,
    scenario: {
      id: scenario.id,
      label: scenario.label,
      objective: scenario.objective,
      weight: scenario.weight
    },
    maxTurns: input.maxTurns,
    turnsCompleted: turnLogs.length,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    metrics,
    plantedIntelligence,
    extractedIntelligence,
    finalOutputPreview,
    transcript: turnLogs,
    score,
    failure
  };
}

function selectScenariosForInput(input) {
  if (input.runAllScenarios) {
    return normalizeScenarioWeights(SCENARIOS);
  }

  const selected = SCENARIOS.find((scenario) => scenario.id === input.scenarioId);
  return normalizeScenarioWeights([selected ?? SCENARIOS[0]]);
}

function normalizeScenarioWeights(scenarios) {
  if (!scenarios.length) {
    return [];
  }

  const withExistingWeights = scenarios.every(
    (scenario) => Number.isFinite(scenario.weight) && scenario.weight > 0
  );

  if (withExistingWeights) {
    const totalWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
    return scenarios.map((scenario) => ({
      ...scenario,
      weight: roundScore((scenario.weight * 100) / totalWeight, 4)
    }));
  }

  const equalWeight = 100 / scenarios.length;
  let accumulated = 0;

  return scenarios.map((scenario, index) => {
    if (index === scenarios.length - 1) {
      return {
        ...scenario,
        weight: roundScore(100 - accumulated, 4)
      };
    }

    const weight = roundScore(equalWeight, 4);
    accumulated += weight;
    return {
      ...scenario,
      weight
    };
  });
}

function buildAggregateMetrics({ scenarioResults, durationMs }) {
  const totalMessagesExchanged = scenarioResults.reduce(
    (sum, scenario) => sum + (scenario.metrics?.totalMessagesExchanged || 0),
    0
  );
  const totalQuestions = scenarioResults.reduce(
    (sum, scenario) => sum + (scenario.metrics?.honeypotQuestionCount || 0),
    0
  );
  const totalRedFlags = scenarioResults.reduce(
    (sum, scenario) => sum + (scenario.metrics?.redFlagMentions || 0),
    0
  );
  const totalElicitationAttempts = scenarioResults.reduce(
    (sum, scenario) => sum + (scenario.metrics?.informationElicitationAttempts || 0),
    0
  );
  const relevantProbeTopics = new Set();
  const latencies = [];

  for (const scenario of scenarioResults) {
    for (const topic of scenario.metrics?.relevantProbeTopics || []) {
      relevantProbeTopics.add(topic);
    }
    for (const turn of scenario.transcript || []) {
      if (Number.isFinite(turn.endpointLatencyMs)) {
        latencies.push(turn.endpointLatencyMs);
      }
    }
  }

  const averageEndpointLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length)
      : 0;

  return {
    turnsReached: scenarioResults.reduce((sum, scenario) => sum + scenario.turnsCompleted, 0),
    totalMessagesExchanged,
    engagementDurationSeconds: Math.max(1, Math.round(durationMs / 1000)),
    honeypotQuestionCount: totalQuestions,
    relevantProbeCount: relevantProbeTopics.size,
    relevantProbeTopics: [...relevantProbeTopics].sort(),
    redFlagMentions: totalRedFlags,
    informationElicitationAttempts: totalElicitationAttempts,
    averageEndpointLatencyMs,
    minEndpointLatencyMs: latencies.length > 0 ? Math.min(...latencies) : 0,
    maxEndpointLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0
  };
}

function mergeExtractedIntelligence(scenarioResults) {
  const merged = {
    phoneNumbers: [],
    bankAccounts: [],
    upiIds: [],
    phishingLinks: [],
    emailAddresses: [],
    caseIds: [],
    policyNumbers: [],
    orderNumbers: []
  };

  for (const scenario of scenarioResults) {
    const intelligence = scenario.extractedIntelligence || {};
    for (const key of Object.keys(merged)) {
      const values = Array.isArray(intelligence[key]) ? intelligence[key] : [];
      for (const value of values) {
        merged[key].push(value);
      }
    }
  }

  for (const key of Object.keys(merged)) {
    merged[key] = [...new Set(merged[key])];
  }

  return merged;
}

function evaluateScenarioScore({
  finalOutputPreview,
  extractedIntelligence,
  plantedIntelligence,
  metrics
}) {
  const scamDetectionPoints = finalOutputPreview?.scamDetected === true ? 20 : 0;
  const intelligenceScore = scoreExtractedIntelligence({
    extractedIntelligence,
    plantedIntelligence
  });
  const conversationQuality = scoreConversationQuality(metrics);
  const engagementQuality = scoreEngagementQuality(metrics);
  const responseStructure = scoreResponseStructure(finalOutputPreview);

  const total = roundScore(
    scamDetectionPoints +
      intelligenceScore.points +
      conversationQuality.points +
      engagementQuality.points +
      responseStructure.points
  );

  return {
    total,
    breakdown: {
      scamDetection: {
        points: roundScore(scamDetectionPoints),
        maxPoints: 20
      },
      extractedIntelligence: intelligenceScore,
      conversationQuality,
      engagementQuality,
      responseStructure
    }
  };
}

function scoreExtractedIntelligence({ extractedIntelligence, plantedIntelligence }) {
  const candidateKeys = INTELLIGENCE_FIELDS.filter(
    (key) => Array.isArray(plantedIntelligence?.[key]) && plantedIntelligence[key].length > 0
  );

  if (!candidateKeys.length) {
    return {
      points: 0,
      maxPoints: 30,
      matchedFields: 0,
      totalFields: 0,
      pointsPerField: 0
    };
  }

  const pointsPerField = 30 / candidateKeys.length;
  let matchedFields = 0;

  for (const key of candidateKeys) {
    const expectedValues = plantedIntelligence[key] || [];
    const actualValues = extractedIntelligence?.[key] || [];
    if (hasOverlap(expectedValues, actualValues)) {
      matchedFields += 1;
    }
  }

  return {
    points: roundScore(matchedFields * pointsPerField),
    maxPoints: 30,
    matchedFields,
    totalFields: candidateKeys.length,
    pointsPerField: roundScore(pointsPerField)
  };
}

function hasOverlap(expectedValues, actualValues) {
  const expected = new Set(expectedValues.map((value) => normalizeScoreValue(value)));
  for (const value of actualValues) {
    if (expected.has(normalizeScoreValue(value))) {
      return true;
    }
  }
  return false;
}

function normalizeScoreValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreConversationQuality(metrics) {
  const turns = metrics?.turnsReached || 0;
  const questions = metrics?.honeypotQuestionCount || 0;
  const relevantQuestions = metrics?.relevantProbeCount || 0;
  const redFlags = metrics?.redFlagMentions || 0;
  const elicitationAttempts = metrics?.informationElicitationAttempts || 0;

  const turnPoints = turns >= 8 ? 8 : turns >= 6 ? 6 : turns >= 4 ? 3 : 0;
  const questionPoints = questions >= 5 ? 4 : questions >= 3 ? 2 : questions >= 1 ? 1 : 0;
  const relevantQuestionPoints =
    relevantQuestions >= 3 ? 3 : relevantQuestions >= 2 ? 2 : relevantQuestions >= 1 ? 1 : 0;
  const redFlagPoints = redFlags >= 5 ? 8 : redFlags >= 3 ? 5 : redFlags >= 1 ? 2 : 0;
  const elicitationPoints = Math.min(7, elicitationAttempts * 1.5);

  return {
    points: roundScore(
      turnPoints +
        questionPoints +
        relevantQuestionPoints +
        redFlagPoints +
        elicitationPoints
    ),
    maxPoints: 30,
    details: {
      turnCount: { turns, points: turnPoints, maxPoints: 8 },
      questionsAsked: { questions, points: questionPoints, maxPoints: 4 },
      relevantQuestions: {
        relevantQuestions,
        points: relevantQuestionPoints,
        maxPoints: 3
      },
      redFlagIdentification: { redFlags, points: redFlagPoints, maxPoints: 8 },
      informationElicitation: {
        attempts: elicitationAttempts,
        points: roundScore(elicitationPoints),
        maxPoints: 7
      }
    }
  };
}

function scoreEngagementQuality(metrics) {
  const duration = metrics?.engagementDurationSeconds || 0;
  const messages = metrics?.totalMessagesExchanged || 0;

  let points = 0;
  if (duration > 0) {
    points += 1;
  }
  if (duration > 60) {
    points += 2;
  }
  if (duration > 180) {
    points += 1;
  }
  if (messages > 0) {
    points += 2;
  }
  if (messages >= 5) {
    points += 3;
  }
  if (messages >= 10) {
    points += 1;
  }

  return {
    points: roundScore(points),
    maxPoints: 10,
    details: {
      engagementDurationSeconds: duration,
      totalMessagesExchanged: messages
    }
  };
}

function scoreResponseStructure(finalOutputPreview) {
  let points = 0;
  let missingRequired = 0;

  const hasSessionId = typeof finalOutputPreview?.sessionId === "string" && finalOutputPreview.sessionId;
  const hasScamDetected = typeof finalOutputPreview?.scamDetected === "boolean";
  const hasExtractedIntel =
    finalOutputPreview?.extractedIntelligence &&
    typeof finalOutputPreview.extractedIntelligence === "object";

  if (hasSessionId) {
    points += 2;
  } else {
    missingRequired += 1;
  }
  if (hasScamDetected) {
    points += 2;
  } else {
    missingRequired += 1;
  }
  if (hasExtractedIntel) {
    points += 2;
  } else {
    missingRequired += 1;
  }

  const hasEngagementFields =
    Number.isFinite(finalOutputPreview?.totalMessagesExchanged) &&
    Number.isFinite(finalOutputPreview?.engagementDurationSeconds);
  if (hasEngagementFields) {
    points += 1;
  }
  if (typeof finalOutputPreview?.agentNotes === "string" && finalOutputPreview.agentNotes.trim()) {
    points += 1;
  }
  if (typeof finalOutputPreview?.scamType === "string" && finalOutputPreview.scamType.trim()) {
    points += 1;
  }
  if (Number.isFinite(finalOutputPreview?.confidenceLevel)) {
    points += 1;
  }

  points = Math.max(0, points - missingRequired);

  return {
    points: roundScore(points),
    maxPoints: 10,
    missingRequired
  };
}

function normalizeGithubRepoRef(inputUrl) {
  if (!inputUrl) {
    return null;
  }

  const raw = String(inputUrl).trim();
  if (!raw) {
    return null;
  }

  let candidate = raw;
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    candidate = `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  } else if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch (_error) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (!["github.com", "www.github.com"].includes(hostname)) {
    return null;
  }

  const parts = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    htmlUrl: `https://github.com/${owner}/${repo}`
  };
}

async function evaluateGithubCodeQuality(githubRepoUrl) {
  if (!githubRepoUrl) {
    return {
      score: 0,
      maxPoints: CODE_QUALITY_MAX,
      status: "missing",
      reason: "GitHub repository URL not provided.",
      repository: null,
      checks: []
    };
  }

  const ref = normalizeGithubRepoRef(githubRepoUrl);
  if (!ref) {
    return {
      score: 0,
      maxPoints: CODE_QUALITY_MAX,
      status: "invalid",
      reason: "GitHub repository URL is invalid.",
      repository: null,
      checks: []
    };
  }

  const cacheKey = ref.fullName.toLowerCase();
  const cached = GITHUB_QUALITY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "honeypot-scammer-tester"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const repoApiUrl = `https://api.github.com/repos/${ref.fullName}`;
  const repoResponse = await fetchGithubApiJson(repoApiUrl, headers);
  if (!repoResponse.ok || !repoResponse.data) {
    const value = {
      score: 0,
      maxPoints: CODE_QUALITY_MAX,
      status: "unavailable",
      reason:
        repoResponse.status === 404
          ? "Repository was not found or is private."
          : `GitHub API returned status ${repoResponse.status}.`,
      repository: {
        fullName: ref.fullName,
        htmlUrl: ref.htmlUrl
      },
      checks: []
    };
    GITHUB_QUALITY_CACHE.set(cacheKey, {
      value,
      expiresAt: Date.now() + GITHUB_QUALITY_CACHE_TTL_MS
    });
    return value;
  }

  const repo = repoResponse.data;
  const checks = [];
  let points = 0;
  const baseRepoApi = `https://api.github.com/repos/${repo.full_name}`;
  const defaultBranch = repo.default_branch || "main";

  const pushCheck = (id, label, earned, maxPoints, details = "") => {
    const safeEarned = Math.max(0, Math.min(maxPoints, earned));
    points += safeEarned;
    checks.push({
      id,
      label,
      points: roundScore(safeEarned),
      maxPoints,
      details
    });
  };

  pushCheck("repo_access", "Repository Accessibility", 2, 2, "Repository is reachable.");

  const readmeResponse = await fetchGithubApiJson(`${baseRepoApi}/readme`, headers);
  if (readmeResponse.ok && readmeResponse.data) {
    const readmeSize = Number(readmeResponse.data.size) || 0;
    const readmePoints = readmeSize >= 500 ? 2 : 1;
    pushCheck(
      "readme",
      "README Quality Signal",
      readmePoints,
      2,
      `README detected (${readmeSize} bytes).`
    );
  } else {
    pushCheck("readme", "README Quality Signal", 0, 2, "README not found.");
  }

  const hasLicense =
    typeof repo.license?.spdx_id === "string" &&
    repo.license.spdx_id.trim() &&
    repo.license.spdx_id !== "NOASSERTION";
  pushCheck(
    "license",
    "License Metadata",
    hasLicense ? 1 : 0,
    1,
    hasLicense ? `License: ${repo.license.spdx_id}.` : "License metadata missing."
  );

  const treeResponse = await fetchGithubApiJson(
    `${baseRepoApi}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    headers
  );

  let hasWorkflow = false;
  let hasTestsByTree = false;
  let hasTestAutomationFile = false;
  let hasPackageJson = false;

  if (treeResponse.ok && Array.isArray(treeResponse.data?.tree)) {
    const testAutomationFiles = new Set([
      "pytest.ini",
      "tox.ini",
      "noxfile.py",
      "jest.config.js",
      "jest.config.ts",
      "vitest.config.ts",
      "vitest.config.js",
      "phpunit.xml"
    ]);

    for (const node of treeResponse.data.tree) {
      const path = String(node?.path || "");
      const lowerPath = path.toLowerCase();
      const baseName = lowerPath.split("/").pop() || "";

      if (
        lowerPath.startsWith(".github/workflows/") &&
        (lowerPath.endsWith(".yml") || lowerPath.endsWith(".yaml"))
      ) {
        hasWorkflow = true;
      }

      if (
        /(^|\/)(test|tests|__tests__)(\/|$)/i.test(lowerPath) ||
        /\.(spec|test)\.[a-z0-9]+$/i.test(lowerPath) ||
        /_test\.go$/i.test(lowerPath)
      ) {
        hasTestsByTree = true;
      }

      if (testAutomationFiles.has(baseName)) {
        hasTestAutomationFile = true;
      }

      if (lowerPath === "package.json") {
        hasPackageJson = true;
      }
    }
  }

  let hasRunnablePackageTestScript = false;
  if (hasPackageJson) {
    const packageJsonResponse = await fetchGithubApiJson(
      `${baseRepoApi}/contents/package.json?ref=${encodeURIComponent(defaultBranch)}`,
      headers
    );
    if (packageJsonResponse.ok && packageJsonResponse.data?.content) {
      const decoded = Buffer.from(
        String(packageJsonResponse.data.content).replace(/\n/g, ""),
        "base64"
      ).toString("utf8");
      try {
        const parsedPackage = JSON.parse(decoded);
        const script = String(parsedPackage?.scripts?.test || "").trim();
        if (
          script &&
          !/no test specified/i.test(script) &&
          !/^echo\s+["']?error/i.test(script)
        ) {
          hasRunnablePackageTestScript = true;
        }
      } catch (_error) {
        hasRunnablePackageTestScript = false;
      }
    }
  }

  const ciPoints = hasWorkflow ? 2 : 0;
  pushCheck(
    "ci",
    "CI Workflow Presence",
    ciPoints,
    2,
    hasWorkflow ? "GitHub Actions workflow detected." : "No CI workflow detected."
  );

  const testPoints = Math.min(
    2,
    (hasTestsByTree ? 1 : 0) +
      (hasTestAutomationFile || hasRunnablePackageTestScript ? 1 : 0)
  );
  pushCheck(
    "tests",
    "Testing Signals",
    testPoints,
    2,
    hasTestsByTree
      ? "Test files/directories detected."
      : "No explicit test files detected in repository tree."
  );

  let recencyPoints = 0;
  let recencyDetails = "Latest push date unavailable.";
  if (repo.pushed_at) {
    const pushedAtMs = Date.parse(repo.pushed_at);
    if (Number.isFinite(pushedAtMs)) {
      const ageDays = Math.floor((Date.now() - pushedAtMs) / 86_400_000);
      recencyPoints = ageDays <= 180 ? 1 : 0;
      recencyDetails = `Last push ${ageDays} day(s) ago.`;
    }
  }
  pushCheck("activity", "Repository Activity Recency", recencyPoints, 1, recencyDetails);

  const value = {
    score: roundScore(points),
    maxPoints: CODE_QUALITY_MAX,
    status: "evaluated",
    reason: "",
    repository: {
      fullName: repo.full_name,
      htmlUrl: repo.html_url || ref.htmlUrl,
      defaultBranch,
      pushedAt: repo.pushed_at || null
    },
    checks
  };

  GITHUB_QUALITY_CACHE.set(cacheKey, {
    value,
    expiresAt: Date.now() + GITHUB_QUALITY_CACHE_TTL_MS
  });
  return value;
}

async function fetchGithubApiJson(url, headers) {
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (_error) {
    return {
      ok: false,
      status: 0,
      data: null
    };
  }
}

function buildRunScoreSummary({ scenarioResults, codeQualityEvaluation }) {
  const codeQualityScore = Math.min(
    CODE_QUALITY_MAX,
    Math.max(0, Number(codeQualityEvaluation?.score) || 0)
  );
  const weightedScenarioScore = roundScore(
    scenarioResults.reduce((sum, scenario) => {
      const weight = scenario.scenario?.weight || 0;
      const total = scenario.score?.total || 0;
      return sum + (total * weight) / 100;
    }, 0)
  );
  const scenarioContribution = roundScore(weightedScenarioScore * 0.9);
  const finalProjectedScore = roundScore(
    Math.min(100, Math.max(0, scenarioContribution + codeQualityScore))
  );

  const weightedBreakdown = {
    scamDetection: 0,
    extractedIntelligence: 0,
    conversationQuality: 0,
    engagementQuality: 0,
    responseStructure: 0
  };

  for (const scenario of scenarioResults) {
    const weightMultiplier = (scenario.scenario?.weight || 0) / 100;
    weightedBreakdown.scamDetection +=
      (scenario.score?.breakdown?.scamDetection?.points || 0) * weightMultiplier;
    weightedBreakdown.extractedIntelligence +=
      (scenario.score?.breakdown?.extractedIntelligence?.points || 0) * weightMultiplier;
    weightedBreakdown.conversationQuality +=
      (scenario.score?.breakdown?.conversationQuality?.points || 0) * weightMultiplier;
    weightedBreakdown.engagementQuality +=
      (scenario.score?.breakdown?.engagementQuality?.points || 0) * weightMultiplier;
    weightedBreakdown.responseStructure +=
      (scenario.score?.breakdown?.responseStructure?.points || 0) * weightMultiplier;
  }

  for (const key of Object.keys(weightedBreakdown)) {
    weightedBreakdown[key] = roundScore(weightedBreakdown[key]);
  }

  return {
    weightedScenarioScore,
    scenarioContributionOutOf90: scenarioContribution,
    codeQualityScoreGithub: roundScore(codeQualityScore),
    codeQualityDetails: codeQualityEvaluation || null,
    projectedFinalScore: finalProjectedScore,
    weightedBreakdown,
    formula:
      "Final Score = (Weighted Scenario Score x 0.9) + Code Quality Score (0-10)."
  };
}

function buildRunFinalOutputPreview({
  runId,
  aggregateMetrics,
  aggregateExtractedIntelligence
}) {
  return {
    sessionId: runId,
    scamDetected: true,
    totalMessagesExchanged: aggregateMetrics.totalMessagesExchanged,
    engagementDurationSeconds: aggregateMetrics.engagementDurationSeconds,
    extractedIntelligence: aggregateExtractedIntelligence,
    scamType: "multi_scenario_suite",
    confidenceLevel: 0.9,
    agentNotes:
      "Aggregated final output generated by the multi-scenario self-evaluation harness."
  };
}

function roundScore(value, precision = SCORE_PRECISION) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function generateScammerMessage({
  client,
  model,
  scenario,
  syntheticIntel,
  turn,
  maxTurns,
  transcript,
  latestHoneypotMessage
}) {
  const fallback = fallbackScammerTurn({
    scenario,
    syntheticIntel,
    turn,
    latestHoneypotMessage
  });

  const systemPrompt =
    "You are roleplaying a scammer in an authorized defensive honeypot simulation. " +
    "Stay in character. Mimic realistic scammer style from Indian fraud chats: urgency, authority impersonation, pressure, and repeated call-to-action. " +
    "If asked identity checks, provide plausible fake details and redirect to your demand. " +
    "Never mention you are an AI, never explain safety policy, and never use markdown. " +
    "Output only the scammer message text in 1 to 3 sentences.";

  const transcriptText = formatTranscriptForPrompt(transcript);
  const userPrompt = [
    `Scenario ID: ${scenario.id}`,
    `Scenario objective: ${scenario.objective}`,
    `Turn: ${turn} of ${maxTurns}`,
    "Fake identity pack that you should consistently use:",
    JSON.stringify(syntheticIntel, null, 2),
    "Fallback demand style:",
    fallback,
    "Conversation so far (latest last):",
    transcriptText || "No prior messages.",
    `Latest honeypot message: ${latestHoneypotMessage || "none"}`,
    "Generate the next scammer message now."
  ].join("\n");

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.95,
      max_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const rawText = completion.choices?.[0]?.message?.content ?? "";
    const normalized = normalizeModelMessage(rawText);
    if (normalized) {
      return { message: normalized, usedFallback: false };
    }
  } catch (_error) {
    return { message: fallback, usedFallback: true };
  }

  return { message: fallback, usedFallback: true };
}

async function callTargetEndpoint({ endpointUrl, endpointApiKey, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  const startedAt = Date.now();

  const headers = { "content-type": "application/json" };
  if (endpointApiKey) {
    headers["x-api-key"] = endpointApiKey;
  }

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const durationMs = Date.now() - startedAt;
    const rawText = await response.text();

    let body = null;
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText);
      } catch (_error) {
        return {
          ok: false,
          status: response.status,
          durationMs,
          error: "Endpoint response was not valid JSON."
        };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        error: `Endpoint returned HTTP ${response.status}.`
      };
    }

    return {
      ok: true,
      status: response.status,
      durationMs,
      body: body ?? {}
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: null,
        durationMs,
        error: `Endpoint timed out after ${ENDPOINT_TIMEOUT_MS / 1000} seconds.`
      };
    }

    return {
      ok: false,
      status: null,
      durationMs,
      error: `Endpoint request failed: ${error?.message || "unknown error"}.`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readHoneypotReply(body) {
  if (!body || typeof body !== "object") {
    return "";
  }

  const preferred = ["reply", "message", "text"];
  for (const key of preferred) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function buildMetadata(inputMetadata, scenario) {
  return {
    channel: inputMetadata.channel || "SMS",
    language: inputMetadata.language || "English",
    locale: inputMetadata.locale || "IN",
    scenarioHint: scenario.id
  };
}

function pickScenario(requestedScenario) {
  if (!requestedScenario || requestedScenario === "auto") {
    return randomItem(SCENARIOS);
  }

  return SCENARIOS.find((scenario) => scenario.id === requestedScenario) ?? SCENARIOS[0];
}

function createSyntheticIntel(scenario) {
  const firstName = randomItem([
    "Rahul",
    "Priya",
    "Amit",
    "Neha",
    "Vikas",
    "Karan",
    "Pooja",
    "Rohit"
  ]);
  const lastName = randomItem([
    "Sharma",
    "Patel",
    "Gupta",
    "Nair",
    "Kumar",
    "Reddy",
    "Verma",
    "Mehta"
  ]);
  const employeePrefix = scenario.employeePrefix;
  const year = new Date().getUTCFullYear();
  const randomFour = randomDigits(4);
  const randomSix = randomDigits(6);

  const handle = scenario.upiHandle;
  const localAlias = `${firstName.toLowerCase()}.${scenario.shortCode}${randomDigits(2)}`;
  const upiId = `${localAlias}@${handle}`;

  const domain = scenario.domain;
  const email = `${scenario.emailAlias}@${domain}`;

  return {
    name: `${firstName} ${lastName}`,
    callbackNumber: `+91-${randomDigits(10)}`,
    employeeId: `${employeePrefix}-${randomFour}`,
    caseReference: `${scenario.casePrefix}-${year}-${randomFour}`,
    transactionId: `${scenario.txnPrefix}-${randomSix}`,
    company: scenario.company,
    department: scenario.department,
    email,
    upiId,
    website: `https://${domain}/${scenario.pathSegment}?ref=${randomSix}`,
    beneficiaryName: `${scenario.company} Support`,
    amount: randomItem(scenario.amountSamples),
    bankAccount: randomDigits(12)
  };
}

function fallbackScammerTurn({
  scenario,
  syntheticIntel,
  turn,
  latestHoneypotMessage
}) {
  const demand = buildDemandLine(scenario, syntheticIntel);
  const opener = buildOpeningLine(scenario, syntheticIntel);
  if (turn === 1) {
    return `${opener} ${demand}`;
  }

  const probe = classifyProbe(latestHoneypotMessage || "");
  if (probe === "callback") {
    return `You can call me at ${syntheticIntel.callbackNumber}, but this is urgent. ${demand}`;
  }
  if (probe === "employee") {
    return `My employee ID is ${syntheticIntel.employeeId}. ${demand}`;
  }
  if (probe === "upi") {
    return `Use UPI ID ${syntheticIntel.upiId}. ${demand}`;
  }
  if (probe === "email") {
    return `Official email is ${syntheticIntel.email}. ${demand}`;
  }
  if (probe === "case") {
    return `Case reference is ${syntheticIntel.caseReference}. ${demand}`;
  }
  if (probe === "website") {
    return `Use this official link ${syntheticIntel.website}. ${demand}`;
  }
  if (probe === "department") {
    return `I am from ${syntheticIntel.department}, ${syntheticIntel.company}. ${demand}`;
  }
  if (probe === "name") {
    return `My name is ${syntheticIntel.name}. ${demand}`;
  }
  if (probe === "company") {
    return `This is ${syntheticIntel.company}. ${demand}`;
  }
  if (probe === "amount") {
    return `The amount is ${syntheticIntel.amount}. ${demand}`;
  }
  if (probe === "beneficiary") {
    return `Beneficiary name is ${syntheticIntel.beneficiaryName}. ${demand}`;
  }
  if (probe === "transaction") {
    return `Transaction ID is ${syntheticIntel.transactionId}. ${demand}`;
  }

  const pressure = randomItem(scenario.pressureLines);
  return `${pressure} ${demand}`;
}

function classifyProbe(message) {
  const text = (message || "").toLowerCase();

  if (/(callback|call.?back|phone|helpline|contact number)/i.test(text)) {
    return "callback";
  }
  if (/(employee id|agent id|id card)/i.test(text)) {
    return "employee";
  }
  if (/(upi|payment handle|which account|bank account|account number)/i.test(text)) {
    return "upi";
  }
  if (/(email|mail id)/i.test(text)) {
    return "email";
  }
  if (/(case|reference|ticket)/i.test(text)) {
    return "case";
  }
  if (/(website|link|url|official site)/i.test(text)) {
    return "website";
  }
  if (/(department|team|unit)/i.test(text)) {
    return "department";
  }
  if (/(full name|your name|who are you)/i.test(text)) {
    return "name";
  }
  if (/(company|organization|merchant)/i.test(text)) {
    return "company";
  }
  if (/(amount|how much|fee|charges)/i.test(text)) {
    return "amount";
  }
  if (/(beneficiary|payee)/i.test(text)) {
    return "beneficiary";
  }
  if (/(transaction|txnid|txn id)/i.test(text)) {
    return "transaction";
  }

  return "none";
}

function buildOpeningLine(scenario, syntheticIntel) {
  switch (scenario.id) {
    case "bank_fraud":
      return `URGENT: Your ${syntheticIntel.company} account is compromised and may be blocked in 2 hours.`;
    case "lottery_prize":
      return `Congratulations, you have won ${syntheticIntel.amount} cashback from ${syntheticIntel.company}.`;
    case "upi_fraud":
      return `ALERT: Your policy verification is pending and will expire today without immediate payment.`;
    case "ecommerce":
      return `LIMITED OFFER: iPhone 15 Pro dispatch is pending at promotional price; verify now to claim.`;
    case "kyc_update":
      return `IMPORTANT: Your KYC update is incomplete and your wallet will be suspended today.`;
    case "electricity_bill":
      return `URGENT: Your electricity due ${syntheticIntel.amount} is pending and power may disconnect shortly.`;
    case "fake_delivery":
      return `INDIA POST: International parcel held at customs. Clear duty now to release shipment.`;
    case "investment_scam":
      return `EXCLUSIVE: High-return crypto mining slot available, but activation closes in minutes.`;
    default:
      return randomItem(scenario.openingLines);
  }
}

function buildDemandLine(scenario, syntheticIntel) {
  switch (scenario.id) {
    case "bank_fraud":
      return "Share your OTP immediately so we can secure your account.";
    case "lottery_prize":
      return `Pay processing fee to ${syntheticIntel.upiId} and share OTP so we can release funds.`;
    case "upi_fraud":
      return `Transfer ${syntheticIntel.amount} to ${syntheticIntel.upiId} and confirm with OTP now.`;
    case "ecommerce":
      return `Email your bank account details and OTP to ${syntheticIntel.email} to complete your claim.`;
    case "kyc_update":
      return `Submit OTP and UPI PIN at ${syntheticIntel.website} to avoid account freeze.`;
    case "electricity_bill":
      return `Pay ${syntheticIntel.amount} now and share payment confirmation and OTP to avoid disconnection.`;
    case "fake_delivery":
      return `Pay customs amount ${syntheticIntel.amount} to ${syntheticIntel.upiId} and send transaction proof now.`;
    case "investment_scam":
      return `Send your first deposit to ${syntheticIntel.upiId} and share OTP to activate the investment plan.`;
    default:
      return scenario.defaultDemand;
  }
}

function getLatestHoneypotMessage(transcript) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index].sender === "user") {
      return transcript[index].text;
    }
  }
  return "";
}

function formatTranscriptForPrompt(transcript) {
  return transcript
    .slice(-10)
    .map((item) =>
      `${item.sender === "scammer" ? "Scammer" : "Honeypot"}: ${item.text}`
    )
    .join("\n");
}

function normalizeModelMessage(message) {
  if (typeof message !== "string") {
    return "";
  }

  return message
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 450);
}

function buildConversationMetrics({ turnLogs, honeypotMessages, durationMs }) {
  const latencies = turnLogs
    .map((turn) => turn.endpointLatencyMs)
    .filter((value) => Number.isFinite(value));

  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : 0;

  const relevantTopics = new Set();
  let questionCount = 0;
  let redFlagMentions = 0;
  let informationElicitationAttempts = 0;

  for (const message of honeypotMessages) {
    if (message.includes("?")) {
      questionCount += 1;
    }

    for (const topic of QUESTION_TOPIC_RULES) {
      if (topic.regex.test(message)) {
        relevantTopics.add(topic.id);
      }
    }

    for (const marker of RED_FLAG_MARKERS) {
      if (marker.test(message)) {
        redFlagMentions += 1;
      }
    }

    if (INFORMATION_ELICITATION_RULES.some((rule) => rule.regex.test(message))) {
      informationElicitationAttempts += 1;
    }
  }

  const totalMessagesExchanged = turnLogs.reduce((acc, item) => {
    if (item.honeypotMessage) {
      return acc + 2;
    }
    return acc + 1;
  }, 0);

  return {
    turnsReached: turnLogs.length,
    totalMessagesExchanged,
    engagementDurationSeconds: Math.max(1, Math.round(durationMs / 1000)),
    honeypotQuestionCount: questionCount,
    relevantProbeCount: relevantTopics.size,
    relevantProbeTopics: [...relevantTopics].sort(),
    redFlagMentions,
    informationElicitationAttempts,
    averageEndpointLatencyMs: avgLatencyMs,
    minEndpointLatencyMs: latencies.length ? Math.min(...latencies) : 0,
    maxEndpointLatencyMs: latencies.length ? Math.max(...latencies) : 0
  };
}

function extractIntelligence(scammerMessages) {
  const text = scammerMessages.join("\n");

  const phoneNumbers = dedupeMatches(
    text,
    /(?:\+?\d[\d\s\-()]{7,}\d)/g,
    normalizeSimple
  );

  const phishingLinks = dedupeMatches(text, /\bhttps?:\/\/[^\s<>"')]+/gi, (value) =>
    value.trim()
  );

  const emails = dedupeMatches(
    text,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    normalizeSimple
  );

  const allHandleLike = dedupeMatches(
    text,
    /\b[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9._-]{1,}\b/g,
    normalizeSimple
  );
  const emailSet = new Set(emails.map((item) => item.toLowerCase()));
  const upiIds = allHandleLike.filter(
    (value) =>
      !emailSet.has(value.toLowerCase()) ||
      /(paytm|ybl|ibl|ok|upi|fake|icici|hdfc|axis|sbi)/i.test(value)
  );

  const bankAccounts = dedupeMatches(
    text,
    /\b(?:\d{9,18}|[A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g,
    normalizeSimple
  );

  const caseIds = dedupeMatches(
    text,
    /\b(?:REF|CRN|KYC|AMZ|TXN|CASE|TKT)[-A-Z0-9]{2,}\b/gi,
    normalizeSimple
  );

  const policyNumbers = dedupeMatches(
    text,
    /\bPOL[A-Z0-9-]{4,}\b/gi,
    normalizeSimple
  );

  const orderNumbers = dedupeMatches(
    text,
    /\b(?:ORD|ORDER)[-A-Z0-9]{4,}\b/gi,
    normalizeSimple
  );

  return {
    phoneNumbers,
    bankAccounts,
    upiIds,
    phishingLinks,
    emailAddresses: emails,
    caseIds,
    policyNumbers,
    orderNumbers
  };
}

function buildFinalOutputPreview({
  sessionId,
  extractedIntelligence,
  metrics,
  scenario
}) {
  return {
    sessionId,
    scamDetected: true,
    totalMessagesExchanged: metrics.totalMessagesExchanged,
    engagementDurationSeconds: metrics.engagementDurationSeconds,
    extractedIntelligence,
    scamType: scenario.id,
    confidenceLevel: 0.9,
    agentNotes:
      "Generated by scammer-mirror tester. Review transcript for adaptive questioning and intelligence capture coverage."
  };
}

function dedupeMatches(text, regex, normalizeFn) {
  const found = text.match(regex) || [];
  const normalized = found.map((value) => normalizeFn(value)).filter(Boolean);
  return [...new Set(normalized)];
}

function normalizeSimple(value) {
  return value.replace(/\s+/g, " ").trim();
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function randomItem(items) {
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}

function randomDigits(length) {
  let output = "";
  while (output.length < length) {
    output += Math.floor(Math.random() * 10).toString();
  }
  return output.slice(0, length);
}

const INTELLIGENCE_FIELDS = [
  "phoneNumbers",
  "bankAccounts",
  "upiIds",
  "phishingLinks",
  "emailAddresses",
  "caseIds",
  "policyNumbers",
  "orderNumbers"
];

const QUESTION_TOPIC_RULES = [
  { id: "callback_number", regex: /(callback|call.?back|phone|helpline)/i },
  { id: "employee_id", regex: /(employee id|agent id|id card)/i },
  { id: "upi_or_account", regex: /(upi|account number|bank account|which account)/i },
  { id: "official_email", regex: /(email|mail id)/i },
  { id: "case_reference", regex: /(case|reference|ticket)/i },
  { id: "official_website", regex: /(website|link|url|official site)/i },
  { id: "department", regex: /(department|team)/i },
  { id: "full_name", regex: /(full name|your name|who are you)/i },
  { id: "company_name", regex: /(company|organization|merchant)/i },
  { id: "amount", regex: /(amount|how much|fee|charges)/i }
];

const INFORMATION_ELICITATION_RULES = [
  { id: "identity", regex: /(name|designation|department|team|who are you)/i },
  { id: "contact", regex: /(phone|callback|number|helpline|contact)/i },
  { id: "digital", regex: /(email|website|link|url|official site)/i },
  { id: "payment", regex: /(upi|account|beneficiary|payee|transaction)/i },
  { id: "case", regex: /(case|reference|ticket|order|policy)/i }
];

const RED_FLAG_MARKERS = [
  /\botp\b/i,
  /\bpin\b/i,
  /\burgent\b/i,
  /\bblocked\b/i,
  /\bcomprom/i,
  /\blink\b/i,
  /\bfee\b/i,
  /\bpayment\b/i,
  /\bscam\b/i
];

const SCENARIOS = [
  {
    id: "bank_fraud",
    label: "Bank Fraud Pressure",
    objective:
      "Impersonate bank fraud desk, reveal fake identity details when asked, and keep demanding OTP.",
    company: "SecureTrust Bank",
    department: "Fraud Prevention Department",
    emailAlias: "support",
    upiHandle: "fakebank",
    domain: "securetrust-verification.com",
    employeePrefix: "EMP",
    casePrefix: "REF",
    txnPrefix: "TXN",
    shortCode: "bank",
    pathSegment: "secure-login",
    amountSamples: ["Rs. 2,500", "Rs. 5,000", "Rs. 8,500"],
    defaultDemand:
      "Share the OTP you received right away so we can secure your account.",
    openingLines: [
      "URGENT: Your account has suspicious activity and could be blocked soon.",
      "Emergency alert: unusual transaction detected on your bank account."
    ],
    pressureLines: [
      "This needs immediate action from your side.",
      "Delay may result in account freeze.",
      "We cannot hold the account for long."
    ]
  },
  {
    id: "lottery_prize",
    label: "Lottery or Cashback Trap",
    objective:
      "Offer prize lure, share fake references, and push for fee, OTP, or UPI PIN.",
    company: "Lucky Draw Rewards",
    department: "Prize Release Team",
    emailAlias: "claims",
    upiHandle: "fakeupi",
    domain: "luckydraw-release.com",
    employeePrefix: "LTR",
    casePrefix: "CLAIM",
    txnPrefix: "PRZ",
    shortCode: "ltry",
    pathSegment: "claim",
    amountSamples: ["Rs. 5,000", "Rs. 15,000", "Rs. 25 Lakh"],
    defaultDemand:
      "To release your prize, pay processing fee now and share OTP immediately.",
    openingLines: [
      "Congratulations! You have won a reward payout from our campaign.",
      "You are selected for a major lottery payout today."
    ],
    pressureLines: [
      "Prize window closes in a few minutes.",
      "We can only process verified claims instantly.",
      "Complete verification now to avoid cancellation."
    ]
  },
  {
    id: "upi_fraud",
    label: "UPI or Policy Renewal Scam",
    objective:
      "Claim urgent policy/UPI issue and force victim to pay to UPI handle plus OTP.",
    company: "National Insurance Services",
    department: "Policy Verification Desk",
    emailAlias: "policy-help",
    upiHandle: "insurancehelp",
    domain: "policy-urgent-verify.com",
    employeePrefix: "POL",
    casePrefix: "POL",
    txnPrefix: "PMT",
    shortCode: "upi",
    pathSegment: "renew",
    amountSamples: ["Rs. 1,999", "Rs. 2,500", "Rs. 4,999"],
    defaultDemand:
      "Pay the pending amount now and confirm with OTP so your policy stays active.",
    openingLines: [
      "ALERT: Your insurance policy is about to lapse within 24 hours.",
      "Immediate action required: your policy verification failed."
    ],
    pressureLines: [
      "Without payment, all benefits will be lost today.",
      "System deadline is near, complete this now.",
      "Only instant verification can prevent policy suspension."
    ]
  },
  {
    id: "ecommerce",
    label: "Ecommerce Offer Scam",
    objective:
      "Pitch unrealistic deal or alert, provide fake link/email, and demand credentials.",
    company: "OnlineDeals Support",
    department: "Offer Verification Team",
    emailAlias: "offers",
    upiHandle: "dealspay",
    domain: "amaz0n-deals.fake-site.com",
    employeePrefix: "OFR",
    casePrefix: "ORD",
    txnPrefix: "ODR",
    shortCode: "deal",
    pathSegment: "claim",
    amountSamples: ["Rs. 999", "Rs. 7,999", "$799.99"],
    defaultDemand:
      "Share your bank details and OTP now so we can complete your discounted claim.",
    openingLines: [
      "Special flash offer approved for your account, claim immediately.",
      "Your premium product confirmation is pending verification."
    ],
    pressureLines: [
      "Offer expires in minutes if not verified.",
      "This is the final reminder before cancellation.",
      "We need your details now to lock your order."
    ]
  },
  {
    id: "kyc_update",
    label: "KYC Update Pressure",
    objective:
      "Pretend account KYC failure and coerce victim into sharing OTP, PIN, and payment data.",
    company: "PhonePe Assist",
    department: "KYC Verification Team",
    emailAlias: "support",
    upiHandle: "phonepe-fake",
    domain: "phonepe-verify.fake-kyc.site",
    employeePrefix: "KYC",
    casePrefix: "KYC",
    txnPrefix: "KYC",
    shortCode: "kyc",
    pathSegment: "complete",
    amountSamples: ["Rs. 500", "Rs. 2,500", "Rs. 5,000"],
    defaultDemand:
      "Complete KYC right now by submitting OTP and UPI PIN on the verification link.",
    openingLines: [
      "IMPORTANT: Your wallet KYC is incomplete and service will be deactivated today.",
      "Your payment app account is under review due to missing KYC."
    ],
    pressureLines: [
      "The link is valid only for a short time.",
      "Delay will auto-freeze your wallet access.",
      "We need immediate verification to keep your account active."
    ]
  },
  {
    id: "electricity_bill",
    label: "Electricity Bill Threat",
    objective:
      "Threaten power disconnection and pressure payment plus OTP sharing.",
    company: "City Electricity Board",
    department: "Billing Department",
    emailAlias: "billing",
    upiHandle: "mseb-pay",
    domain: "billing-urgent-pay.com",
    employeePrefix: "MSEB",
    casePrefix: "CRN",
    txnPrefix: "EBILL",
    shortCode: "elec",
    pathSegment: "pay",
    amountSamples: ["Rs. 2,500", "Rs. 4,200", "Rs. 8,500"],
    defaultDemand:
      "Pay your pending bill now and share transaction plus OTP to avoid disconnection.",
    openingLines: [
      "URGENT: Your electricity bill is overdue and power will be disconnected soon.",
      "Immediate payment required to keep your electricity active."
    ],
    pressureLines: [
      "Disconnection order is already generated.",
      "If you delay, restoration charges will be added.",
      "Settle this now to avoid service shutdown."
    ]
  },
  {
    id: "fake_delivery",
    label: "Parcel or Customs Scam",
    objective:
      "Claim parcel hold and push duty payment with rushed urgency.",
    company: "India Parcel Customs Desk",
    department: "Customs Clearance Unit",
    emailAlias: "customs",
    upiHandle: "parcel-duty",
    domain: "parcel-release-center.com",
    employeePrefix: "CST",
    casePrefix: "SHIP",
    txnPrefix: "PAR",
    shortCode: "dlv",
    pathSegment: "release",
    amountSamples: ["Rs. 1,250", "Rs. 3,750", "Rs. 5,000"],
    defaultDemand:
      "Pay customs duty now and share payment reference to release your parcel immediately.",
    openingLines: [
      "INDIA POST: International parcel is held due to unpaid customs duty.",
      "Your shipment is blocked at customs and needs urgent clearance."
    ],
    pressureLines: [
      "Parcel will be returned if you do not pay now.",
      "Storage penalty starts shortly.",
      "This is final notice before parcel cancellation."
    ]
  },
  {
    id: "investment_scam",
    label: "Investment Return Scam",
    objective:
      "Push high return investment, ask deposit, and keep escalating pressure.",
    company: "Crypto Growth Partners",
    department: "Investor Activation Desk",
    emailAlias: "invest",
    upiHandle: "crypto-profit",
    domain: "profit-now-invest.com",
    employeePrefix: "INV",
    casePrefix: "INV",
    txnPrefix: "INVEST",
    shortCode: "inv",
    pathSegment: "start",
    amountSamples: ["Rs. 10,000", "Rs. 25,000", "Rs. 50,000"],
    defaultDemand:
      "Send initial investment now and share OTP to activate guaranteed monthly returns.",
    openingLines: [
      "Exclusive investment slot open now with guaranteed high monthly return.",
      "Your profile is pre-approved for premium crypto income plan."
    ],
    pressureLines: [
      "Only a few seats remain in this cycle.",
      "Activation window closes in minutes.",
      "Deposit now to lock your return plan."
    ]
  },
  {
    id: "job_offer",
    label: "Fake Job Offer Scam",
    objective:
      "Offer instant placement and request payment for onboarding, KYC, or training activation.",
    company: "TalentBridge Careers",
    department: "HR Verification Unit",
    emailAlias: "hiring",
    upiHandle: "jobdesk-pay",
    domain: "talentbridge-onboard.com",
    employeePrefix: "HR",
    casePrefix: "JOB",
    txnPrefix: "JOIN",
    shortCode: "job",
    pathSegment: "verify-profile",
    amountSamples: ["Rs. 850", "Rs. 1,999", "Rs. 3,500"],
    defaultDemand:
      "Pay onboarding fee now and share OTP to confirm your joining slot immediately.",
    openingLines: [
      "Congratulations, your CV is shortlisted for immediate joining.",
      "We have approved your profile for priority placement."
    ],
    pressureLines: [
      "Your slot expires today if payment is not done.",
      "Offer letter is released only after instant verification.",
      "Complete this now to avoid profile rejection."
    ]
  },
  {
    id: "loan_approval",
    label: "Instant Loan Scam",
    objective:
      "Promise fast loan disbursal and force processing or insurance payment first.",
    company: "RapidCash Finance",
    department: "Loan Sanction Desk",
    emailAlias: "loans",
    upiHandle: "loan-clearance",
    domain: "rapidcash-approval.com",
    employeePrefix: "LON",
    casePrefix: "LOAN",
    txnPrefix: "DSB",
    shortCode: "loan",
    pathSegment: "instant-disbursal",
    amountSamples: ["Rs. 2,999", "Rs. 4,500", "Rs. 7,250"],
    defaultDemand:
      "Pay pre-disbursal charge now and share OTP so your loan can be released instantly.",
    openingLines: [
      "Your personal loan is approved and ready for same-day credit.",
      "Final verification pending before disbursal to your account."
    ],
    pressureLines: [
      "Disbursal will auto-cancel after this verification window.",
      "Only one quick payment is required from your side.",
      "Act now to avoid sanction expiry."
    ]
  },
  {
    id: "tech_support",
    label: "Remote Access Tech Support Scam",
    objective:
      "Claim device compromise and push remote access app plus emergency payment.",
    company: "Device Secure Support",
    department: "Technical Risk Team",
    emailAlias: "support",
    upiHandle: "techfix-help",
    domain: "secure-device-fix.com",
    employeePrefix: "TEC",
    casePrefix: "CASE",
    txnPrefix: "FIX",
    shortCode: "tech",
    pathSegment: "remote-secure",
    amountSamples: ["Rs. 1,200", "Rs. 2,400", "Rs. 4,800"],
    defaultDemand:
      "Install remote support app now, then pay diagnostic fee and share OTP to secure the device.",
    openingLines: [
      "Critical alert: malware activity detected on your device from foreign login.",
      "Security center warning: your phone is exposed and needs immediate remote cleanup."
    ],
    pressureLines: [
      "If not fixed now, your banking apps may be compromised.",
      "You must complete verification before the scan can proceed.",
      "Do not delay, this is a high-risk incident."
    ]
  },
  {
    id: "social_media",
    label: "Social Media Verification Scam",
    objective:
      "Claim account violation and ask password reset OTP or verification payment.",
    company: "InstaConnect Support",
    department: "Account Compliance Team",
    emailAlias: "compliance",
    upiHandle: "social-verify",
    domain: "instaconnect-check.com",
    employeePrefix: "SOC",
    casePrefix: "SM",
    txnPrefix: "ACC",
    shortCode: "soc",
    pathSegment: "appeal",
    amountSamples: ["Rs. 499", "Rs. 999", "Rs. 1,999"],
    defaultDemand:
      "Share the login OTP now and pay verification charge to prevent permanent account suspension.",
    openingLines: [
      "Notice: policy violation detected and your social account is queued for suspension.",
      "Your account appeal is pending urgent verification."
    ],
    pressureLines: [
      "Appeal link expires in minutes.",
      "Without immediate action, your account will be disabled permanently.",
      "Complete verification now to avoid data loss."
    ]
  },
  {
    id: "government_subsidy",
    label: "Government Subsidy Scam",
    objective:
      "Pretend subsidy release and collect fee, account details, and OTP.",
    company: "Citizen Benefits Cell",
    department: "Subsidy Disbursal Office",
    emailAlias: "benefits",
    upiHandle: "govt-release",
    domain: "benefit-credit-portal.com",
    employeePrefix: "GOV",
    casePrefix: "BEN",
    txnPrefix: "SUB",
    shortCode: "gov",
    pathSegment: "release-fund",
    amountSamples: ["Rs. 750", "Rs. 1,250", "Rs. 2,100"],
    defaultDemand:
      "Pay verification charge and share OTP immediately so subsidy can be credited today.",
    openingLines: [
      "You are eligible for urgent government subsidy transfer this cycle.",
      "Your subsidy file is approved and awaiting final activation."
    ],
    pressureLines: [
      "Funds will be reverted if activation is not done now.",
      "This is a one-time verification requirement.",
      "Complete the process before the daily settlement closes."
    ]
  },
  {
    id: "romance_extortion",
    label: "Romance Extortion Scam",
    objective:
      "Build emotional urgency and pressure immediate transfer to resolve fabricated crisis.",
    company: "Private Assistance Contact",
    department: "Emergency Desk",
    emailAlias: "help",
    upiHandle: "urgent-personal",
    domain: "priority-help-now.com",
    employeePrefix: "EMG",
    casePrefix: "TKT",
    txnPrefix: "HELP",
    shortCode: "rom",
    pathSegment: "urgent",
    amountSamples: ["Rs. 5,000", "Rs. 12,000", "Rs. 20,000"],
    defaultDemand:
      "Send emergency transfer now and share transaction confirmation plus OTP quickly.",
    openingLines: [
      "I am in urgent trouble right now and need immediate financial help.",
      "Emergency situation, I cannot call; please help with quick transfer now."
    ],
    pressureLines: [
      "Please act quickly, there is no time left.",
      "I will repay once this emergency is resolved.",
      "Delay will make this situation much worse."
    ]
  },
  {
    id: "qr_refund",
    label: "QR Refund Scam",
    objective:
      "Pose as merchant support and trick victim into scanning QR or approving collect request.",
    company: "QuickPay Merchant Help",
    department: "Refund Settlement Team",
    emailAlias: "refunds",
    upiHandle: "refund-center",
    domain: "quickpay-refund-help.com",
    employeePrefix: "RFD",
    casePrefix: "RFD",
    txnPrefix: "RFN",
    shortCode: "rfd",
    pathSegment: "instant-refund",
    amountSamples: ["Rs. 999", "Rs. 1,850", "Rs. 3,299"],
    defaultDemand:
      "Scan the QR now and share OTP to receive refund instantly in your account.",
    openingLines: [
      "Your failed payment refund is ready and waiting for acceptance.",
      "We detected pending refund against your recent transaction."
    ],
    pressureLines: [
      "Refund request expires in a few minutes.",
      "Approve quickly or the amount will be reversed.",
      "Complete this now to avoid another refund delay."
    ]
  }
];
