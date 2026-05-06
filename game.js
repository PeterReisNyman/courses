const STORAGE_KEY = "course-ranker-state-v1";
const STATE_API = "/api/state";
const K_FACTOR = 32;
const INITIAL_RATING = 1000;

const els = {
  totalCourses: document.querySelector("#totalCourses"),
  matchCount: document.querySelector("#matchCount"),
  ratedCount: document.querySelector("#ratedCount"),
  departmentFilter: document.querySelector("#departmentFilter"),
  cengOnly: document.querySelector("#cengOnly"),
  pairingMode: document.querySelector("#pairingMode"),
  undoButton: document.querySelector("#undoButton"),
  skipButton: document.querySelector("#skipButton"),
  resetButton: document.querySelector("#resetButton"),
  exportButton: document.querySelector("#exportButton"),
  rankingList: document.querySelector("#rankingList"),
  catalogCount: document.querySelector("#catalogCount"),
  catalogSearch: document.querySelector("#catalogSearch"),
  catalogSort: document.querySelector("#catalogSort"),
  courseCatalog: document.querySelector("#courseCatalog"),
  chooseLeft: document.querySelector("#chooseLeft"),
  chooseRight: document.querySelector("#chooseRight"),
  starLeft: document.querySelector("#starLeft"),
  starRight: document.querySelector("#starRight"),
  likeBothButton: document.querySelector("#likeBothButton"),
  hateBothButton: document.querySelector("#hateBothButton"),
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
  starred: [],
  currentPair: [],
  filters: {
    department: "All departments",
    cengOnly: false,
    mode: "balanced",
  },
};

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
    starred: savedState.starred || state.starred,
    currentPair: savedState.currentPair || state.currentPair,
    filters: {
      ...state.filters,
      ...(savedState.filters || {}),
    },
  };

  for (const course of courses) {
    state.ratings[course.course_code] ??= INITIAL_RATING;
    state.games[course.course_code] ??= 0;
  }

  populateFilters();
  bindEvents();
  applyStoredControls();
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
  els.starLeft.addEventListener("click", () => toggleVisibleStar("left"));
  els.starRight.addEventListener("click", () => toggleVisibleStar("right"));
  els.likeBothButton.addEventListener("click", likeBoth);
  els.hateBothButton.addEventListener("click", hateBoth);
  els.courseCatalog.addEventListener("click", (event) => {
    const button = event.target.closest("[data-star-course]");
    if (!button) return;
    toggleStar(button.dataset.starCourse);
  });
  els.skipButton.addEventListener("click", () => {
    state.history.push({ type: "skip", pair: [...state.currentPair] });
    nextPair();
    persistAndRender();
  });
  els.undoButton.addEventListener("click", undo);
  els.resetButton.addEventListener("click", resetRankings);
  els.exportButton.addEventListener("click", exportRankings);
  els.catalogSearch.addEventListener("input", render);
  els.catalogSort.addEventListener("change", render);
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
  els.undoButton.disabled = state.history.length === 0;
  els.skipButton.disabled = state.currentPair.length !== 2;
  els.chooseLeft.disabled = state.currentPair.length !== 2;
  els.chooseRight.disabled = state.currentPair.length !== 2;
  els.starLeft.disabled = state.currentPair.length !== 2;
  els.starRight.disabled = state.currentPair.length !== 2;
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
  renderCatalog(pool);
}

function renderCourse(side, course) {
  const fields = sideFields[side];
  const starButton = side === "left" ? els.starLeft : els.starRight;
  fields.code.textContent = course.course_code;
  fields.credits.textContent = `${course.credit_units} credits`;
  fields.title.textContent = course.title;
  fields.department.textContent = course.department;
  fields.description.textContent = course.description || "No description available.";
  fields.ceng.textContent = course.part_of_ceng === "Yes" ? "CENG" : "Non-CENG";
  fields.link.href = course.course_url;
  updateStarButton(starButton, course.course_code);
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
  updateStarButton(side === "left" ? els.starLeft : els.starRight, null);
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

function renderCatalog(pool) {
  const search = els.catalogSearch.value.trim().toLowerCase();
  const courseRows = catalogSortedCourses(pool)
    .filter((course) => matchesCatalogSearch(course, search));

  els.catalogCount.textContent = `${courseRows.length} shown`;
  els.courseCatalog.innerHTML = courseRows
    .map((course) => {
      const relation = relationStats(course.course_code);
      const rating = state.ratings[course.course_code];
      const games = state.games[course.course_code];
      const starred = isStarred(course.course_code);
      return `
        <article class="catalog-card">
          <div class="catalog-main">
            <div class="catalog-title">
              <strong>${escapeHtml(course.course_code)}</strong>
              <span>${escapeHtml(course.title)}</span>
            </div>
            <div class="catalog-meta">
              <span>${escapeHtml(course.department)}</span>
              <span>${escapeHtml(course.credit_units)} credits</span>
              <span>${course.part_of_ceng === "Yes" ? "CENG" : "Cross-college"}</span>
            </div>
            <p class="catalog-description">${escapeHtml(course.description || "No description available.")}</p>
            <div class="catalog-relation">
              <span>${relation.picked} picked</span>
              <span>${relation.rejected} rejected</span>
              <span>${relation.likedBoth} liked both</span>
              <span>${relation.hatedBoth} hated both</span>
            </div>
          </div>
          <div class="catalog-score">
            <strong>${rating}</strong>
            <small>${games} choices</small>
            <button type="button" class="catalog-star ${starred ? "is-starred" : ""}" data-star-course="${escapeAttr(course.course_code)}" aria-pressed="${starred}">
              ${starred ? "Starred" : "Star"}
            </button>
            <a href="${escapeAttr(course.course_url)}" target="_blank" rel="noreferrer">Open</a>
          </div>
        </article>
      `;
    })
    .join("");
}

function catalogSortedCourses(pool) {
  const sort = els.catalogSort.value;
  return [...pool].sort((a, b) => {
    if (sort === "code") return a.course_code.localeCompare(b.course_code);
    if (sort === "department") return a.department.localeCompare(b.department) || a.course_code.localeCompare(b.course_code);
    if (sort === "credits") return Number(b.credit_units) - Number(a.credit_units) || a.course_code.localeCompare(b.course_code);
    if (sort === "choices") return state.games[b.course_code] - state.games[a.course_code] || state.ratings[b.course_code] - state.ratings[a.course_code];
    if (sort === "starred") return Number(isStarred(b.course_code)) - Number(isStarred(a.course_code)) || state.ratings[b.course_code] - state.ratings[a.course_code];
    if (sort === "liked") return relationStats(b.course_code).likedBoth - relationStats(a.course_code).likedBoth || state.ratings[b.course_code] - state.ratings[a.course_code];
    if (sort === "hated") return relationStats(b.course_code).hatedBoth - relationStats(a.course_code).hatedBoth || state.ratings[a.course_code] - state.ratings[b.course_code];
    return state.ratings[b.course_code] - state.ratings[a.course_code] || state.games[b.course_code] - state.games[a.course_code] || a.course_code.localeCompare(b.course_code);
  });
}

function toggleVisibleStar(side) {
  const code = side === "left" ? state.currentPair[0] : state.currentPair[1];
  if (!code) return;
  toggleStar(code);
}

function toggleStar(courseCode) {
  if (isStarred(courseCode)) {
    state.starred = state.starred.filter((code) => code !== courseCode);
  } else {
    state.starred = [...state.starred, courseCode];
  }
  persistAndRender();
}

function isStarred(courseCode) {
  return state.starred.includes(courseCode);
}

function updateStarButton(button, courseCode) {
  const starred = courseCode ? isStarred(courseCode) : false;
  button.classList.toggle("is-starred", starred);
  button.setAttribute("aria-pressed", String(starred));
  button.textContent = starred ? "Starred" : "Star course";
}

function matchesCatalogSearch(course, search) {
  if (!search) return true;
  return [
    course.course_code,
    course.title,
    course.department,
    course.credit_units,
    course.part_of_ceng,
    course.description,
  ].some((value) => String(value || "").toLowerCase().includes(search));
}

function relationStats(courseCode) {
  return state.relations.reduce((stats, relation) => {
    if (relation.type === "picked") {
      if (relation.picked_course_code === courseCode) stats.picked += 1;
      if (relation.rejected_course_code === courseCode) stats.rejected += 1;
    }
    if (relation.type === "liked_both" && (relation.left_course_code === courseCode || relation.right_course_code === courseCode)) {
      stats.likedBoth += 1;
    }
    if (relation.type === "hated_both" && (relation.left_course_code === courseCode || relation.right_course_code === courseCode)) {
      stats.hatedBoth += 1;
    }
    return stats;
  }, { picked: 0, rejected: 0, likedBoth: 0, hatedBoth: 0 });
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
