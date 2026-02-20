# Scammer Mirror API Tester

Web app to self-test honeypot APIs by simulating scammer conversations for up to 10 turns.

## What It Does
- Collects:
  - OpenAI API key (used to generate scammer messages)
  - Target endpoint URL
  - Optional target `x-api-key`
- Sends requests in the same shape described in your PDF:
  - `sessionId`
  - `message` (`sender: "scammer"`, `text`, `timestamp`)
  - `conversationHistory`
  - `metadata`
- Reads endpoint replies in order: `reply`, then `message`, then `text`
- Hard-caps runs to `10` turns
- Shows:
  - Turn-by-turn transcript
  - Endpoint latency and status per turn
  - Extracted scam intelligence (phones, UPI IDs, links, emails, case IDs, etc.)
  - Final output preview compatible with honeypot evaluation format

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
