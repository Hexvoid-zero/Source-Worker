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

const S = { jobId: null, poll: null, wsPoll: null, open: {}, allModels: [], customModels: {} };
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
  await Promise.all([loadRouting(), loadJobs(), loadConnectors(), loadCoderWorkspacePath()]);
}

async function loadRouting() {
  try {
    const m = await api("/models");
    S.allModels = m.models.map(x => x.name);
    
    const psel = $("planModelSelect");
    if (psel) {
      psel.innerHTML = S.allModels.map(name => `<option value="${name}">${name}</option>`).join("");
      if (m.routing["plan"]) {
        psel.value = m.routing["plan"];
      }
    }

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
  closeWorkspacePoll();
  S.jobId = null; S.open = {};
  $("hero").hidden = false; $("mission").hidden = true; $("workspaceView").hidden = true;
  $("coderView").hidden = true;
  $("btnWorkspace").classList.remove("active");
  $("btnCoder").classList.remove("active");
  $("goal").value = ""; loadJobs();
}

async function run() {
  const goal = $("goal").value.trim();
  if (!goal) return;
  const plan_model = $("planModelSelect").value;
  try {
    const { id } = await api("/jobs", { method: "POST", body: JSON.stringify({ goal, plan_model }) });
    openJob(id);
    loadJobs();
  } catch (e) { toast("Failed to start: " + e.message, 4000); }
}

async function openJob(id) {
  S.jobId = id; S.open = {}; S.customModels = {};
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  closeWorkspacePoll();
  
  let job;
  try {
    job = await api(`/jobs/${id}`);
  } catch (e) {
    toast("Failed to load job: " + e.message, 4000);
    return;
  }
  
  loadJobs();
  
  if (job.is_coder) {
    $("hero").hidden = true; $("mission").hidden = true; $("workspaceView").hidden = true;
    $("coderView").hidden = false;
    $("btnWorkspace").classList.remove("active");
    $("btnCoder").classList.add("active");
    document.querySelectorAll("#jobList .job").forEach(j => {
      if (j.id === id) j.classList.add("active");
      else j.classList.remove("active");
    });
    
    renderCoderJob(job);
    loadCoderRecents();
    
    if (!TERMINAL.includes(job.status)) {
      S.poll = setInterval(async () => {
        try {
          const updated = await api(`/jobs/${id}`);
          renderCoderJob(updated);
          if (TERMINAL.includes(updated.status)) {
            clearInterval(S.poll);
            S.poll = null;
            loadJobs();
            loadCoderRecents();
          }
        } catch (e) {}
      }, 1500);
    }
    return;
  }
  
  // Standard job flow
  $("hero").hidden = true; $("mission").hidden = false; $("workspaceView").hidden = true;
  $("coderView").hidden = true;
  $("btnWorkspace").classList.remove("active");
  $("btnCoder").classList.remove("active");
  $("tasks").innerHTML = ""; $("final").hidden = true;
  
  renderJob(job);
  
  if (!TERMINAL.includes(job.status) && job.status !== "pending_approval") {
    S.poll = setInterval(async () => {
      try {
        const updated = await api(`/jobs/${id}`);
        renderJob(updated);
        if (TERMINAL.includes(updated.status) || updated.status === "pending_approval") {
          clearInterval(S.poll);
          S.poll = null;
          loadJobs();
        }
      } catch (e) {}
    }, 1500);
  }
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
    const card = document.createElement("div");
    card.className = "task" + (t.spawned_by ? " spawned" : "") + (job.status === "pending_approval" ? " pending-approval" : "");
    
    if (job.status === "pending_approval") {
      const currentModel = S.customModels[t.id] || t.model;
      const options = S.allModels.map((mname) => {
        const selected = mname === currentModel ? "selected" : "";
        return `<option value="${mname}" ${selected}>${mname}</option>`;
      }).join("");
      
      card.innerHTML =
        `<div class="task-head">
          <span class="task-icon ti-pending">${KIND_ICON[t.kind] || "•"}</span>
          <div style="flex:1;min-width:0">
            <div class="task-title" style="font-weight:600">${t.title}</div>
            <div class="task-detail-preview" style="font-size:11.5px;color:var(--muted);margin-top:3px">${t.detail || ""}</div>
            <div class="task-sub" style="margin-top:6px;gap:8px;display:flex;align-items:center">
              <span class="kind">${t.kind}</span>
              <span style="color:var(--muted);font-size:11px">Model:</span>
              <select class="task-model-select select-premium" data-id="${t.id}" style="padding:3px 6px;border-radius:4px;background:var(--panel2);border:1px solid var(--edge);font-size:11px;color:var(--text)">
                ${options}
              </select>
            </div>
          </div>
        </div>`;
        
      const sel = card.querySelector(".task-model-select");
      if (sel) {
        sel.onchange = (e) => {
          S.customModels[t.id] = e.target.value;
        };
      }
    } else {
      const icon = st === "done" ? "✓" : st === "failed" ? "✗" : st === "running" ? "" : KIND_ICON[t.kind] || "•";
      const ts = (steps[t.id] || []).slice(-8).map((s) => `<span class="tstep">${s.replace(/</g, "&lt;")}</span>`).join("");
      
      if (S.open[t.id] === undefined) {
        S.open[t.id] = (st === "running");
      }
      const isOpen = S.open[t.id];
      
      card.innerHTML =
        `<div class="task-head">
          <span class="task-icon ti-${st}">${icon}</span>
          <div style="flex:1;min-width:0">
            <div class="task-title">${t.title}</div>
            <div class="task-sub">
              <span class="kind">${t.kind}</span>
              ${t.model ? `<span class="task-model">${t.model}</span>` : ""}
              <span>${st}</span>
            </div>
          </div>
          ${st === "running" ? '<span class="spin"></span>' : ""}
        </div>
        <div class="task-body" style="border-top:1px solid var(--edge);padding:11px 13px;background:var(--panel2)" ${isOpen ? "" : "hidden"}>
          ${t.detail ? `<div style="font-size:12px;color:var(--text);margin-bottom:8px"><strong>Instructions:</strong><div style="margin-top:3px;color:var(--muted);white-space:pre-wrap">${t.detail}</div></div>` : ""}
          ${ts ? `<div style="font-size:12px;color:var(--text);margin-bottom:8px"><strong>Thinking / Steps:</strong><div class="task-steps" style="padding:4px 0 0 0;margin-top:3px">${ts}</div></div>` : ""}
          ${(t.output && st === "done") ? `<div style="font-size:12px;color:var(--text);border-top:1px solid var(--edge);padding-top:8px"><strong>Output:</strong><div class="task-output assistant" style="border:none;background:none;padding:5px 0 0 0;max-height:none">${fmt(t.output)}</div></div>` : ""}
        </div>`;

      card.querySelector(".task-head").onclick = () => {
        S.open[t.id] = !S.open[t.id];
        const body = card.querySelector(".task-body");
        if (body) body.hidden = !S.open[t.id];
      };
    }
    el.appendChild(card);
  }

  if (job.status === "pending_approval") {
    const btnBox = document.createElement("div");
    btnBox.className = "approve-box";
    btnBox.style = "margin: 20px auto 0; text-align: center; max-width: 600px;";
    btnBox.innerHTML = `<button class="approve-btn" id="btnApprovePlan">Approve Plan & Start Execution</button>`;
    el.appendChild(btnBox);
    
    $("btnApprovePlan").onclick = async () => {
      const selectedTasks = [];
      document.querySelectorAll(".task-model-select").forEach((sel) => {
        selectedTasks.push({
          id: parseInt(sel.getAttribute("data-id")),
          model: sel.value
        });
      });
      try {
        await api(`/jobs/${job.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ tasks: selectedTasks })
        });
        toast("Plan approved! Executing tasks...");
        openJob(job.id);
      } catch (e) {
        toast("Failed to approve plan: " + e.message, 4000);
      }
    };
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

// --------------------------------------------------------------------------- workspace
function closeWorkspacePoll() {
  if (S.wsPoll) { clearInterval(S.wsPoll); S.wsPoll = null; }
}

async function openWorkspace() {
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  S.jobId = null;
  closeWorkspacePoll();
  
  $("hero").hidden = true;
  $("mission").hidden = true;
  $("workspaceView").hidden = false;
  $("coderView").hidden = true;
  $("btnWorkspace").classList.add("active");
  $("btnCoder").classList.remove("active");

  document.querySelectorAll("#jobList .job").forEach(j => j.classList.remove("active"));
  
  await refreshWorkspace();
  S.wsPoll = setInterval(refreshWorkspace, 1500);
}

async function refreshWorkspace() {
  try {
    const data = await api("/workspace/agents");
    $("wsPath").textContent = data.workspace_path;
    
    // HR Portal
    const availDiv = $("availableAgents");
    availDiv.innerHTML = data.available_agents.map(a => {
      const isHired = data.hired.includes(a.id);
      const btnText = isHired ? "Dismiss" : "Hire Agent";
      const btnClass = isHired ? "btn-hire hired" : "btn-hire";
      const specsHtml = a.specialties.map(s => `<span class="agent-spec-tag">${s}</span>`).join("");
      
      return `
        <div class="agent-card ${isHired ? 'hired' : ''}">
          <div class="agent-card-header">
            <div class="agent-avatar">${a.avatar}</div>
            <div class="agent-info">
              <div class="agent-name">${a.name}</div>
              <div class="agent-role">${a.role}</div>
            </div>
          </div>
          <div class="agent-desc">${a.description}</div>
          <div class="agent-specs">${specsHtml}</div>
          <div class="agent-card-footer">
            <div class="agent-cost">Rate: <span>$${a.cost}/hr</span></div>
            <button class="${btnClass}" onclick="toggleAgentHired('${a.id}', ${isHired})">${btnText}</button>
          </div>
        </div>
      `;
    }).join("");
    
    // Assignee dropdown
    const select = $("agentAssigneeSelect");
    const currentVal = select.value;
    select.innerHTML = '<option value="all">Entire Team (Collaborative Handoff)</option>';
    data.available_agents.forEach(a => {
      if (data.hired.includes(a.id)) {
        select.innerHTML += `<option value="${a.id}">${a.name} (${a.role})</option>`;
      }
    });
    if (select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    }
    
    // Office Floor Desks
    const floor = $("officeFloor");
    floor.innerHTML = "";
    if (data.hired.length === 0) {
      floor.innerHTML = `
        <div style="grid-column: 1 / span 2; text-align: center; padding: 40px; color: var(--muted)">
          <div style="font-size: 32px; margin-bottom: 10px">🏢</div>
          <h3 style="color:var(--text-bright)">Office is currently empty.</h3>
          <p style="font-size: 11.5px; margin-top: 5px; color:var(--muted)">Hire agents from the HR Portal on the left to start working!</p>
        </div>
      `;
    } else {
      data.hired.forEach(aid => {
        const a = data.available_agents.find(x => x.id === aid);
        if (!a) return;
        const statusData = data.agents_status[aid] || { status: "idle", current_task: null, logs: [] };
        
        const isActive = (statusData.status !== "idle");
        const deskClass = "agent-desk" + (isActive ? " active-worker" : "");
        const statusDotClass = "desk-status-dot " + statusData.status;
        const statusBadgeClass = "desk-status-badge " + statusData.status;
        
        const deskLogsHtml = (statusData.logs || []).slice(-5).map(l => {
          const timeStr = new Date(l.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return `<div class="log-line ${l.type}">[${timeStr}] ${l.text}</div>`;
        }).join("");
        
        let bubbleText = "Zzz... Assign me some work!";
        if (statusData.status !== "idle" && statusData.current_task) {
          bubbleText = `<strong>Working on:</strong> ${statusData.current_task}`;
        }
        
        floor.innerHTML += `
          <div class="${deskClass}">
            <div class="agent-desk-header">
              <div class="desk-agent-profile">
                <div class="desk-avatar-wrapper">
                  <div class="agent-avatar" style="width:28px; height:28px; font-size:16px">${a.avatar}</div>
                  <div class="${statusDotClass}"></div>
                </div>
                <div>
                  <div class="agent-name" style="font-size:12px">${a.name}</div>
                  <div class="agent-role" style="font-size:9.5px">${a.role}</div>
                </div>
              </div>
              <div class="${statusBadgeClass}">${statusData.status}</div>
            </div>
            
            <div class="desk-status-bubble">
              <div>${bubbleText}</div>
            </div>
            
            <div class="desk-agent-logs">
              ${deskLogsHtml || '<div class="log-line" style="color:var(--muted)">Waiting for task logs...</div>'}
            </div>
          </div>
        `;
      });
    }
    
    // Console Logs
    const consoleDiv = $("globalConsoleLogs");
    if (data.project && data.project.logs && data.project.logs.length > 0) {
      consoleDiv.innerHTML = data.project.logs.map(log => {
        const match = log.match(/^\[([^\]]+)\]\s*(?:([A-Z]+):\s*)?([\s\S]*)$/);
        if (match) {
          const senderName = match[1];
          const action = match[2];
          const text = match[3];
          
          const agent = data.available_agents.find(a => a.name === senderName || a.role === senderName);
          const avatar = agent ? agent.avatar : "🤖";
          
          const actionBadge = action ? `<span class="dm-action-badge ${action.toLowerCase()}">${action.toLowerCase()}</span>` : "";
          const formattedText = (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
          
          return `
            <div class="dm-message dm-left">
              <div class="dm-avatar">${avatar}</div>
              <div class="dm-content">
                <span class="dm-sender-name">${senderName} ${actionBadge}</span>
                <div class="dm-bubble">${formattedText}</div>
              </div>
            </div>
          `;
        } else {
          // System / User action
          const formattedText = (log || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
          return `
            <div class="dm-message dm-right">
              <div class="dm-content">
                <div class="dm-bubble">${formattedText}</div>
              </div>
            </div>
          `;
        }
      }).join("");
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
    } else {
      consoleDiv.innerHTML = `
        <div class="dm-message dm-right">
          <div class="dm-content">
            <div class="dm-bubble">Office system ready. Hire agents and assign tasks.</div>
          </div>
        </div>
      `;
    }
    
    await refreshWorkspaceFiles();
  } catch (e) {
    console.error("Error refreshing workspace:", e);
  }
}

async function toggleAgentHired(agentId, isHired) {
  try {
    const endpoint = isHired ? "/workspace/agents/fire" : "/workspace/agents/hire";
    await api(endpoint, { method: "POST", body: JSON.stringify({ agent_id: agentId }) });
    toast(isHired ? "Agent dismissed." : "Agent hired!");
    await refreshWorkspace();
  } catch (e) {
    toast("Action failed: " + e.message);
  }
}
window.toggleAgentHired = toggleAgentHired;

async function refreshWorkspaceFiles() {
  try {
    const files = await api("/workspace/files");
    const grid = $("wsFileGrid");
    grid.innerHTML = "";
    
    if (files.length === 0) {
      grid.innerHTML = '<div style="grid-column: 1 / span 3; text-align: center; color: var(--muted); font-size: 11px; padding: 20px">No files generated yet.</div>';
      return;
    }
    
    files.forEach(f => {
      let icon = "📄";
      if (f.name.endsWith(".html")) icon = "🌐";
      else if (f.name.endsWith(".css")) icon = "🎨";
      else if (f.name.endsWith(".js")) icon = "📜";
      else if (f.name.endsWith(".md")) icon = "📝";
      
      const sizeStr = f.size > 1024 ? (f.size / 1024).toFixed(1) + " KB" : f.size + " B";
      
      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML = `
        <div class="file-icon">${icon}</div>
        <div class="file-name" title="${f.name}">${f.name}</div>
        <div class="file-size">${sizeStr}</div>
        <button class="file-delete-btn" title="Delete file">✕</button>
      `;
      
      item.onclick = (e) => {
        if (e.target.classList.contains("file-delete-btn")) return;
        viewWorkspaceFile(f.name);
      };
      
      item.querySelector(".file-delete-btn").onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete ${f.name}?`)) {
          await api(`/workspace/files/delete?path=${encodeURIComponent(f.name)}`, { method: "POST" });
          toast("File deleted.");
          refreshWorkspaceFiles();
        }
      };
      
      grid.appendChild(item);
    });
  } catch (e) {
    console.error("Error refreshing workspace files:", e);
  }
}

async function viewWorkspaceFile(fileName) {
  try {
    const data = await api(`/workspace/files/read?path=${encodeURIComponent(fileName)}`);
    $("codeModalTitle").textContent = fileName;
    $("codeModalBody").textContent = data.content;
    $("codeModal").hidden = false;
  } catch (e) {
    toast("Failed to read file: " + e.message);
  }
}

async function assignWorkspaceTask() {
  const input = $("agentTaskInput");
  const task = input.value.trim();
  if (!task) return;
  
  const assignee = $("agentAssigneeSelect").value;
  try {
    await api("/workspace/agents/assign", {
      method: "POST",
      body: JSON.stringify({ agent_id: assignee, task: task })
    });
    toast("Task assigned! Hired agents are on it.");
    input.value = "";
    await refreshWorkspace();
  } catch (e) {
    toast("Assignment failed: " + e.message, 4000);
  }
}

// Workspace folder change
function editWorkspacePath() {
  $("wsPath").style.display = "none";
  $("btnEditPath").style.display = "none";
  $("pathEditForm").style.display = "flex";
  $("wsPathInput").value = $("wsPath").textContent;
}

function cancelWorkspacePath() {
  $("pathEditForm").style.display = "none";
  $("wsPath").style.display = "";
  $("btnEditPath").style.display = "";
}

async function saveWorkspacePath() {
  const path = $("wsPathInput").value.trim();
  try {
    const res = await api("/workspace/config", {
      method: "POST",
      body: JSON.stringify({ workspace_path: path })
    });
    toast("Workspace path updated successfully.");
    $("wsPath").textContent = res.workspace_path;
    cancelWorkspacePath();
    await refreshWorkspace();
  } catch (e) {
    toast("Failed to update path: " + e.message, 4000);
  }
}

// Custom Agent creation
function openCustomAgentModal() {
  const select = $("cAgentModel");
  select.innerHTML = S.allModels.map(name => `<option value="${name}">${name}</option>`).join("");
  
  $("cAgentName").value = "";
  $("cAgentRole").value = "";
  $("cAgentSpecialties").value = "";
  $("cAgentDesc").value = "";
  $("cAgentAvatar").value = "🤖";
  $("cAgentCost").value = "120";
  
  $("customAgentModal").hidden = false;
}

function closeCustomAgentModal() {
  $("customAgentModal").hidden = true;
}

async function saveCustomAgent() {
  const avatar = $("cAgentAvatar").value.trim();
  const name = $("cAgentName").value.trim();
  const role = $("cAgentRole").value.trim();
  const specsStr = $("cAgentSpecialties").value.trim();
  const desc = $("cAgentDesc").value.trim();
  const model = $("cAgentModel").value;
  const cost = parseInt($("cAgentCost").value) || 100;
  
  if (!name || !role) {
    toast("Name and Role are required fields.");
    return;
  }
  
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").trim("-");
  if (!id) {
    toast("Invalid agent name.");
    return;
  }
  
  const specialties = specsStr.split(",").map(x => x.trim()).filter(Boolean);
  
  try {
    await api("/workspace/agents/custom", {
      method: "POST",
      body: JSON.stringify({
        id, name, avatar, role, specialties, description: desc, model, cost
      })
    });
    toast("Custom agent created successfully!");
    closeCustomAgentModal();
    await refreshWorkspace();
  } catch (e) {
    toast("Failed to create agent: " + e.message, 4000);
  }
}

// --------------------------------------------------------------------------- wire
// --------------------------------------------------------------------------- Source Work Coder
function switchCoderTab(activeId, panelToShowId) {
  document.querySelectorAll(".coder-rail .cr-item").forEach(btn => {
    if (btn.id === activeId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  if (panelToShowId === "coderComposerPanel") {
    $("coderComposerPanel").style.display = "flex";
    $("coderMemoryPanel").style.display = "none";
  } else if (panelToShowId === "coderMemoryPanel") {
    $("coderComposerPanel").style.display = "none";
    $("coderMemoryPanel").style.display = "flex";
    loadCoderMemory();
  }
}

async function loadCoderMemory() {
  const el = $("coderMemoryList");
  if (!el) return;
  el.innerHTML = '<div style="color:var(--muted); font-size:13px; text-align:center; padding:20px;">Loading memory...</div>';
  try {
    const res = await api("/memory");
    const content = res.content || "";
    const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      el.innerHTML = '<div style="color:var(--muted); font-size:13px; text-align:center; padding:20px;">No memory saved yet. Use the "remember" action in your coder sessions to save facts.</div>';
      return;
    }
    el.innerHTML = lines.map(line => {
      let text = line;
      if (text.startsWith("- ")) text = text.substring(2);
      return `<div style="background:var(--panel); border:1px solid var(--edge); border-radius:8px; padding:12px; font-size:13px; color:var(--text); line-height:1.4">${text}</div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red); font-size:13px; text-align:center; padding:20px;">Failed to load memory: ${e.message}</div>`;
  }
}

async function loadCoderWorkspacePath() {
  try {
    const data = await api("/workspace/agents");
    const p = data.workspace_path || "";
    const isDefault = p.replace(/\\/g, "/").toLowerCase().endsWith("workspaces/virtual_office");
    const label = isDefault ? "Default" : (p.split(/[\\/]/).filter(Boolean).pop() || "Default");
    $("coderRepoLabel").textContent = label;
  } catch (e) {
    console.error("Failed to load coder workspace path:", e);
  }
}

function openCoder() {
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  closeWorkspacePoll();
  $("hero").hidden = true;
  $("mission").hidden = true;
  $("workspaceView").hidden = true;
  $("coderView").hidden = false;
  $("btnWorkspace").classList.remove("active");
  $("btnCoder").classList.add("active");
  document.querySelectorAll("#jobList .job").forEach(j => j.classList.remove("active"));
  populateCoderModels();
  loadCoderRecents();
  switchCoderTab("crNew", "coderComposerPanel");
  loadCoderWorkspacePath();
  
  if (S.jobId) {
    openJob(S.jobId);
  } else {
    renderCoderJob(null);
  }
}

function renderCoderJob(job) {
  if (!job) {
    $("coderGreeting").hidden = false;
    $("coderSuggest").hidden = false;
    $("coderChatHistory").hidden = true;
    $("coderChatHistory").innerHTML = "";
    return;
  }
  
  $("coderGreeting").hidden = true;
  $("coderSuggest").hidden = true;
  $("coderChatHistory").hidden = false;
  
  const steps = {};
  for (const e of job.events || []) {
    if (e.type === "task_step") {
      (steps[e.id] = steps[e.id] || []).push(`${e.step}${e.text ? " " + e.text : ""}`);
    }
  }

  let html = "";
  for (const t of job.tasks) {
    const prompt = t.id === 1 ? job.goal : t.detail;
    html += `
      <div class="coder-msg user">
        <div class="coder-bubble">${fmt(prompt)}</div>
      </div>
    `;
    
    const st = t.status || "pending";
    const ts = (steps[t.id] || []).slice(-8).map(s => `<span class="tstep">${s.replace(/</g, "&lt;")}</span>`).join("");
    
    let content = "";
    if (st === "done") {
      content = fmt(t.output);
    } else if (st === "failed") {
      content = `<div style="color:var(--red); font-weight:600">Error:</div><div style="color:var(--red)">${fmt(t.output)}</div>`;
    } else {
      content = `
        <div class="coder-running">
          <div style="display:flex; align-items:center; gap:8px">
            <span class="spin"></span>
            <span style="font-weight:600; color:var(--accent)">Executing subtask: ${t.title}...</span>
          </div>
          ${ts ? `<div class="task-steps" style="margin-top:10px; padding:0">${ts}</div>` : ""}
        </div>
      `;
    }
    
    html += `
      <div class="coder-msg assistant">
        <div class="coder-bubble">${content}</div>
      </div>
    `;
  }
  
  $("coderChatHistory").innerHTML = html;
  $("coderChatHistory").scrollTop = $("coderChatHistory").scrollHeight;
}

function populateCoderModels() {
  const sel = $("coderModelSelect");
  if (!sel) return;
  const models = (S.allModels && S.allModels.length) ? S.allModels : ["(no models)"];
  sel.innerHTML = models.map(n => `<option value="${n}">${n}</option>`).join("");
}

async function loadCoderRecents() {
  const el = $("coderRecents");
  if (!el) return;
  let jobs = [];
  try { jobs = await api("/jobs"); } catch (e) {}
  if (!jobs.length) { el.innerHTML = '<div class="cr-empty">No sessions yet</div>'; return; }
  el.innerHTML = "";
  for (const j of jobs.slice(0, 12)) {
    const row = document.createElement("button");
    row.className = "cr-recent";
    row.innerHTML = `<span class="cr-recent-dot ${j.status}"></span><span class="cr-recent-title"></span>`;
    row.querySelector(".cr-recent-title").textContent = j.title || "session";
    row.onclick = () => openJob(j.id);
    el.appendChild(row);
  }
}

let coderAttachedFiles = [];

function renderCoderAttachments() {
  const container = $("coderAttachments");
  if (!container) return;
  if (coderAttachedFiles.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = coderAttachedFiles.map((file, idx) => {
    let icon = "📄";
    if (file.name.endsWith(".py") || file.name.endsWith(".js") || file.name.endsWith(".ts") || file.name.endsWith(".jsx")) {
      icon = "‹›";
    } else if (file.name.endsWith(".json") || file.name.endsWith(".xml") || file.name.endsWith(".yaml") || file.name.endsWith(".yml")) {
      icon = "🗄";
    } else if (file.name.endsWith(".html")) {
      icon = "🌐";
    } else if (file.name.endsWith(".css")) {
      icon = "🎨";
    }
    return `
      <div class="coder-attachment-badge">
        <span>${icon}</span>
        <span>${file.name}</span>
        <span class="cab-del" onclick="removeCoderAttachment(${idx})">✕</span>
      </div>
    `;
  }).join("");
}

function removeCoderAttachment(idx) {
  coderAttachedFiles.splice(idx, 1);
  renderCoderAttachments();
}
window.removeCoderAttachment = removeCoderAttachment;

async function handleCoderFileSelect(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  
  for (const file of files) {
    if (file.size > 1024 * 1024 * 1024) {
      toast(`File "${file.name}" is too large (max 1GB).`, 4000);
      continue;
    }
    const reader = new FileReader();
    reader.onload = function(evt) {
      const content = evt.target.result;
      if (coderAttachedFiles.some(f => f.name === file.name)) {
        toast(`File "${file.name}" is already attached.`, 3000);
        return;
      }
      coderAttachedFiles.push({ name: file.name, content: content });
      renderCoderAttachments();
    };
    reader.readAsText(file);
  }
  e.target.value = "";
}

async function handleCoderFolderSelect(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  
  for (const file of files) {
    if (file.size > 1024 * 1024 * 1024) {
      toast(`File "${file.name}" is too large (max 1GB).`, 4000);
      continue;
    }
    const pathName = file.webkitRelativePath || file.name;
    const reader = new FileReader();
    reader.onload = function(evt) {
      const content = evt.target.result;
      if (coderAttachedFiles.some(f => f.name === pathName)) {
        return;
      }
      coderAttachedFiles.push({ name: pathName, content: content });
      renderCoderAttachments();
    };
    reader.readAsText(file);
  }
  e.target.value = "";
}

// --- Source Work Coder: streaming Claude-Code-style session ---
let coderHistory = [];      // [{role,content}] conversational memory for follow-ups
let coderStreaming = false;

function coderEsc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function coderResetSession() {
  coderHistory = [];
  if ($("coderChatHistory")) { $("coderChatHistory").innerHTML = ""; $("coderChatHistory").hidden = true; }
  if ($("coderGreeting")) $("coderGreeting").hidden = false;
  if ($("coderSuggest")) $("coderSuggest").hidden = false;
}

function coderRenderEvent(turn, ev) {
  if (ev.type === "start") {
    const repo = (ev.repo || "").split(/[\\/]/).filter(Boolean).pop() || ev.repo;
    turn.insertAdjacentHTML("beforeend", `<div class="cx-start">▸ ${coderEsc(ev.model)} · ${coderEsc(repo)}</div>`);
  } else if (ev.type === "think") {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-think">${coderEsc(ev.text)}</div>`);
  } else if (ev.type === "tool") {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-tool"><span class="cx-tool-name">${coderEsc(ev.name)}</span> <span class="cx-tool-arg">${coderEsc(ev.arg || "")}</span></div>`);
  } else if (ev.type === "tool_result") {
    const r = coderEsc((ev.result || "").split("\n").slice(0, 16).join("\n"));
    turn.insertAdjacentHTML("beforeend", `<details class="cx-result"><summary>output</summary><pre>${r}</pre></details>`);
  } else if (ev.type === "file_edit") {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-edit">${ev.kind === "write" ? "＋ created" : "✎ edited"} <code>${coderEsc(ev.path)}</code></div>`);
  } else if (ev.type === "final") {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-final">${fmt(ev.text || "")}</div>`);
  } else if (ev.type === "error") {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-err">${coderEsc(ev.text || "")}</div>`);
  }
}

async function coderSubmit() {
  if (coderStreaming) return;
  const task = $("coderInput").value.trim();
  if (!task) return;
  const model = $("coderModelSelect").value;

  $("coderGreeting").hidden = true;
  if ($("coderSuggest")) $("coderSuggest").hidden = true;
  const box = $("coderChatHistory");
  box.hidden = false;
  $("coderInput").value = "";
  coderAttachedFiles = []; renderCoderAttachments();

  box.insertAdjacentHTML("beforeend", `<div class="cx-msg cx-user">${coderEsc(task)}</div>`);
  const turn = document.createElement("div");
  turn.className = "cx-turn";
  box.appendChild(turn);
  box.scrollTop = box.scrollHeight;

  coderStreaming = true;
  $("coderSend").disabled = true;
  let finalText = "";
  try {
    const res = await fetch("/api/coder/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, model, history: coderHistory })
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "final") finalText = ev.text || "";
        coderRenderEvent(turn, ev);
        box.scrollTop = box.scrollHeight;
      }
    }
  } catch (e) {
    turn.insertAdjacentHTML("beforeend", `<div class="cx-err">Error: ${coderEsc(e.message || e)}</div>`);
  } finally {
    coderHistory.push({ role: "user", content: task });
    if (finalText) coderHistory.push({ role: "assistant", content: finalText });
    coderStreaming = false;
    $("coderSend").disabled = false;
  }
}

function coderToggleRepo(show) {
  $("coderRepoBtn").style.display = show ? "none" : "";
  $("coderRepoEdit").hidden = !show;
  if (show) $("coderRepoInput").focus();
}

async function coderSaveRepo() {
  const path = $("coderRepoInput").value.trim();
  try {
    const res = await api("/workspace/config", { method: "POST", body: JSON.stringify({ workspace_path: path }) });
    const p = res.workspace_path || "";
    const label = path ? (p.split(/[\\/]/).filter(Boolean).pop() || "Default") : "Default";
    $("coderRepoLabel").textContent = label;
    toast("Repo set: " + label);
  } catch (e) { toast("Failed: " + e.message, 4000); }
  coderToggleRepo(false);
}

document.addEventListener("DOMContentLoaded", () => {
  $("newJob").onclick = newJob;
  $("run").onclick = run;
  $("btnWorkspace").onclick = openWorkspace;
  $("btnCoder").onclick = openCoder;
  $("crNew").onclick = () => { S.jobId = null; coderResetSession(); switchCoderTab("crNew", "coderComposerPanel"); $("coderInput").value = ""; $("coderInput").focus(); };
  $("crMemory").onclick = () => { switchCoderTab("crMemory", "coderMemoryPanel"); };
  $("btnClearCoderMemory").onclick = async () => {
    if (confirm("Clear all coder memory?")) {
      try {
        await api("/memory", { method: "DELETE" });
        loadCoderMemory();
        toast("Coder memory cleared.");
      } catch (e) {
        toast("Failed to clear memory: " + e.message, 4000);
      }
    }
  };
  $("coderSend").onclick = coderSubmit;
  $("btnCoderAttach").onclick = () => $("coderFileInput").click();
  $("coderFileInput").onchange = handleCoderFileSelect;
  $("btnCoderAttachFolder").onclick = () => $("coderFolderInput").click();
  $("coderFolderInput").onchange = handleCoderFolderSelect;
  $("coderInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) coderSubmit(); });
  $("coderRepoBtn").onclick = () => { $("coderRepoInput").value = ""; coderToggleRepo(true); };
  $("coderRepoSave").onclick = coderSaveRepo;
  $("coderRepoCancel").onclick = () => coderToggleRepo(false);
  $("coderRepoInput").addEventListener("keydown", (e) => { if (e.key === "Enter") coderSaveRepo(); if (e.key === "Escape") coderToggleRepo(false); });
  $("coderSuggest").querySelectorAll("button").forEach((b) => (b.onclick = () => { $("coderInput").value = b.textContent; coderSubmit(); }));
  document.querySelectorAll(".cr-item[data-coder]").forEach(b => (b.onclick = () => toast(b.textContent.trim() + " — coming soon in Source Work Coder")));
  $("btnAssignTask").onclick = assignWorkspaceTask;
  $("btnEditPath").onclick = editWorkspacePath;
  $("btnCancelPath").onclick = cancelWorkspacePath;
  $("btnSavePath").onclick = saveWorkspacePath;
  $("wsPathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveWorkspacePath(); });
  
  $("btnCustomAgent").onclick = openCustomAgentModal;
  $("cAgentCancel").onclick = closeCustomAgentModal;
  $("cAgentSave").onclick = saveCustomAgent;
  $("customAgentModal").onclick = (e) => { if (e.target === $("customAgentModal")) closeCustomAgentModal(); };
  $("agentTaskInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) assignWorkspaceTask(); });
  $("codeModalClose").onclick = () => { $("codeModal").hidden = true; };
  $("codeModal").onclick = (e) => { if (e.target === $("codeModal")) $("codeModal").hidden = true; };
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
