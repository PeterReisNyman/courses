const STORAGE_KEY = "course-ranker-state-v1";
const STATE_API = "/api/state";
const K_FACTOR = 32;
const INITIAL_RATING = 1000;
const SHOT_DELAY_MIN_MS = 25000;
const SHOT_DELAY_MAX_MS = 75000;

const els = {
  totalCourses: document.querySelector("#totalCourses"),
  matchCount: document.querySelector("#matchCount"),
  ratedCount: document.querySelector("#ratedCount"),
  shotCount: document.querySelector("#shotCount"),
  departmentFilter: document.querySelector("#departmentFilter"),
  cengOnly: document.querySelector("#cengOnly"),
  pairingMode: document.querySelector("#pairingMode"),
  undoButton: document.querySelector("#undoButton"),
  skipButton: document.querySelector("#skipButton"),
  resetButton: document.querySelector("#resetButton"),
  exportButton: document.querySelector("#exportButton"),
  rankingList: document.querySelector("#rankingList"),
  chooseLeft: document.querySelector("#chooseLeft"),
  chooseRight: document.querySelector("#chooseRight"),
  likeBothButton: document.querySelector("#likeBothButton"),
  hateBothButton: document.querySelector("#hateBothButton"),
  shotBreak: document.querySelector("#shotBreak"),
  userShotCount: document.querySelector("#userShotCount"),
  manShotCount: document.querySelector("#manShotCount"),
  confirmShot: document.querySelector("#confirmShot"),
  dismissShot: document.querySelector("#dismissShot"),
};

const sideFields = {
  left: {
    code: document.querySelector("#leftCode"),
    credits: document.querySelector("#leftCredits"),
    title: document.querySelector("#leftTitle"),
    department: document.querySelector("#leftDepartment"),
    description: document.querySelector("#leftDescription"),
    ceng: document.querySelector("#leftCeng"),
    link: document.querySelector("#leftLink"),
  },
  right: {
    code: document.querySelector("#rightCode"),
    credits: document.querySelector("#rightCredits"),
    title: document.querySelector("#rightTitle"),
    department: document.querySelector("#rightDepartment"),
    description: document.querySelector("#rightDescription"),
    ceng: document.querySelector("#rightCeng"),
    link: document.querySelector("#rightLink"),
  },
};

let courses = [];
let saveQueue = Promise.resolve();
let fileSaveAvailable = true;
let state = {
  ratings: {},
  games: {},
  history: [],
  relations: [],
  currentPair: [],
  filters: {
    department: "All departments",
    cengOnly: false,
    mode: "balanced",
  },
  shotBreaks: {
    userShots: 0,
    manShots: 0,
    events: [],
    nextAt: 0,
    visible: false,
  },
};

let shotTimer = null;

init();

async function init() {
  const savedState = await loadState();

  courses = await fetch("courses.json").then((response) => {
    if (!response.ok) throw new Error("Could not load courses.json");
    return response.json();
  });

  state = {
    ...state,
    ratings: savedState.ratings || state.ratings,
    games: savedState.games || state.games,
    history: savedState.history || state.history,
    relations: savedState.relations || state.relations,
    currentPair: savedState.currentPair || state.currentPair,
    filters: {
      ...state.filters,
      ...(savedState.filters || {}),
    },
    shotBreaks: {
      ...state.shotBreaks,
      ...(savedState.shotBreaks || {}),
    },
  };

  for (const course of courses) {
    state.ratings[course.course_code] ??= INITIAL_RATING;
    state.games[course.course_code] ??= 0;
  }

  populateFilters();
  bindEvents();
  applyStoredControls();
  scheduleShotBreak();
  nextPair();
  render();
}

async function loadState() {
  try {
    const response = await fetch(STATE_API);
    if (response.ok) {
      fileSaveAvailable = true;
      return await response.json();
    }
  } catch {
    fileSaveAvailable = false;
  }

  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!fileSaveAvailable) return;

  const stateToSave = JSON.parse(JSON.stringify(state));
  saveQueue = saveQueue
    .then(() => fetch(STATE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stateToSave),
    }))
    .then((response) => {
      if (!response.ok) {
        fileSaveAvailable = false;
      }
    })
    .catch(() => {
      fileSaveAvailable = false;
    });
}

function populateFilters() {
  const departments = ["All departments", ...new Set(courses.map((course) => course.department))].sort((a, b) => {
    if (a === "All departments") return -1;
    if (b === "All departments") return 1;
    return a.localeCompare(b);
  });

  els.departmentFilter.innerHTML = departments
    .map((department) => `<option value="${escapeAttr(department)}">${escapeHtml(department)}</option>`)
    .join("");
}

function bindEvents() {
  els.chooseLeft.addEventListener("click", () => choose("left"));
  els.chooseRight.addEventListener("click", () => choose("right"));
  els.likeBothButton.addEventListener("click", likeBoth);
  els.hateBothButton.addEventListener("click", hateBoth);
  els.confirmShot.addEventListener("click", confirmShotBreak);
  els.dismissShot.addEventListener("click", dismissShotBreak);
  els.skipButton.addEventListener("click", () => {
    state.history.push({ type: "skip", pair: [...state.currentPair] });
    nextPair();
    persistAndRender();
  });
  els.undoButton.addEventListener("click", undo);
  els.resetButton.addEventListener("click", resetRankings);
  els.exportButton.addEventListener("click", exportRankings);
  els.departmentFilter.addEventListener("change", () => {
    state.filters.department = els.departmentFilter.value;
    nextPair();
    persistAndRender();
  });
  els.cengOnly.addEventListener("change", () => {
    state.filters.cengOnly = els.cengOnly.checked;
    nextPair();
    persistAndRender();
  });
  els.pairingMode.addEventListener("change", () => {
    state.filters.mode = els.pairingMode.value;
    nextPair();
    persistAndRender();
  });
  window.addEventListener("keydown", handleKeys);
}

function applyStoredControls() {
  els.departmentFilter.value = state.filters.department;
  els.cengOnly.checked = state.filters.cengOnly;
  els.pairingMode.value = state.filters.mode;
}

function choose(side) {
  const [leftCode, rightCode] = state.currentPair;
  if (!leftCode || !rightCode) return;

  const winner = side === "left" ? leftCode : rightCode;
  const loser = side === "left" ? rightCode : leftCode;
  const before = snapshot([winner, loser]);
  updateElo(winner, loser);

  state.history.push({
    id: createRelationId(),
    type: "choice",
    winner,
    loser,
    chosenSide: side,
    pair: [...state.currentPair],
    before,
  });
  state.relations.push({
    id: state.history[state.history.length - 1].id,
    type: "picked",
    at: new Date().toISOString(),
    left_course_code: leftCode,
    right_course_code: rightCode,
    picked_course_code: winner,
    rejected_course_code: loser,
    chosen_side: side,
  });

  nextPair();
  persistAndRender();
}

function updateElo(winner, loser) {
  const winnerRating = state.ratings[winner];
  const loserRating = state.ratings[loser];
  const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
  const expectedLoser = 1 - expectedWinner;

  state.ratings[winner] = Math.round(winnerRating + K_FACTOR * (1 - expectedWinner));
  state.ratings[loser] = Math.round(loserRating + K_FACTOR * (0 - expectedLoser));
  state.games[winner] += 1;
  state.games[loser] += 1;
}

function hateBoth() {
  const [leftCode, rightCode] = state.currentPair;
  if (!leftCode || !rightCode) return;

  const before = snapshot([leftCode, rightCode]);
  state.ratings[leftCode] = Math.max(0, state.ratings[leftCode] - 16);
  state.ratings[rightCode] = Math.max(0, state.ratings[rightCode] - 16);
  state.games[leftCode] += 1;
  state.games[rightCode] += 1;

  state.history.push({
    id: createRelationId(),
    type: "hateBoth",
    pair: [...state.currentPair],
    before,
  });
  state.relations.push({
    id: state.history[state.history.length - 1].id,
    type: "hated_both",
    at: new Date().toISOString(),
    left_course_code: leftCode,
    right_course_code: rightCode,
    picked_course_code: null,
    rejected_course_code: null,
    chosen_side: null,
  });

  nextPair();
  persistAndRender();
}

function likeBoth() {
  const [leftCode, rightCode] = state.currentPair;
  if (!leftCode || !rightCode) return;

  const before = snapshot([leftCode, rightCode]);
  state.ratings[leftCode] += 16;
  state.ratings[rightCode] += 16;
  state.games[leftCode] += 1;
  state.games[rightCode] += 1;

  state.history.push({
    id: createRelationId(),
    type: "likeBoth",
    pair: [...state.currentPair],
    before,
  });
  state.relations.push({
    id: state.history[state.history.length - 1].id,
    type: "liked_both",
    at: new Date().toISOString(),
    left_course_code: leftCode,
    right_course_code: rightCode,
    picked_course_code: null,
    rejected_course_code: null,
    chosen_side: null,
  });

  nextPair();
  persistAndRender();
}

function snapshot(codes) {
  return codes.reduce((memo, code) => {
    memo[code] = {
      rating: state.ratings[code],
      games: state.games[code],
    };
    return memo;
  }, {});
}

function undo() {
  const entry = state.history.pop();
  if (!entry) return;

  if (entry.type === "choice" || entry.type === "hateBoth" || entry.type === "likeBoth") {
    for (const [code, values] of Object.entries(entry.before)) {
      state.ratings[code] = values.rating;
      state.games[code] = values.games;
    }
    state.relations = state.relations.filter((relation) => relation.id !== entry.id);
  }

  state.currentPair = entry.pair;
  persistAndRender();
}

function resetRankings() {
  const confirmed = window.confirm("Reset your rankings and choice history?");
  if (!confirmed) return;

  state.ratings = {};
  state.games = {};
  state.history = [];
  state.relations = [];
  state.currentPair = [];
  for (const course of courses) {
    state.ratings[course.course_code] = INITIAL_RATING;
    state.games[course.course_code] = 0;
  }
  nextPair();
  persistAndRender();
}

function scheduleShotBreak() {
  window.clearTimeout(shotTimer);

  if (state.shotBreaks.visible) {
    showShotBreak();
    return;
  }

  if (!state.shotBreaks.nextAt) {
    state.shotBreaks.nextAt = Date.now() + randomDelay(SHOT_DELAY_MIN_MS, SHOT_DELAY_MAX_MS);
    saveState();
  }

  const delay = Math.max(1000, state.shotBreaks.nextAt - Date.now());
  shotTimer = window.setTimeout(triggerShotBreak, delay);
}

function triggerShotBreak() {
  state.shotBreaks.visible = true;
  state.shotBreaks.manShots += 1;
  state.shotBreaks.events.push({
    at: new Date().toISOString(),
    userConfirmed: false,
  });
  saveState();
  showShotBreak();
  render();
}

function showShotBreak() {
  els.shotBreak.classList.add("is-visible");
  els.shotBreak.setAttribute("aria-hidden", "false");
}

function hideShotBreak() {
  els.shotBreak.classList.remove("is-visible");
  els.shotBreak.setAttribute("aria-hidden", "true");
}

function confirmShotBreak() {
  state.shotBreaks.userShots += 1;
  const latest = state.shotBreaks.events[state.shotBreaks.events.length - 1];
  if (latest) latest.userConfirmed = true;
  closeShotBreak();
}

function dismissShotBreak() {
  closeShotBreak();
}

function closeShotBreak() {
  state.shotBreaks.visible = false;
  state.shotBreaks.nextAt = Date.now() + randomDelay(SHOT_DELAY_MIN_MS, SHOT_DELAY_MAX_MS);
  hideShotBreak();
  persistAndRender();
  scheduleShotBreak();
}

function nextPair() {
  const pool = filteredCourses();
  if (pool.length < 2) {
    state.currentPair = [];
    return;
  }

  const pair = selectPair(pool);
  state.currentPair = pair.map((course) => course.course_code);
}

function filteredCourses() {
  return courses.filter((course) => {
    const departmentMatch = state.filters.department === "All departments" || course.department === state.filters.department;
    const cengMatch = !state.filters.cengOnly || course.part_of_ceng === "Yes";
    return departmentMatch && cengMatch;
  });
}

function selectPair(pool) {
  if (state.filters.mode === "discover") {
    return lowestGamePair(pool);
  }

  if (state.filters.mode === "close") {
    return closeRatingPair(pool);
  }

  return balancedPair(pool);
}

function lowestGamePair(pool) {
  return [...pool]
    .sort((a, b) => state.games[a.course_code] - state.games[b.course_code] || Math.random() - 0.5)
    .slice(0, 2);
}

function closeRatingPair(pool) {
  const sorted = rankedCourses(pool);
  const start = randomInt(Math.max(1, sorted.length - 1));
  return [sorted[start], sorted[start + 1] || sorted[start - 1]];
}

function balancedPair(pool) {
  const underplayed = [...pool]
    .sort((a, b) => state.games[a.course_code] - state.games[b.course_code])
    .slice(0, Math.min(pool.length, 40));
  const first = underplayed[randomInt(underplayed.length)];
  const candidates = pool
    .filter((course) => course.course_code !== first.course_code)
    .sort((a, b) => {
      const ratingA = Math.abs(state.ratings[a.course_code] - state.ratings[first.course_code]);
      const ratingB = Math.abs(state.ratings[b.course_code] - state.ratings[first.course_code]);
      const gamesA = state.games[a.course_code];
      const gamesB = state.games[b.course_code];
      return ratingA - ratingB || gamesA - gamesB;
    });
  const second = candidates.slice(0, Math.min(candidates.length, 12))[randomInt(Math.min(candidates.length, 12))];
  return Math.random() > 0.5 ? [first, second] : [second, first];
}

function render() {
  const pool = filteredCourses();
  els.totalCourses.textContent = pool.length;
  els.matchCount.textContent = state.history.filter((entry) => entry.type === "choice").length;
  els.ratedCount.textContent = pool.filter((course) => state.games[course.course_code] > 0).length;
  els.shotCount.textContent = state.shotBreaks.userShots;
  els.userShotCount.textContent = state.shotBreaks.userShots;
  els.manShotCount.textContent = state.shotBreaks.manShots;
  els.undoButton.disabled = state.history.length === 0;
  els.skipButton.disabled = state.currentPair.length !== 2;
  els.chooseLeft.disabled = state.currentPair.length !== 2;
  els.chooseRight.disabled = state.currentPair.length !== 2;
  els.likeBothButton.disabled = state.currentPair.length !== 2;
  els.hateBothButton.disabled = state.currentPair.length !== 2;

  if (state.currentPair.length === 2) {
    renderCourse("left", findCourse(state.currentPair[0]));
    renderCourse("right", findCourse(state.currentPair[1]));
  } else {
    renderEmpty("left");
    renderEmpty("right");
  }

  renderRankings(pool);
}

function renderCourse(side, course) {
  const fields = sideFields[side];
  fields.code.textContent = course.course_code;
  fields.credits.textContent = `${course.credit_units} credits`;
  fields.title.textContent = course.title;
  fields.department.textContent = course.department;
  fields.description.textContent = course.description || "No description available.";
  fields.ceng.textContent = course.part_of_ceng === "Yes" ? "CENG" : "Non-CENG";
  fields.link.href = course.course_url;
}

function renderEmpty(side) {
  const fields = sideFields[side];
  fields.code.textContent = "No match";
  fields.credits.textContent = "";
  fields.title.textContent = "Choose a broader filter";
  fields.department.textContent = "";
  fields.description.textContent = "At least two courses are needed for a comparison.";
  fields.ceng.textContent = "";
  fields.link.href = "#";
}

function renderRankings(pool) {
  const ranked = rankedCourses(pool).slice(0, 20);
  els.rankingList.innerHTML = ranked
    .map((course) => {
      const rating = state.ratings[course.course_code];
      const games = state.games[course.course_code];
      return `
        <li>
          <span class="rank-title">${escapeHtml(course.course_code)} · ${escapeHtml(course.title)}</span>
          <span class="rank-detail">${escapeHtml(course.department)} · ${rating} rating · ${games} choices</span>
        </li>
      `;
    })
    .join("");
}

function rankedCourses(pool = courses) {
  return [...pool].sort((a, b) => {
    const ratingDiff = state.ratings[b.course_code] - state.ratings[a.course_code];
    const gamesDiff = state.games[b.course_code] - state.games[a.course_code];
    return ratingDiff || gamesDiff || a.course_code.localeCompare(b.course_code);
  });
}

function exportRankings() {
  const exportData = rankedCourses().map((course, index) => ({
    rank: index + 1,
    course_code: course.course_code,
    title: course.title,
    department: course.department,
    rating: state.ratings[course.course_code],
    choices: state.games[course.course_code],
  }));
  const blob = new Blob([`${JSON.stringify(exportData, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "course-rankings.json";
  link.click();
  URL.revokeObjectURL(url);
}

function handleKeys(event) {
  if (event.target.matches("input, select, button, a")) return;
  if (event.key === "ArrowLeft") choose("left");
  if (event.key === "ArrowRight") choose("right");
  if (event.key.toLowerCase() === "s") {
    state.history.push({ type: "skip", pair: [...state.currentPair] });
    nextPair();
    persistAndRender();
  }
  if (event.key.toLowerCase() === "u") undo();
}

function findCourse(code) {
  return courses.find((course) => course.course_code === code);
}

function persistAndRender() {
  saveState();
  render();
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function randomDelay(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function createRelationId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
