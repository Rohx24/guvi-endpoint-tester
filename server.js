import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || 8080);
const TURN_CAP = 10;
const ENDPOINT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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

  const input = parsed.value;
  const scenario = pickScenario(input.scenarioId);
  const syntheticIntel = createSyntheticIntel(scenario);
  const sessionId = crypto.randomUUID();
  const metadata = buildMetadata(input.metadata, scenario);
  const client = new OpenAI({ apiKey: input.openaiApiKey });

  const startedAt = Date.now();
  const conversationHistory = [];
  const transcriptForModel = [];
  const turnLogs = [];
  let failure = null;

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
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
      turnLogs.push({
        turn,
        scammerMessage,
        honeypotMessage: null,
        endpointStatus: endpointResult.status,
        endpointLatencyMs: endpointResult.durationMs,
        usedFallback: generatedTurn.usedFallback,
        error: endpointResult.error
      });
      break;
    }

    const honeypotMessage = readHoneypotReply(endpointResult.body);
    if (!honeypotMessage) {
      failure = {
        turn,
        reason:
          "Endpoint response did not include reply, message, or text in JSON body.",
        endpointStatus: endpointResult.status
      };
      turnLogs.push({
        turn,
        scammerMessage,
        honeypotMessage: null,
        endpointStatus: endpointResult.status,
        endpointLatencyMs: endpointResult.durationMs,
        usedFallback: generatedTurn.usedFallback,
        error:
          "Endpoint response did not include reply, message, or text in JSON body."
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

    turnLogs.push({
      turn,
      scammerMessage,
      honeypotMessage,
      endpointStatus: endpointResult.status,
      endpointLatencyMs: endpointResult.durationMs,
      usedFallback: generatedTurn.usedFallback,
      requestPayload
    });
  }

  const endedAt = Date.now();
  const scammerMessages = turnLogs
    .map((turn) => turn.scammerMessage)
    .filter(Boolean);
  const honeypotMessages = turnLogs
    .map((turn) => turn.honeypotMessage)
    .filter(Boolean);

  const extractedIntelligence = extractIntelligence(scammerMessages);
  const metrics = buildConversationMetrics({
    turnLogs,
    honeypotMessages,
    durationMs: endedAt - startedAt
  });

  res.json({
    status: failure ? "partial" : "success",
    sessionId,
    scenario: {
      id: scenario.id,
      label: scenario.label,
      objective: scenario.objective
    },
    maxTurns: input.maxTurns,
    turnCap: TURN_CAP,
    turnsCompleted: turnLogs.length,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    endpoint: {
      url: input.endpointUrl,
      timeoutMs: ENDPOINT_TIMEOUT_MS
    },
    metrics,
    extractedIntelligence,
    finalOutputPreview: buildFinalOutputPreview({
      sessionId,
      extractedIntelligence,
      metrics,
      scenario
    }),
    transcript: turnLogs,
    failure
  });
});

app.listen(PORT, () => {
  console.log(`Scammer tester running on http://localhost:${PORT}`);
});

function parseAndValidateInput(body) {
  const openaiApiKey = asTrimmedString(body.openaiApiKey);
  const endpointUrl = asTrimmedString(body.endpointUrl);
  const endpointApiKey = asTrimmedString(body.endpointApiKey);
  const scenarioId = asTrimmedString(body.scenarioId) || "auto";
  const model = asTrimmedString(body.model) || DEFAULT_MODEL;

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
      scenarioId,
      model,
      maxTurns,
      metadata
    }
  };
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
  }
];
