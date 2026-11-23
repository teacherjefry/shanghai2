/*
 * Shanghai Session Scorekeeper — Firestore edition
 * All application/session/settings/history data is stored in Firebase Firestore.
 * Firestore realtime listeners keep the current session and previous-session history synchronized.
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD7G7grzcQARxS7oP-lUFH8T9O6mfxuW5w",
  authDomain: "shanghai-2e018.firebaseapp.com",
  projectId: "shanghai-2e018",
  storageBucket: "shanghai-2e018.firebasestorage.app",
  messagingSenderId: "435074339511",
  appId: "1:435074339511:web:cec8e0df2faee8e34d3332"
};

const FIRESTORE_SESSIONS = "shanghaiSessions";
const FIRESTORE_META = "shanghaiMeta";
const FIRESTORE_META_DOC = "appState";

let storageReady = false;
let storageConnectPromise = null;
let firestoreDb = null;
let sessionId = null;
let sessionCompleted = false;
let localStateDirty = false;
let localStateVersion = 0;
let storageSaveQueue = Promise.resolve();
let settingsDirty = false;
let historyUnsubscribe = null;
let activeSessionUnsubscribe = null;
let metaUnsubscribe = null;
let historyRecords = [];
let currentRound = 0;
let currentTheme = "dark";
let chartInstance = null;

const makeId = () => (
  (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const rounds = [
  { title: "Round 1", requirements: "2 Sets", details: "Two sets" },
  { title: "Round 2", requirements: "1 Set + 1 Run", details: "One set and one run" },
  { title: "Round 3", requirements: "2 Runs", details: "Two runs" },
  { title: "Round 4", requirements: "3 Sets", details: "Three sets" },
  { title: "Round 5", requirements: "2 Sets + 1 Run", details: "Two sets and one run" },
  { title: "Round 6", requirements: "1 Set + 2 Runs", details: "One set and two runs" },
  { title: "Round 7", requirements: "3 Runs", details: "Three runs" }
];

let state = {
  date: new Date().toISOString().slice(0,10),
  players: [],
  scores: Array.from({length: 7}, () => [])
};

const $ = id => document.getElementById(id);

if (!window.firebase) {
  throw new Error("Firebase SDK did not load.");
}
if (!firebase.apps.length) {
  firebase.initializeApp(FIREBASE_CONFIG);
}
firestoreDb = firebase.firestore();
// Use long-polling when the browser/network cannot establish Firestore's
// normal streaming connection. This affects only Firestore transport.
try {
  firestoreDb.settings({ experimentalAutoDetectLongPolling: true });
} catch (error) {
  console.warn("Firestore transport settings could not be applied:", error);
}

function cloneSessionRecord(id = sessionId) {
  const now = new Date().toISOString();
  return {
    id,
    date: state.date,
    players: state.players.map(p => ({ name: String(p.name || "") })),
    // Firestore does not allow arrays nested directly inside arrays.
    // Keep the in-memory score shape unchanged, but store each round as a
    // named field so Firestore receives a map containing plain arrays.
    scores: Object.fromEntries(
      state.scores.map((round, index) => [
        `round${index + 1}`,
        Array.isArray(round) ? round.map(v => Number(v) || 0) : []
      ])
    ),
    currentRound: Math.max(0, Math.min(6, Number(currentRound) || 0)),
    completed: !!sessionCompleted,
    completedAt: sessionCompleted ? (state.completedAt || now) : null,
    updatedAt: now,
    createdAt: state.createdAt || now
  };
}

function sessionsCollection() {
  return firestoreDb.collection(FIRESTORE_SESSIONS);
}

function metaDocument() {
  return firestoreDb.collection(FIRESTORE_META).doc(FIRESTORE_META_DOC);
}

function setSessionId(id) {
  sessionId = id || makeId();
}

function detachActiveSessionListener() {
  if (activeSessionUnsubscribe) {
    activeSessionUnsubscribe();
    activeSessionUnsubscribe = null;
  }
}

function normalizeSession(record) {
  if (!record) return null;
  const players = Array.isArray(record.players) ? record.players.map(p => ({ name: String(p?.name || "") })) : [];
  const scores = Array.from({length: 7}, (_, i) => {
    // New Firestore format: scores is a map (round1...round7).
    // Also accept the previous array format for backward compatibility.
    const storedRound = Array.isArray(record.scores)
      ? record.scores[i]
      : record.scores?.[`round${i + 1}`];
    return Array.isArray(storedRound)
      ? storedRound.map(v => Math.max(0, Number(v) || 0))
      : [];
  });
  return {
    id: record.id,
    date: record.date || new Date().toISOString().slice(0,10),
    players,
    scores,
    currentRound: Number.isInteger(record.currentRound) ? Math.max(0, Math.min(6, record.currentRound)) : 0,
    completed: !!record.completed,
    completedAt: record.completedAt || null,
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString()
  };
}

function applyStoredSession(record) {
  const remote = normalizeSession(record);
  if (!remote) return false;
  state = {
    date: remote.date,
    players: remote.players,
    scores: remote.scores
  };
  state.createdAt = remote.createdAt;
  state.completedAt = remote.completedAt;
  currentRound = remote.currentRound;
  sessionCompleted = remote.completed;
  return true;
}

async function persistToFirestore() {
  if (!storageReady || !sessionId) return false;

  const saveVersion = localStateVersion;
  const saveSessionId = sessionId;
  storageSaveQueue = storageSaveQueue.then(async () => {
    try {
      const record = cloneSessionRecord(saveSessionId);
      // Send only JSON-safe Firestore values. This preserves the existing
      // in-memory score structure while preventing unsupported JS values
      // from reaching DocumentReference.set().
      const firestoreRecord = JSON.parse(JSON.stringify(record));
      await sessionsCollection().doc(saveSessionId).set(firestoreRecord, { merge: true });
      await metaDocument().set({
        activeSessionId: saveSessionId,
        theme: currentTheme,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      if (saveVersion === localStateVersion && saveSessionId === sessionId) {
        localStateDirty = false;
      }
      if ($("cloudStatus")) $("cloudStatus").textContent = "✓ Saved to Firestore";
      return true;
    } catch (error) {
      console.error("Firestore save error:", error);
      if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore save failed — ${error.message || error}`;
      return false;
    }
  }).catch(error => {
    console.error("Firestore save queue error:", error);
    if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore save failed — ${error.message || error}`;
    return false;
  });

  return storageSaveQueue;
}

function save() {
  localStateDirty = true;
  localStateVersion++;
  if (storageReady) {
    persistToFirestore();
  } else if (storageConnectPromise) {
    storageConnectPromise.then(() => {
      if (localStateDirty) persistToFirestore();
    }).catch(() => {});
  }
}

async function saveSettingsToFirestore() {
  try {
    await metaDocument().set({
      theme: currentTheme,
      activeSessionId: sessionId || null,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    settingsDirty = false;
    if ($("cloudStatus")) $("cloudStatus").textContent = "✓ Settings saved to Firestore";
  } catch (error) {
    settingsDirty = true;
    console.error("Firestore settings save error:", error);
    if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore settings save failed — ${error.message || error}`;
  }
}

function listenToActiveSession(id) {
  detachActiveSessionListener();
  if (!id) return;

  activeSessionUnsubscribe = sessionsCollection().doc(id).onSnapshot(snapshot => {
    if (!snapshot.exists) return;
    const record = normalizeSession({ id: snapshot.id, ...snapshot.data() });
    if (!record) return;

    setSessionId(record.id);
    // Do not re-render the score form while a score input is focused. This
    // prevents Firestore's realtime snapshot from interrupting multi-digit
    // score entry. The local value is saved on the input's change event.
    if (document.activeElement && document.activeElement.classList.contains("score-input")) {
      if ($("cloudStatus")) $("cloudStatus").textContent = "✓ Synced with Firestore";
      return;
    }
    applyStoredSession(record);
    localStateDirty = false;
    renderAll();
    if ($("cloudStatus")) $("cloudStatus").textContent = "✓ Synced with Firestore";
  }, error => {
    console.error("Firestore session listener error:", error);
    if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore realtime sync failed — ${error.message || error}`;
  });
}

function startHistoryListener() {
  if (historyUnsubscribe) historyUnsubscribe();
  historyUnsubscribe = sessionsCollection().onSnapshot(snapshot => {
    historyRecords = snapshot.docs
      .map(doc => normalizeSession({ id: doc.id, ...doc.data() }))
      .filter(Boolean)
      .sort((a,b) => {
        const ad = Date.parse(a.completedAt || a.updatedAt || a.createdAt || 0);
        const bd = Date.parse(b.completedAt || b.updatedAt || b.createdAt || 0);
        return bd - ad;
      });
  }, error => {
    console.error("Firestore history listener error:", error);
    if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore history sync failed — ${error.message || error}`;
  });
}

async function loadFromFirestore() {
  try {
    const metaSnapshot = await metaDocument().get();
    const meta = metaSnapshot.exists ? metaSnapshot.data() : {};

    if (!settingsDirty && (meta.theme === "light" || meta.theme === "dark")) {
      currentTheme = meta.theme;
    }

    let activeId = meta.activeSessionId;
    if (!activeId) {
      activeId = makeId();
      setSessionId(activeId);
      state = {
        date: new Date().toISOString().slice(0,10),
        players: [],
        scores: Array.from({length: 7}, () => [])
      };
      currentRound = 0;
      sessionCompleted = false;
      state.createdAt = new Date().toISOString();
      localStateDirty = true;
      localStateVersion++;
      storageReady = true;
      await persistToFirestore();
    } else {
      setSessionId(activeId);
      const activeSnapshot = await sessionsCollection().doc(activeId).get();
      if (activeSnapshot.exists) {
        applyStoredSession(normalizeSession({ id: activeSnapshot.id, ...activeSnapshot.data() }));
        localStateDirty = false;
      } else {
        state.createdAt = new Date().toISOString();
        localStateDirty = true;
        localStateVersion++;
        storageReady = true;
        await persistToFirestore();
      }
    }

    storageReady = true;
    listenToActiveSession(sessionId);
    startHistoryListener();

    if (metaUnsubscribe) metaUnsubscribe();
    metaUnsubscribe = metaDocument().onSnapshot(snapshot => {
      if (!snapshot.exists) return;
      const data = snapshot.data() || {};

      if (!settingsDirty && (data.theme === "light" || data.theme === "dark") && data.theme !== currentTheme) {
        currentTheme = data.theme;
        applyTheme();
        lucide.createIcons();
      }

      if (data.activeSessionId && data.activeSessionId !== sessionId) {
        setSessionId(data.activeSessionId);
        listenToActiveSession(sessionId);
      }
    }, error => {
      console.error("Firestore settings/session listener error:", error);
      if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore realtime listener failed — ${error.message || error}`;
    });

    renderAll();
    if ($("cloudStatus")) $("cloudStatus").textContent = "✓ Synced with Firestore";
    return true;
  } catch (error) {
    storageReady = false;
    console.error("Firestore load error:", error);
    if ($("cloudStatus")) $("cloudStatus").textContent = `Firestore unavailable — ${error.message || error}`;
    return false;
  }
}

function totals() {
  return state.players.map((p, i) => ({
    ...p,
    total: state.scores.reduce((sum, round) => sum + (Number(round[i]) || 0), 0),
    index: i
  })).sort((a,b) => a.total - b.total);
}

function launchFireworks() {
  const layer = document.createElement("div");
  layer.className = "fixed inset-0 pointer-events-none z-[10000]";
  layer.innerHTML = `<span class="firework one"></span><span class="firework two"></span><span class="firework three"></span><span class="firework four"></span>`;
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 3200);
}

async function startAnotherSession() {
  const carry = await Swal.fire({
    icon: "question",
    title: "Start a new session?",
    text: "Choose whether to keep the player names. The new session will always start with fresh scores.",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "Yes, carry names",
    denyButtonText: "No, fresh start",
    cancelButtonText: "Cancel"
  });

  if (carry.isDismissed) return;

  const previousPlayers = state.players.map(p => ({...p}));
  let keepPlayers = carry.isConfirmed;
  const nextDate = new Date().toISOString().slice(0,10);

  if (keepPlayers) {
    const timing = await Swal.fire({
      icon: "question",
      title: "Continue today or start a new day?",
      text: "A new day starts completely fresh. Continuing today can carry the player names.",
      showDenyButton: true,
      showCancelButton: true,
      confirmButtonText: "Continue today",
      denyButtonText: "New day",
      cancelButtonText: "Cancel"
    });
    if (timing.isDismissed) return;
    if (timing.isDenied) keepPlayers = false;
  }

  detachActiveSessionListener();
  setSessionId(makeId());
  state = {
    date: nextDate,
    players: keepPlayers ? previousPlayers : [],
    scores: Array.from({length: 7}, () => keepPlayers ? previousPlayers.map(() => 0) : [])
  };
  state.createdAt = new Date().toISOString();
  state.completedAt = null;
  currentRound = 0;
  sessionCompleted = false;
  localStateDirty = true;
  localStateVersion++;

  if (storageReady) await persistToFirestore();
  listenToActiveSession(sessionId);
  renderAll();
  Swal.fire({
    icon:"success",
    title:"New session started!",
    text: keepPlayers ? "Player names carried over. Scores have been reset." : "Fresh session started with no previous player or score data.",
    timer:1800,
    showConfirmButton:false
  });
}

function formatSessionDate(dateString, includeTime = false) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString || "";
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit", month: "short", year: "numeric", weekday: "short"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  const dateText = `${get("day")}-${get("month")}-${get("year")}, ${get("weekday")}`;
  if (!includeTime) return dateText;
  return `${dateText}, ${new Intl.DateTimeFormat("en-US", {hour:"numeric", minute:"2-digit"}).format(new Date())}`;
}

function updateSessionDateDisplay() {
  const input = $("sessionDate");
  if (!input) return;
  input.value = formatSessionDate(state.date, true);
}

function renderLeaderboard() {
  const list = totals();
  $("leaderboard").innerHTML = list.length ? list.map((p, rank) => `
    <div class="flex items-center justify-between rounded-2xl bg-white/5 border border-white/10 px-3 py-2">
      <div class="flex items-center gap-3">
        <span class="font-black w-5">${rank+1}</span>
        <span class="font-semibold">${escapeHtml(p.name)}</span>
      </div>
      <span class="font-black">${p.total}</span>
    </div>`).join("") : `<div class="text-white/40 text-sm">Add players to begin.</div>`;
  const hasScored = list.some(p => p.total > 0);
  $("winner").textContent = hasScored ? list[0].name : "";
}

function renderRound() {
  const r = rounds[currentRound];
  $("roundCounter").textContent = `${currentRound + 1} / 7`;
  $("rounds").innerHTML = `
    <div class="round-card glass rounded-3xl p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-widest text-white/45">${r.title}</p>
          <h2 class="text-2xl font-black mt-1">${r.requirements}</h2>
          <p class="text-sm text-white/55 mt-1">${r.details}. Enter each player's score for this round.</p>
        </div>
        <div class="badge badge-primary badge-lg">Score</div>
      </div>
      <div class="divider opacity-20"></div>
      <div id="playerScores" class="space-y-2">
        ${state.players.map((p,i) => `
          <div class="flex items-center justify-between gap-2 rounded-2xl bg-black/10 px-3 py-2">
            <span class="font-semibold truncate">${escapeHtml(p.name)}</span>
            <input class="input input-bordered bg-white/10 score-input"
              type="number" min="0" inputmode="numeric"
              data-index="${i}" value="${Number(state.scores[currentRound][i]) > 0 ? Number(state.scores[currentRound][i]) : ""}">
          </div>`).join("") || `<p class="text-sm text-white/40">Add at least one player.</p>`}
      </div>
    </div>`;
  document.querySelectorAll(".score-input").forEach(input => {
    input.addEventListener("input", e => {
      const i = Number(e.target.dataset.index);
      state.scores[currentRound][i] = Math.max(0, Number(e.target.value) || 0);
      renderLeaderboard();
    });
    // Save only after the player finishes editing this score. Saving on every
    // keystroke causes Firestore's realtime listener to re-render the input
    // while a multi-digit score (for example, 15) is still being entered.
    input.addEventListener("change", () => {
      save();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function addPlayer() {
  const name = $("playerName").value.trim();
  if (!name) return Swal.fire({icon:"warning", title:"Enter a player name", confirmButtonText:"OK"});
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase()))
    return Swal.fire({icon:"info", title:"Player already exists", confirmButtonText:"OK"});
  state.players.push({name});
  state.scores.forEach(r => r.push(0));
  $("playerName").value = "";
  renderLeaderboard();
  renderRound();
  lucide.createIcons();
  save();
}

function showChart() {
  if (!state.players.length) return Swal.fire({icon:"info", title:"No players yet", text:"Add players first."});
  $("scoreChartTable").innerHTML = `
    <div class="overflow-x-auto">
      <table class="table table-sm w-full">
        <thead>
          <tr>
            <th class="sticky left-0 z-10 bg-slate-900 text-white">Round</th>
            ${state.players.map(p => `<th class="text-center whitespace-nowrap text-white">${escapeHtml(p.name)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rounds.map((round, ri) => `
            <tr>
              <th class="sticky left-0 z-10 bg-slate-900 text-white whitespace-nowrap">${round.title}</th>
              ${state.players.map((p, i) => `<td class="text-center font-semibold text-white">${Number(state.scores[ri][i]) || 0}</td>`).join("")}
            </tr>`).join("")}
          <tr class="border-t-2 border-white/20">
            <th class="sticky left-0 z-10 bg-slate-900 text-white">Total</th>
            ${state.players.map((p, i) => `<td class="text-center font-black text-amber-300">${state.scores.reduce((sum, round) => sum + (Number(round[i]) || 0), 0)}</td>`).join("")}
          </tr>
        </tbody>
      </table>
    </div>`;
  $("chartModal").showModal();
}

function showRoundScores() {
  if (!state.players.length) return Swal.fire({icon:"info", title:"No players yet", text:"Add players first."});
  $("roundScoresList").innerHTML = rounds.map((round, ri) => `
    <div class="score-round-card rounded-2xl p-3">
      <div class="flex items-center justify-between mb-2">
        <div>
          <div class="font-bold text-slate-800">${round.title}</div>
          <div class="text-xs text-slate-400">${round.requirements}</div>
        </div>
        <span class="badge badge-outline">Round ${ri+1}</span>
      </div>
      <div class="space-y-1">
        ${state.players.map((p,i) => `
          <div class="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
            <span class="font-medium truncate pr-3">${escapeHtml(p.name)}</span>
            <b class="text-slate-800">${Number(state.scores[ri][i]) || 0}</b>
          </div>`).join("")}
      </div>
    </div>`).join("");
  $("roundScoresModal").showModal();
}


function applyTheme() {
  document.body.classList.toggle("theme-dark", currentTheme === "dark");
  document.body.classList.toggle("theme-light", currentTheme === "light");
  const icon = $("themeIcon");
  if (icon) icon.setAttribute("data-lucide", currentTheme === "dark" ? "sun" : "moon");
  const label = $("themeLabel");
  if (label) label.textContent = currentTheme === "dark" ? "Light" : "Dark";
}

function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  applyTheme();
  settingsDirty = true;
  saveSettingsToFirestore();
  lucide.createIcons();
}

async function showHistory() {
  if (!storageReady) {
    return Swal.fire({
      icon:"info",
      title:"History unavailable",
      text:"Firestore is still connecting. Please try again in a moment."
    });
  }

  try {
    const sessions = historyRecords
      .filter(s => s && s.completed && (s.id !== sessionId || sessionCompleted));

    if (!sessions.length) {
      $("historyList").innerHTML = `<div class="text-sm opacity-60 p-3">No completed sessions yet.</div>`;
    } else {
      $("historyList").innerHTML = sessions.map((s,idx) => {
        const totalsList = (Array.isArray(s.players) ? s.players : [])
          .map((player,i) => ({
            name: player.name,
            total: (s.scores || []).reduce((sum,r) => sum + (Number(r?.[i]) || 0), 0)
          }))
          .sort((a,b) => a.total - b.total);
        const winner = totalsList[0];
        return `<button class="history-item w-full text-left rounded-2xl p-3" data-session-id="${escapeHtml(s.id)}">
          <div class="flex items-center justify-between">
            <div>
              <div class="font-bold">Session ${sessions.length-idx}</div>
              <div class="text-xs opacity-60">${escapeHtml(formatSessionDate(s.date || "Unknown date"))}</div>
            </div>
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </div>
          <div class="mt-2 text-sm">
            <span class="opacity-60">Winner:</span>
            <b>${winner ? escapeHtml(winner.name) : "—"}</b>
            ${winner ? ` <span class="opacity-60">(${winner.total})</span>` : ""}
          </div>
        </button>`;
      }).join("");
    }

    document.querySelectorAll(".history-item").forEach(btn =>
      btn.addEventListener("click", () => loadHistorySession(btn.dataset.sessionId))
    );
    lucide.createIcons();
    $("historyModal").showModal();
  } catch (error) {
    console.error("Firestore history error:", error);
    Swal.fire({icon:"error", title:"Could not load history", text:String(error.message || error)});
  }
}

async function loadHistorySession(id) {
  try {
    const record = historyRecords.find(item => item.id === id);
    if (!record) return;
    const players = record.players;
    const scores = record.scores;
    $("historyDetail").innerHTML =
      `<div class="mb-3"><div class="text-xs opacity-60">Session date</div><div class="font-bold">${escapeHtml(formatSessionDate(record.date || "Unknown date"))}</div></div>` +
      rounds.map((r,ri) =>
        `<div class="history-round rounded-2xl p-3 mb-2">
          <div class="font-bold">${r.title} <span class="text-xs opacity-60">• ${r.requirements}</span></div>
          <div class="mt-2 space-y-1">
            ${players.map((player,i) =>
              `<div class="flex justify-between text-sm"><span>${escapeHtml(player.name)}</span><b>${Number(scores[ri]?.[i]) || 0}</b></div>`
            ).join("")}
          </div>
        </div>`
      ).join("");
    $("historyListView").classList.add("hidden");
    $("historyDetailView").classList.remove("hidden");
    lucide.createIcons();
  } catch (error) {
    console.error("Firestore history detail error:", error);
  }
}

function renderAll() {
  applyTheme();
  renderLeaderboard();
  renderRound();
  lucide.createIcons();
  updateSessionDateDisplay();
  gsap.fromTo(".round-card", {opacity:0,y:8}, {opacity:1,y:0,duration:.3});
}

$("addPlayer").onclick = addPlayer;
$("saveLocalBtn").onclick = async () => {
  if (!storageReady || !sessionId) {
    if ($("cloudStatus")) $("cloudStatus").textContent = "Firestore is still connecting...";
    return;
  }
  localStateDirty = true;
  localStateVersion++;
  await persistToFirestore();
};
$("refreshBtn").onclick = () => window.location.reload();
$("playerName").addEventListener("keydown", e => { if (e.key === "Enter") addPlayer(); });
$("nextBtn").onclick = async () => {
  if (currentRound < 6) {
    currentRound++;
    renderRound();
    save();
    return;
  }

  const result = await Swal.fire({
    icon: "info",
    title: "You’re already on the final round",
    text: "This is Round 7 of 7. There isn’t another round to move to. Would you like to finish the session now?",
    showCancelButton: true,
    confirmButtonText: "Finish Session",
    cancelButtonText: "Stay on Round 7"
  });

  if (result.isConfirmed) $("finishBtn").click();
};
$("prevBtn").onclick = () => { if (currentRound > 0) { currentRound--; renderRound(); save(); } };
$("chartBtn").onclick = showChart;
$("roundScoresBtn").onclick = showRoundScores;

$("themeToggle").onclick = () => {
  toggleTheme();
  closeSettingsMenu();
};
$("roundScoresBtn").onclick = () => {
  showRoundScores();
  closeSettingsMenu();
};
$("historyBtn").onclick = () => {
  showHistory();
  closeSettingsMenu();
};

const settingsBtn = $("settingsBtn");
const settingsMenu = $("settingsMenu");
function closeSettingsMenu() {
  if (settingsMenu) settingsMenu.classList.add("hidden");
}
if (settingsBtn && settingsMenu) {
  settingsBtn.onclick = (event) => {
    event.stopPropagation();
    settingsMenu.classList.toggle("hidden");
  };
  settingsMenu.onclick = (event) => event.stopPropagation();
  document.addEventListener("click", closeSettingsMenu);
}
$("historyBackBtn").onclick = () => { $("historyDetailView").classList.add("hidden"); $("historyListView").classList.remove("hidden"); };

$("resetBtn").onclick = async () => {
  const result = await Swal.fire({
    icon:"warning",
    title:"Reset session?",
    text:"All data in the current game will be erased.",
    showCancelButton:true,
    confirmButtonText:"Reset",
    confirmButtonColor:"#dc2626"
  });
  if (!result.isConfirmed) return;

  try {
    if (storageReady && sessionId) await sessionsCollection().doc(sessionId).delete();

    state = {
      date:new Date().toISOString().slice(0,10),
      players:[],
      scores:Array.from({length:7},()=>[])
    };
    state.createdAt = new Date().toISOString();
    state.completedAt = null;
    currentRound = 0;
    sessionCompleted = false;
    setSessionId(makeId());
    localStateDirty = true;
    localStateVersion++;
    if ($("cloudStatus")) $("cloudStatus").textContent = "";
    if (storageReady) await persistToFirestore();
    renderAll();
    closeSettingsMenu();

    Swal.fire({
      icon:"success",
      title:"Session Reset",
      text:"The current game has been cleared and saved to Firestore.",
      timer:1200,
      showConfirmButton:false
    });
  } catch (error) {
    console.error("Firestore reset error:", error);
    Swal.fire({icon:"error", title:"Reset failed", text:String(error.message || error)});
  }
};

$("finishBtn").onclick = async () => {
  if (!state.players.length) return Swal.fire({icon:"info", title:"Add players first"});
  const list = totals();
  const winner = list[0];
  sessionCompleted = true;
  state.completedAt = new Date().toISOString();
  localStateDirty = true;
  localStateVersion++;
  await persistToFirestore();
  launchFireworks();
  const result = await Swal.fire({
    customClass: { popup: "winner-popup" },
    showCancelButton: true,
    confirmButtonText: "Play Another Session",
    cancelButtonText: "Exit",
    width: 390,
    html: `
      <div class="relative py-3">
        <div class="firework one"></div><div class="firework two"></div>
        <div class="text-amber-300 text-sm uppercase tracking-[.3em] font-bold">Session Complete</div>
        <div class="winner-trophy text-7xl my-3">🏆</div>
        <div class="text-white/60 text-sm">Winner</div>
        <div class="winner-name-float text-4xl font-black text-amber-300 mt-1 break-words">${escapeHtml(winner.name)}</div>
        <div class="text-white/50 mt-1">Lowest total score: <b class="text-white">${winner.total}</b></div>
        <div class="mt-5 text-left rounded-2xl bg-white/5 border border-white/10 p-3">
          ${list.map((p,i)=>`<div class="flex justify-between py-1 ${i===0 ? 'text-amber-300 font-bold' : 'text-white/80'}"><span>${i+1}. ${escapeHtml(p.name)}</span><b>${p.total}</b></div>`).join("")}
        </div>
      </div>`
  });
  if (result.isConfirmed) await startAnotherSession();
};

window.addEventListener("load", async () => {
  flatpickr("#sessionDate", {
    dateFormat:"Y-m-d",
    defaultDate:state.date,
    onChange: (selectedDates, dateStr) => {
      if (dateStr) { state.date = dateStr; save(); updateSessionDateDisplay(); }
    },
    onReady: () => updateSessionDateDisplay()
  });
  updateSessionDateDisplay();
  setInterval(updateSessionDateDisplay, 30000);
  tippy("[data-tippy-content]");
  const list = document.getElementById("leaderboard");
  if (list && window.Sortable) new Sortable(list, {animation:150});
  renderAll();
  // Connect to Firestore in the background so the app opens immediately.
  storageConnectPromise = loadFromFirestore();
  if (document.documentElement.classList.contains("skip-splash")) {
    const splash = $("splash");
    if (splash) splash.remove();
  } else {
    setTimeout(() => {
      sessionStorage.setItem("shanghai-splash-seen", "1");
      gsap.to("#splash", {opacity:0,duration:.25,onComplete:()=> $("splash").remove()});
    }, 700);
  }
});
