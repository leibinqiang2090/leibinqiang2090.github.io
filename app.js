const app = {
  state: null,
  filter: "all",
  search: "",
  dirty: false,
  busy: false,
  saving: false,
  saveTimer: null,
  syncTimer: null,
  ocrWorker: null,
  lastCorrections: [],
  reviewQueue: [],
  reviewIndex: 0,
  reviewRevealed: false,
  answerSelected: false,
  reviewMode: "queue",
  readOnly: false,
  advanceTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CACHE_KEY = "xingjinju-cloud-cache-v1";
const SESSION_TOKEN_KEY = "xingjinju-session-token";
const CLOUD_CONFIG = window.XINGJINJU_CONFIG || {};

function appUrl(path = "") {
  return new URL(String(path).replace(/^\/+/, ""), CLOUD_CONFIG.appBase || location.href).href;
}

function sessionToken() {
  return sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
}

function requireSession() {
  const token = sessionToken();
  if (!token) {
    location.replace(appUrl("login.html"));
    throw new Error("需要重新验证访问码");
  }
  return token;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeSpaces(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/([\u4e00-\u9fff，。；：、（）])\s+(?=[\u4e00-\u9fff，。；：、（）])/g, "$1")
    .trim();
}

function cleanMeaning(value = "") {
  let text = normalizeSpaces(value)
    .replace(/^(?:vt|vi|v|n|adj|adv|prep|conj|pron|pref)\.?\s*/i, "")
    .replace(/\s*·\s*·\s*·\s*/g, "……")
    .trim();
  return text;
}

function cleanWord(value = "") {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[：:…·]+$/g, "")
    .replace(/\s+/g, (match, offset, text) =>
      /^(?:[a-z] )+[a-z]$/.test(text) ? "" : " ",
    )
    .trim();
}

function primarySense(value = "") {
  return cleanMeaning(value).split(/[；;]/)[0].trim().slice(0, 24) || "待补充的意思";
}

function getMainWord(group) {
  return group.words.find((entry) => entry.correct)?.word || group.mainWord || group.words[0]?.word;
}

function getMasteryLevel(group) {
  const stored = Number(group?.masteryLevel);
  if (Number.isInteger(stored) && stored >= 0 && stored <= 3) {
    return stored;
  }
  return group?.mastered ? 3 : 0;
}

function masteryMeta(group) {
  const level = getMasteryLevel(group);
  return [
    { label: "未学习", className: "mastery-new", short: "新词" },
    { label: "学习中", className: "mastery-learning", short: "学习中" },
    { label: "较熟悉", className: "mastery-familiar", short: "较熟悉" },
    { label: "已掌握", className: "mastery-mastered", short: "已掌握" },
  ][level];
}

function isDue(group) {
  const level = getMasteryLevel(group);
  if (level === 0) return true;
  if (!group.nextReviewAt) return level < 3;
  return new Date(group.nextReviewAt).getTime() <= Date.now();
}

function normalizeMasteryState() {
  let changed = false;
  app.state.settings ||= {};
  if (!Number.isInteger(Number(app.state.settings.dailyGoal))) {
    app.state.settings.dailyGoal = 20;
    changed = true;
  }
  if (!Array.isArray(app.state.studyHistory)) {
    app.state.studyHistory = [];
    changed = true;
  }
  for (const group of app.state?.groups || []) {
    if (!Number.isInteger(Number(group.masteryLevel))) {
      group.masteryLevel = group.mastered ? 3 : 0;
      changed = true;
    }
    if (Boolean(group.mastered) !== (Number(group.masteryLevel) >= 3)) {
      group.mastered = Number(group.masteryLevel) >= 3;
      changed = true;
    }
  }
  return changed;
}

function getDailyGoal() {
  return Math.max(5, Math.min(200, Number(app.state?.settings?.dailyGoal) || 20));
}

function isToday(value) {
  return new Date(value).toDateString() === new Date().toDateString();
}

function getTodayCompleted() {
  return (app.state?.studyHistory || []).filter((entry) => entry?.at && isToday(entry.at)).length;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

function setCloudStatus(text, className = "") {
  const element = $("#cloudStatus");
  element.textContent = text;
  element.className = className;
}

async function cloudFetch(path, options = {}) {
  const token = requireSession();
  const method = String(options.method || "GET").toUpperCase();

  async function rpc(name, body) {
    const response = await fetch(`${CLOUD_CONFIG.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: CLOUD_CONFIG.publishableKey,
        Authorization: `Bearer ${CLOUD_CONFIG.publishableKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || payload?.loginRequired) {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      location.replace(appUrl("login.html"));
      throw new Error("需要重新验证访问码");
    }
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error || `请求失败（${response.status}）`);
    }
    return payload;
  }

  if (path === "/api/state" && method === "GET") {
    return rpc("app_load_state", { p_token: token });
  }
  if (path === "/api/state" && method === "PUT") {
    return rpc("app_save_state", {
      p_token: token,
      p_state: JSON.parse(options.body || "{}"),
    });
  }
  if (path === "/api/auth/logout") {
    return rpc("app_logout", { p_token: token });
  }
  if (path === "/api/images" && method === "POST") {
    const body = JSON.parse(options.body || "{}");
    return { imageData: body.dataUrl || "" };
  }
  if (path.startsWith("/api/dictionary?")) {
    const requestUrl = new URL(path, location.href);
    const response = await fetch(
      `${CLOUD_CONFIG.supabaseUrl}/functions/v1/dictionary?word=${encodeURIComponent(
        requestUrl.searchParams.get("word") || "",
      )}`,
      {
        headers: {
          apikey: CLOUD_CONFIG.publishableKey,
          Authorization: `Bearer ${CLOUD_CONFIG.publishableKey}`,
          "x-app-token": token,
        },
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error || `词典查询失败（${response.status}）`);
    }
    return payload;
  }
  throw new Error("不支持的云端请求");
}

function serializableState() {
  return {
    version: 2,
    groups: app.state.groups,
    settings: app.state.settings || {},
    correctionLogs: (app.state.correctionLogs || []).slice(0, 20),
    studyHistory: (app.state.studyHistory || []).slice(-500),
  };
}

function cacheState() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(app.state));
  } catch {
    // OCR assets and a large word library may exceed some browser quotas.
  }
}

async function loadCloud(showToast = false) {
  if ((app.busy || app.dirty) && !showToast) {
    return;
  }
  setCloudStatus("正在同步云端…");
  try {
    const state = await cloudFetch("/api/state");
    if ((app.busy || app.dirty) && !showToast) {
      return;
    }
    app.state = state;
    app.readOnly = state.accessRole === "guest";
    const masteryChanged = normalizeMasteryState();
    app.dirty = false;
    cacheState();
    renderAll();
    applyReadOnlyMode();
    if (masteryChanged && !app.readOnly) {
      scheduleSave();
    }
    setCloudStatus("云端已同步", "sync-saved");
    $("#lastSyncText").textContent = new Date().toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (showToast) {
      toast("已从云端同步最新词库");
    }
  } catch (error) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      app.state = JSON.parse(cached);
      renderAll();
      setCloudStatus("离线模式", "sync-saving");
      toast("网络不可用，当前显示上次缓存");
    } else {
      setCloudStatus("云端连接失败", "sync-saving");
      toast(error.message);
    }
  }
}

function scheduleSave() {
  app.dirty = true;
  cacheState();
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(saveCloud, 450);
}

async function saveCloud() {
  if (!app.state || app.saving) {
    return;
  }
  app.saving = true;
  setCloudStatus("正在保存…", "sync-saving");
  try {
    const state = await cloudFetch("/api/state", {
      method: "PUT",
      body: JSON.stringify(serializableState()),
    });
    app.state = state;
    app.dirty = false;
    cacheState();
    renderSummary();
    setCloudStatus("已保存到云端", "sync-saved");
  } catch (error) {
    setCloudStatus("等待重新同步", "sync-saving");
    toast(`保存失败：${error.message}`);
  } finally {
    app.saving = false;
    if (app.dirty) {
      clearTimeout(app.saveTimer);
      app.saveTimer = setTimeout(saveCloud, 1800);
    }
  }
}

function renderSummary() {
  const groups = app.state?.groups || [];
  const goal = getDailyGoal();
  const completed = getTodayCompleted();
  const dueCount = groups.filter(isDue).length;
  $("#heroCount").textContent = groups.length;
  $("#statGroups").textContent = groups.length;
  $("#statToday").textContent = `${completed} / ${goal}`;
  $("#statMastered").textContent = groups.filter((group) => getMasteryLevel(group) === 3).length;
  $("#goalDone").textContent = completed;
  $("#goalTarget").textContent = goal;
  $("#goalProgress").style.width = `${Math.min(100, (completed / goal) * 100)}%`;
  $("#heroReviewLabel").textContent = completed >= goal ? "继续复习" : "开始今日复习";
  $("#goalMessage").textContent = app.readOnly
    ? `访客可查看全部 ${groups.length} 组词，学习进度由所有者维护。`
    : completed >= goal
      ? `今日目标已完成，还有 ${dueCount} 组可继续复习。`
      : `还差 ${goal - completed} 组；当前待复习 ${dueCount} 组。`;
}

function applyReadOnlyMode() {
  document.body.classList.toggle("readonly-mode", app.readOnly);
  $("#readonlyBanner").hidden = !app.readOnly;
}

function renderTokens(group) {
  if (group.customSentence) {
    let html = escapeHtml(group.customSentence);
    for (const entry of [...group.words].sort((a, b) => b.word.length - a.word.length)) {
      const expression = new RegExp(`\\b${entry.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      html = html.replace(
        expression,
        `<span class="word-token ${entry.correct ? "is-main" : ""}">${escapeHtml(entry.word)}</span>`,
      );
    }
    return html;
  }
  const sentence = group.sentences?.[0] || {
    segments: [{ type: "text", text: group.sentence || "" }],
  };
  return (sentence.segments || [])
    .map((segment) => {
      if (segment.type !== "word") {
        return escapeHtml(segment.text);
      }
      const correct = group.words[segment.wordIndex]?.correct;
      return `<span class="word-token ${correct ? "is-main" : ""}" title="${escapeHtml(
        segment.meaning || "",
      )}">${escapeHtml(segment.text)}</span>`;
    })
    .join("");
}

function renderMemoryBlock(group) {
  const mainWord = getMainWord(group);
  const sentence =
    group.memorySentence ||
    group.customSentence ||
    buildClientComparisonSentence(group);
  const segments = buildSegments(sentence, group.words);
  return `
    <div class="sentence-block main-memory-block">
      <div class="sentence-label"><span>CONTRAST MEMORY · 全词对照</span><span>主词为 ${escapeHtml(
        mainWord,
      )}</span></div>
      <div class="sentence-text">${segments
        .map((segment) => {
          if (segment.type !== "word") return escapeHtml(segment.text);
          const isMain = group.words[segment.wordIndex]?.correct;
          return `<span class="word-token ${isMain ? "is-main" : ""}">${escapeHtml(
            segment.text,
          )}</span>`;
        })
        .join("")}</div>
    </div>
  `;
}

function buildClientComparisonSentence(group) {
  const main = group.words.find((entry) => entry.correct) || group.words[0];
  const ordered = [main, ...group.words.filter((entry) => entry !== main)].filter(Boolean);
  const items = ordered.map((entry) => {
    const contrastItem = group.contrast?.items?.find(
      (item) => String(item.word).toLowerCase() === String(entry.word).toLowerCase(),
    );
    return {
      word: entry.word,
      pos: contrastItem?.pos || "",
      meaning: primarySense(contrastItem?.meaning || entry.meaning).replace(/：.*$/, ""),
    };
  });
  const label = (item) => `${item.word}${item.pos ? `（${item.pos}）` : ""}是“${item.meaning}”`;
  if (items.length <= 1) return `对照记：${label(items[0] || { word: "", pos: "", meaning: "" })}。`;
  if (items.length === 2) return `对照记：${label(items[0])}，而 ${label(items[1])}。`;
  if (items.length === 3) {
    return `对照记：${label(items[0])}；${label(items[1])}，而 ${label(items[2])}。`;
  }
  const base = `对照记：${label(items[0])}；易混项 ${label(items[1])}。另外，${label(
    items[2],
  )}，而 ${label(items[3])}`;
  const extra = items.slice(4).map((item) => `还有 ${label(item)}`).join("；");
  return `${base}${extra ? `；${extra}` : ""}。`;
}

function renderContrast(group) {
  if (!group.contrast) {
    return `
      <div class="card-analysis">
        <strong>${escapeHtml(group.analysis?.label || "抓差异")}</strong>
        <span>${escapeHtml(group.analysis?.differences || "")}</span>
      </div>
    `;
  }
  return `
    <section class="contrast-panel">
      <div class="contrast-panel-head">
        <span>易混词辨析</span>
        <strong>${escapeHtml(group.contrast.title)}</strong>
      </div>
      <p class="contrast-note">${escapeHtml(group.contrast.note)}</p>
      <div class="contrast-items">
        ${(group.contrast.items || [])
          .map(
            (item) => `
              <article class="contrast-item">
                <div class="contrast-word-row">
                  <b>${escapeHtml(item.word)}</b>
                  <em class="contrast-pos">${escapeHtml(item.pos || "")}</em>
                  <span>${escapeHtml(item.meaning)}</span>
                </div>
                <p class="contrast-clue">${escapeHtml(item.clue)}</p>
                <code>${escapeHtml(item.collocation)}</code>
                <p class="contrast-example">${escapeHtml(item.example)}</p>
                <p class="contrast-example-cn">${escapeHtml(item.exampleCn || "")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function filteredGroups() {
  const query = app.search.trim().toLowerCase();
  return (app.state?.groups || []).filter((group) => {
    const level = getMasteryLevel(group);
    if (app.filter === "due" && !isDue(group)) return false;
    if (app.filter === "learning" && (level === 0 || level === 3)) return false;
    if (app.filter === "mastered" && level !== 3) return false;
    if (app.filter === "favorite" && !group.favorite) return false;
    if (!query) return true;
    return [
      group.mainWord,
      group.sentence,
      group.words.flatMap((word) => [word.word, word.meaning]).join(" "),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function renderCard(group) {
  const main = getMainWord(group);
  const mastery = masteryMeta(group);
  const imageSource = group.imageData ||
    (group.imageId ? appUrl(`api/images/${encodeURIComponent(group.imageId)}`) : "");
  return `
    <article class="memory-card ${group.mastered ? "mastered" : ""}" data-group-id="${escapeHtml(
      group.id,
    )}">
      <div class="card-main">
        <div class="card-topline">
          <div class="word-heading">
            <h3>${escapeHtml(main)}</h3>
            <span class="phonetic">${escapeHtml(group.phonetic || "")}</span>
          </div>
          <span class="badge mastery-status ${mastery.className}">${mastery.label}</span>
        </div>
        ${
          imageSource
            ? `<div class="card-source-link">
                <img class="cloud-card-image" src="${escapeHtml(imageSource)}" alt="" loading="lazy" />
                <span>${escapeHtml(group.sourceImage || "云端截图")}</span>
              </div>`
            : '<div class="card-source-link"><span>云端词卡</span></div>'
        }
      </div>
      ${renderMemoryBlock(group)}
      ${renderContrast(group)}
      <div class="card-footer">
        <div class="card-tools">
          <button class="tool-button" data-action="speak">
            <svg><use href="#icon-volume"></use></svg>美音
          </button>
        </div>
        <div class="card-actions">
          <button class="tool-button icon-only readonly-hide ${group.favorite ? "active" : ""}" data-action="favorite" title="收藏">
            <svg><use href="#icon-star"></use></svg>
          </button>
          <button class="tool-button icon-only readonly-hide" data-action="edit" title="编辑">
            <svg><use href="#icon-edit"></use></svg>
          </button>
          <button class="tool-button learn-button" data-action="learn">
            <svg><use href="#icon-spark"></use></svg>${
              mastery.className === "mastery-new"
                ? "开始学习"
                : mastery.className === "mastery-mastered"
                  ? "再次复习"
                  : "继续学习"
            }
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderAll() {
  renderSummary();
  const groups = filteredGroups();
  $("#cardGrid").innerHTML = groups.map(renderCard).join("");
  $("#emptyState").hidden = groups.length > 0;
  $$(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === app.filter);
  });
  renderCorrectionPanel();
}

function renderCorrectionPanel() {
  const logs = app.state?.correctionLogs || [];
  $("#correctionPanel").hidden = logs.length === 0;
  if (!logs.length) return;
  $("#correctionSummary").textContent = `${logs[0].imageName || "最近图片"}：自动核对 ${
    logs[0].checked || 0
  } 个词，改正 ${logs[0].corrections?.length || 0} 项。`;
}

function switchView(name) {
  $$(".nav-item[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === name);
  });
  $$(".view").forEach((view) => view.classList.remove("active"));
  $(`#${name}View`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function playAmerican(word) {
  const audio = new Audio(
    `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`,
  );
  audio.play().catch(() => {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
  });
}

function openEdit(group = null) {
  $("#editModalTitle").textContent = group ? "编辑这组记忆句" : "新建一组记忆句";
  $("#editGroupId").value = group?.id || "";
  $("#mainWordInput").value = group ? getMainWord(group) : "";
  $("#phoneticInput").value = group?.phonetic || "";
  $("#customSentenceInput").value = group?.customSentence || "";
  $("#deleteGroupButton").hidden = !group;
  $("#wordEditor").innerHTML = rowsForWords(group?.words || []);
  $("#editModal").hidden = false;
}

function rowsForWords(words) {
  return Array.from({ length: Math.max(4, words.length) }, (_, index) => ({
    word: words[index]?.word || "",
    meaning: words[index]?.meaning || "",
    correct: Boolean(words[index]?.correct),
  }))
    .map(
      (entry, index) => `
        <div class="word-editor-row">
          <label class="correct-radio"><input type="radio" name="correctWord" value="${index}" ${
            entry.correct ? "checked" : ""
          } /></label>
          <input class="word-field" value="${escapeHtml(entry.word)}" placeholder="单词 ${index + 1}" />
          <input class="meaning-field" value="${escapeHtml(entry.meaning)}" placeholder="中文释义" />
        </div>
      `,
    )
    .join("");
}

function closeModal(id) {
  $(`#${id}`).hidden = true;
}

function findCommonAffix(words) {
  const list = words.map((entry) => entry.word.toLowerCase());
  let prefix = list[0] || "";
  for (const word of list.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < word.length && prefix[index] === word[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  if (prefix.length >= 1) {
    return {
      label: `共同开头 ${prefix}-`,
      differences: list.map((word) => `${word} → ${word.slice(prefix.length) || word}`).join("；"),
    };
  }
  return {
    label: "逐个抓首字母",
    differences: list.map((word) => `${word} → ${word[0]}`).join("；"),
  };
}

function makeStory(group) {
  if (group.customSentence) return group.customSentence;
  const bits = group.words.slice(0, 4);
  return `周末整理笔记时，小林先想到 ${bits[0]?.word || ""} 的“${primarySense(
    bits[0]?.meaning,
  )}”，接着用 ${bits[1]?.word || ""} 的“${primarySense(
    bits[1]?.meaning,
  )}”补全画面，再把 ${bits[2]?.word || ""} 和 ${bits[3]?.word || ""} 放进同一个生活片段。`;
}

function buildSegments(text, words) {
  const lower = text.toLowerCase();
  const entries = words
    .map((entry, index) => ({ entry, index, needle: entry.word.toLowerCase() }))
    .sort((a, b) => b.needle.length - a.needle.length);
  const segments = [];
  let cursor = 0;
  while (cursor < text.length) {
    let best = null;
    for (const item of entries) {
      const position = lower.indexOf(item.needle, cursor);
      if (position >= 0 && (!best || position < best.position)) best = { ...item, position };
    }
    if (!best) {
      segments.push({ type: "text", text: text.slice(cursor) });
      break;
    }
    if (best.position > cursor) segments.push({ type: "text", text: text.slice(cursor, best.position) });
    segments.push({
      type: "word",
      text: best.entry.word,
      meaning: primarySense(best.entry.meaning),
      wordIndex: best.index,
    });
    cursor = best.position + best.entry.word.length;
  }
  return segments;
}

function decorateGroup(group) {
  const story = makeStory(group);
  const affix = findCommonAffix(group.words);
  return {
    ...group,
    mainWord: getMainWord(group),
    sentence: story,
    sentences: [{ text: story, segments: buildSegments(story, group.words) }],
    analysis: { ...affix, sentence: `${affix.label}。${affix.differences}。` },
    updatedAt: new Date().toISOString(),
  };
}

function saveEditedGroup(event) {
  event.preventDefault();
  const id = $("#editGroupId").value;
  const rows = $$("#wordEditor .word-editor-row")
    .map((row, index) => ({
      word: $(".word-field", row).value.trim().toLowerCase(),
      meaning: $(".meaning-field", row).value.trim(),
      correct: $(`input[name="correctWord"][value="${index}"]`).checked,
    }))
    .filter((entry) => entry.word);
  if (rows.length < 2) {
    toast("至少填写两个形近词");
    return;
  }
  const mainInput = $("#mainWordInput").value.trim().toLowerCase();
  const main = rows.find((entry) => entry.word === mainInput) || rows.find((entry) => entry.correct) || rows[0];
  rows.forEach((entry) => {
    entry.correct = entry === main;
  });
  const existing = app.state.groups.find((group) => group.id === id);
  const group = decorateGroup({
    ...(existing || {
      id: `custom-${crypto.randomUUID()}`,
      favorite: false,
      mastered: false,
      masteryLevel: 0,
      reviewCount: 0,
      lastReviewedAt: null,
      nextReviewAt: null,
      createdAt: new Date().toISOString(),
      confidence: "reviewed",
    }),
    words: rows,
    mainWord: main.word,
    phonetic: $("#phoneticInput").value.trim(),
    customSentence: $("#customSentenceInput").value.trim(),
    editedByUser: true,
    confidence: "reviewed",
  });
  if (existing) {
    app.state.groups[app.state.groups.indexOf(existing)] = group;
  } else {
    app.state.groups.unshift(group);
  }
  closeModal("editModal");
  renderAll();
  scheduleSave();
}

function deleteEditedGroup() {
  const id = $("#editGroupId").value;
  if (!id || !confirm("确定删除这组词吗？")) return;
  app.state.groups = app.state.groups.filter((group) => group.id !== id);
  closeModal("editModal");
  renderAll();
  scheduleSave();
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("图片压缩失败"));
            return;
          }
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              dataUrl: reader.result,
              width: canvas.width,
              height: canvas.height,
              sourceWidth: image.width,
              sourceHeight: image.height,
            });
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        0.72,
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张图片，请从相册选择 JPG/PNG 截图"));
    };
    image.src = url;
  });
}

async function ensureOcrWorker() {
  if (app.ocrWorker) return app.ocrWorker;
  if (!window.Tesseract) throw new Error("OCR 组件尚未加载，请刷新页面");
  app.ocrWorker = await Tesseract.createWorker("eng+chi_sim", Tesseract.OEM.LSTM_ONLY, {
    workerPath: appUrl("vendor/tesseract/worker.min.js"),
    corePath: appUrl("vendor/tesseract/"),
    langPath: appUrl("vendor/tessdata"),
    logger: (message) => {
      if (typeof message.progress === "number") {
        setOcrProgress(message.status || "正在识别…", Math.round(message.progress * 100));
      }
    },
  });
  await app.ocrWorker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
  });
  return app.ocrWorker;
}

function flattenOcrLines(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = normalizeSpaces(line.text || "");
        if (!text || !line.bbox) continue;
        lines.push({
          text,
          x: line.bbox.x0,
          y: line.bbox.y0,
          height: line.bbox.y1 - line.bbox.y0,
        });
      }
    }
  }
  return lines;
}

function parseVocabularyLines(lines, width, height) {
  const mainCandidates = lines
    .filter(
      (line) =>
        /^[A-Za-z][A-Za-z' -]{1,29}$/.test(line.text) &&
        line.y > height * 0.05 &&
        line.y < height * 0.52 &&
        line.height >= 18,
    )
    .sort((a, b) => b.height - a.height || a.y - b.y);
  const mainLine = mainCandidates[0];
  if (!mainLine) return null;
  const options = lines
    .filter(
      (line) =>
        /^[A-Za-z][A-Za-z' -]{1,29}$/.test(line.text) &&
        line.y > mainLine.y + Math.max(60, mainLine.height * 1.5) &&
        line.x < width * 0.76 &&
        line.height >= 10,
    )
    .sort((a, b) => a.y - b.y);
  if (options.length < 2) return null;
  const words = options.slice(0, 4).map((option, index, all) => {
    const nextY = all[index + 1]?.y ?? Math.min(height * 0.95, option.y + 180);
    const meaning = lines
      .filter(
        (line) =>
          /[\u4e00-\u9fff]/.test(line.text) &&
          line.y > option.y &&
          line.y < nextY &&
          line.x < width * 0.9,
      )
      .sort((a, b) => a.y - b.y)[0]?.text;
    return {
      word: cleanWord(option.text),
      meaning: cleanMeaning(meaning || ""),
      correct: false,
    };
  });
  const main = cleanWord(mainLine.text);
  let matching = words.find((entry) => entry.word === main);
  if (!matching) {
    matching = { word: main, meaning: "", correct: true };
    words.push(matching);
  }
  matching.correct = true;
  return {
    mainWord: main,
    phonetic: "",
    words: words.filter(
      (entry) =>
        entry.word &&
        !["abc", "sth", "sb", "usage"].includes(entry.word) &&
        /^[a-z][a-z' -]{1,31}$/i.test(entry.word),
    ),
    confidence: "needs-review",
  };
}

function meaningOverlap(original, dictionary) {
  if (!original || !dictionary) return false;
  const words = original.split(/[；;]/).flatMap((part) => part.match(/[\u4e00-\u9fff]{2,}/g) || []);
  return words.some((word) => {
    for (let index = 0; index <= word.length - 2; index += 1) {
      if (dictionary.includes(word.slice(index, index + 2))) return true;
    }
    return false;
  });
}

async function validateWords(group) {
  const corrections = [];
  const contrastItems = [];
  const lookups = await Promise.all(
    group.words.map(async (entry) => {
      try {
        return await cloudFetch(`/api/dictionary?word=${encodeURIComponent(entry.word)}`);
      } catch {
        return null;
      }
    }),
  );
  group.words.forEach((entry, index) => {
    const lookup = lookups[index];
    if (!lookup) {
      contrastItems.push({
        word: entry.word,
        pos: "",
        meaning: primarySense(entry.meaning),
        collocation: "—",
        example: "—",
        exampleCn: "—",
      });
      return;
    }
    const original = { ...entry };
    if (lookup.word && lookup.word !== entry.word) {
      entry.word = lookup.word;
      corrections.push({
        type: "word",
        word: lookup.word,
        original: original.word,
        corrected: lookup.word,
        reason: "词典标准拼写",
      });
    }
    if (lookup.phonetic) entry.phonetic = lookup.phonetic;
    const shouldCorrect = !entry.meaning || !meaningOverlap(entry.meaning, lookup.fullMeaning);
    if (shouldCorrect && lookup.meaning && lookup.meaning !== entry.meaning) {
      corrections.push({
        type: "meaning",
        word: entry.word,
        original: original.meaning || "（无释义）",
        corrected: lookup.meaning,
        reason: original.meaning ? "原释义与词典不符" : "原图未识别出释义",
      });
      entry.meaning = lookup.meaning;
    }
    contrastItems.push({
      word: entry.word,
      pos: lookup.pos || inferPartOfSpeech(entry.meaning),
      meaning: primarySense(entry.meaning),
      collocation: lookup.collocation || "搭配见例句",
      example: lookup.example || "—",
      exampleCn: lookup.exampleCn || "—",
    });
  });
  const main = group.words.find((entry) => entry.correct) || group.words[0];
  if (main) {
    group.mainWord = main.word;
    group.phonetic = main.phonetic ? `/${main.phonetic.replaceAll("/", "")}/` : "";
  }
  group.contrast = {
    generatedBy: "dictionary-auto",
    title: "词性、搭配与双语例句",
    note: "先看词性确定句法位置，再用固定搭配和例句把意思固定下来。",
    items: contrastItems,
  };
  group.memorySentence = buildClientComparisonSentence(group);
  group.memorySentenceSource = "comparison-generated";
  group.memoryIncludesAllWords = true;
  return { corrections, contrast: group.contrast };
}

function inferPartOfSpeech(meaning = "") {
  if (/地$/.test(meaning)) return "adv.";
  if (/的$/.test(meaning)) return "adj.";
  if (/[动作做使]$/.test(meaning)) return "v.";
  return "";
}

async function processImageFile(file) {
  setOcrProgress(`准备处理 ${file.name}`, 2);
  const compressed = await compressImage(file);
  const uploaded = await cloudFetch("/api/images", {
    method: "POST",
    body: JSON.stringify({ dataUrl: compressed.dataUrl, filename: file.name }),
  });
  setOcrProgress("正在读取截图…", 5);
  const worker = await ensureOcrWorker();
  const result = await worker.recognize(file, {}, { blocks: true });
  const lines = flattenOcrLines(result.data);
  const parsed = parseVocabularyLines(lines, compressed.sourceWidth, compressed.sourceHeight);
  if (!parsed) {
    return { imageData: uploaded.imageData, failed: true, filename: file.name, corrections: [] };
  }
  const validation = await validateWords(parsed);
  const corrections = validation.corrections;
  const signature = parsed.words
    .map((entry) => entry.word)
    .sort()
    .join("|");
  const duplicate = app.state.groups.find(
    (group) =>
      group.words
        .map((entry) => entry.word)
        .sort()
        .join("|") === signature,
  );
  if (duplicate) {
    duplicate.imageData = uploaded.imageData;
    delete duplicate.imageId;
    duplicate.sourceImage = file.name;
    duplicate.contrast = parsed.contrast || duplicate.contrast;
    return {
      imageData: uploaded.imageData,
      duplicate: true,
      filename: file.name,
      corrections,
      checked: parsed.words.length,
    };
  }
  const group = decorateGroup({
    ...parsed,
    id: `cloud-${crypto.randomUUID()}`,
    imageData: uploaded.imageData,
    sourceImage: file.name,
    favorite: false,
    mastered: false,
    masteryLevel: 0,
    reviewCount: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    createdAt: new Date().toISOString(),
  });
  app.state.groups.unshift(group);
  return {
    imageData: uploaded.imageData,
    filename: file.name,
    group,
    corrections,
    checked: parsed.words.length,
  };
}

function setOcrProgress(status, percent) {
  $("#ocrProgress").hidden = false;
  $("#ocrStatus").textContent = status;
  $("#ocrPercent").textContent = `${Math.max(0, Math.min(100, percent))}%`;
  $("#ocrProgressBar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

async function handleImageFiles(files) {
  if (!files.length) return;
  const button = $("#uploadButton");
  button.disabled = true;
  app.busy = true;
  const allCorrections = [];
  let failed = 0;
  let duplicates = 0;
  let checked = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      setOcrProgress(`处理 ${index + 1} / ${files.length}：${files[index].name}`, 3);
      try {
        const result = await processImageFile(files[index]);
        allCorrections.push(...(result.corrections || []));
        checked += result.checked || 0;
        if (result.failed) failed += 1;
        if (result.duplicate) duplicates += 1;
      } catch (error) {
        failed += 1;
        console.error(error);
      }
      setOcrProgress(`已完成 ${index + 1} / ${files.length}`, ((index + 1) / files.length) * 100);
    }
    app.lastCorrections = allCorrections;
    if (allCorrections.length || failed || duplicates) {
      app.state.correctionLogs = [
        {
          at: new Date().toISOString(),
          imageName: files.length === 1 ? files[0].name : `${files.length} 张图片`,
          checked,
          corrections: allCorrections,
          failed,
          duplicates,
        },
        ...(app.state.correctionLogs || []),
      ].slice(0, 20);
    }
    renderAll();
    scheduleSave();
    toast(
      `处理完成：改正 ${allCorrections.length} 项${
        duplicates ? `，跳过重复 ${duplicates} 张` : ""
      }${failed ? `，失败 ${failed} 张` : ""}`,
    );
  } finally {
    app.busy = false;
    button.disabled = false;
    setTimeout(() => {
      $("#ocrProgress").hidden = true;
    }, 800);
    $("#imageInput").value = "";
  }
}

function showCorrections() {
  const log = app.state?.correctionLogs?.[0];
  const corrections = log?.corrections || [];
  $("#correctionModalSummary").innerHTML = `
    <span>核对 <strong>${log?.checked || 0}</strong> 个词</span>
    <span>自动改正 <strong>${corrections.length}</strong> 项</span>
    <span>重复跳过 <strong>${log?.duplicates || 0}</strong> 张</span>
    <span>识别失败 <strong>${log?.failed || 0}</strong> 张</span>
  `;
  $("#correctionList").innerHTML = corrections.length
    ? corrections
        .map(
          (item) => `
            <div class="correction-row">
              <div><small>${item.type === "word" ? "拼写纠正" : "释义纠正"}</small>${escapeHtml(
                log.imageName || "",
              )}</div>
              <div><span class="correction-word">${escapeHtml(item.word)}</span></div>
              <div><span class="correction-original">${escapeHtml(
                item.original,
              )}</span><small>修改前</small></div>
              <div><span class="correction-fixed">${escapeHtml(
                item.corrected,
              )}</span><small>${escapeHtml(item.reason)}</small></div>
            </div>
          `,
        )
        .join("")
    : '<div class="correction-empty">本次未发现需要改正的内容。</div>';
  $("#correctionModal").hidden = false;
}

function uniqueReviewGroups(groups) {
  const seenWords = new Set();
  return groups.filter((group) => {
    const key = normalizeSpaces(getMainWord(group)).toLowerCase();
    if (!key || seenWords.has(key)) {
      return false;
    }
    seenWords.add(key);
    return true;
  });
}

function reviewedWordsToday() {
  const groups = app.state?.groups || [];
  const reviewedGroupIds = new Set(
    (app.state?.studyHistory || [])
      .filter((entry) => entry?.at && isToday(entry.at))
      .map((entry) => entry.groupId),
  );
  return new Set(
    groups
      .filter((group) => reviewedGroupIds.has(group.id))
      .map((group) => normalizeSpaces(getMainWord(group)).toLowerCase()),
  );
}

function unreviewedReviewGroups() {
  const reviewed = reviewedWordsToday();
  return uniqueReviewGroups(
    (app.state?.groups || []).filter((group) => {
      const key = normalizeSpaces(getMainWord(group)).toLowerCase();
      return reviewed.size === 0 || !reviewed.has(key);
    }),
  );
}

function nextReviewBatchSize() {
  const configured = Math.max(10, Math.min(getDailyGoal(), 50));
  const unseen = unreviewedReviewGroups().length;
  return unseen > 0 ? Math.min(unseen, configured) : configured;
}

function startReview(groupId = null) {
  const groups = app.state?.groups || [];
  if (!groups.length) {
    toast("还没有词卡");
    return;
  }
  if (groupId) {
    const group = groups.find((entry) => entry.id === groupId);
    if (!group) return;
    app.reviewQueue = [group];
    app.reviewMode = "single";
  } else if (app.readOnly) {
    app.reviewQueue = [...groups].sort(() => Math.random() - 0.5).slice(0, 10);
    app.reviewMode = "guest";
  } else {
    const unseenGroups = unreviewedReviewGroups();
    const candidates = unseenGroups.length ? unseenGroups : uniqueReviewGroups(groups);
    const due = candidates.filter(isDue);
    const source = [
      ...due,
      ...candidates.filter((group) => !isDue(group)),
    ].sort(
      (left, right) =>
        getMasteryLevel(left) - getMasteryLevel(right) ||
        new Date(left.nextReviewAt || 0) - new Date(right.nextReviewAt || 0),
    );
    const goal = getDailyGoal();
    const remaining = Math.max(0, goal - getTodayCompleted());
    const sessionLimit = Math.min(
      source.length,
      remaining > 0 ? remaining : nextReviewBatchSize(),
    );
    app.reviewQueue = source.slice(0, sessionLimit);
    app.reviewMode = due.length ? "review" : "practice";
  }
  app.reviewIndex = 0;
  app.reviewRevealed = false;
  app.ratingInProgress = false;
  clearTimeout(app.advanceTimer);
  $("#reviewModal").hidden = false;
  renderReview();
}

function renderReview() {
  const total = app.reviewQueue.length;
  $("#reviewPreviousButton").hidden = total === 0;
  $("#reviewPreviousButton").disabled = app.reviewIndex <= 0 || total === 0;
  if (app.reviewIndex >= total) {
    const completed = getTodayCompleted();
    const goal = getDailyGoal();
    const nextBatch = nextReviewBatchSize();
    const unseenCount = unreviewedReviewGroups().length;
    $("#reviewBody").innerHTML = `
      <div class="review-done"><div>
        <div class="done-seal">记住了</div>
        <h3>这一轮完成了</h3>
        <p>今日已完成 ${completed} / ${goal} 组。${
          completed >= goal ? "目标已达成，可以继续巩固。" : "复习结果已同步到云端。"
        }</p>
        <div class="review-done-actions">
          <button class="soft-button" data-review-previous>返回上一个单词</button>
          <button class="primary-button" data-continue-review>${
            unseenCount > 0 ? `继续复习 ${nextBatch} 组` : "再复习一轮"
          }</button>
          <button class="soft-button" data-close="reviewModal">回到词卡</button>
        </div>
      </div></div>`;
    return;
  }
  const group = app.reviewQueue[app.reviewIndex];
  const main = getMainWord(group);
  const mastery = masteryMeta(group);
  app.reviewRevealed = false;
  app.answerSelected = false;
  $("#reviewProgressText").textContent = `${app.reviewIndex + 1} / ${total}`;
  $("#reviewProgressBar").style.width = `${(app.reviewIndex / total) * 100}%`;
  $("#reviewBody").innerHTML = `
    <div class="learn-session">
      <div class="learn-session-meta">
        <span class="badge mastery-status ${mastery.className}">${mastery.label}</span>
        <span>${
          app.reviewMode === "single"
            ? "单词组学习"
            : app.reviewMode === "review"
              ? "到期复习"
              : app.reviewMode === "guest"
                ? "访客练习 · 不记录"
                : "自由复习"
        }</span>
      </div>
      <div class="learn-word-stage">
        <span class="section-kicker">RECALL THIS WORD</span>
        <div class="recall-word"><h3>${escapeHtml(main)}</h3>
          <button data-review-speak title="播放美音"><svg><use href="#icon-volume"></use></svg></button>
        </div>
        <p class="recall-prompt">${escapeHtml(group.phonetic || "")}</p>
        <p class="learn-hint">选择最符合这个单词的释义。答对自动进入下一词，答错才显示完整答案。</p>
        <div class="meaning-options review-meaning-options">
          ${[...group.words]
            .sort(() => Math.random() - 0.5)
            .map(
              (entry, index) => `
                <button class="meaning-option" data-review-answer="${index}" data-correct="${
                  entry.correct ? "true" : "false"
                }">
                  ${escapeHtml(entry.meaning || "释义待补")}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
      <div id="learnAnswer"></div>
    </div>
  `;
}

function showPreviousReviewWord() {
  if (!app.reviewQueue.length || app.reviewIndex <= 0) {
    return;
  }
  clearTimeout(app.advanceTimer);
  app.reviewIndex = Math.min(app.reviewIndex - 1, app.reviewQueue.length - 1);
  app.reviewRevealed = false;
  app.answerSelected = false;
  renderReview();
}

function recordMasteryRating(rating) {
  const group = app.reviewQueue[app.reviewIndex];
  if (app.readOnly) {
    return masteryMeta(group);
  }
  const currentLevel = getMasteryLevel(group);
  let nextLevel = currentLevel;
  let nextReviewAt;
  if (rating === "again") {
    nextLevel = 0;
    nextReviewAt = Date.now() + 10 * 60 * 1000;
  } else if (rating === "hard") {
    nextLevel = 1;
    nextReviewAt = Date.now() + 24 * 60 * 60 * 1000;
  } else {
    nextLevel = Math.min(3, currentLevel + 1);
    nextReviewAt = Date.now() + nextGoodInterval(currentLevel) * 24 * 60 * 60 * 1000;
  }
  group.masteryLevel = nextLevel;
  group.mastered = nextLevel >= 3;
  group.nextReviewAt = new Date(nextReviewAt).toISOString();
  group.reviewCount = Number(group.reviewCount || 0) + 1;
  group.lastReviewedAt = new Date().toISOString();
  app.state.studyHistory = [
    ...(app.state.studyHistory || []),
    {
      at: group.lastReviewedAt,
      groupId: group.id,
      rating,
      previousLevel: currentLevel,
      nextLevel,
    },
  ].slice(-500);
  renderSummary();
  renderAll();
  scheduleSave();
  return masteryMeta(group);
}

function nextGoodInterval(level) {
  if (level >= 3) return 30;
  return { 0: 1, 1: 3, 2: 7 }[level] || 1;
}

function answerReview(button) {
  if (app.answerSelected) return;
  app.answerSelected = true;
  const group = app.reviewQueue[app.reviewIndex];
  const isCorrect = button.dataset.correct === "true";
  $$(".review-meaning-options .meaning-option").forEach((option) => {
    option.disabled = true;
    if (option === button) option.classList.add(isCorrect ? "correct" : "wrong");
    if (!isCorrect && option.dataset.correct === "true") option.classList.add("correct");
  });
  if (isCorrect) {
    const nextMeta = recordMasteryRating("good");
    toast(app.readOnly ? "回答正确，访客练习不记录进度" : `回答正确，已记录：${nextMeta.label}`);
    $("#learnAnswer").innerHTML = `
      <div class="answer-feedback correct-feedback">
        <strong>回答正确</strong>
        <span>即将进入下一词…</span>
      </div>
    `;
    clearTimeout(app.advanceTimer);
    app.advanceTimer = setTimeout(() => {
      app.reviewIndex += 1;
      renderReview();
    }, 650);
    return;
  }

  app.reviewRevealed = true;
  $("#learnAnswer").innerHTML = `
    <div class="learn-answer-panel wrong-answer-panel">
      <div class="answer-feedback wrong-feedback">
        <strong>这次混淆了，正确答案已标绿</strong>
        <span>看完辨析后继续下一词。</span>
      </div>
      ${renderMemoryBlock(group)}
      ${renderContrast(group)}
      <div class="wrong-answer-footer">
        ${
          app.readOnly
            ? `<span>访客练习不记录完成状态。</span>
               <button class="primary-button" data-review-next>看完，下一词</button>`
            : `<span>看完答案后，选择你对这个词的实际掌握程度：</span>
               <div class="footer-actions">
                 <button class="soft-button" data-review-next-rating="again">还是没记住</button>
                 <button class="primary-button" data-review-next-rating="hard">有点模糊</button>
               </div>`
        }
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    $("#learnAnswer")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function openGoalModal() {
  $("#goalInput").value = getDailyGoal();
  $("#goalModal").hidden = false;
  setTimeout(() => $("#goalInput").select(), 50);
}

function saveDailyGoal(event) {
  event.preventDefault();
  const value = Math.max(5, Math.min(200, Number($("#goalInput").value) || 20));
  app.state.settings ||= {};
  app.state.settings.dailyGoal = value;
  closeModal("goalModal");
  renderSummary();
  scheduleSave();
  toast(`每日目标已设为 ${value} 组`);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      switchView(nav.dataset.nav);
      return;
    }
    const close = event.target.closest("[data-close]");
    if (close) {
      closeModal(close.dataset.close);
      return;
    }
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      app.filter = filter.dataset.filter;
      renderAll();
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      const group = app.state.groups.find(
        (item) => item.id === action.closest("[data-group-id]")?.dataset.groupId,
      );
      if (!group) return;
      if (action.dataset.action === "favorite") {
        group.favorite = !group.favorite;
        renderAll();
        scheduleSave();
      } else if (action.dataset.action === "learn") {
        startReview(group.id);
      } else if (action.dataset.action === "speak") {
        playAmerican(getMainWord(group));
      } else if (action.dataset.action === "edit") {
        openEdit(group);
      }
      return;
    }
    const reviewAnswer = event.target.closest("[data-review-answer]");
    if (reviewAnswer) {
      answerReview(reviewAnswer);
      return;
    }
    if (event.target.closest("[data-review-previous]")) {
      showPreviousReviewWord();
      return;
    }
    if (event.target.closest("[data-review-next]")) {
      app.reviewIndex += 1;
      renderReview();
      return;
    }
    if (event.target.closest("[data-continue-review]")) {
      startReview();
      return;
    }
    const nextRating = event.target.closest("[data-review-next-rating]");
    if (nextRating) {
      const nextMeta = recordMasteryRating(nextRating.dataset.reviewNextRating);
      toast(`已记录：${nextMeta.label}`);
      app.reviewIndex += 1;
      renderReview();
      return;
    }
    if (event.target.closest("[data-review-speak]")) {
      playAmerican(getMainWord(app.reviewQueue[app.reviewIndex]));
    }
  });

  $("#searchInput").addEventListener("input", (event) => {
    app.search = event.target.value;
    renderAll();
  });
  $("#newGroupButton").addEventListener("click", () => openEdit());
  $("#heroReviewButton").addEventListener("click", () => startReview());
  $("#reviewNav").addEventListener("click", () => startReview());
  $("#syncButton").addEventListener("click", () => loadCloud(true));
  $("#quickSyncButton").addEventListener("click", () => loadCloud(true));
  $("#groupForm").addEventListener("submit", saveEditedGroup);
  $("#goalForm").addEventListener("submit", saveDailyGoal);
  $("#dailyGoalButton").addEventListener("click", openGoalModal);
  $("#deleteGroupButton").addEventListener("click", deleteEditedGroup);
  $("#uploadButton").addEventListener("click", () => $("#imageInput").click());
  $("#imageInput").addEventListener("change", (event) => handleImageFiles([...event.target.files]));
  $("#toggleCorrectionsButton").addEventListener("click", showCorrections);
  $$(".goal-presets [data-goal-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#goalInput").value = button.dataset.goalPreset;
    });
  });
  $("#logoutButton").addEventListener("click", async () => {
    try {
      await cloudFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      location.replace(appUrl("login.html"));
    }
  });
  $$(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    });
  });
  window.addEventListener("online", () => {
    if (app.dirty) saveCloud();
    else loadCloud(false);
  });
  window.addEventListener("offline", () => setCloudStatus("离线模式", "sync-saving"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !app.dirty) loadCloud(false);
  });
}

async function init() {
  if (!sessionToken()) {
    location.replace(appUrl("login.html"));
    return;
  }
  bindEvents();
  await loadCloud(false);
  app.syncTimer = setInterval(() => {
    if (!document.hidden && !app.dirty && !app.saving) loadCloud(false);
  }, 30000);
  if ("serviceWorker" in navigator && location.pathname === "/") {
    navigator.serviceWorker.register(appUrl("sw.js")).catch(() => {});
  }
}

init();
