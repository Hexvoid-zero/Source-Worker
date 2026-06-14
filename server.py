"""Source Worker — a digital worker that turns a goal into finished work.

Instead of answering one question at a time, it decomposes a goal into a task
graph, routes each subtask to the best-suited model, runs them asynchronously
(spawning sub-tasks and searching for missing info when blocked), then
synthesizes one finished deliverable. Uses local Ollama models and pluggable
connectors (Slack, Notion, Google Drive, Snowflake, Salesforce, HubSpot, MCP).
Serves its own UI; packaged to a standalone exe.
"""
import html as html_lib
import json
import os
import re
import string
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")
DATA_DIR = Path(os.getenv("SOURCE_WORKER_DATA") or (Path(os.getenv("LOCALAPPDATA") or Path.home()) / "SourceWorker"))
JOBS_DIR = DATA_DIR / "jobs"
CONNECTORS_FILE = DATA_DIR / "connectors.json"
WORKSPACES = DATA_DIR / "workspaces"
for d in (DATA_DIR, JOBS_DIR, WORKSPACES):
    d.mkdir(parents=True, exist_ok=True)

STATIC_DIR = (
    Path(sys._MEIPASS) / "static" if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent.parent / "static"
)
MAX_TASKS = 24
MAX_STEPS_PER_TASK = 8
MAX_BYTES = 2_000_000

# built-in connector catalogue (real API calls need credentials / an MCP server)
BUILTIN_CONNECTORS = [
    {"id": "slack", "name": "Slack", "kind": "messaging"},
    {"id": "notion", "name": "Notion", "kind": "docs"},
    {"id": "gdrive", "name": "Google Drive", "kind": "files"},
    {"id": "snowflake", "name": "Snowflake", "kind": "data"},
    {"id": "salesforce", "name": "Salesforce", "kind": "crm"},
    {"id": "hubspot", "name": "HubSpot", "kind": "crm"},
]

app = FastAPI(title="Source Worker")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


# --------------------------------------------------------------------------- LLM + routing
def list_models() -> list[dict]:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3.0)
        out = []
        for m in r.json().get("models", []):
            name = m.get("name", "")
            if name:
                out.append({"name": name, "size": m.get("size", 0) or 0, "is_embed": "embed" in name, "is_cloud": name.endswith("cloud")})
        return out
    except Exception:
        return []


def llm_available() -> bool:
    try:
        return httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2.0).status_code == 200
    except Exception:
        return False


def chat_models() -> list[dict]:
    return sorted([m for m in list_models() if not m["is_embed"] and not m["is_cloud"]], key=lambda m: m["size"], reverse=True)


def route_model(kind: str) -> str | None:
    """Pick the best-suited model for a task kind from installed local models."""
    all_names = {m["name"] for m in list_models()}
    if OLLAMA_MODEL and (OLLAMA_MODEL in all_names or f"{OLLAMA_MODEL}:latest" in all_names):
        return OLLAMA_MODEL if OLLAMA_MODEL in all_names else f"{OLLAMA_MODEL}:latest"
    models = chat_models()
    if not models:
        return next((x["name"] for x in list_models() if not x["is_embed"]), None)
    big = models[0]["name"]
    small = models[-1]["name"]
    mid = models[len(models) // 2]["name"]
    table = {
        "plan": big, "synthesize": big, "code": big, "analyze": big,
        "write": mid, "design": mid, "data": mid, "research": small if len(models) > 1 else mid,
    }
    return table.get(kind, mid)


def llm_chat(messages: list[dict], model: str | None, max_tokens: int = 2000) -> str | None:
    if not model:
        return None
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            # think=False: qwen3-style reasoning models otherwise spend the whole token
            # budget in a hidden 'thinking' field and return empty content.
            json={"model": model, "messages": messages, "stream": False, "think": False, "options": {"num_predict": max_tokens}},
            timeout=600.0,
        )
        r.raise_for_status()
        return r.json()["message"]["content"]
    except Exception:
        return None


def tmpl(s: str, **kw) -> str:
    """Fill {name} placeholders without touching literal JSON braces in the text."""
    for k, v in kw.items():
        s = s.replace("{" + k + "}", str(v))
    return s


def parse_json(raw: str):
    if not raw:
        return None
    raw = re.sub(r"```(?:json)?", "", raw)  # strip code fences
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    cand = m.group(0)
    attempts = [
        cand,
        re.sub(r",\s*([}\]])", r"\1", cand),          # trailing commas
        re.sub(r",\s*([}\]])", r"\1", cand).replace("\n", "\\n"),
    ]
    for a in attempts:
        try:
            return json.loads(a)
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- connectors
def load_connectors() -> list[dict]:
    if CONNECTORS_FILE.exists():
        try:
            saved = json.loads(CONNECTORS_FILE.read_text(encoding="utf-8"))
        except Exception:
            saved = {}
    else:
        saved = {}
    out = []
    for c in BUILTIN_CONNECTORS:
        s = saved.get(c["id"], {})
        out.append({**c, "builtin": True, "connected": bool(s.get("connected")), "config": s.get("config", "")})
    for cid, s in saved.items():
        if not any(b["id"] == cid for b in BUILTIN_CONNECTORS):
            out.append({"id": cid, "name": s.get("name", cid), "kind": s.get("kind", "mcp"), "builtin": False,
                        "connected": bool(s.get("connected")), "config": s.get("config", "")})
    return out


def save_connectors(items: dict):
    CONNECTORS_FILE.write_text(json.dumps(items), encoding="utf-8")


def connector_state() -> dict:
    if CONNECTORS_FILE.exists():
        try:
            return json.loads(CONNECTORS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def use_connector(service: str, request: str) -> str:
    state = connector_state()
    s = state.get(service)
    known = {c["id"]: c["name"] for c in load_connectors()}
    if service not in known:
        return f"(unknown connector '{service}'. Available: {', '.join(known)})"
    if not (s and s.get("connected")):
        return f"({known[service]} is not connected. Connect it in the Connectors panel to let the worker use it.)"
    # Connected: in this local build connectors are framework stubs unless backed by
    # an MCP server. Return a structured acknowledgement the agent can build on.
    return f"[{known[service]}] handled request: {request[:200]} (connected; configure an MCP backend for live data)"


# --------------------------------------------------------------------------- tools (workspace-scoped)
def job_ws(job: dict) -> Path:
    p = WORKSPACES / job["id"]
    p.mkdir(parents=True, exist_ok=True)
    return p


def t_web_search(query: str) -> str:
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    try:
        page = httpx.get(url, headers={"User-Agent": "SourceWorker/0.1"}, timeout=20.0, follow_redirects=True).text
    except Exception as e:
        return f"(search failed: {e})"
    out = []
    pat = re.compile(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', re.DOTALL)
    for m in pat.finditer(page):
        href = urllib.parse.parse_qs(urllib.parse.urlparse(m.group(1)).query).get("uddg", [m.group(1)])[0]
        title = html_lib.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        snip = html_lib.unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip()
        out.append(f"- {title}\n  {href}\n  {snip}")
        if len(out) >= 6:
            break
    return "\n".join(out) or "(no results)"


def t_write_file(job: dict, path: str, content: str) -> str:
    target = (job_ws(job) / path).resolve()
    if not str(target).startswith(str(job_ws(job).resolve())):
        return "(path not allowed)"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"wrote {path} ({len(content)} chars)"


def t_read_file(job: dict, path: str) -> str:
    target = (job_ws(job) / path).resolve()
    if not str(target).startswith(str(job_ws(job).resolve())) or not target.is_file():
        return f"(not found: {path})"
    return target.read_text(encoding="utf-8", errors="replace")[:8000]


def t_shell(job: dict, command: str) -> str:
    try:
        p = subprocess.run(command, cwd=str(job_ws(job)), shell=True, capture_output=True, text=True, timeout=90)
        return ((p.stdout or "") + (("\n[stderr]\n" + p.stderr) if p.stderr else ""))[:6000] or f"(exit {p.returncode})"
    except Exception as e:
        return f"(error: {e})"


# --------------------------------------------------------------------------- the worker
PLANNER_SYSTEM = """You are the planner of a digital worker. Decompose the user's GOAL into a minimal
ordered set of concrete subtasks that together produce a finished deliverable.

Return ONE JSON object, nothing else:
{"deliverable":"<one line: what the finished output is, e.g. 'a markdown research report saved as report.md'>",
 "tasks":[{"id":1,"title":"short title","kind":"research|analyze|write|code|design|data","deps":[],"detail":"precise, self-contained instructions for this subtask"}]}

Rules: 3 to 7 tasks. deps reference earlier task ids only. The FINAL task must assemble
and write the deliverable file into the workspace. Choose 'kind' honestly so the right model is used.
GOAL:
{goal}"""

WORKER_SYSTEM = """You are a sub-agent of a digital worker, executing ONE subtask of a larger goal.
Work in the shared workspace folder. Use tools to actually do the work. Reply with ONE JSON object:
{"action":"think","text":"..."}
{"action":"web_search","query":"..."}
{"action":"read_file","path":"rel/path"}
{"action":"write_file","path":"rel/path","content":"FULL content"}
{"action":"shell","command":"..."}
{"action":"use_connector","service":"slack|notion|gdrive|snowflake|salesforce|hubspot","request":"what you need"}
{"action":"subtask","title":"...","kind":"research|analyze|write|code|design|data","detail":"..."}   // spawn a sub-agent if blocked
{"action":"final","text":"the result/output of THIS subtask in markdown"}

Rules: take real actions; don't fake results. If blocked or missing info, web_search, use a connector, or spawn a subtask.
Keep the subtask focused. End with "final" describing what you produced (and any files written).

OVERALL GOAL: {goal}
DELIVERABLE: {deliverable}
THIS SUBTASK: {title}
INSTRUCTIONS: {detail}
{context}"""

SYNTH_SYSTEM = """You are the synthesizer of a digital worker. Combine the subtask results below into the
single finished DELIVERABLE the user asked for. Produce the complete, polished final output in markdown.
Do not describe the process; produce the actual deliverable.

GOAL: {goal}
DELIVERABLE: {deliverable}

SUBTASK RESULTS:
{results}"""


def emit(job: dict, etype: str, **kw):
    job["events"].append({"t": time.time(), "type": etype, **kw})
    persist(job)


def persist(job: dict):
    try:
        (JOBS_DIR / f"{job['id']}.json").write_text(json.dumps(job), encoding="utf-8")
    except Exception:
        pass


def run_task(job: dict, task: dict):
    task["status"] = "running"
    task["model"] = route_model(task.get("kind", "write"))
    emit(job, "task_start", id=task["id"], title=task["title"], kind=task.get("kind"), model=task["model"])

    deps_out = ""
    for d in task.get("deps", []):
        dt = next((t for t in job["tasks"] if t["id"] == d), None)
        if dt and dt.get("output"):
            deps_out += f"\n[Result of task {d} — {dt['title']}]:\n{dt['output'][:2500]}\n"
    context = f"\nRESULTS FROM DEPENDENCIES:{deps_out}" if deps_out else ""

    messages = [{"role": "system", "content": tmpl(
        WORKER_SYSTEM, goal=job["goal"], deliverable=job.get("deliverable", ""), title=task["title"],
        detail=task.get("detail", ""), context=context)}]
    messages.append({"role": "user", "content": "Begin this subtask. Respond with one JSON action."})

    output = ""
    for _ in range(MAX_STEPS_PER_TASK):
        if job.get("cancel"):
            break
        raw = llm_chat(messages, task["model"], max_tokens=2500)
        if not raw:
            output = "(model unavailable)"
            break
        act = parse_json(raw)
        if not act or "action" not in act:
            output = raw.strip()
            break
        a = act["action"]
        if a == "final":
            output = str(act.get("text", ""))
            break
        if a == "think":
            emit(job, "task_step", id=task["id"], step="think", text=str(act.get("text", ""))[:200])
            messages += [{"role": "assistant", "content": raw}, {"role": "user", "content": "Continue."}]
            continue
        if a == "subtask" and len([t for t in job["tasks"]]) < MAX_TASKS:
            nid = max(t["id"] for t in job["tasks"]) + 1
            newt = {"id": nid, "title": act.get("title", "subtask"), "kind": act.get("kind", "research"),
                    "deps": [], "detail": act.get("detail", ""), "status": "pending", "output": "", "spawned_by": task["id"]}
            job["tasks"].append(newt)
            task.setdefault("deps", []).append(nid)
            emit(job, "subtask_added", id=nid, title=newt["title"], by=task["id"])
            run_task(job, newt)  # resolve the spawned subtask now
            messages += [{"role": "assistant", "content": raw},
                         {"role": "user", "content": f"Subtask result:\n{newt.get('output','')[:2500]}\nContinue."}]
            continue
        # plain tools
        if a == "web_search":
            res = t_web_search(str(act.get("query", "")))
        elif a == "read_file":
            res = t_read_file(job, str(act.get("path", "")))
        elif a == "write_file":
            res = t_write_file(job, str(act.get("path", "")), str(act.get("content", "")))
        elif a == "shell":
            res = t_shell(job, str(act.get("command", "")))
        elif a == "use_connector":
            res = use_connector(str(act.get("service", "")), str(act.get("request", "")))
        else:
            output = raw.strip()
            break
        emit(job, "task_step", id=task["id"], step=a, text=(act.get("query") or act.get("path") or act.get("command") or act.get("service") or "")[:160])
        messages += [{"role": "assistant", "content": raw}, {"role": "user", "content": f"Result of {a}:\n{res[:4000]}"}]
    task["output"] = output or "(no output)"
    task["status"] = "done"
    emit(job, "task_done", id=task["id"], output=task["output"][:1500])


def run_job(job_id: str):
    job = _jobs[job_id]
    try:
        if not llm_available():
            job["status"] = "failed"
            job["final"] = "Ollama isn't running. Start it (`ollama serve`) and pull a model."
            emit(job, "final", text=job["final"]); emit(job, "done"); return

        # 1. plan
        job["status"] = "planning"
        emit(job, "status", status="planning")
        pmodel = route_model("plan")
        plan = None
        for attempt in range(3):
            nudge = "Produce the plan as one JSON object." if attempt == 0 else \
                "Return ONLY a valid JSON object with keys 'deliverable' and 'tasks' (an array). No prose, no code fences."
            plan = parse_json(llm_chat([{"role": "system", "content": tmpl(PLANNER_SYSTEM, goal=job["goal"])},
                                        {"role": "user", "content": nudge}], pmodel, max_tokens=1500) or "")
            if plan and isinstance(plan.get("tasks"), list) and plan["tasks"]:
                break
        if not plan or not isinstance(plan.get("tasks"), list) or not plan["tasks"]:
            job["status"] = "failed"; job["final"] = "Could not produce a plan. Try rephrasing the goal."
            emit(job, "final", text=job["final"]); emit(job, "done"); return
        job["deliverable"] = plan.get("deliverable", "the requested output")
        job["tasks"] = [{"id": int(t.get("id", i + 1)), "title": t.get("title", f"Task {i+1}"),
                         "kind": t.get("kind", "write"), "deps": [int(d) for d in t.get("deps", [])],
                         "detail": t.get("detail", ""), "status": "pending", "output": ""}
                        for i, t in enumerate(plan["tasks"][:MAX_TASKS])]
        emit(job, "plan", deliverable=job["deliverable"], tasks=[{k: t[k] for k in ("id", "title", "kind", "deps")} for t in job["tasks"]])

        # 2. execute (dependency order)
        job["status"] = "running"; emit(job, "status", status="running")
        done = set()
        guard = 0
        while len([t for t in job["tasks"] if t["status"] == "done"]) < len(job["tasks"]) and guard < MAX_TASKS * 2:
            guard += 1
            if job.get("cancel"):
                break
            progressed = False
            for t in list(job["tasks"]):
                if t["status"] == "pending" and all(d in done or not any(x["id"] == d for x in job["tasks"]) for d in t.get("deps", [])):
                    run_task(job, t)
                    done.add(t["id"])
                    progressed = True
            if not progressed:  # break dependency deadlock — run remaining pending
                rem = [t for t in job["tasks"] if t["status"] == "pending"]
                if not rem:
                    break
                run_task(job, rem[0]); done.add(rem[0]["id"])

        if job.get("cancel"):
            job["status"] = "cancelled"; emit(job, "status", status="cancelled"); emit(job, "done"); return

        # 3. synthesize deliverable
        job["status"] = "synthesizing"; emit(job, "status", status="synthesizing")
        results = "\n\n".join(f"### {t['title']} ({t['kind']})\n{t.get('output','')}" for t in job["tasks"])[:14000]
        final = llm_chat([{"role": "system", "content": tmpl(SYNTH_SYSTEM, goal=job["goal"], deliverable=job["deliverable"], results=results)},
                          {"role": "user", "content": "Produce the finished deliverable now."}], route_model("synthesize"), max_tokens=3500)
        final = final or results
        t_write_file(job, "deliverable.md", final)
        job["final"] = final
        job["status"] = "done"
        emit(job, "final", text=final)
        emit(job, "done")
    except Exception as e:
        job["status"] = "failed"; job["final"] = f"Worker error: {e}"
        emit(job, "final", text=job["final"]); emit(job, "done")
    finally:
        persist(job)


# --------------------------------------------------------------------------- API
class JobIn(BaseModel):
    goal: str


class ConnectorIn(BaseModel):
    id: str = ""
    name: str = ""
    kind: str = "mcp"
    config: str = ""
    connected: bool = True


@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "llm": llm_available(), "models": [m["name"] for m in chat_models()]}


@app.get("/api/models")
def models():
    return {"models": list_models(), "routing": {k: route_model(k) for k in ("plan", "research", "analyze", "write", "code", "design", "data", "synthesize")}}


@app.post("/api/jobs")
def create_job(body: JobIn):
    if not body.goal.strip():
        raise HTTPException(400, "goal required")
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "goal": body.goal.strip(), "status": "queued", "deliverable": "", "tasks": [],
           "events": [], "final": "", "created": time.time(), "title": body.goal.strip()[:70]}
    with _lock:
        _jobs[jid] = job
    persist(job)
    threading.Thread(target=run_job, args=(jid,), daemon=True).start()
    return {"id": jid}


@app.get("/api/jobs")
def list_jobs():
    out = []
    seen = set()
    for j in _jobs.values():
        out.append({"id": j["id"], "title": j.get("title"), "status": j["status"], "created": j["created"]})
        seen.add(j["id"])
    for p in JOBS_DIR.glob("*.json"):
        if p.stem in seen:
            continue
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            out.append({"id": j["id"], "title": j.get("title"), "status": j["status"], "created": j.get("created", 0)})
        except Exception:
            continue
    out.sort(key=lambda j: j["created"], reverse=True)
    return out


def _load_job(jid: str) -> dict | None:
    if jid in _jobs:
        return _jobs[jid]
    p = JOBS_DIR / f"{jid}.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


@app.get("/api/jobs/{jid}")
def get_job(jid: str, since: int = 0):
    job = _load_job(jid)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "id": job["id"], "goal": job["goal"], "status": job["status"], "deliverable": job.get("deliverable", ""),
        "tasks": job.get("tasks", []), "final": job.get("final", ""), "title": job.get("title"),
        "events": job.get("events", [])[since:], "event_count": len(job.get("events", [])),
    }


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str):
    job = _jobs.get(jid)
    if job:
        job["cancel"] = True
    return {"ok": True}


@app.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    _jobs.pop(jid, None)
    (JOBS_DIR / f"{jid}.json").unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/connectors")
def connectors():
    return load_connectors()


@app.post("/api/connectors")
def add_connector(body: ConnectorIn):
    state = connector_state()
    cid = body.id or re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-") or uuid.uuid4().hex[:6]
    state[cid] = {"name": body.name or cid, "kind": body.kind, "config": body.config, "connected": body.connected}
    save_connectors(state)
    return {"ok": True, "id": cid}


@app.put("/api/connectors/{cid}/toggle")
def toggle_connector(cid: str):
    state = connector_state()
    cur = state.get(cid, {})
    name = cur.get("name") or next((c["name"] for c in BUILTIN_CONNECTORS if c["id"] == cid), cid)
    cur["name"] = name
    cur["connected"] = not cur.get("connected")
    state[cid] = cur
    save_connectors(state)
    return {"ok": True, "connected": cur["connected"]}


@app.delete("/api/connectors/{cid}")
def remove_connector(cid: str):
    state = connector_state()
    state.pop(cid, None)
    save_connectors(state)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/{full_path:path}", include_in_schema=False)
def assets(full_path: str):
    target = (STATIC_DIR / full_path).resolve()
    if str(target).startswith(str(Path(STATIC_DIR).resolve())) and target.is_file():
        return FileResponse(target)
    return FileResponse(STATIC_DIR / "index.html")
