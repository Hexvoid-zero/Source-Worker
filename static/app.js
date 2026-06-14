"use strict";
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rfetch(url, opts, tries) {
  tries = tries || 4;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); }
    catch (e) { if (i < tries - 1) { await sleep(500 * (i + 1)); continue; } throw e; }
  }
}
async function api(path, opts) {
  const res = await rfetch("/api" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}
function toast(m, ms) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms || 2600); }

function fmt(text) {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, (m, c) => `<pre>${c}</pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
}

const S = { jobId: null, poll: null, open: {} };
const KIND_ICON = { research: "🔎", analyze: "📊", write: "✍", code: "‹›", design: "🎨", data: "🗄", plan: "🧭", synthesize: "🧩" };
const TERMINAL = ["done", "failed", "cancelled"];

// --------------------------------------------------------------------------- boot
async function boot() {
  try {
    const h = await api("/health");
    const s = $("status");
    s.className = "status " + (h.llm ? "on" : "off");
    s.innerHTML = `<span class="dot"></span> ${h.llm ? (h.models[0] || "ready") : "Ollama offline"}`;
  } catch (e) { $("status").innerHTML = `<span class="dot"></span> backend offline`; }
  await Promise.all([loadRouting(), loadJobs(), loadConnectors()]);
}

async function loadRouting() {
  try {
    const m = await api("/models");
    const el = $("routing"); el.innerHTML = "";
    const order = ["plan", "research", "analyze", "write", "code", "design", "data", "synthesize"];
    for (const k of order) {
      if (!m.routing[k]) continue;
      const r = document.createElement("div"); r.className = "route-row";
      r.innerHTML = `<span class="rk">${k}</span><span class="rm">${m.routing[k]}</span>`;
      el.appendChild(r);
    }
  } catch (e) {}
}

async function loadJobs() {
  const jobs = await api("/jobs").catch(() => []);
  const el = $("jobList"); el.innerHTML = "";
  if (!jobs.length) { el.innerHTML = '<div class="hint" style="padding:2px 4px">No jobs yet.</div>'; return; }
  for (const j of jobs) {
    const row = document.createElement("div");
    row.className = "job" + (j.id === S.jobId ? " active" : "");
    row.innerHTML = `<span class="js ${j.status}"></span><span class="jt">${j.title || "job"}</span><span class="jx">✕</span>`;
    row.querySelector(".jt").onclick = () => openJob(j.id);
    row.querySelector(".jx").onclick = async (e) => { e.stopPropagation(); await api(`/jobs/${j.id}`, { method: "DELETE" }); if (S.jobId === j.id) newJob(); loadJobs(); };
    el.appendChild(row);
  }
}

async function loadConnectors() {
  const conns = await api("/connectors").catch(() => []);
  const el = $("connList"); el.innerHTML = "";
  for (const c of conns) {
    const row = document.createElement("div");
    row.className = "conn" + (c.connected ? " on" : "");
    row.innerHTML = `<div class="conn-l"><span class="conn-dot"></span><span class="conn-name">${c.name}</span></div>` +
      `<div class="conn-actions"><button class="conn-toggle ${c.connected ? 'on' : ''}" title="${c.connected ? 'Disconnect' : 'Connect'}">${c.connected ? '●' : '○'}</button>` +
      (c.builtin ? "" : `<button class="conn-rm" title="Remove">✕</button>`) + `</div>`;
    row.querySelector(".conn-toggle").onclick = async () => { await api(`/connectors/${c.id}/toggle`, { method: "PUT" }); loadConnectors(); };
    const rm = row.querySelector(".conn-rm");
    if (rm) rm.onclick = async () => { await api(`/connectors/${c.id}`, { method: "DELETE" }); loadConnectors(); };
    el.appendChild(row);
  }
}

// --------------------------------------------------------------------------- jobs
function newJob() {
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  S.jobId = null; S.open = {};
  $("hero").hidden = false; $("mission").hidden = true;
  $("goal").value = ""; loadJobs();
}

async function run() {
  const goal = $("goal").value.trim();
  if (!goal) return;
  try {
    const { id } = await api("/jobs", { method: "POST", body: JSON.stringify({ goal }) });
    openJob(id);
    loadJobs();
  } catch (e) { toast("Failed to start: " + e.message, 4000); }
}

async function openJob(id) {
  S.jobId = id; S.open = {};
  $("hero").hidden = true; $("mission").hidden = false;
  $("tasks").innerHTML = ""; $("final").hidden = true;
  if (S.poll) clearInterval(S.poll);
  const tick = async () => {
    let job;
    try { job = await api(`/jobs/${id}`); } catch (e) { return; }
    renderJob(job);
    if (TERMINAL.includes(job.status)) { clearInterval(S.poll); S.poll = null; loadJobs(); }
  };
  await tick();
  S.poll = setInterval(tick, 1500);
  loadJobs();
}

function renderJob(job) {
  $("missionGoal").textContent = job.goal;
  $("jobStatus").className = "pill " + job.status;
  $("jobStatus").textContent = job.status;
  $("deliverable").textContent = job.deliverable ? "→ " + job.deliverable : "";
  $("cancelJob").hidden = TERMINAL.includes(job.status);

  // steps aggregated from events
  const steps = {};
  for (const e of job.events || []) {
    if (e.type === "task_step") { (steps[e.id] = steps[e.id] || []).push(`${e.step}${e.text ? " " + e.text : ""}`); }
  }

  const el = $("tasks"); el.innerHTML = "";
  if (!job.tasks.length && job.status === "planning") {
    el.innerHTML = `<div class="hint" style="padding:8px"><span class="spin" style="display:inline-block;vertical-align:middle"></span> Planning — decomposing the goal into subtasks…</div>`;
  }
  for (const t of job.tasks) {
    const st = t.status || "pending";
    const icon = st === "done" ? "✓" : st === "running" ? "" : KIND_ICON[t.kind] || "•";
    const card = document.createElement("div");
    card.className = "task" + (t.spawned_by ? " spawned" : "");
    const ts = (steps[t.id] || []).slice(-8).map((s) => `<span class="tstep">${s.replace(/</g, "&lt;")}</span>`).join("");
    card.innerHTML =
      `<div class="task-head">
        <span class="task-icon ti-${st}">${icon}</span>
        <div style="flex:1;min-width:0">
          <div class="task-title">${t.title}</div>
          <div class="task-sub"><span class="kind">${t.kind}</span>${t.model ? `<span class="task-model">${t.model}</span>` : ""}<span>${st}</span></div>
        </div>
        ${st === "running" ? '<span class="spin"></span>' : ""}
      </div>
      ${ts ? `<div class="task-steps">${ts}</div>` : ""}`;
    if (t.output && st === "done") {
      const out = document.createElement("div"); out.className = "task-output assistant";
      out.innerHTML = "<p>" + fmt(t.output) + "</p>";
      out.hidden = !S.open[t.id];
      card.querySelector(".task-head").onclick = () => { S.open[t.id] = !S.open[t.id]; out.hidden = !S.open[t.id]; };
      card.appendChild(out);
    }
    el.appendChild(card);
  }

  if (job.final && TERMINAL.includes(job.status)) {
    $("final").hidden = false;
    $("finalBody").innerHTML = "<p>" + fmt(job.final) + "</p>";
    $("dlFinal").onclick = () => {
      const blob = new Blob([job.final], { type: "text/markdown" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deliverable.md"; a.click();
    };
  }
}

// --------------------------------------------------------------------------- wire
document.addEventListener("DOMContentLoaded", () => {
  $("newJob").onclick = newJob;
  $("run").onclick = run;
  $("goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); });
  $("examples").querySelectorAll("button").forEach((b) => (b.onclick = () => { $("goal").value = b.textContent; run(); }));
  $("cancelJob").onclick = async () => { if (S.jobId) { await api(`/jobs/${S.jobId}/cancel`, { method: "POST" }); toast("Cancelling…"); } };
  $("addConn").onclick = () => ($("connModal").hidden = false);
  $("connCancel").onclick = () => ($("connModal").hidden = true);
  $("connSave").onclick = async () => {
    const name = $("connName").value.trim(), url = $("connUrl").value.trim();
    if (!name) { toast("Name required"); return; }
    await api("/connectors", { method: "POST", body: JSON.stringify({ name, kind: "mcp", config: url, connected: true }) });
    $("connModal").hidden = true; $("connName").value = ""; $("connUrl").value = ""; loadConnectors(); toast("Connector added");
  };
  boot();
});
