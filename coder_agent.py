"""Source Work Coder — a Claude-Code-style coding agent (shared core).

A streaming, tool-using agent that works inside a real repository: it explores and reads
files, edits them, runs commands, and iterates until the task is done — driven by a local
Ollama model with a one-JSON-action-per-turn protocol. This single module backs all three
front-ends: the web view, the terminal CLI, and the VS Code extension.

Public API:
    run_coder(repo, task, model, history=None) -> generator of event dicts
    list_models(), resolve_model()  (thin Ollama helpers, self-contained)
"""
import os
import re
import json
import time
import fnmatch
import subprocess
from pathlib import Path

import httpx

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MAX_STEPS = int(os.getenv("SWC_MAX_STEPS", "40"))
MAX_BYTES = 200_000

SYSTEM = r"""You are Source Work Coder, an expert software engineer working in a real code
repository — like Claude Code. You accomplish the user's task by exploring the repo, editing
files, and running commands, verifying as you go.

Respond with EXACTLY ONE JSON object per turn and NOTHING else:
{"action":"think","text":"a brief plan or reasoning for the next step"}
{"action":"list_dir","path":"."}
{"action":"read_file","path":"src/app.py"}
{"action":"search","query":"text or regex to find","glob":"*.py"}
{"action":"write_file","path":"src/new_file.py","content":"the FULL file content"}
{"action":"edit_file","path":"src/app.py","old":"exact existing text","new":"replacement text"}
{"action":"run","command":"pytest -q"}
{"action":"final","text":"a short markdown summary of what you changed and why"}

Rules:
- Output EXACTLY ONE JSON object per turn — nothing before or after it. Do NOT combine two
  actions. Every object has an "action" key plus that action's own keys (e.g. "path",
  "command", "content"). Never put a bare string as a value without its key.
- Take ONE step per turn. Read a file before you edit it.
- edit_file replaces the FIRST exact occurrence of "old" (match whitespace exactly); use a
  unique snippet. Use write_file for brand-new files.
- After meaningful changes, run the project's tests or the relevant command to verify, and
  fix any failures before finishing.
- Keep going until the task is fully complete, then reply with a "final" action.
- No prose, no markdown fences. Escape quotes as \" and newlines as \n inside JSON strings.

Example of a correct first turn (you would output ONLY this line):
{"action":"list_dir","path":"."}
Then, after seeing the result, a later turn might be:
{"action":"write_file","path":"calc.py","content":"def add(a, b):\n    return a + b\n\nif __name__ == \"__main__\":\n    print(add(2, 3))\n"}
"""


# --------------------------------------------------------------------------- Ollama helpers
def list_models() -> list[str]:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3.0)
        return [m["name"] for m in r.json().get("models", []) if "embed" not in m.get("name", "")]
    except Exception:
        return []


def resolve_model(preferred: str | None = None) -> str | None:
    names = list_models()
    if preferred and (preferred in names or f"{preferred}:latest" in names):
        return preferred if preferred in names else f"{preferred}:latest"
    env = os.getenv("OLLAMA_MODEL", "")
    if env and (env in names or f"{env}:latest" in names):
        return env if env in names else f"{env}:latest"
    # prefer a coding-capable local model, else the largest non-cloud
    for hint in ("qwen3.5", "qwen2.5-coder", "deepseek-coder", "codellama", "qwen"):
        for n in names:
            if hint in n and not n.endswith("cloud"):
                return n
    local = [n for n in names if not n.endswith("cloud")]
    return (local or names or [None])[0]


def _llm(messages: list[dict], model: str, max_tokens: int = 2000) -> str | None:
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            # think=False: qwen3-style reasoning models otherwise return empty content.
            json={"model": model, "messages": messages, "stream": False, "think": False,
                  "options": {"num_predict": max_tokens, "temperature": 0.2}},
            timeout=600.0,
        )
        r.raise_for_status()
        return r.json()["message"]["content"]
    except Exception as e:
        return f"__LLM_ERROR__ {e}"


def _parse_action(raw: str):
    """Pull the first JSON object out of the model's reply (tolerant of fences/prose)."""
    if not raw:
        return None
    s = raw.strip()
    s = re.sub(r"^```(?:json)?|```$", "", s, flags=re.MULTILINE).strip()
    start = s.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    blob = s[start:i + 1]
                    try:
                        return json.loads(blob)
                    except Exception:
                        try:
                            return json.loads(blob.replace("\n", "\\n"))
                        except Exception:
                            return None
    return None


# --------------------------------------------------------------------------- repo-scoped tools
def _safe(repo: Path, path: str) -> Path:
    p = (repo / (path or ".")).resolve()
    if not str(p).startswith(str(repo.resolve())):
        raise ValueError("path escapes the repository")
    return p


def _list_dir(repo: Path, path: str) -> str:
    base = _safe(repo, path or ".")
    if not base.is_dir():
        return f"(not a directory: {path})"
    rows = []
    for c in sorted(base.iterdir(), key=lambda c: (c.is_file(), c.name.lower())):
        if c.name in (".git", "node_modules", "__pycache__", ".venv"):
            continue
        rows.append(("DIR  " if c.is_dir() else "file ") + c.name)
    return "\n".join(rows) or "(empty)"


def _read_file(repo: Path, path: str) -> str:
    p = _safe(repo, path)
    if not p.is_file():
        return f"(not found: {path})"
    if p.stat().st_size > MAX_BYTES:
        return f"(file too large: {p.stat().st_size} bytes)"
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    numbered = "\n".join(f"{i+1:>4}  {ln}" for i, ln in enumerate(lines[:1200]))
    return numbered or "(empty file)"


def _write_file(repo: Path, path: str, content: str) -> str:
    p = _safe(repo, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"wrote {path} ({len(content)} chars, {content.count(chr(10))+1} lines)"


def _edit_file(repo: Path, path: str, old: str, new: str) -> str:
    p = _safe(repo, path)
    if not p.is_file():
        return f"(not found: {path})"
    text = p.read_text(encoding="utf-8", errors="replace")
    if old not in text:
        return "(edit failed: 'old' text not found — read the file again and copy an exact, unique snippet)"
    if text.count(old) > 1:
        return f"(edit failed: 'old' text appears {text.count(old)} times — include more surrounding context to make it unique)"
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    return f"edited {path}"


def _search(repo: Path, query: str, glob: str) -> str:
    if not query:
        return "(search needs a query)"
    try:
        rx = re.compile(query, re.IGNORECASE)
    except re.error:
        rx = re.compile(re.escape(query), re.IGNORECASE)
    glob = glob or "*"
    hits, scanned = [], 0
    for p in repo.rglob("*"):
        if any(part in (".git", "node_modules", "__pycache__", ".venv") for part in p.parts):
            continue
        if not p.is_file() or not fnmatch.fnmatch(p.name, glob):
            continue
        scanned += 1
        if scanned > 2000:
            break
        try:
            for i, ln in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines()):
                if rx.search(ln):
                    hits.append(f"{p.relative_to(repo)}:{i+1}: {ln.strip()[:160]}")
                    if len(hits) >= 60:
                        break
        except Exception:
            continue
        if len(hits) >= 60:
            break
    return "\n".join(hits) or "(no matches)"


def _run(repo: Path, command: str) -> str:
    try:
        p = subprocess.run(command, cwd=str(repo), shell=True, capture_output=True,
                           text=True, timeout=180)
        out = (p.stdout or "") + (("\n[stderr]\n" + p.stderr) if p.stderr else "")
        return (f"$ {command}\n" + (out or f"(exit {p.returncode}, no output)"))[:8000]
    except subprocess.TimeoutExpired:
        return f"$ {command}\n(timed out after 180s)"
    except Exception as e:
        return f"$ {command}\n(error: {e})"


# --------------------------------------------------------------------------- the agent loop
def run_coder(repo, task: str, model: str | None = None, history: list | None = None):
    """Run the coding agent, yielding event dicts:
       {type: start|think|tool|tool_result|file_edit|final|error, ...}
    """
    repo = Path(repo).resolve()
    repo.mkdir(parents=True, exist_ok=True)
    model = resolve_model(model)
    if not model:
        yield {"type": "error", "text": "No Ollama model available. Pull one, e.g. `ollama pull qwen3.5:4b`."}
        return

    yield {"type": "start", "model": model, "repo": str(repo)}

    messages = [{"role": "system", "content": SYSTEM}]
    for h in (history or []):
        if isinstance(h, dict) and h.get("role") in ("user", "assistant") and h.get("content"):
            messages.append({"role": h["role"], "content": str(h["content"])})
    messages.append({"role": "user", "content": f"Repository root: {repo}\n\nTask:\n{task}"})

    fails = 0
    for _ in range(MAX_STEPS):
        raw = _llm(messages, model, max_tokens=2000)
        if raw and raw.startswith("__LLM_ERROR__"):
            yield {"type": "error", "text": raw.replace("__LLM_ERROR__", "Ollama error:")}
            return
        action = _parse_action(raw or "")
        if not action or "action" not in action:
            # Smaller models occasionally emit malformed JSON — nudge and retry instead of bailing.
            fails += 1
            if fails >= 3:
                yield {"type": "final", "text": (raw or "").strip() or "(could not parse a valid action)"}
                return
            messages += [{"role": "assistant", "content": raw or ""},
                         {"role": "user", "content": 'That was not a single valid JSON action. Reply with EXACTLY one '
                          'JSON object and nothing else, e.g. {"action":"list_dir","path":"."}'}]
            continue
        fails = 0

        a = action.get("action")
        if a == "think":
            yield {"type": "think", "text": str(action.get("text", ""))}
            messages += [{"role": "assistant", "content": raw}, {"role": "user", "content": "Continue."}]
            continue
        if a == "final":
            yield {"type": "final", "text": str(action.get("text", ""))}
            return

        try:
            if a == "list_dir":
                arg = action.get("path", "."); result = _list_dir(repo, arg)
            elif a == "read_file":
                arg = action.get("path", ""); result = _read_file(repo, arg)
            elif a == "search":
                arg = action.get("query", ""); result = _search(repo, arg, action.get("glob", "*"))
            elif a == "write_file":
                arg = action.get("path", ""); result = _write_file(repo, arg, str(action.get("content", "")))
                yield {"type": "file_edit", "path": arg, "kind": "write"}
            elif a == "edit_file":
                arg = action.get("path", ""); result = _edit_file(repo, arg, str(action.get("old", "")), str(action.get("new", "")))
                if not result.startswith("(edit failed"):
                    yield {"type": "file_edit", "path": arg, "kind": "edit"}
            elif a == "run":
                arg = action.get("command", ""); result = _run(repo, arg)
            else:
                arg = ""; result = f"(unknown action: {a})"
        except Exception as e:
            arg, result = "", f"(tool error: {e})"

        yield {"type": "tool", "name": a, "arg": str(arg)[:200]}
        yield {"type": "tool_result", "name": a, "result": result[:4000]}
        messages += [{"role": "assistant", "content": raw},
                     {"role": "user", "content": f"Result of {a}:\n{result[:6000]}"}]

    yield {"type": "final", "text": "Reached the step limit. Ask me to continue."}
