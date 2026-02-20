# Scammer Mirror API Tester

Web app to self-test honeypot APIs with live streaming evaluation runs.

## What It Does
- Collects:
  - OpenAI API key (used to generate scammer messages)
  - Target endpoint URL
  - Optional target `x-api-key`
- Streams run output in real time (turn-by-turn as each request completes)
- Supports:
  - Full suite: `15 scenarios x 10 turns each`
  - Single scenario debug runs
- Sends requests in the same shape described in your PDF:
  - `sessionId`
  - `message` (`sender: "scammer"`, `text`, `timestamp`)
  - `conversationHistory`
  - `metadata`
- Reads endpoint replies in order: `reply`, then `message`, then `text`
- Hard-caps each scenario at `10` turns
- Shows:
  - Live per-scenario transcript
  - Endpoint latency and status per turn
  - Pause/resume controls for outgoing endpoint calls during a run
  - PDF-style scoring breakdown (Scam Detection, Intelligence, Conversation, Engagement, Response Structure)
  - Aggregate intelligence extraction and final output preview

## Run
```bash
npm install
npm start
```

Open `http://localhost:8080`.

## Notes
- Endpoint timeout is 30 seconds per turn.
- No API keys are written to disk.
- If OpenAI generation fails for a turn, the app uses deterministic fallback scammer phrasing so the run can continue.
- Code quality score is not inferred automatically; projected final score assumes code quality score `0/10` unless passed explicitly in API input.
