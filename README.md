# Source Worker ⬡

A **digital worker** in the SourceMind suite. You describe an outcome; it turns it into finished work —
instead of answering one question at a time, it **decomposes the goal into subtasks, routes each to the
best-suited model, runs them asynchronously, and synthesizes one deliverable**.

## What it does

- Multi-step work: research, reports, writing, coding, dashboards, presentations, recurring workflows
- **Task decomposition** — a planner breaks the goal into a dependency graph of subtasks
- **Model routing** — each subtask goes to the model best at that job (code/analysis → your largest
  local model, research → a fast small one, etc.); the routing table is shown live in the sidebar
- **Async sub-agents** — subtasks run in order; a blocked task can spawn more sub-tasks, search the
  web, or run code to get unstuck
- **Synthesis** — all results are assembled into one finished deliverable (saved as `deliverable.md`)
- **Connectors** — Slack, Notion, Google Drive, Snowflake, Salesforce, HubSpot (toggle to connect) plus
  custom MCP servers; the worker's sub-agents can call them as tools

Runs locally on [Ollama](https://ollama.com). Jobs persist in `%LOCALAPPDATA%\SourceWorker`; each job
gets its own workspace folder with the files it produced.

## How it works

`Goal → plan (decompose) → route each subtask to a model → execute with tools (web / files / shell /
connectors), spawning sub-agents when blocked → synthesize the deliverable.` Jobs run in the background
and are polled live, so long-running work keeps going and the UI shows the task graph filling in.

## Run from source

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python launcher.py     # http://127.0.0.1:8785
```

Needs Ollama running with at least one chat model (more models = better routing).

## Build the standalone .exe

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
# -> dist\SourceWorker\SourceWorker.exe
```

Opens as a native app window (embedded WebView2, falling back to Edge/Chrome `--app` — no browser chrome).

## Note

Built-in connectors are a framework: toggling one "connects" it for the worker, but live data from
Slack/Notion/Snowflake/etc. requires real API credentials or an MCP backend. `shell` and file tools act
within each job's workspace folder.
