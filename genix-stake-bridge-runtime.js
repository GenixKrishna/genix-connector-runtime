(function () {
  "use strict";

  const API_ROOT = "http://127.0.0.1:3000/api/stake";
  const SETTINGS_KEY = "genix_stake_bridge_settings_v5";
  const EVENTS_KEY = "genix_stake_bridge_events_v1";
  const CRASH_ROUNDS_KEY = "genix_stake_crash_history_v1";
  const FINISHED_BETS_KEY = "genix_stake_bridge_finished_bets_v1";
  const TOKEN_PATTERN = /^gx1_[A-Za-z0-9_-]{43}$/;
  const SUPPORTED_GAMES = new Set(["mines", "moles", "dice", "dragon_tower", "hilo", "keno", "limbo", "plinko", "crash"]);
  const CASHOUT_GAMES = new Set(["mines", "moles", "crash"]);
  const ONE_SHOT_GAMES = new Set(["dice", "keno", "limbo", "plinko"]);
  const GAME_FIELD_LABELS = {
    dice: ["Difficulty", "Multiplier", "Roll Over", "Win Chance"],
    dragon_tower: ["Difficulty", "Rows"],
    hilo: ["Profit Higher", "Profit Lower"],
    keno: ["Difficulty"],
    limbo: ["Target Multiplier", "Win Chance"],
    plinko: ["Difficulty", "Rows"],
    crash: ["Cashout At", "Profit on Win"],
  };
  const defaults = {
    authorizationToken: "", pairingRegistered: false, monitoringEnabled: false, username: "", usernameOverride: "", betaMode: false, connected: false, activeBet: null,
    lastStakeOrigin: "", stakeDomain: "", lastActivityAt: 0, lastHeartbeatAt: 0,
  };
  let settings = { ...defaults };
  let events = [];
  let eventWriteQueue = Promise.resolve();
  let eventStorageQueue = Promise.resolve();
  let verifiedStakeUsername = "";
  let host;
  let root;
  let activityStack;
  let lastRenderedGame = null;
  let generating = false;
  let syncing = false;
  let checking = false;
  let syncRetryTimer = 0;
  let connectionRetryTimer = 0;
  let syncRetryDelay = 500;
  let pendingBetIds = new Set();
  let pendingRoundKeys = new Set();
  let pendingMinePickCounts = new Map();
  let mineClickSequences = new Map();
  let pendingTileClicks = [];
  let finishedStakeBetIds = new Set();
  let finishingBetIds = new Set();
  let finishingBetTypes = new Map();
  let recentlyEndedBet = null;
  let activeBetControl = null;
  let moleClickReservations = new Map();
  let recentPointerTileClicks = new Map();
  let pendingGameActions = new Map();
  let visibleScanBusy = false;
  let visibleActiveFingerprint = "";
  let visibleInactiveSince = 0;
  let visibleInactiveBetId = "";
  let pendingCashoutGames = new Set();
  let gameHeartbeatBusy = false;
  let lastGameHeartbeatAt = 0;
  let lastGameHeartbeatFingerprint = "";
  let lastConnectionCheckAt = 0;
  let lastCrashCashoutAt = 0;
  let lastCrashVisibleState = null;
  let lastCrashVisibleStateAt = 0;
  let lastCrashMultiplier = null;
  let lastCrashMultiplierAt = 0;
  let crashVisualCache = { scannedAt: 0, liveNode: null, countdownNode: null, crashedNode: null, history: [] };
  let crashTextObserver = null;
  let crashTextObserverTarget = null;
  let crashSyncTimer = 0;
  let recentCrashRounds = [];
  let lastVisibleCrashHistoryKey = "";
  let lastObservedCrashStatus = "";
  let waitForIdleAfterFinish = false;
  let pendingBetIntent = null;
  const recentSelectionCounts = { mines: null, moles: null };
  let initialized = false;
  let resolveInitialized;
  const initializedPromise = new Promise((resolve) => { resolveInitialized = resolve; });
  const nativeFetch = window.fetch;
  const localFallbackStorage = new Map();

  async function readStoredValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        const value = await GM_getValue(key, undefined);
        if (value !== undefined) return value;
      }
    } catch (_) {}
    try {
      if (typeof GM !== "undefined" && typeof GM.getValue === "function") {
        const value = await GM.getValue(key, undefined);
        if (value !== undefined) return value;
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem("__genix_bridge__" + key);
      if (raw !== null) return JSON.parse(raw);
    } catch (_) {}
    return localFallbackStorage.has(key) ? localFallbackStorage.get(key) : fallback;
  }

  async function writeStoredValue(key, value) {
    localFallbackStorage.set(key, value);
    try {
      if (typeof GM_setValue === "function") {
        await GM_setValue(key, value);
        return;
      }
    } catch (_) {}
    try {
      if (typeof GM !== "undefined" && typeof GM.setValue === "function") {
        await GM.setValue(key, value);
        return;
      }
    } catch (_) {}
    try { localStorage.setItem("__genix_bridge__" + key, JSON.stringify(value)); } catch (_) {}
  }

  const readSettings = async () => {
    const stored = await readStoredValue(SETTINGS_KEY, null)
      || await readStoredValue("genix_stake_bridge_settings_v4", null)
      || await readStoredValue("genix_stake_bridge_settings_v3", {});
    const result = { ...defaults, ...(stored || {}) };
    if (result.activeBet && !result.activeBet.detectionSource) result.activeBet.detectionSource = "screen";
    if (typeof result.usernameOverride !== "string") result.usernameOverride = "";
    if (typeof result.betaMode !== "boolean") result.betaMode = false;
    if (typeof stored?.pairingRegistered !== "boolean") result.pairingRegistered = TOKEN_PATTERN.test(result.authorizationToken);
    if (typeof stored?.monitoringEnabled !== "boolean") result.monitoringEnabled = false;
    return result;
  };
  const saveSettings = async (next) => {
    settings = { ...settings, ...next };
    await writeStoredValue(SETTINGS_KEY, settings);
    renderConnection();
  };
  const saveEvents = async () => {
    events = events.slice(-100);
    const snapshot = events.slice();
    const write = eventStorageQueue.then(() => writeStoredValue(EVENTS_KEY, snapshot));
    eventStorageQueue = write.catch(() => {});
    await write;
  };
  const isStakeDomain = (hostname) => /(^|\.)stake\.(com|ac|bet)$/i.test(String(hostname || ""));
  const isStakeOrigin = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" && isStakeDomain(url.hostname);
    } catch { return false; }
  };
  const stakeApiOrigin = () => location.origin;
  const getStakeUsername = () => String(settings.usernameOverride || "").trim().replace(/^@/, "");
  const currentGame = () => {
    const path = location.pathname.toLowerCase();
    const segments = path.split("/").filter(Boolean);
    const gameSegment = segments.findIndex((segment) => segment === "games");
    const slug = gameSegment >= 0 ? (segments[gameSegment + 1] || "").replace(/_/g, "-") : "";
    const aliases = [
      ["mines", "mines"], ["moles", "moles"], ["dice", "dice"],
      ["dragon-tower", "dragon_tower"], ["tower", "dragon_tower"],
      ["hilo", "hilo"], ["hi-lo", "hilo"], ["keno", "keno"],
      ["limbo", "limbo"], ["plinko", "plinko"], ["crash", "crash"],
    ];
    const match = aliases.find(([route]) => slug === route || slug.endsWith("-" + route));
    if (match && SUPPORTED_GAMES.has(match[1])) return match[1];
    return "";
  };

  function setStatus(message, isError = false) {
    const status = root?.querySelector("#genix-inline-status");
    if (!status) return;
    status.textContent = String(message || "");
    status.dataset.error = isError ? "true" : "false";
  }

  function showActivityToast(message) {
    const approvedMessages = new Map([
      ["Connected with Predictor", "✓"],
      ["Detected Mines game", "M"],
      ["Detected Moles game", "M"],
      ["Active bet detected", "↗"],
    ]);
    if (!activityStack || !approvedMessages.has(message)) return;
    const toast = document.createElement("div");
    toast.className = "activity-toast";
    const icon = document.createElement("span");
    icon.className = "activity-icon";
    icon.textContent = approvedMessages.get(message);
    const text = document.createElement("span");
    text.className = "activity-message";
    text.textContent = message;
    toast.append(icon, text);
    activityStack.append(toast);
    while (activityStack.children.length > 3) activityStack.firstElementChild?.remove();
    window.requestAnimationFrame(() => toast.classList.add("show"));
    window.setTimeout(() => {
      toast.classList.remove("show");
      window.setTimeout(() => toast.remove(), 360);
    }, 2800);
  }

  function request(method, path, token, payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const headers = {};
      if (payload) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = "Bearer " + token;
      const onload = (response) => {
        if (settled) return;
        settled = true;
        let body = {};
        try { body = JSON.parse(response.responseText || "{}"); } catch (_) {}
        if (response.status >= 200 && response.status < 300) resolve(body);
        else {
          const error = new Error(body.error || "Predictor returned HTTP " + response.status + ".");
          error.status = response.status;
          reject(error);
        }
      };
      const onerror = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message || "Could not reach the Genix Predictor backend."));
      };
      const requestOptions = {
        method,
        url: API_ROOT + path,
        headers,
        data: payload ? JSON.stringify(payload) : undefined,
        timeout: 10000,
        onload,
        onerror: () => onerror("Sync is queued and will retry automatically."),
        ontimeout: () => onerror("Sync is queued and will retry automatically."),
      };
      let gmRequest = null;
      try { if (typeof GM_xmlhttpRequest === "function") gmRequest = GM_xmlhttpRequest; } catch (_) {}
      try { if (!gmRequest && typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") gmRequest = GM.xmlHttpRequest.bind(GM); } catch (_) {}
      if (gmRequest) {
        try {
          const result = gmRequest(requestOptions);
          if (result && typeof result.then === "function") result.then(onload).catch(() => onerror("Sync is queued and will retry automatically."));
          return;
        } catch (_) {}
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      nativeFetch.call(window, API_ROOT + path, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        cache: "no-store",
        mode: "cors",
        signal: controller.signal,
      }).then(async (response) => {
        const responseText = await response.text();
        window.clearTimeout(timeout);
        onload({ status: response.status, responseText });
      }).catch((error) => {
        window.clearTimeout(timeout);
        onerror("Sync is queued and will retry automatically.");
      });
    });
  }

  async function updateUsername(value) {
    const username = String(value || "").trim().replace(/^@/, "").slice(0, 64);
    if (!validStakeUsername(username)) return;
    verifiedStakeUsername = username;
    renderConnection();
    renderStakeStatus();
    if (settings.authorizationToken && settings.usernameOverride) void checkConnection();
  }

  async function saveCustomUsername() {
    const input = root?.querySelector("#genix-stake-username");
    const username = String(input?.value || "").trim().replace(/^@/, "");
    if (!validStakeUsername(username)) {
      setStatus("Enter the Stake username you want to use, then save it.", true);
      return;
    }
    try {
      if (settings.pairingRegistered && TOKEN_PATTERN.test(settings.authorizationToken)) {
        await request("POST", "/connection/username", settings.authorizationToken, { username });
      }
      await saveSettings({ username, usernameOverride: username });
      setStatus("Custom Stake username saved.");
      renderConnection();
      if (settings.monitoringEnabled) { lastConnectionCheckAt = 0; void checkConnection(); }
    } catch (error) {
      setStatus(error.message || "Could not save this username.", true);
    }
  }

  function validStakeUsername(value) {
    const username = String(value || "").trim().replace(/^@/, "");
    return /^[a-z0-9_]{2,64}$/i.test(username)
      && !["stake", "stakecom", "stakeac", "stakebet", "anonymous"].includes(username.toLowerCase());
  }

  function readStakeBet(payload, game) {
    if (!payload || typeof payload !== "object") return null;
    const user = payload.user || payload.data?.user || null;
    const bet = payload.activeCasinoBet || user?.activeCasinoBet || payload.data?.activeCasinoBet || null;
    if (!bet || typeof bet !== "object") return null;
    const state = bet.state || {};
    const rawCount = game === "moles"
      ? state.molesCount ?? state.moleCount ?? state.numberOfMoles ?? bet.molesCount ?? bet.moleCount ?? bet.numberOfMoles
      : state.minesCount ?? state.mineCount ?? state.numberOfMines ?? bet.minesCount ?? bet.mineCount ?? bet.numberOfMines;
    return {
      id: String(bet.id || ""),
      active: bet.active === true,
      username: String(bet.user?.name || user?.name || ""),
      amount: String(bet.amount ?? ""),
      count: Number(rawCount),
      currency: String(bet.currency || ""),
    };
  }

  function isMatchingActiveBet(activeBet, betId, game, count, amount) {
    if (!activeBet || activeBet.game !== game) return false;
    if (betId && activeBet.stakeBetId === betId) return true;
    if (!String(activeBet.stakeBetId || "").startsWith("visible-")) return false;
    const age = Date.now() - (Date.parse(activeBet.betCapturedAt || "") || 0);
    return age >= 0 && age < 30000
      && (!Number.isInteger(count) || activeBet.selectionCount === count)
      && amountsMatch(activeBet.betAmount, amount);
  }

  async function finishActiveBet(eventType, extra = {}) {
    const activeBet = settings.activeBet;
    if (!activeBet) return false;
    const finishKey = String(activeBet.betEventId || activeBet.stakeBetId);
    if (finishingBetIds.has(finishKey)) return false;
    finishingBetIds.add(finishKey);
    finishingBetTypes.set(finishKey, eventType);
    waitForIdleAfterFinish = true;
    rememberFinishedBet(activeBet);
    recentlyEndedBet.eventType = eventType;
    recentlyEndedBet.betEventId = activeBet.betEventId || activeBet.stakeBetId;
    try {
      await saveSettings({ activeBet: null });
      activeBetControl = null;
      visibleActiveFingerprint = "";
      visibleInactiveSince = 0;
      visibleInactiveBetId = "";
      const finishLabel = eventType === "cashout" ? "CASHOUT WIN" : eventType === "round_end" ? "ROUND COMPLETE" : "BET LOST";
      setStatus(finishLabel + " · " + activeBet.game.toUpperCase());
      await queueEvent(activeBet, eventType, extra);
      return true;
    } finally {
      finishingBetIds.delete(finishKey);
      finishingBetTypes.delete(finishKey);
    }
  }

  function rememberFinishedBet(bet) {
    if (!bet) return;
    const ids = [bet.stakeBetId, bet.betEventId].filter((id) => typeof id === "string" && id.length > 0);
    for (const id of ids) finishedStakeBetIds.add(id);
    while (finishedStakeBetIds.size > 100) finishedStakeBetIds.delete(finishedStakeBetIds.values().next().value);
    recentlyEndedBet = {
      game: bet.game,
      selectionCount: bet.selectionCount,
      betAmount: String(bet.betAmount ?? "0"),
      username: bet.username,
      gameData: bet.gameData || {},
      betEventId: bet.betEventId || bet.stakeBetId,
      betCapturedAt: bet.betCapturedAt,
      endedAt: Date.now(),
    };
    void writeStoredValue(FINISHED_BETS_KEY, Array.from(finishedStakeBetIds));
  }

  function validDetails(details) {
    const max = details.game === "mines" ? 24 : details.game === "moles" ? 6 : 0;
    const validSelection = max
      ? Number.isInteger(details.selectionCount) && details.selectionCount >= 1 && details.selectionCount <= max
      : SUPPORTED_GAMES.has(details.game) && details.selectionCount === 0;
    return Boolean(validStakeUsername(details.username) && validSelection
      && /^\d{1,16}(?:\.\d{1,8})?$/.test(String(details.betAmount)) && Number(details.betAmount) >= 0);
  }

  function safeGameData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = {};
    for (const [key, raw] of Object.entries(value).slice(0, 20)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) continue;
      if (typeof raw === "number" && Number.isFinite(raw)) result[key] = Math.max(-1_000_000, Math.min(1_000_000, raw));
      else if (typeof raw === "boolean") result[key] = raw;
      else if (typeof raw === "string") result[key] = raw.replace(/[\u0000-\u001f]/g, " ").slice(0, 100);
    }
    return result;
  }

  function amountsMatch(left, right) {
    if (left == null || left === "" || right == null || right === "") return true;
    const a = Number(String(left).replace(/,/g, ""));
    const b = Number(String(right).replace(/,/g, ""));
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8;
  }

  function scheduleEventRetry() {
    if (syncRetryTimer || !settings.monitoringEnabled || !settings.authorizationToken) return;
    const delay = syncRetryDelay + Math.floor(Math.random() * 200);
    syncRetryDelay = Math.min(5000, Math.ceil(syncRetryDelay * 1.7));
    syncRetryTimer = window.setTimeout(() => {
      syncRetryTimer = 0;
      if (settings.monitoringEnabled && settings.connected) void flushEvents();
    }, delay);
  }

  function scheduleConnectionRetry() {
    if (connectionRetryTimer || !settings.monitoringEnabled || !settings.authorizationToken) return;
    connectionRetryTimer = window.setTimeout(() => {
      connectionRetryTimer = 0;
      void checkConnection();
    }, 2000);
  }

  async function flushEvents() {
    if (syncing || !settings.monitoringEnabled || !settings.connected || !settings.authorizationToken || !events.length) return;
    syncing = true;
    let retryAfterFlush = false;
    try {
      let next = events.find((event) => !event.synced && !event.discarded && (!settings.betaMode || event.eventType === "game_action"));
      while (next) {
        const { eventId, username, game, selectionCount, betAmount, capturedAt, eventType, roundIndex, selectedHole, outcome, betEventId, betCapturedAt, gameData } = next;
        try {
          await request("POST", "/events", settings.authorizationToken, {
            eventId, username, game, selectionCount, betAmount, capturedAt,
            eventType, roundIndex, selectedHole, outcome, betEventId, betCapturedAt, gameData,
          });
        } catch (error) {
          if (error?.status === 400) {
            const rejectedIndex = events.findIndex((event) => event.eventId === eventId);
            if (rejectedIndex >= 0) events[rejectedIndex] = { ...events[rejectedIndex], discarded: true };
            await saveEvents();
            setStatus("Skipped one invalid queued event and continued syncing.", true);
            next = events.find((event) => !event.synced && !event.discarded && (!settings.betaMode || event.eventType === "game_action"));
            continue;
          }
          if (error?.status === 401 || error?.status === 403) {
            await saveSettings({ connected: false });
            scheduleConnectionRetry();
          } else retryAfterFlush = true;
          throw error;
        }
        const index = events.findIndex((event) => event.eventId === eventId);
        if (index >= 0) events[index] = { ...events[index], synced: true };
        await saveEvents();
        syncRetryDelay = 500;
        next = events.find((event) => !event.synced && !event.discarded && (!settings.betaMode || event.eventType === "game_action"));
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        setStatus("Reconnect Genix Predictor to resume syncing.", true);
      }
      if (error?.status !== 401 && error?.status !== 403) retryAfterFlush = true;
    } finally {
      syncing = false;
      if (retryAfterFlush && settings.connected) scheduleEventRetry();
    }
  }

  async function checkConnection() {
    if (checking || !settings.monitoringEnabled || !settings.pairingRegistered || !settings.authorizationToken) return;
    checking = true;
    lastConnectionCheckAt = Date.now();
    try {
      const connection = await request("GET", "/connection?summary=status", settings.authorizationToken);
      if (connection.expired) {
        await saveSettings({ connected: false, pairingRegistered: false, monitoringEnabled: false, activeBet: null });
        setStatus("Token inactive for 7 days. Generate a fresh token, then connect it manually in Genix Predictor.", true);
        return;
      }
      if (connection.linked) {
        const pageUsername = getStakeUsername();
        const accountMismatch = Boolean(validStakeUsername(pageUsername) && connection.username !== pageUsername);
        if (!accountMismatch) {
          const wasConnected = settings.connected;
          const game = currentGame();
          const gameData = game === "crash" ? readVisibleCrashState() : game ? readVisibleGameData(game) : {};
          await request("POST", "/heartbeat", settings.authorizationToken, { game: game || null, gameData });
          lastGameHeartbeatAt = Date.now();
          lastGameHeartbeatFingerprint = JSON.stringify({ game: game || null, gameData });
          await saveSettings({ connected: true, lastHeartbeatAt: Date.now() });
          if (!wasConnected) showActivityToast("Connected with Predictor");
          if (connectionRetryTimer) window.clearTimeout(connectionRetryTimer);
          connectionRetryTimer = 0;
          await flushEvents();
        } else {
          await saveSettings({ connected: false });
          setStatus("This token is linked to " + connection.username + ", but this page reports " + pageUsername + ". Connect with the matching account.", true);
        }
      } else {
        await saveSettings({ connected: false });
      }
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) await saveSettings({ connected: false });
      if (error?.status === 401 || error?.status === 403) setStatus("Reconnect Genix Predictor to resume syncing.", true);
      scheduleConnectionRetry();
    } finally { checking = false; }
    renderConnection();
  }

  function queueEvent(details, eventType = "bet_placed", extra = {}) {
    if (settings.betaMode && eventType !== "game_action") return Promise.resolve(null);
    const write = eventWriteQueue.then(() => appendQueuedEvent(details, eventType, extra));
    eventWriteQueue = write.catch(() => null);
    return write;
  }

  function recordGameAction(game, action, actionData = {}) {
    if (!SUPPORTED_GAMES.has(game)) return;
    const activeBet = settings.activeBet?.game === game ? settings.activeBet : null;
    const visible = readVisibleGameState(game);
    const count = game === "mines" || game === "moles"
      ? Number.isInteger(visible?.count) ? visible.count : activeBet?.selectionCount || readVisibleSelectionCount(game) || 1
      : 0;
    const amount = visible?.amount !== "" && visible?.amount != null ? visible.amount : activeBet?.betAmount || readVisibleBetAmount() || "0";
    const gameData = safeGameData({ ...(visible?.gameData || {}), action, ...actionData });
    void queueEvent({ username: getStakeUsername(), game, selectionCount: count, betAmount: String(amount), gameData }, "game_action", { gameData, capturedAt: new Date().toISOString() });
  }

  async function appendQueuedEvent(details, eventType = "bet_placed", extra = {}) {
    if (!validDetails(details)) {
      setStatus("Visible Stake username, game count, or wager amount is missing.", true);
      return null;
    }
    const now = Date.now();
    const eventId = crypto.randomUUID();
    const capturedAt = extra.capturedAt || new Date(now).toISOString();
    const standaloneAction = eventType === "game_action" && !details.betEventId;
    const parentBetId = eventType === "bet_placed" || standaloneAction ? eventId : details.betEventId;
    const parentBetAt = eventType === "bet_placed" || standaloneAction ? capturedAt : details.betCapturedAt;
    if (!parentBetId || !parentBetAt) return null;
    const event = {
      eventId,
      username: details.username.slice(0, 64),
      game: details.game,
      selectionCount: details.selectionCount,
      betAmount: String(details.betAmount),
      capturedAt,
      eventType,
      roundIndex: extra.roundIndex ?? null,
      selectedHole: extra.selectedHole ?? null,
      outcome: extra.outcome ?? "unknown",
      betEventId: parentBetId,
      betCapturedAt: parentBetAt,
      gameData: safeGameData({ ...(details.gameData || {}), ...(extra.gameData || {}) }),
      synced: false,
    };
    events.push(event);
    if (eventType === "bet_placed") {
      await saveSettings({
        username: event.username,
        activeBet: {
          stakeBetId: String(extra.stakeBetId || event.eventId),
          game: details.game,
          username: details.username,
          selectionCount: details.selectionCount,
          betAmount: String(details.betAmount),
          betEventId: event.eventId,
          betCapturedAt: event.capturedAt,
          gameData: event.gameData,
          lastMoleRounds: 0,
          seenActiveAt: Date.now(),
          currency: String(extra.currency || ""),
          detectionSource: String(extra.source || "screen"),
        },
      });
    } else {
      await saveSettings({ username: event.username });
    }
    await saveEvents();
    if (eventType === "bet_placed") { setStatus("ACTIVE BET · " + details.game.toUpperCase()); if (details.game === "mines" || details.game === "moles") showActivityToast("Active bet detected"); }
    else if (eventType === "cashout") { setStatus("CASHOUT WIN · " + details.game.toUpperCase()); showActivityToast("CASHOUT WIN · " + details.game.toUpperCase()); }
    else if (eventType === "loss") { setStatus("BET LOST · " + details.game.toUpperCase()); showActivityToast("BET LOST · " + details.game.toUpperCase(), true); }
    else if (eventType === "round_end") setStatus("ROUND COMPLETE · " + details.game.toUpperCase());
    else if (eventType === "mine_pick" && extra.outcome === "mine") showActivityToast("MINE HIT · BET LOST", true);
    else if (eventType === "mine_pick" && extra.outcome === "safe") showActivityToast("SAFE TILE · MINES");
    else if (eventType === "mole_pick" && extra.outcome === "mole") { setStatus("BET LOST · MOLES"); showActivityToast("MOLE HIT · BET LOST", true); }
    void flushEvents();
    return event;
  }

  async function startDetectedBet(game, bet) {
    if (settings.betaMode || !SUPPORTED_GAMES.has(game)) return;
    const count = Number(bet.count);
    const amount = String(bet.amount ?? "").replace(/,/g, "");
    const username = getStakeUsername();
    if (!bet.id || !bet.active || finishedStakeBetIds.has(bet.id) || pendingBetIds.has(bet.id) || settings.activeBet?.stakeBetId === bet.id) return;
    const activeBet = settings.activeBet;
    const sameBetDetails = activeBet?.game === game
      && activeBet.selectionCount === count
      && amountsMatch(activeBet.betAmount, amount);
    const isFreshBetClick = pendingBetIntent?.game === game && Date.now() - pendingBetIntent.at < 5000;
    const betCapturedAfterClick = Boolean(isFreshBetClick && activeBet
      && String(activeBet.betEventId || activeBet.stakeBetId || "") !== pendingBetIntent.previousBetEventId
      && Date.parse(activeBet.betCapturedAt || "") >= pendingBetIntent.at - 250);
    const recentVisibleBet = sameBetDetails
      && activeBet.detectionSource === "screen"
      && (!isFreshBetClick || betCapturedAfterClick)
      && Date.now() - (Date.parse(activeBet.betCapturedAt || "") || 0) < 3000;
    if (bet.source === "screen" && sameBetDetails && (!isFreshBetClick || betCapturedAfterClick)) return;
    if (bet.source !== "screen" && recentVisibleBet) {
      await saveSettings({ activeBet: { ...activeBet, stakeBetId: bet.id, detectionSource: "api" } });
      return;
    }
    if (activeBet) await finishActiveBet("loss", { outcome: "loss" });
    waitForIdleAfterFinish = false;
    if (pendingBetIntent?.game === game && Date.now() - pendingBetIntent.at < 3000) {
      activeBetControl = pendingBetIntent.control;
    }
    const details = { username, game, selectionCount: count, betAmount: amount, gameData: safeGameData(bet.gameData) };
    if (!validDetails(details)) {
      setStatus("Visible Stake username, game count, or wager amount is invalid.", true);
      return;
    }
    pendingBetIds.add(bet.id);
    try {
      const event = await queueEvent(details, "bet_placed", { stakeBetId: bet.id, currency: bet.currency, source: bet.source, gameData: details.gameData });
      if (!event) pendingBetIds.delete(bet.id);
      else if (settings.activeBet?.betEventId === event.eventId) drainPendingTileClicks(settings.activeBet);
    } finally { window.setTimeout(() => pendingBetIds.delete(bet.id), 3000); }
  }

  async function processMinesResponse(payload) {
    const bet = readStakeBet(payload, "mines");
    const rawUsername = payload?.user?.name || payload?.data?.user?.name || bet?.username;
    if (validStakeUsername(rawUsername)) await updateUsername(rawUsername);
    const userName = validStakeUsername(rawUsername) ? rawUsername : getStakeUsername();
    if (bet) {
      if (bet.active) {
        const visibleAmount = readVisibleBetAmount();
        const visibleCount = readVisibleSelectionCount("mines");
        const apiCount = Number.isInteger(bet.count) && bet.count >= 1 && bet.count <= 24 ? bet.count : null;
        const apiAmount = /^\d{1,16}(?:\.\d{1,8})?$/.test(bet.amount) ? bet.amount : "";
        await startDetectedBet("mines", {
          ...bet,
          username: userName || bet.username,
          amount: apiAmount || visibleAmount || bet.amount,
          count: apiCount ?? visibleCount ?? bet.count,
          source: "api",
        });
      } else if (bet.active === false && isMatchingActiveBet(settings.activeBet, bet.id, "mines", bet.count, bet.amount)) {
        await finishActiveBet("loss", { outcome: "loss" });
      }
    }
  }

  function unwrapMolesNode(payload) {
    const data = payload?.data || payload;
    if (!data || typeof data !== "object") return null;
    for (const operation of ["molesBet", "molesNext", "molesCashout"]) {
      if (data[operation] && typeof data[operation] === "object") {
        const node = data[operation];
        return { operation, bet: node.bet || node.activeCasinoBet || node };
      }
    }
    const activeBet = data?.user?.activeCasinoBet || payload?.user?.activeCasinoBet;
    const game = String(activeBet?.game?.slug || activeBet?.game || "").toLowerCase();
    if (activeBet?.state && (game === "moles" || Number.isInteger(activeBet.state.molesCount))) {
      return { operation: "molesNext", bet: activeBet };
    }
    return null;
  }

  async function processMolesResponse(payload) {
    const found = unwrapMolesNode(payload);
    const rawUsername = payload?.data?.user?.name || payload?.user?.name || found?.bet?.user?.name || "";
    if (validStakeUsername(rawUsername)) await updateUsername(rawUsername);
    const userName = validStakeUsername(rawUsername) ? rawUsername : getStakeUsername();
    if (!found) return;
    const { operation, bet } = found;
    const state = bet.state || {};
    const rounds = Array.isArray(state.rounds) ? state.rounds : [];
    const betId = String(bet.id || "");
    const storedBet = settings.activeBet?.game === "moles" ? settings.activeBet : null;
    const storedBetAge = storedBet ? Date.now() - (Date.parse(storedBet.betCapturedAt || "") || 0) : Infinity;
    const currentBet = storedBet && (storedBet.stakeBetId === betId
      || (String(storedBet.stakeBetId || "").startsWith("visible-") && storedBetAge >= 0 && storedBetAge < 30000)) ? storedBet : null;
    const candidateUsername = bet.user?.name || userName || currentBet?.username || getStakeUsername() || "";
    const username = validStakeUsername(candidateUsername) ? String(candidateUsername) : "";
    const visibleAmount = readVisibleBetAmount();
    const visibleCount = readVisibleSelectionCount("moles");
    const apiCount = Number(state.molesCount ?? state.moleCount ?? state.numberOfMoles ?? bet.molesCount ?? bet.moleCount ?? bet.numberOfMoles);
    const acceptedApiCount = Number.isInteger(apiCount) && apiCount >= 1 && apiCount <= 6 ? apiCount : null;
    const apiAmount = String(bet.amount ?? "").replace(/,/g, "");
    const details = {
      username,
      game: "moles",
      selectionCount: acceptedApiCount ?? visibleCount ?? currentBet?.selectionCount,
      betAmount: /^\d{1,16}(?:\.\d{1,8})?$/.test(apiAmount) ? apiAmount
        : /^\d{1,16}(?:\.\d{1,8})?$/.test(visibleAmount) ? visibleAmount
          : currentBet?.betAmount ?? apiAmount,
    };
    if (!betId || !validDetails(details)) {
      setStatus("Visible Moles count or wager could not be read.", true);
      return;
    }

    const isNewBet = settings.activeBet?.stakeBetId !== betId;
    if (isNewBet && operation !== "molesCashout" && bet.active !== false) {
      await startDetectedBet("moles", { id: betId, active: true, username, count: details.selectionCount, amount: details.betAmount, currency: bet.currency || "", source: "api" });
    }
    const active = settings.activeBet;
    if (!isMatchingActiveBet(active, betId, "moles", details.selectionCount, details.betAmount)) return;

    const knownRounds = Number(active.lastMoleRounds || 0);
    for (let index = knownRounds; index < rounds.length; index++) {
      const round = rounds[index] || {};
      const pick = Number(round.pick);
      if (!Number.isInteger(pick) || pick < 0 || pick > 6) continue;
      const roundIndex = index + 2;
      const maximumRound = details.selectionCount === 1 ? 8 : 9;
      if (roundIndex > maximumRound) {
        await saveSettings({ activeBet: { ...settings.activeBet, lastMoleRounds: index + 1 } });
        continue;
      }
      const key = String(active.betEventId || betId) + ":" + roundIndex;
      if (pendingRoundKeys.has(key)) continue;
      pendingRoundKeys.add(key);
      const hit = typeof round.hit === "boolean" ? round.hit
        : typeof round.isSafe === "boolean" ? round.isSafe
          : typeof round.safe === "boolean" ? round.safe : null;
      const result = String(round.outcome || round.result || "").toLowerCase();
      const outcome = hit === true || /^(safe|win|success)$/.test(result) ? "safe"
        : hit === false || /^(mole|loss|lose|mine)$/.test(result) ? "mole"
          : "unknown";
      if (outcome === "unknown") {
        pendingRoundKeys.delete(key);
        continue;
      }
      if (outcome === "mole") rememberFinishedBet(active);
      await queueEvent(active, "mole_pick", { roundIndex, selectedHole: pick, outcome });
      if (outcome === "mole") {
        waitForIdleAfterFinish = true;
        activeBetControl = null;
        await saveSettings({ activeBet: null });
      }
      else await saveSettings({ activeBet: { ...settings.activeBet, lastMoleRounds: index + 1 } });
      window.setTimeout(() => pendingRoundKeys.delete(key), 3000);
      if (outcome === "mole") break;
    }

    if (operation === "molesCashout" && isMatchingActiveBet(settings.activeBet, betId, "moles", details.selectionCount, details.betAmount)) {
      await finishActiveBet("cashout");
    } else if (bet.active === false && isMatchingActiveBet(settings.activeBet, betId, "moles", details.selectionCount, details.betAmount)) {
      await finishActiveBet("loss", { outcome: "loss" });
    }
  }

  async function processStakeResponse(url, payload) {
    if (!initialized) await initializedPromise;
    if (settings.betaMode) return;
    if (!isStakeOrigin(url) || !payload || typeof payload !== "object") return;
    const observedName = payload?.user?.name || payload?.data?.user?.name;
    if (observedName) await updateUsername(observedName);
    if (String(url).includes("/_api/casino/active-bet/mines")) {
      if (currentGame() === "mines") await processMinesResponse(payload);
      return;
    }
    if (unwrapMolesNode(payload)) {
      await processMolesResponse(payload);
    }
  }

  function installNetworkHooks() {
    const shouldInspectStakeResponse = (value) => {
      if (!isStakeOrigin(value)) return false;
      const path = String(value);
      return path.includes("/_api/casino/active-bet/mines")
        || (currentGame() === "moles" && (path.includes("/_api/graphql") || /\/moles(?:\/|\?|$)|moles(?:Bet|Next|Cashout)/i.test(path)));
    };
    try {
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input?.url || "";
        const promise = nativeFetch.apply(this, arguments);
        if (!shouldInspectStakeResponse(url)) return promise;
        promise.then((response) => {
          const path = response.url || url;
          if (!shouldInspectStakeResponse(path)) return;
          response.clone().text().then((text) => {
            try { void processStakeResponse(path, JSON.parse(text)); } catch (_) {}
          }).catch(() => {});
        }).catch(() => {});
        return promise;
      };
    } catch (_) {}

    try {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__genixStakeUrl = new URL(url, location.href).href; }
        catch (_) { this.__genixStakeUrl = String(url || ""); }
        this.__genixStakeInspect = shouldInspectStakeResponse(this.__genixStakeUrl);
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        if (!this.__genixStakeInspect) return send.apply(this, arguments);
        this.addEventListener("load", () => {
          try {
            const url = this.__genixStakeUrl || "";
            let payload = this.responseType === "json" ? this.response : this.responseText;
            if (typeof payload === "string") payload = JSON.parse(payload);
            void processStakeResponse(url, payload);
          } catch (_) {}
        }, { once: true });
        return send.apply(this, arguments);
      };
    } catch (_) {}
  }

  async function pollStakeUsername() {
    try {
      const payload = await requestStakeJson("/_api/graphql", { query: "query GetUser { user { name } }", operationName: "GetUser" });
      const username = payload?.data?.user?.name;
      if (username) await updateUsername(username);
    } catch (_) {
      const visibleUsername = findVisibleStakeUsername();
      if (visibleUsername) await updateUsername(visibleUsername);
    }
  }

  function findVisibleStakeUsername() {
    for (const link of document.querySelectorAll("a[href]")) {
      let path = "";
      try { path = new URL(link.href, location.href).pathname; } catch (_) {}
      const match = path.match(/^\/@([a-z0-9_]{2,64})\/?$/i);
      if (match && validStakeUsername(match[1])) return match[1];
    }
    return "";
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.03;
  }

  function normalizedText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visibleGameRoot() {
    return document.querySelector("main") || document.body || document;
  }

  function labeledElements(label, scope = document) {
    const selector = "label,span,div,p,[data-testid],[aria-label]";
    const found = [];
    for (const element of scope.querySelectorAll(selector)) {
      if (element.childElementCount > 5) continue;
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text.length > 64 || !(text === label.toLowerCase() || text.startsWith(label.toLowerCase() + " ")) || !isVisible(element)) continue;
      found.push(element);
    }
    return found.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
  }

  function controlValue(element) {
    if (!element) return null;
    if (element instanceof HTMLSelectElement) return Number(element.value);
    if (element instanceof HTMLInputElement) return Number(element.value);
    return Number(element.getAttribute("aria-valuenow"));
  }

  function readVisibleSelectionCount(game) {
    if (game !== "mines" && game !== "moles") return 0;
    const label = game === "mines" ? "Mines" : "Moles";
    const max = game === "mines" ? 24 : 6;
    const labels = labeledElements(label);
    const controls = Array.from(document.querySelectorAll("input[type=range],input[type=number],select,[role=slider],[aria-valuenow]"))
      .filter(isVisible);
    const candidates = [];
    const distance = (a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const dx = Math.max(0, ar.left - br.right, br.left - ar.right);
      const dy = Math.max(0, ar.top - br.bottom, br.top - ar.bottom);
      return Math.hypot(dx, dy);
    };

    for (const labelElement of labels) {
      if (labelElement instanceof HTMLLabelElement && labelElement.htmlFor) {
        const linked = document.getElementById(labelElement.htmlFor);
        const value = controlValue(linked);
        if (Number.isInteger(value) && value >= 1 && value <= max) return value;
      }
      const ownText = normalizedText(labelElement);
      const ownMatch = ownText.match(new RegExp("^" + label + "\\s*[:\\-]?\\s*([1-9]|1\\d|2[0-4])\\b", "i"));
      if (ownMatch && Number(ownMatch[1]) <= max) return Number(ownMatch[1]);

      for (const control of controls) {
        const value = controlValue(control);
        if (!Number.isInteger(value) || value < 1 || value > max) continue;
        const attrs = [control.getAttribute("aria-label"), control.getAttribute("name"), control.id, control.getAttribute("data-testid"), control.getAttribute("aria-labelledby")]
          .filter(Boolean).join(" ").toLowerCase();
        const rangeMin = Number(control.getAttribute("min") || 1);
        const rangeMax = Number(control.getAttribute("max") || max);
        const isGameRange = game === "mines" && control instanceof HTMLInputElement && control.type === "range" && rangeMin <= 1 && rangeMax >= 24;
        const isGameSelect = game === "moles" && control instanceof HTMLSelectElement;
        const nearLabel = distance(labelElement, control);
        if (nearLabel > 220) continue;
        let score = 500 - nearLabel;
        if (attrs.includes(game)) score += 1000;
        if (isGameRange || isGameSelect) score += 500;
        if (control instanceof HTMLInputElement && control.type === "range" && !isGameRange && game === "mines") continue;
        candidates.push({ value, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const value = candidates[0]?.value;
    if (Number.isInteger(value)) {
      recentSelectionCounts[game] = { value, at: Date.now() };
      return value;
    }
    const recent = recentSelectionCounts[game];
    return recent && Date.now() - recent.at < 2000 ? recent.value : null;
  }

  function readVisibleBetAmount() {
    if (currentGame() === "crash") return readVisibleCrashBetAmount();
    for (const label of labeledElements("Bet Amount")) {
      let node = label;
      if (label instanceof HTMLLabelElement && label.htmlFor) {
        const linkedInput = document.getElementById(label.htmlFor);
        if (linkedInput instanceof HTMLInputElement && isVisible(linkedInput) && linkedInput.type !== "range") {
          const linkedAmount = String(linkedInput.value ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
          if (/^\d{1,16}(?:\.\d{1,8})?$/.test(linkedAmount)) return linkedAmount;
        }
      }
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        const inputs = Array.from(node.querySelectorAll("input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=hidden])"))
          .filter((input) => isVisible(input)
            && !/total profit|\bmines?\b|\bmoles?\b/i.test([input.getAttribute("aria-label"), input.getAttribute("name"), input.getAttribute("data-testid")].join(" "))
            && !/total profit/i.test(normalizedText(input.parentElement)));
        const labelRect = label.getBoundingClientRect();
        inputs.sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return Math.abs(aRect.top - labelRect.top) - Math.abs(bRect.top - labelRect.top);
        });
        for (const input of inputs) {
          const raw = input.value;
          const amount = String(raw ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
          if (/^\d{1,16}(?:\.\d{1,8})?$/.test(amount)) return amount;
        }
      }
    }
    return "";
  }

  function readVisibleCrashBetAmount() {
    const scope = visibleGameRoot();
    const labels = labeledElements("Bet Amount", scope).filter((element) => normalizedText(element).replace(/[:*]\s*$/, "").toLowerCase() === "bet amount");
    const otherLabels = ["Cashout At", "Profit on Win", "Total Profit"].flatMap((name) => labeledElements(name, scope))
      .filter((element) => ["cashout at", "profit on win", "total profit"].includes(normalizedText(element).replace(/[:*]\s*$/, "").toLowerCase()));
    const controls = Array.from(scope.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]),[role=spinbutton]"))
      .filter(isVisible);
    const candidates = [];
    const labelGap = (labelRect, controlRect) => {
      const horizontalGap = Math.max(0, labelRect.left - controlRect.right, controlRect.left - labelRect.right);
      const verticalGap = controlRect.top >= labelRect.bottom ? controlRect.top - labelRect.bottom : labelRect.top >= controlRect.bottom ? labelRect.top - controlRect.bottom + 300 : 0;
      return horizontalGap * 2 + verticalGap;
    };
    for (const label of labels) {
      if (label instanceof HTMLLabelElement && label.htmlFor) {
        const linked = document.getElementById(label.htmlFor);
        if (linked instanceof HTMLInputElement && isVisible(linked)) {
          const value = String(linked.value ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
          if (/^\d{1,16}(?:\.\d{1,8})?$/.test(value)) return value;
        }
      }
      const labelRect = label.getBoundingClientRect();
      let container = label;
      for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
        const containerRawText = String(container.textContent || "");
        if (containerRawText.length > 180) break;
        const containerText = containerRawText.replace(/\s+/g, " ").trim();
        if (/cash\s*out at|profit on win|total profit/i.test(containerText)) break;
        const localControls = Array.from(container.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]),[role=spinbutton]"))
          .filter(isVisible);
        if (localControls.length > 1) break;
        if (localControls.length !== 1) continue;
        const local = localControls[0];
        const attrs = [local.getAttribute("aria-label"), local.getAttribute("name"), local.id, local.getAttribute("data-testid"), local.getAttribute("placeholder"), local.getAttribute("aria-labelledby")].filter(Boolean).join(" ").toLowerCase();
        if (/cash\s*out|profit|target|win chance|total profit/.test(attrs)) continue;
        const raw = local instanceof HTMLInputElement ? local.value : local.getAttribute("aria-valuenow");
        const value = String(raw ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
        const localRect = local.getBoundingClientRect();
        const belowLabel = localRect.top >= labelRect.bottom - 4;
        const verticalGap = Math.max(0, localRect.top - labelRect.bottom);
        if (/^\d{1,16}(?:\.\d{1,8})?$/.test(value) && belowLabel && verticalGap <= 38 && labelGap(labelRect, localRect) <= 90) return value;
      }
      for (const control of controls) {
        const attrs = [control.getAttribute("aria-label"), control.getAttribute("name"), control.id, control.getAttribute("data-testid"), control.getAttribute("placeholder"), control.getAttribute("aria-labelledby")].filter(Boolean).join(" ").toLowerCase();
        const nearbyText = normalizedText(control.parentElement);
        if (/cash\s*out|profit|target|win chance|total profit/.test(attrs) || /cash\s*out at|profit on win|total profit/i.test(nearbyText)) continue;
        const raw = control instanceof HTMLInputElement ? control.value : control.getAttribute("aria-valuenow");
        const value = String(raw ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
        if (!/^\d{1,16}(?:\.\d{1,8})?$/.test(value)) continue;
        const rect = control.getBoundingClientRect();
        const belowLabel = rect.top >= labelRect.bottom - 4;
        const verticalGap = Math.max(0, rect.top - labelRect.bottom);
        if (!belowLabel || verticalGap > 38) continue;
        let score = labelGap(labelRect, rect);
        if (otherLabels.some((otherLabel) => labelGap(otherLabel.getBoundingClientRect(), rect) + 8 < score)) continue;
        if (attrs.includes("bet") || attrs.includes("wager")) score -= 250;
        const inputParentText = normalizedText(control.parentElement);
        if (inputParentText.length <= 80 && /bet amount/i.test(inputParentText)) score -= 80;
        if (inputParentText.length <= 80 && /cash\s*out at/i.test(inputParentText)) score += 1000;
        candidates.push({ value, score });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.score <= 90 ? candidates[0].value : "";
  }

  function readVisibleLabelValue(label) {
    const scope = currentGame() === "crash" ? visibleGameRoot() : document;
    const labels = labeledElements(label, scope).filter((element) => normalizedText(element).replace(/[:*]\s*$/, "").toLowerCase() === label.toLowerCase());
    const controls = Array.from(scope.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,[role=slider]"))
      .filter(isVisible);
    for (const labelElement of labels) {
      if (labelElement instanceof HTMLLabelElement && labelElement.htmlFor) {
        const linked = document.getElementById(labelElement.htmlFor);
        if (linked instanceof HTMLInputElement || linked instanceof HTMLSelectElement) {
          const raw = linked instanceof HTMLSelectElement ? linked.selectedOptions[0]?.textContent || linked.value : linked.value;
          if (raw != null && String(raw).trim()) return String(raw).trim().slice(0, 80);
        }
      }
      const labelRect = labelElement.getBoundingClientRect();
      const nearby = controls.map((control) => {
        const rect = control.getBoundingClientRect();
        const dx = Math.max(0, labelRect.left - rect.right, rect.left - labelRect.right);
        const dy = Math.max(0, labelRect.top - rect.bottom, rect.top - labelRect.bottom);
        const attrs = [control.getAttribute("aria-label"), control.getAttribute("name"), control.id, control.getAttribute("data-testid"), control.getAttribute("aria-labelledby")].filter(Boolean).join(" ").toLowerCase();
        return { control, score: Math.hypot(dx, dy) - (attrs.includes(label.toLowerCase()) ? 500 : 0) };
      }).filter((item) => item.score < 180).sort((a, b) => a.score - b.score);
      const control = nearby[0]?.control;
      if (!control) continue;
      const raw = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.textContent || control.value
        : control instanceof HTMLInputElement ? control.value : control.getAttribute("aria-valuenow");
      if (raw != null && String(raw).trim()) return String(raw).trim().replace(/\s+/g, " ").slice(0, 80);
    }
    return "";
  }

  function readVisibleGameData(game) {
    const labels = GAME_FIELD_LABELS[game] || [];
    const data = {};
    for (const label of labels) {
      const value = readVisibleLabelValue(label);
      if (!value) continue;
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const numeric = Number(value.replace(/[,x×%]/gi, "").trim());
      data[key] = Number.isFinite(numeric) && /^[-+]?\d[\d,.]*(?:x|×|%)?$/i.test(value) ? numeric : value;
    }
    return safeGameData(data);
  }

  function readVisibleCrashState() {
    const visibleState = lastCrashVisibleState && Date.now() - lastCrashVisibleStateAt < 500
      ? lastCrashVisibleState : readVisibleGameState("crash");
    const data = safeGameData({ ...(visibleState?.gameData || {}) });
    // Only the dedicated Bet Amount control is authoritative. A nearby
    // Cashout At / Profit field must never be used as the wager fallback.
    delete data.bet_amount;
    const visual = readVisibleCrashVisuals();
    const liveText = crashElementText(visual.liveNode);
    const liveMatch = liveText.match(/(?:^|[^\d.])(\d{1,6}(?:\.\d{1,4})?)\s*[x×]/i);
    const liveValue = liveMatch ? Number(liveMatch[1]) : null;
    const liveMultiplier = liveValue != null && Number.isFinite(liveValue) && liveValue >= 1 && liveValue <= 100_000
      ? liveValue : null;
    const countdownText = crashElementText(visual.countdownNode);
    const countdownMatch = countdownText.match(/starting\s+in\s*[:\-]?\s*(\d{1,3}(?:\.\d{1,3})?)\s*s\b/i);
    const countdown = countdownMatch ? Number(countdownMatch[1]) : null;
    const crashed = /\bcrashed\b/i.test(crashElementText(visual.crashedNode));
    const phase = crashed ? "crashed" : countdown != null ? "starting" : liveMultiplier != null || visibleState?.hasCashout ? "live" : visibleState?.active ? "queued" : "waiting";
    if (liveMultiplier != null) {
      lastCrashMultiplier = liveMultiplier;
      lastCrashMultiplierAt = Date.now();
    }
    if (phase === "starting") {
      lastCrashMultiplier = 1;
      lastCrashMultiplierAt = Date.now();
    } else if (phase === "waiting") {
      lastCrashMultiplier = null;
      lastCrashMultiplierAt = 0;
    }
    const displayMultiplier = liveMultiplier
      ?? (phase === "starting" ? 1 : (phase === "live" || phase === "crashed") && Date.now() - lastCrashMultiplierAt < 2500 ? lastCrashMultiplier : null);
    const screenHistory = visual.history;
    if (displayMultiplier != null) data.current_multiplier = displayMultiplier;
    if (countdown != null) data.countdown_seconds = countdown;
    data.round_phase = phase;
    const betAmount = visibleState?.amount ?? "";
    if (betAmount !== "") data.bet_amount = betAmount;
    data.bet_active = Boolean(visibleState?.active);
    data.crash_status = phase;

    if (screenHistory.length >= 5) {
      const historyKey = screenHistory.map((value) => value.toFixed(2)).join(",");
      if (historyKey !== lastVisibleCrashHistoryKey) {
        recentCrashRounds = mergeCrashRoundHistory(recentCrashRounds, screenHistory);
        lastVisibleCrashHistoryKey = historyKey;
        void writeStoredValue(CRASH_ROUNDS_KEY, recentCrashRounds);
      }
    }
    if (phase === "crashed" && lastObservedCrashStatus !== "crashed" && liveMultiplier != null && screenHistory.length < 5) {
      recentCrashRounds = [...recentCrashRounds, liveMultiplier].slice(-10);
      void writeStoredValue(CRASH_ROUNDS_KEY, recentCrashRounds);
    }
    lastObservedCrashStatus = phase;
    const history = screenHistory.length >= 5 ? screenHistory.slice(-10) : recentCrashRounds.slice(-10);
    if (history.length) data.crash_history = history.map((value) => value.toFixed(2)).join(",");
    return safeGameData(data);
  }

  function crashElementText(element) {
    if (!element?.isConnected) return "";
    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    const dataMultiplier = element.getAttribute("data-multiplier");
    const label = String(element.getAttribute("aria-label") || element.getAttribute("title") || (dataMultiplier ? `${dataMultiplier}x` : "")).replace(/\s+/g, " ").trim();
    if (!text || (!/[x×]/i.test(text) && !/\bcrashed\b|starting\s+in/i.test(text))) return label || text;
    return text;
  }

  function readVisibleCrashVisuals() {
    const now = Date.now();
    const previous = crashVisualCache;
    const disconnected = [previous.liveNode, previous.countdownNode, previous.crashedNode].some((node) => node && !node.isConnected);
    if (!disconnected && now - previous.scannedAt < 250) return previous;

    const candidates = [];
    let countdownNode = null;
    let crashedNode = null;
    const scope = visibleGameRoot();
    for (const element of scope.querySelectorAll("span,div,p,strong,b,text,[aria-label],[data-testid],[data-multiplier],[data-value]")) {
      const labeledMultiplier = element.hasAttribute("data-multiplier") || element.hasAttribute("data-value") || element.hasAttribute("aria-label");
      if (element.childElementCount > 24 && !labeledMultiplier) continue;
      const text = crashElementText(element);
      if (!text || text.length > 100) continue;
      const hasCrashStatus = /\bcrashed\b/i.test(text);
      const hasCountdown = /starting\s+in\s*[:\-]?\s*\d{1,3}(?:\.\d{1,3})?\s*s\b/i.test(text);
      const matches = Array.from(text.matchAll(/(?:^|[^\d.])(\d{1,6}(?:\.\d{1,4})?)\s*[x×]/gi));
      if (!hasCrashStatus && !hasCountdown && matches.length !== 1) continue;
      if (!isVisible(element)) continue;
      if (!crashedNode && hasCrashStatus) crashedNode = element;
      if (!countdownNode && hasCountdown) countdownNode = element;
      if (matches.length !== 1 || text.length > 72) continue;
      const value = Number(matches[0][1]);
      if (!Number.isFinite(value) || value < 1 || value > 100_000) continue;
      const rect = element.getBoundingClientRect();
      const fontSize = Number.parseFloat(window.getComputedStyle(element).fontSize) || 0;
      const centerX = (rect.left + rect.right) / 2;
      const centerY = (rect.top + rect.bottom) / 2;
      const existing = candidates.find((candidate) => candidate.value === value && Math.abs(candidate.centerX - centerX) < 18 && Math.abs(candidate.centerY - centerY) < 10);
      if (existing) {
        if (fontSize * 4 + rect.height > existing.rank) Object.assign(existing, { node: element, fontSize, left: rect.left, top: rect.top, centerX, centerY, height: rect.height, rank: fontSize * 4 + rect.height });
        continue;
      }
      candidates.push({ node: element, value, left: rect.left, top: rect.top, centerX, centerY, fontSize, height: rect.height, rank: fontSize * 4 + rect.height });
    }

    const rows = new Map();
    for (const item of candidates.filter((candidate) => candidate.fontSize < 22 && candidate.top < window.innerHeight * 0.48)) {
      const row = Math.round(item.top / 10);
      rows.set(row, [...(rows.get(row) || []), item]);
    }
    const historyRow = [...rows.values()].filter((row) => row.length >= 5).sort((a, b) => b.length - a.length)[0] || [];
    const history = historyRow.sort((a, b) => a.left - b.left).slice(-10).map((item) => item.value);
    const historyBottom = historyRow.length
      ? Math.max(window.innerHeight * 0.18, Math.max(...historyRow.map((item) => item.top + item.height)) + Math.max(40, window.innerHeight * 0.06))
      : window.innerHeight * 0.18;
    const rootRect = scope.getBoundingClientRect();
    const rootCenterX = (rootRect.left + rootRect.right) / 2;
    const liveCandidates = candidates.filter((item) => {
      if (item.top < historyBottom) return false;
      const central = item.centerX >= rootRect.left + rootRect.width * 0.12
        && item.centerX <= rootRect.right - rootRect.width * 0.04;
      return central && (item.fontSize >= 24 || item.height >= 32);
    });
    const live = liveCandidates.sort((a, b) => {
      const aDistance = Math.abs(a.centerX - rootCenterX) + Math.abs(a.centerY - (rootRect.top + rootRect.height * 0.45)) * 0.35;
      const bDistance = Math.abs(b.centerX - rootCenterX) + Math.abs(b.centerY - (rootRect.top + rootRect.height * 0.45)) * 0.35;
      return b.rank - a.rank || aDistance - bDistance;
    })[0];
    crashVisualCache = { scannedAt: now, liveNode: live?.node || null, countdownNode, crashedNode, history };
    return crashVisualCache;
  }

  function mergeCrashRoundHistory(stored, visible) {
    if (visible.length >= 8) return visible.slice(-10);
    for (let overlap = Math.min(stored.length, visible.length); overlap > 0; overlap--) {
      const storedTail = stored.slice(-overlap);
      const visibleHead = visible.slice(0, overlap);
      if (storedTail.every((value, index) => value.toFixed(2) === visibleHead[index].toFixed(2))) {
        return [...stored.slice(0, -overlap), ...visible].slice(-10);
      }
    }
    if (visible.length <= stored.length && visible.every((value, index) => value.toFixed(2) === stored[stored.length - visible.length + index]?.toFixed(2))) return stored.slice(-10);
    return visible.slice(-10);
  }

  function syncVisibleGameHeartbeat(force = false) {
    if (!settings.monitoringEnabled || !settings.connected || !settings.authorizationToken || gameHeartbeatBusy) return;
    const game = currentGame();
    const now = Date.now();
    const minimumInterval = game === "crash" ? 200 : 450;
    if (!force && now - lastGameHeartbeatAt < minimumInterval) return;
    const gameData = game === "crash" ? readVisibleCrashState() : game ? readVisibleGameData(game) : {};
    const payload = { game: game || null, gameData };
    const fingerprint = JSON.stringify(payload);
    if (!force && fingerprint === lastGameHeartbeatFingerprint && now - lastGameHeartbeatAt < 15000) return;
    gameHeartbeatBusy = true;
    lastGameHeartbeatAt = now;
    lastGameHeartbeatFingerprint = fingerprint;
    void request("POST", "/heartbeat", settings.authorizationToken, payload)
      .catch(() => { lastGameHeartbeatFingerprint = ""; })
      .finally(() => { gameHeartbeatBusy = false; });
  }

  function installCrashTextObserver() {
    const target = visibleGameRoot();
    if (!target || (crashTextObserver && target === crashTextObserverTarget && target.isConnected)) return;
    if (crashTextObserver) crashTextObserver.disconnect();
    crashTextObserverTarget = target;
    crashTextObserver = new MutationObserver((records) => {
      if (currentGame() !== "crash" || !settings.monitoringEnabled || !settings.connected) return;
      let relevantTextChanged = false;
      for (const record of records) {
        const nodes = record.type === "characterData"
          ? [record.target.parentElement]
          : [record.target, ...Array.from(record.addedNodes || []).filter((node) => node.nodeType === Node.ELEMENT_NODE)];
        for (const node of nodes) {
          if (!(node instanceof Element)) continue;
          const text = node.childElementCount <= 2 ? String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
          if (/(?:\d{1,6}(?:\.\d{1,4})?\s*[x×]|\bcrashed\b|starting\s+in)/i.test(text)) {
            relevantTextChanged = true;
            break;
          }
        }
        if (relevantTextChanged) break;
      }
      if (!relevantTextChanged) return;
      window.clearTimeout(crashSyncTimer);
      crashSyncTimer = window.setTimeout(() => syncVisibleGameHeartbeat(), 35);
    });
    crashTextObserver.observe(target, { subtree: true, childList: true, characterData: true });
  }

  function isEnabledControl(element) {
    if (!element || element.disabled || element.getAttribute("aria-disabled") === "true" || element.getAttribute("data-disabled") === "true") return false;
    if (/disabled|inactive|loading/i.test(String(element.className || ""))) return false;
    const style = window.getComputedStyle(element);
    return style.pointerEvents !== "none" && Number(style.opacity || 1) > 0.55;
  }

  function eventElement(event, selector) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof Element && node.matches(selector)) return node;
    }
    return event.target instanceof Element ? event.target.closest(selector) : null;
  }

  function eventInsideHost(event) {
    return Boolean(host && typeof event.composedPath === "function" && event.composedPath().includes(host));
  }

  function controlText(element) {
    return [normalizedText(element), element?.value, element?.getAttribute("aria-label"), element?.getAttribute("title"), element?.getAttribute("data-testid")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function resolveControlReference(reference) {
    if (!reference || reference.game !== currentGame()) return null;
    if (reference.element?.isConnected && isVisible(reference.element)) return reference.element;
    const centerX = Number(reference.centerX);
    const centerY = Number(reference.centerY);
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return null;
    const controls = Array.from(document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]"))
      .filter((element) => isVisible(element) && /^(bet|play|place bet|start|start game|cash\s*out|cashout)\b/i.test(controlText(element)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, distance: Math.hypot((rect.left + rect.right) / 2 - centerX, (rect.top + rect.bottom) / 2 - centerY) };
      })
      .sort((a, b) => a.distance - b.distance);
    return controls[0]?.distance <= 180 ? controls[0].element : null;
  }

  function rememberControlReference(game, element) {
    const rect = element?.getBoundingClientRect?.();
    return {
      game,
      element,
      centerX: rect ? (rect.left + rect.right) / 2 : NaN,
      centerY: rect ? (rect.top + rect.bottom) / 2 : NaN,
    };
  }

  function readVisibleGameState(game = currentGame()) {
    if (!SUPPORTED_GAMES.has(game)) return null;
    const scope = visibleGameRoot();
    const amount = readVisibleBetAmount();
    const count = readVisibleSelectionCount(game);
    const gameData = readVisibleGameData(game);
    const amountLabel = labeledElements("Bet Amount", scope)[0];
    const controls = Array.from(scope.querySelectorAll("button,[role=button],input[type=button],input[type=submit]"))
      .map((element) => ({
        element,
        text: [element.textContent, element.value, element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
      }))
      .filter(({ text }) => /\bcash\s*out\b|\bcashout\b|^(bet|play|place bet|start|start game)\b/i.test(text))
      .filter(({ element }) => isVisible(element))
      .map((item) => ({ ...item, distance: amountLabel ? Math.abs(item.element.getBoundingClientRect().top - amountLabel.getBoundingClientRect().top) : 0 }))
      .filter((item) => !amountLabel || item.distance < 900);
    const cashout = controls.filter(({ text }) => /\bcash\s*out\b|\bcashout\b/i.test(text)).sort((a, b) => a.distance - b.distance)[0];
    const bet = controls.filter(({ text }) => /^(bet|play|place bet|start|start game)\b/i.test(text)).sort((a, b) => a.distance - b.distance)[0];
    const betEnabled = Boolean(bet && isEnabledControl(bet.element));
    const cashoutEnabled = Boolean(cashout && isEnabledControl(cashout.element));
    const controlReference = activeBetControl?.game === game ? activeBetControl
      : pendingBetIntent?.game === game ? pendingBetIntent.control : null;
    const trackedAction = resolveControlReference(controlReference);
    const trackedText = trackedAction ? controlText(trackedAction) : "";
    const trackedActive = /\bcash\s*out\b|\bcashout\b/i.test(trackedText)
      ? true
      : /^(bet|play|place bet|start|start game)\b/i.test(trackedText) ? false : null;
    const cashoutText = cashout ? controlText(cashout.element) : "";
    const betText = bet ? controlText(bet.element) : "";
    const state = {
      game,
      amount,
      count,
      gameData,
      hasCashout: Boolean(cashout),
      cashoutText,
      cashoutEnabled,
      hasBet: Boolean(bet),
      betText,
      betEnabled,
      active: game === "crash" ? Boolean(cashout || (bet && /cancel/i.test(betText))) : trackedActive ?? Boolean(cashout && !bet),
    };
    if (game === "crash") {
      lastCrashVisibleState = state;
      lastCrashVisibleStateAt = Date.now();
    }
    return state;
  }

  async function scanVisibleGameState() {
    if (visibleScanBusy) return;
    const game = currentGame();
    renderStakeStatus();
    if (!game || settings.betaMode) return;
    if (!CASHOUT_GAMES.has(game)) return;
    visibleScanBusy = true;
    try {
      const state = readVisibleGameState(game);
      if (!state) return;
      if (!state.active) {
        visibleActiveFingerprint = "";
        waitForIdleAfterFinish = false;
        const waitingForBetTransition = pendingBetIntent?.game === game && Date.now() - pendingBetIntent.at < 5000;
        if (waitingForBetTransition) {
          visibleInactiveBetId = "";
          visibleInactiveSince = 0;
          return;
        }
        const activeKey = settings.activeBet?.betEventId || settings.activeBet?.stakeBetId || "";
        const waitingForMoleClick = game === "moles" && settings.activeBet?.game === "moles"
          && Array.from(pendingRoundKeys).some((key) => key.startsWith(activeKey + ":"));
        const waitingForMinesClick = game === "mines" && settings.activeBet?.game === "mines"
          && Number(pendingMinePickCounts.get(String(activeKey)) || 0) > 0;
        const activeBet = settings.activeBet?.game === game ? settings.activeBet : null;
        if (game === "crash" && activeBet) {
          const crashData = readVisibleCrashState();
          const quickRoundEnded = Boolean(activeBet.crashQueuedSeenAt && state.hasBet && /^bet next round\b/i.test(state.betText));
          const roundWasLive = Boolean(activeBet.crashLiveSeenAt || crashData.crash_status === "crashed" || quickRoundEnded);
          if (!activeBet.seenActiveAt || !roundWasLive || !state.hasBet || /cancel|queued|waiting/i.test(state.betText)) {
            visibleInactiveBetId = "";
            visibleInactiveSince = 0;
            return;
          }
          if (Date.now() - lastCrashCashoutAt < 1200) return;
          const activeId = String(activeBet.stakeBetId || "");
          if (visibleInactiveBetId !== activeId) {
            visibleInactiveBetId = activeId;
            visibleInactiveSince = Date.now();
          } else if (Date.now() - visibleInactiveSince >= 350) {
            if (crashData.cashout_result === "cashed out") await finishActiveBet("cashout", { outcome: "win", gameData: crashData });
            else await finishActiveBet("loss", { outcome: "loss", gameData: crashData });
          }
          return;
        }
        const activeId = String(activeBet?.stakeBetId || "");
        if (activeBet && state.hasBet && !waitingForMoleClick && !waitingForMinesClick && activeBet.seenActiveAt) {
          if (visibleInactiveBetId !== activeId) {
            visibleInactiveBetId = activeId;
            visibleInactiveSince = Date.now();
          } else if (Date.now() - visibleInactiveSince >= 500) {
            await finishActiveBet("loss", { outcome: "loss", ...(game === "crash" ? { gameData: readVisibleCrashState() } : {}) });
          }
        } else {
          visibleInactiveBetId = "";
          visibleInactiveSince = 0;
        }
        return;
      }
      const newBetIntent = pendingBetIntent?.game === game && Date.now() - pendingBetIntent.at < 5000;
      if (waitForIdleAfterFinish && !newBetIntent) return;
      const activeBet = settings.activeBet?.game === game ? settings.activeBet : null;
      const count = game === "crash" ? 0 : Number.isInteger(state.count) ? state.count : activeBet?.selectionCount;
      const amount = state.amount !== "" ? state.amount : activeBet?.betAmount ?? "0";
      if (game === "crash" && activeBet && state.hasCashout && !activeBet.crashLiveSeenAt) {
        await saveSettings({ activeBet: { ...activeBet, crashLiveSeenAt: Date.now() } });
      } else if (game === "crash" && activeBet && state.hasBet && /cancel/i.test(state.betText) && !activeBet.crashQueuedSeenAt) {
        await saveSettings({ activeBet: { ...activeBet, crashQueuedSeenAt: Date.now() } });
      }
      const fingerprint = [game, count, amount].join(":");
      if (fingerprint === visibleActiveFingerprint) return;
      if (!Number.isInteger(count) || (game !== "crash" && count < 1) || !validStakeUsername(getStakeUsername())) {
        setStatus("Cashout state detected. Waiting for the visible game count and Stake username.", true);
        return;
      }
      visibleActiveFingerprint = fingerprint;
      const visibleBetId = "visible-" + game + "-" + Date.now();
      await startDetectedBet(game, {
        id: visibleBetId,
        active: true,
        username: getStakeUsername(),
        count,
        amount,
        gameData: state.gameData,
        source: "screen",
      });
      if (game === "crash" && settings.activeBet?.game === "crash") {
        const detectedCrashBet = settings.activeBet;
        if (state.hasCashout && !detectedCrashBet.crashLiveSeenAt) await saveSettings({ activeBet: { ...detectedCrashBet, crashLiveSeenAt: Date.now() } });
        else if (state.hasBet && /cancel/i.test(state.betText) && !detectedCrashBet.crashQueuedSeenAt) await saveSettings({ activeBet: { ...detectedCrashBet, crashQueuedSeenAt: Date.now() } });
      }
      if (settings.activeBet?.game === game && !settings.activeBet.seenActiveAt) {
        await saveSettings({ activeBet: { ...settings.activeBet, seenActiveAt: Date.now() } });
      }
      visibleInactiveBetId = "";
      visibleInactiveSince = 0;
    } finally {
      visibleScanBusy = false;
    }
  }

  function observeVisibleBetClick(event) {
    const game = currentGame();
    if (!game || !SUPPORTED_GAMES.has(game) || eventInsideHost(event)) return;
    const target = eventElement(event, "button,[role=button],input[type=button],input[type=submit]");
    if (!target || !isEnabledControl(target)) return;
    const text = controlText(target);
    if (!/^(bet|play|place bet|start|start game)\b/i.test(text)) return;

    if (settings.betaMode) {
      showActivityToast("BETA MODE · BET CLICK RECORDED");
      recordGameAction(game, "bet click · beta mode");
      return;
    }

    visibleActiveFingerprint = "";
    pendingRoundKeys.clear();
    const previousFinish = settings.activeBet?.game === game
      ? finishActiveBet(CASHOUT_GAMES.has(game) && !(game === "crash" && !settings.activeBet.crashLiveSeenAt) ? "loss" : "round_end", { outcome: CASHOUT_GAMES.has(game) ? "loss" : "unknown" })
      : Promise.resolve(false);
    const intent = {
      game,
      username: getStakeUsername(),
      selectionCount: readVisibleSelectionCount(game),
      betAmount: readVisibleBetAmount(),
      gameData: readVisibleGameData(game),
      selectedActionItems: (pendingGameActions.get(game) || []).filter((item) => Date.now() - item.at < 15000).slice(-16),
      at: Date.now(),
      previousFinish,
      previousBetEventId: settings.activeBet?.game === game
        ? String(settings.activeBet.betEventId || settings.activeBet.stakeBetId || "") : "",
      control: rememberControlReference(game, target),
    };
    pendingBetIntent = intent;
    const confirmIntent = async () => {
      if (pendingBetIntent !== intent || currentGame() !== game || Date.now() - intent.at >= 5000) return;
      await intent.previousFinish;
      if (pendingBetIntent !== intent || currentGame() !== game) return;
      if (!CASHOUT_GAMES.has(game)) {
        const state = readVisibleGameState(game);
        const amount = state?.amount !== "" && state?.amount != null ? state.amount : intent.betAmount || "0";
        const selectedActions = intent.selectedActionItems.filter((item) => item.at < intent.at).map((item) => item.action).join(", ").slice(0, 100);
        const gameData = safeGameData({ ...(state?.gameData || intent.gameData), ...(selectedActions ? { selected_actions: selectedActions } : {}) });
        await startDetectedBet(game, {
          id: "click-" + game + "-" + intent.at + "-" + crypto.randomUUID(),
          active: true,
          username: intent.username,
          count: 0,
          amount,
          gameData,
          source: "screen",
        });
        const detectedId = settings.activeBet?.game === game ? settings.activeBet.betEventId : "";
        pendingBetIntent = null;
        const detectedBet = settings.activeBet?.game === game && settings.activeBet.betEventId === detectedId ? settings.activeBet : null;
        if (detectedBet) {
          const laterActions = (pendingGameActions.get(game) || []).filter((item) => item.at >= intent.at && Date.now() - item.at < 15000);
          pendingGameActions.delete(game);
          for (const item of laterActions) {
            const actionData = safeGameData({ ...(detectedBet.gameData || {}), action: item.action, x: item.x, y: item.y });
            void queueEvent({
              username: detectedBet.username,
              game,
              selectionCount: 0,
              betAmount: detectedBet.betAmount,
              betEventId: detectedBet.betEventId,
              betCapturedAt: detectedBet.betCapturedAt,
              gameData: actionData,
            }, "game_action", { gameData: actionData, capturedAt: new Date(item.at).toISOString() });
          }
        } else pendingGameActions.delete(game);
        if (detectedId && ONE_SHOT_GAMES.has(game)) {
          window.setTimeout(() => {
            if (settings.activeBet?.game === game && settings.activeBet.betEventId === detectedId) {
              void finishActiveBet("round_end", { outcome: "unknown" });
            }
          }, 900);
        }
        renderConnection();
        return;
      }
      const activeId = settings.activeBet?.game === game
        ? String(settings.activeBet.betEventId || settings.activeBet.stakeBetId || "") : "";
      const activeBetWasCaptured = Boolean(activeId && activeId !== intent.previousBetEventId
        && Date.parse(settings.activeBet?.betCapturedAt || "") >= intent.at - 250);
      if (activeBetWasCaptured) {
        const state = readVisibleGameState(game);
        if (state?.active) {
          activeBetControl = intent.control;
          pendingBetIntent = null;
          return;
        }
        if (Date.now() - intent.at < 5000) {
          window.setTimeout(() => void confirmIntent(), 100);
          return;
        }
        pendingBetIntent = null;
        return;
      }
      const state = readVisibleGameState(game);
      if (state?.active) {
        activeBetControl = intent.control;
        const count = game === "crash" ? 0 : Number.isInteger(state.count) ? state.count : intent.selectionCount;
        const amount = state.amount !== "" ? state.amount : intent.betAmount;
        await startDetectedBet(game, {
          id: "click-" + game + "-" + intent.at,
          active: true,
          username: intent.username,
          count,
          amount,
          gameData: game === "crash" ? readVisibleCrashState() : state.gameData,
          source: "screen",
        });
        if (game === "crash" && settings.activeBet?.game === "crash") {
          const detectedCrashBet = settings.activeBet;
          if (state.hasCashout && !detectedCrashBet.crashLiveSeenAt) await saveSettings({ activeBet: { ...detectedCrashBet, crashLiveSeenAt: Date.now() } });
          else if (state.hasBet && /cancel/i.test(state.betText) && !detectedCrashBet.crashQueuedSeenAt) await saveSettings({ activeBet: { ...detectedCrashBet, crashQueuedSeenAt: Date.now() } });
        }
        if (settings.activeBet?.game === game) pendingBetIntent = null;
        else if (Date.now() - intent.at < 5000) window.setTimeout(() => void confirmIntent(), 180);
        else pendingBetIntent = null;
        return;
      }
      if (Date.now() - intent.at < 5000) window.setTimeout(() => void confirmIntent(), 180);
      else pendingBetIntent = null;
    };
    window.setTimeout(() => void confirmIntent(), 180);
  }

  function closestVisibleMoleCell(target) {
    if (!(target instanceof Element)) return null;
    return target.closest("button,[role=button],[data-testid*=hole i],[aria-label*=hole i],[class*=hole i],[class*=cell i],[class*=tile i]");
  }

  function findGridCellIndex(target, expectedCount, cell) {
    if (!cell || !isVisible(cell)) return null;
    const directLabel = [cell.getAttribute("aria-label"), cell.getAttribute("data-testid"), normalizedText(cell)].join(" ");
    const labeledIndex = directLabel.match(/(?:hole|cell|tile|spot)\s*#?\s*([1-9]\d?)\b/i);
    if (labeledIndex) {
      const value = Number(labeledIndex[1]);
      if (value >= 1 && value <= expectedCount) return value - 1;
    }

    for (let node = cell.parentElement, depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const nodes = Array.from(node.querySelectorAll("button,[role=button],[data-testid*=hole i],[aria-label*=hole i],[data-testid*=tile i],[aria-label*=tile i],[class*=hole i],[class*=cell i],[class*=tile i],[class*=gem i]"));
      const seen = new Set();
      const cells = nodes.filter((item) => {
        if (!isVisible(item)) return false;
        const rect = item.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24 || rect.width > 220 || rect.height > 220) return false;
        const ratio = rect.width / rect.height;
        if (ratio < 0.72 || ratio > 1.38) return false;
        const key = Math.round(rect.left) + ":" + Math.round(rect.top);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const rect = cell.getBoundingClientRect();
      const matching = cells.filter((item) => {
        const other = item.getBoundingClientRect();
        const centerX = Math.abs((other.left + other.right) / 2 - (rect.left + rect.right) / 2);
        const centerY = Math.abs((other.top + other.bottom) / 2 - (rect.top + rect.bottom) / 2);
        return centerX < 6 && centerY < 6;
      }).sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return Math.abs(a.width - rect.width) + Math.abs(a.height - rect.height)
          - Math.abs(b.width - rect.width) - Math.abs(b.height - rect.height);
      });
      const matchingCell = matching[0];
      if (cells.length === expectedCount && matchingCell) return cells.indexOf(matchingCell);
      if (cells.length > expectedCount && matchingCell) {
        const selectedRect = matchingCell.getBoundingClientRect();
        const nearest = cells.filter((item) => {
          const other = item.getBoundingClientRect();
          return Math.abs(other.width - selectedRect.width) < 4 && Math.abs(other.height - selectedRect.height) < 4;
        });
        if (nearest.length === expectedCount && nearest.includes(matchingCell)) return nearest.indexOf(matchingCell);
      }
    }
    return null;
  }

  function findMoleCellIndex(target, clientX, clientY) {
    return findGridCellIndex(target, 7, closestVisibleMoleCell(target)) ?? geometricGridCellIndex(target, 7, clientX, clientY);
  }

  function geometricGridCellIndex(target, expectedCount, clientX, clientY) {
    if (!(target instanceof Element)) return null;
    let pointX = Number(clientX);
    let pointY = Number(clientY);
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY) || (!pointX && !pointY)) {
      const rect = target.getBoundingClientRect();
      pointX = (rect.left + rect.right) / 2;
      pointY = (rect.top + rect.bottom) / 2;
    }
    for (let container = target.parentElement, depth = 0; container && depth < 12; depth++, container = container.parentElement) {
      const squares = Array.from(container.querySelectorAll("*")).filter((item) => {
        if (!isVisible(item)) return false;
        const rect = item.getBoundingClientRect();
        if (rect.width < 36 || rect.height < 36 || rect.width > 220 || rect.height > 220) return false;
        const ratio = rect.width / rect.height;
        return ratio >= 0.78 && ratio <= 1.28;
      });
      const bySize = new Map();
      for (const item of squares) {
        const rect = item.getBoundingClientRect();
        const sizeKey = Math.round(rect.width / 4) + ":" + Math.round(rect.height / 4);
        if (!bySize.has(sizeKey)) bySize.set(sizeKey, new Map());
        const centerKey = Math.round((rect.left + rect.right) / 2 / 3) + ":" + Math.round((rect.top + rect.bottom) / 2 / 3);
        const group = bySize.get(sizeKey);
        if (!group.has(centerKey)) group.set(centerKey, item);
      }
      for (const group of bySize.values()) {
        if (group.size !== expectedCount) continue;
        const cells = Array.from(group.values()).sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return a.top - b.top || a.left - b.left;
        });
        const selected = cells.findIndex((item) => {
          const rect = item.getBoundingClientRect();
          return pointX >= rect.left - 2 && pointX <= rect.right + 2 && pointY >= rect.top - 2 && pointY <= rect.bottom + 2;
        });
        if (selected >= 0) return selected;
      }
    }
    return null;
  }

  function findMinesCellIndex(target, clientX, clientY) {
    if (!(target instanceof Element)) return null;
    const cell = target.closest("button,[role=button],[data-testid*=tile i],[aria-label*=tile i],[class*=tile i],[class*=cell i],[class*=gem i]");
    return findGridCellIndex(target, 25, cell) ?? geometricGridCellIndex(target, 25, clientX, clientY);
  }

  function visibleMoleOutcome(target) {
    const cell = closestVisibleMoleCell(target);
    if (!cell) return "unknown";
    const descendants = Array.from(cell.querySelectorAll("[aria-label],[data-testid],[data-state],img,svg"));
    const text = [normalizedText(cell), cell.getAttribute("aria-label"), cell.getAttribute("title"), cell.getAttribute("data-state"),
      ...descendants.flatMap((node) => [node.getAttribute("aria-label"), node.getAttribute("data-state"), node.getAttribute("alt"), node.getAttribute("src")])]
      .filter(Boolean).join(" ").toLowerCase();
    const classes = [String(cell.className || ""), ...descendants.map((node) => String(node.className || ""))].join(" ").toLowerCase();
    if (/\b(mole|mine|bomb|lost|lose|failure|danger)\b/i.test(text) || /\b(?:is-mine|is-mole|mole-hit|mine-hit|has-mole|revealed-mine|is-lost|is-danger)\b/i.test(classes)) return "mole";
    if (/\b(safe|win|success)\b/i.test(text) || /\b(?:is-safe|safe-hit|revealed-safe|is-win|is-success)\b/i.test(classes)) return "safe";
    return "unknown";
  }

  function visibleMinesOutcome(target) {
    if (!(target instanceof Element)) return "unknown";
    const cell = target.closest("button,[role=button],[data-testid*=tile i],[aria-label*=tile i],[class*=tile i],[class*=cell i],[class*=gem i]")
      || Array.from({ length: 8 }, (_, index) => {
        let node = target;
        for (let depth = 0; node && depth < index; depth++) node = node.parentElement;
        return node;
      }).find((node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= 36 && rect.height >= 36 && rect.width <= 220 && rect.height <= 220 && rect.width / rect.height >= 0.78 && rect.width / rect.height <= 1.28;
      });
    if (!cell) return "unknown";
    const descendants = Array.from(cell.querySelectorAll("[aria-label],[data-testid],[data-state],img,svg"));
    const text = [normalizedText(cell), cell.getAttribute("aria-label"), cell.getAttribute("title"), cell.getAttribute("data-state"),
      ...descendants.flatMap((node) => [node.getAttribute("aria-label"), node.getAttribute("data-state"), node.getAttribute("alt"), node.getAttribute("src")])]
      .filter(Boolean).join(" ").toLowerCase();
    const classes = [String(cell.className || ""), ...descendants.map((node) => String(node.className || ""))].join(" ").toLowerCase();
    if (/\b(mine|bomb|explosion|lost|lose|failure|danger)\b/i.test(text) || /\b(?:is-mine|is-bomb|mine-hit|bomb-hit|exploded|is-lost|is-danger)\b/i.test(classes)) return "mine";
    if (/\b(gem|diamond|safe|win|success)\b/i.test(text) || /\b(?:is-gem|is-safe|safe-hit|revealed-safe|is-win|is-success)\b/i.test(classes)) return "safe";
    return "unknown";
  }

  function reserveMoleRound(bet) {
    const key = String(bet.betEventId || bet.stakeBetId);
    const current = Math.max(Number(bet.lastMoleRounds || 0), Number(moleClickReservations.get(key) || 0));
    const roundIndex = current + 2;
    moleClickReservations.set(key, roundIndex - 1);
    if (moleClickReservations.size > 100) moleClickReservations.delete(moleClickReservations.keys().next().value);
    return roundIndex;
  }

  function dispatchTileClick(bet, selectedHole, target, reservedRoundIndex = null, clickedAt = Date.now()) {
    if (!bet || !selectedHole && selectedHole !== 0) return;
    if (bet.game === "mines") {
      const betKey = String(bet.betEventId || bet.stakeBetId);
      const sequence = Number(mineClickSequences.get(betKey) || 0) + 1;
      mineClickSequences.set(betKey, sequence);
      if (mineClickSequences.size > 100) mineClickSequences.delete(mineClickSequences.keys().next().value);
      const capturedAt = new Date(Math.max(clickedAt, Date.parse(bet.betCapturedAt || "") || 0)).toISOString();
      pendingMinePickCounts.set(betKey, Number(pendingMinePickCounts.get(betKey) || 0) + 1);
      void processVisibleMinesClick({ ...bet }, selectedHole, sequence, target, capturedAt);
      return;
    }
    if (bet.game !== "moles") return;
    const maximumRound = bet.selectionCount === 1 ? 8 : 9;
    const roundIndex = Number.isInteger(reservedRoundIndex) ? reservedRoundIndex : reserveMoleRound(bet);
    if (Number.isInteger(reservedRoundIndex)) {
      const betKey = String(bet.betEventId || bet.stakeBetId);
      moleClickReservations.set(betKey, Math.max(Number(moleClickReservations.get(betKey) || 0), roundIndex - 1));
      if (moleClickReservations.size > 100) moleClickReservations.delete(moleClickReservations.keys().next().value);
    }
    if (roundIndex > maximumRound) return;
    const key = String(bet.betEventId || bet.stakeBetId) + ":" + roundIndex;
    if (pendingRoundKeys.has(key)) return;
    pendingRoundKeys.add(key);
    const capturedAt = new Date(Math.max(clickedAt, Date.parse(bet.betCapturedAt || "") || 0)).toISOString();
    void processVisibleMoleClick({ ...bet }, selectedHole, roundIndex, key, target, capturedAt);
  }

  function holdTileClick(game, selectedHole, target) {
    const now = Date.now();
    pendingTileClicks = pendingTileClicks.filter((click) => now - click.at <= 5000).slice(-11);
    const reservedRoundIndex = game === "moles" ? 2 + pendingTileClicks.filter((click) => click.game === "moles").length : null;
    pendingTileClicks.push({ game, selectedHole, target, at: now, reservedRoundIndex });
  }

  function drainPendingTileClicks(bet) {
    if (!bet) return;
    const now = Date.now();
    const ready = pendingTileClicks.filter((click) => click.game === bet.game && now - click.at <= 5000);
    pendingTileClicks = pendingTileClicks.filter((click) => click.game !== bet.game && now - click.at <= 5000);
    for (const click of ready) dispatchTileClick(bet, click.selectedHole, click.target, click.reservedRoundIndex, click.at);
  }

  function isSyntheticTileClick(event, key) {
    const now = Date.now();
    if (event.type === "pointerdown") {
      const recent = recentPointerTileClicks.get(key) || [];
      recent.push(now);
      recentPointerTileClicks.set(key, recent);
      window.setTimeout(() => {
        const currentTime = Date.now();
        const pending = recentPointerTileClicks.get(key) || [];
        const retained = pending.filter((at) => currentTime - at < 800);
        if (retained.length) recentPointerTileClicks.set(key, retained);
        else recentPointerTileClicks.delete(key);
      }, 800);
      return false;
    }
    if (event.type !== "click") return false;
    const pending = recentPointerTileClicks.get(key) || [];
    const matchIndex = pending.findIndex((at) => now - at <= 800);
    if (matchIndex < 0) return false;
    pending.splice(matchIndex, 1);
    if (pending.length) recentPointerTileClicks.set(key, pending);
    else recentPointerTileClicks.delete(key);
    return true;
  }

  async function processVisibleMoleClick(bet, selectedHole, roundIndex, key, target, capturedAt) {
    const betKey = String(bet.betEventId || bet.stakeBetId);
    try {
      await queueEvent(bet, "mole_pick", { roundIndex, selectedHole, outcome: "unknown", capturedAt });
      let outcome = "unknown";
      let gameState = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        gameState = readVisibleGameState("moles");
        outcome = visibleMoleOutcome(target);
        if (outcome !== "unknown") break;
        if (gameState && !gameState.active && attempt >= 5) {
          const finishType = finishingBetTypes.get(betKey) || (recentlyEndedBet?.betEventId === betKey ? recentlyEndedBet.eventType : "");
          const latest = settings.activeBet;
          const highestReservedRound = Math.max(Number(moleClickReservations.get(betKey) || 0) + 1, Number(latest?.lastMoleRounds || 0) + 1);
          outcome = finishType === "cashout" || roundIndex < highestReservedRound ? "safe" : "mole";
          break;
        }
      }
      if (outcome === "unknown" && gameState?.active) outcome = "safe";
      const latest = settings.activeBet;
      const sameActiveBet = latest?.game === "moles" && latest.betEventId === bet.betEventId;
      if (outcome === "unknown") return;
      if (outcome === "mole" && sameActiveBet) {
        rememberFinishedBet(latest);
        recentlyEndedBet.eventType = "loss";
        recentlyEndedBet.betEventId = latest.betEventId || latest.stakeBetId;
      }
      await queueEvent(sameActiveBet ? latest : bet, "mole_pick", { roundIndex, selectedHole, outcome, capturedAt });
      if (outcome === "mole") {
        if (sameActiveBet) {
          waitForIdleAfterFinish = true;
          await saveSettings({ activeBet: null });
          activeBetControl = null;
          visibleActiveFingerprint = "";
        }
      } else if (sameActiveBet) {
        const current = settings.activeBet;
        if (current?.betEventId === latest.betEventId) {
          await saveSettings({ activeBet: { ...current, lastMoleRounds: Math.max(Number(current.lastMoleRounds || 0), roundIndex - 1) } });
        }
      }
    } catch (_) {
      setStatus("Moles click queued · syncing when connection is available.", true);
    } finally {
      pendingRoundKeys.delete(key);
    }
  }

  async function processVisibleMinesClick(bet, selectedHole, sequence, target, capturedAt) {
    const betKey = String(bet.betEventId || bet.stakeBetId);
    try {
      await queueEvent(bet, "mine_pick", { roundIndex: sequence, selectedHole, outcome: "unknown", capturedAt });
      let outcome = "unknown";
      let gameState = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        gameState = readVisibleGameState("mines");
        outcome = visibleMinesOutcome(target);
        if (outcome !== "unknown") break;
        if (gameState && !gameState.active && attempt >= 5) {
          const finishType = finishingBetTypes.get(betKey) || (recentlyEndedBet?.betEventId === betKey ? recentlyEndedBet.eventType : "");
          const latestSequence = Number(mineClickSequences.get(betKey) || sequence);
          outcome = finishType === "cashout" || sequence < latestSequence ? "safe" : "mine";
          break;
        }
      }
      if (outcome === "unknown" && gameState?.active) outcome = "safe";
      if (outcome === "unknown") return;
      const latest = settings.activeBet;
      const sameActiveBet = latest?.game === "mines" && latest.betEventId === bet.betEventId;
      if (outcome === "mine" && sameActiveBet) {
        rememberFinishedBet(latest);
        recentlyEndedBet.eventType = "loss";
        recentlyEndedBet.betEventId = latest.betEventId || latest.stakeBetId;
      }
      await queueEvent(sameActiveBet ? latest : bet, "mine_pick", { roundIndex: sequence, selectedHole, outcome, capturedAt });
      if (outcome === "mine" && sameActiveBet) {
        waitForIdleAfterFinish = true;
        await saveSettings({ activeBet: null });
        activeBetControl = null;
        visibleActiveFingerprint = "";
      }
    } catch (_) {
      setStatus("Mines click queued · syncing when connection is available.", true);
    } finally {
      const remaining = Number(pendingMinePickCounts.get(betKey) || 1) - 1;
      if (remaining > 0) pendingMinePickCounts.set(betKey, remaining);
      else pendingMinePickCounts.delete(betKey);
    }
  }

  function observeVisibleTileClick(event) {
    const game = currentGame();
    if ((game !== "moles" && game !== "mines") || eventInsideHost(event)) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const closestCell = game === "moles" ? closestVisibleMoleCell : (node) => node instanceof Element ? node.closest("button,[role=button],[data-testid*=tile i],[aria-label*=tile i],[class*=tile i],[class*=cell i],[class*=gem i]") : null;
    const cellTarget = path.find((node) => node instanceof Element && closestCell(node)) || event.target;
    const selectedHole = game === "moles" ? findMoleCellIndex(cellTarget, event.clientX, event.clientY) : findMinesCellIndex(cellTarget, event.clientX, event.clientY);
    if (selectedHole === null) return;
    const clickKey = game + ":" + selectedHole;
    if (isSyntheticTileClick(event, clickKey)) return;
    showActivityToast(game.toUpperCase() + " TILE · " + (selectedHole + 1));
    if (settings.betaMode) {
      recordGameAction(game, "tile opened · beta mode", { selected_hole: selectedHole });
      return;
    }
    const bet = settings.activeBet;
    if (bet?.game === game) {
      dispatchTileClick(bet, selectedHole, cellTarget);
      return;
    }
    const state = readVisibleGameState(game);
    if (pendingBetIntent?.game === game || state?.active) holdTileClick(game, selectedHole, cellTarget);
    else recordGameAction(game, "tile selected", { selected_hole: selectedHole });
  }

  function requestStakeJson(path, payload) {
    const url = stakeApiOrigin() + path;
    const body = JSON.stringify(payload);
    return nativeFetch.call(window, url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-language": "en" },
      body,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Stake returned HTTP " + response.status + ".");
      return response.json();
    });
  }

  function createAuthorizationToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return "gx1_" + encoded;
  }

  async function registerPairing(username, token) {
    try {
      await request("POST", "/pairing", null, { token, username });
      return token;
    } catch (error) {
      if (error?.status !== 409) throw error;
      const replacement = createAuthorizationToken();
      await request("POST", "/pairing", null, { token: replacement, username });
      return replacement;
    }
  }

  async function connectPredictor() {
    if (generating || settings.monitoringEnabled) return;
    const enteredUsername = String(root?.querySelector("#genix-stake-username")?.value || "").trim().replace(/^@/, "");
    const username = enteredUsername || settings.usernameOverride;
    if (!validStakeUsername(username)) return setStatus("Enter your Stake username and save it first.", true);
    generating = true;
    renderConnection();
    const button = root?.querySelector("#genix-connect");
    if (button) button.disabled = true;
    setStatus("Connecting the Genix bridge…");
    try {
      let token = settings.authorizationToken;
      if (!TOKEN_PATTERN.test(token)) token = createAuthorizationToken();
      if (!settings.pairingRegistered) token = await registerPairing(username, token);
      else await request("POST", "/connection/username", token, { username });
      await saveSettings({ authorizationToken: token, pairingRegistered: true, monitoringEnabled: true, username, usernameOverride: username, connected: false });
      setStatus("Bridge connected. Connect this token in Genix Predictor.");
      renderToken();
      lastConnectionCheckAt = 0;
      void checkConnection();
    } catch (error) {
      setStatus(error.message || "Could not prepare the Genix token.", true);
    } finally {
      generating = false;
      renderConnection();
    }
  }

  function renderToken() {
    if (!root) return;
    const field = root.querySelector("#genix-auth-token");
    if (field) field.value = settings.authorizationToken ? settings.authorizationToken : "";
  }

  function renderStakeStatus() {
    if (!root) return;
    const current = currentGame();
    if (current === "crash") installCrashTextObserver();
    else if (crashTextObserver) {
      crashTextObserver.disconnect();
      crashTextObserver = null;
      crashTextObserverTarget = null;
      window.clearTimeout(crashSyncTimer);
    }
    if (current === lastRenderedGame) {
      syncVisibleGameHeartbeat();
      return;
    }
    lastRenderedGame = current;
    if (current) {
      setStatus("GAME · " + current.toUpperCase() + " DETECTED");
      if (current === "mines") showActivityToast("Detected Mines game");
      if (current === "moles") showActivityToast("Detected Moles game");
    }
    const game = root.querySelector("#genix-game-value");
    if (game) {
      game.textContent = current ? current[0].toUpperCase() + current.slice(1) : "None";
    }
    syncVisibleGameHeartbeat(true);
  }

  function renderConnection() {
    if (!root) return;
    const indicator = root.querySelector("#genix-live-dot");
    const label = root.querySelector("#genix-live-label");
    const live = Boolean(settings.connected);
    if (indicator) indicator.classList.toggle("live", live);
    if (indicator) indicator.classList.toggle("offline", !live && !generating);
    if (indicator) indicator.classList.toggle("pending", generating);
    if (label) label.textContent = generating ? "Connecting…" : live ? "Connected" : "Disconnected";
    const username = root.querySelector("#genix-username");
    if (username) username.textContent = settings.usernameOverride || "No username saved";
    const usernameInput = root.querySelector("#genix-stake-username");
    if (usernameInput && root.activeElement !== usernameInput) usernameInput.value = settings.usernameOverride || "";
    if (usernameInput) usernameInput.hidden = false;
    const button = root.querySelector("#genix-connect");
    if (button) {
      button.textContent = settings.monitoringEnabled ? "DISCONNECT" : "CONNECT";
      button.disabled = generating || !settings.usernameOverride;
      button.classList.toggle("danger", settings.monitoringEnabled);
    }
    const prediction = root.querySelector("#genix-prediction-value");
    if (prediction) prediction.textContent = settings.betaMode ? "Beta mode" : settings.activeBet ? "Active" : live ? "Monitoring" : "Waiting";
    const beta = root.querySelector("#genix-beta-mode");
    if (beta) { beta.checked = Boolean(settings.betaMode); beta.disabled = Boolean(settings.activeBet); }
  }

  async function disconnectPredictor() {
    if (!settings.authorizationToken || generating || !settings.monitoringEnabled) return;
    generating = true;
    setStatus("Disconnecting Genix Predictor…");
    renderConnection();
    try {
      await request("DELETE", "/connection", settings.authorizationToken);
      await saveSettings({ connected: false, monitoringEnabled: false, activeBet: null });
      setStatus("Disconnected. Paste the same token into Genix Predictor and connect manually to resume.");
    } catch (error) {
      setStatus(error.message || "Could not disconnect the Predictor.", true);
    } finally {
      generating = false;
      renderConnection();
    }
  }

  function mountPanel() {
    if (document.getElementById("genix-stake-bridge-host") || !document.body) return;
    host = document.createElement("div");
    host.id = "genix-stake-bridge-host";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial;color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
      *{box-sizing:border-box}button,input{font:inherit}.panel,.fab{pointer-events:auto}.panel{width:min(286px,calc(100vw - 20px));max-height:min(72vh,560px);max-height:min(72dvh,560px);display:flex;flex-direction:column;color:#edf0f7;background:#0d0f17;border:1px solid #303544;border-radius:13px;box-shadow:0 18px 52px #0009;overflow:hidden;font-size:11px;transform-origin:bottom right;transition:opacity .2s ease,transform .24s cubic-bezier(.2,.8,.2,1),visibility .2s}.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;border-bottom:1px solid #2b303d}.brand{font-weight:800;letter-spacing:.035em;font-size:12px}.sub{margin-top:3px;color:#a3f62a;font-size:8px;font-weight:750;letter-spacing:.035em}.body{overflow-y:auto;overscroll-behavior:contain;padding:11px 13px 13px}.connection{display:flex;align-items:center;gap:8px;padding:9px 10px;background:#10131c;border:1px solid #1e2430;border-radius:8px;color:#e4e9f1;font-size:11px}.dot{width:8px;height:8px;flex:none;border-radius:50%;background:#697386}.dot.live{background:#00e701;box-shadow:0 0 9px #00e701;animation:pulse 1.35s ease-in-out infinite}@keyframes pulse{50%{opacity:.36;box-shadow:0 0 3px #00e701}}label,.user-label{display:block;margin:11px 0 5px;color:#8b94a6;font-size:8px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}input{min-width:0;width:100%;height:31px;padding:0 8px;color:#e9edf5;background:#090b11;border:1px solid #282e3b;border-radius:6px;font-size:10px;outline:none}input:focus{border-color:#526077}.token{font-family:ui-monospace,monospace;letter-spacing:.025em}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.button{min-height:31px;padding:0 9px;border:0;border-radius:6px;background:#a3f62a;color:#11170c;font-size:9px;font-weight:750;cursor:pointer;transition:filter .16s,transform .16s,opacity .16s}.button:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px)}.button.secondary{color:#dce3ee;background:#222a38;border:1px solid #384153}.button:disabled{opacity:.72;cursor:default}.button.danger{width:100%;margin-top:7px;color:#fff;background:#dc353d}.domain{margin-top:10px}.user{margin-top:10px;padding:9px 10px;background:#12151e;border:1px solid #2b303c;border-radius:7px}.user-label{margin:0}.user-name{margin-top:5px;color:#edf0f7;font-size:10px;font-weight:700;overflow-wrap:anywhere}.user input{margin-top:7px}input[hidden]{display:none!important}.status{margin:8px 0 0;color:#a3f62a;font-size:9px;line-height:1.4}.status:empty{display:none}.status[data-error=true]{color:#ffc48b}.tiles{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.tile{min-width:0;padding:8px 9px;background:#10131c;border:1px solid #242a36;border-radius:7px}.tile-label{color:#8791a3;font-size:7px;font-weight:700;letter-spacing:.04em}.tile-value{margin-top:4px;color:#edf0f7;font-size:9px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.foot{margin:9px 0 0;color:#717b8e;font-size:8px;line-height:1.4}.collapse{display:grid;width:23px;height:23px;place-items:center;padding:0;color:#cdd5e1;background:#10131c;border:1px solid #353b49;border-radius:6px;font-size:14px;line-height:1;cursor:pointer}.fab{position:absolute;right:0;bottom:0;display:grid;width:44px;height:44px;place-items:center;padding:0;border:1px solid #c4ff58;border-radius:50%;color:#10170b;background:#a3f62a;font-size:18px;font-weight:900;box-shadow:0 8px 26px #0009,0 0 20px #a3f62a33;cursor:pointer;opacity:0;transform:scale(.8);pointer-events:none;transition:opacity .18s,transform .22s cubic-bezier(.2,.8,.2,1)}:host(.closed) .panel{opacity:0;visibility:hidden;transform:translateY(8px) scale(.97);pointer-events:none}:host(.closed) .fab{opacity:1;transform:scale(1);pointer-events:auto}@media(max-width:600px){.panel{width:min(286px,calc(100vw - 18px));max-height:min(72vh,520px);max-height:min(72dvh,520px);border-radius:12px}.top{padding:10px 11px}.body{padding:10px 11px 11px}.fab{width:42px;height:42px}}
    </style>
    <style>.toast{position:fixed;top:max(12px,env(safe-area-inset-top,0px));left:50%;z-index:2147483647;max-width:calc(100vw - 24px);padding:9px 14px;border:1px solid #384153;border-radius:8px;background:#10131c;color:#edf0f7;box-shadow:0 8px 24px #0008;font:700 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;text-align:center;opacity:0;visibility:hidden;transform:translate(-50%,-8px);transition:opacity .22s ease,transform .22s cubic-bezier(.2,.8,.2,1),visibility .22s;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toast.show{opacity:1;visibility:visible;transform:translate(-50%,0)}.toast[data-error=true]{border-color:#bf7141;color:#ffc48b}@media(prefers-reduced-motion:reduce){.toast{transition:none}}</style>
    <style>.toast{left:auto!important;right:max(12px,env(safe-area-inset-right,0px));transform:translateY(-8px)}.toast.show{transform:translateY(0)}</style>
    <style>.soul-head{padding:14px 15px;border:0}.soul-brandline{display:flex;align-items:center;gap:10px}.soul-icon{display:grid;width:29px;height:29px;place-items:center;border-radius:9px;background:#1d1738;color:#a77aff;font-size:20px;font-weight:900}.soul-head .brand{color:#9c76ff;font-size:15px;letter-spacing:0}.soul-head .sub{color:#8f99aa;font-size:8px;letter-spacing:.1em}.soul-status{margin:0 13px 12px;padding:10px 12px;border:1px solid #20232d;border-radius:11px;background:#0b0d13;font-size:12px;color:#d8dce5}.soul-status .dot{margin-left:auto}.soul-form{padding:0 13px 13px}.soul-label{margin:13px 0 6px;color:#929aab;font-size:9px}.soul-field{height:40px;border-radius:10px;background:#0b0d13;border-color:#262a35;font-size:12px}.soul-row{grid-template-columns:minmax(0,1fr) auto;gap:8px}.soul-button{height:40px;border-radius:10px;font-size:10px}.soul-primary{width:100%;margin-top:9px;background:#a3f62a;color:#101409}.soul-connect{width:100%;margin-top:9px;background:#e6373f;color:#fff}.soul-connect:not(.danger){background:#e6373f;color:#fff}.soul-tiles{grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}.soul-tiles .tile{padding:14px 12px;border-radius:11px;text-align:center}.soul-tiles .tile-label{font-size:9px;font-weight:500;letter-spacing:.06em}.soul-tiles .tile-value{font-size:12px}.beta-row{display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding:12px 14px;border:1px solid #22252f;border-radius:11px;background:#0b0d13;color:#d4d8e1;font-size:12px;font-weight:650}.beta-switch{position:relative;width:40px;height:23px;flex:none;margin:0;appearance:none;border:0;border-radius:999px;background:#292d36;cursor:pointer;transition:background .2s}.beta-switch:before{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:white;content:'';transition:transform .2s}.beta-switch:checked{background:#a3f62a}.beta-switch:checked:before{transform:translateX(17px)}.beta-switch:disabled{opacity:.45;cursor:not-allowed}.soul-foot{margin:11px 1px 0;color:#768091;font-size:9px;line-height:1.45}#genix-activity-stack{position:fixed;top:max(12px,env(safe-area-inset-top,0px));right:max(12px,env(safe-area-inset-right,0px));z-index:2147483647;display:flex;max-width:min(360px,calc(100vw - 24px));flex-direction:column;align-items:flex-end;gap:7px;pointer-events:none}.activity-toast{max-width:100%;padding:9px 12px;border:1px solid #343947;border-radius:10px;background:#11131b;color:#f0f2f8;box-shadow:0 8px 26px #0008;font:750 10px/1.35 Inter,ui-sans-serif,system-ui,sans-serif;opacity:0;transform:translateY(-8px) scale(.98);transition:opacity .18s ease,transform .2s cubic-bezier(.2,.8,.2,1);overflow-wrap:anywhere}.activity-toast.show{opacity:1;transform:translateY(0) scale(1)}.activity-toast[data-error=true]{border-color:#a5404a;color:#ffd9df}@media(prefers-reduced-motion:reduce){.activity-toast{transition:none}}</style>
    <div class='panel'><div class='top soul-head'><div class='soul-brandline'><span class='soul-icon'>G</span><div><div class='brand'>Genix Predictor</div></div></div><button class='collapse' id='genix-collapse' type='button' aria-label='Minimize panel'>−</button></div>
      <div class='connection soul-status'><span id='genix-live-label'>Disconnected</span><span class='dot offline' id='genix-live-dot'></span></div>
      <div class='body soul-form'>
        <label class='soul-label' for='genix-stake-username'>STAKE USERNAME</label><div class='row soul-row'><input class='soul-field' id='genix-stake-username' type='text' autocomplete='off' spellcheck='false' placeholder='Enter your Stake username'><button class='button secondary soul-button' id='genix-save-username' type='button'>Save</button></div>
        <label class='soul-label' for='genix-auth-token'>GENIX BRIDGE TOKEN</label><div class='row soul-row'><input class='token soul-field' id='genix-auth-token' type='password' readonly autocomplete='off' placeholder='Created when you connect'><button class='button secondary soul-button' id='genix-copy' type='button'>Copy</button></div>
        <button class='button soul-button soul-connect' id='genix-connect' type='button'>Connect</button>
        <div class='tiles soul-tiles'><div class='tile'><div class='tile-label'>GAME</div><div class='tile-value' id='genix-game-value'>None</div></div><div class='tile'><div class='tile-label'>PREDICTION</div><div class='tile-value' id='genix-prediction-value'>Waiting</div></div></div>
        <label class='beta-row' for='genix-beta-mode'><span>BETA MODE</span><input class='beta-switch' id='genix-beta-mode' type='checkbox' aria-label='Enable Beta Mode'></label>
        <p class='inline-status' id='genix-inline-status' role='status' aria-live='polite'></p>
      </div>
    </div>
    <div id='genix-activity-stack' aria-live='polite'></div>
    <button class='fab' id='genix-open' type='button' aria-label='Open Genix Stake connector'>G</button>`;
    const redesignStyle = document.createElement("style");
    redesignStyle.textContent = `
      :host{--accent:#9566ff;--accent-deep:#6d35db;--panel:#101117;--surface:#0b0d13;--line:#232630;--muted:#929bad;--text:#eef0f6;color-scheme:dark}
      .panel{width:min(320px,calc(100vw - 20px));max-height:min(90vh,430px);max-height:min(90dvh,430px);border:1px solid #272833;border-radius:18px;background:var(--panel);box-shadow:0 24px 70px #0009,0 0 0 1px #ffffff03;font-size:12px;transform-origin:bottom right;transition:opacity .22s ease,transform .32s cubic-bezier(.2,.8,.2,1),visibility .22s}
      .soul-head{min-height:44px;padding:8px 12px 7px;border:0}.soul-brandline{gap:8px}.soul-icon{width:29px;height:29px;border-radius:9px;background:#211a35;color:#a77aff;font-size:16px;font-weight:850;box-shadow:inset 0 0 0 1px #a77aff20}.soul-head .brand{color:#a77aff;font-size:13px;font-weight:760;letter-spacing:0}.soul-head .sub{margin-top:3px;color:#8790a2;font-size:8px;font-weight:700;letter-spacing:.12em}
      .collapse{width:27px;height:27px;border-radius:9px;border-color:#30323d;background:#191a22;color:#d9dce4;font-size:15px;transition:background .16s,border-color .16s}.collapse:hover{background:#23242e;border-color:#484a59}
      .soul-status{min-height:35px;margin:0 12px 5px;padding:7px 10px;border:1px solid #20222d;border-radius:10px;background:#0b0d13;color:#dce0e9;font-size:11px;font-weight:550}.soul-status .dot{width:8px;height:8px;margin-left:auto;background:#737888}.soul-status .dot.live{background:#12c58b;box-shadow:0 0 0 4px #12c58b20,0 0 12px #12c58b90;animation:pulse 1.6s ease-in-out infinite}.soul-status .dot.offline{background:#ed4e58;box-shadow:0 0 0 4px #ed4e581b,0 0 12px #ed4e5880}
      .soul-form{min-height:0;padding:0 12px 10px;overflow-y:auto;scrollbar-width:none;overscroll-behavior:contain}.soul-form::-webkit-scrollbar{display:none;width:0;height:0}.soul-label{margin:7px 0 3px;color:#929bad;font-size:7px;font-weight:720;letter-spacing:.09em}.soul-field{height:31px;padding:0 10px;border:1px solid #272a35;border-radius:9px;background:#0b0d13;color:#e8eaf0;font-size:10px;transition:border-color .16s,box-shadow .16s}.soul-field:focus{border-color:#8857e8;box-shadow:0 0 0 3px #8c5cf41c}.soul-row{grid-template-columns:minmax(0,1fr) auto;gap:6px}.soul-button{min-height:31px;height:31px;padding:0 10px;border-radius:9px;font-size:9px;font-weight:700}.button.secondary{border:1px solid #30323c;background:#1a1b23;color:#9ca6b8}.button.secondary:hover:not(:disabled){border-color:#484a59;background:#22232d;color:#e7e9ef}
      .soul-primary{width:100%;height:32px;min-height:32px;margin-top:6px;border:1px solid #9868ff35;border-radius:9px;background:#1a1724;color:#b89aff;font-size:9px}.soul-primary:hover:not(:disabled){background:#241d35;filter:none}.soul-connect{width:100%;height:34px;min-height:34px;margin-top:6px;border:0;border-radius:10px;background:linear-gradient(105deg,#9566ff,#6d35db);color:white;font-size:10px;letter-spacing:.025em;box-shadow:0 7px 18px #7039d733}.soul-connect:not(.danger){background:linear-gradient(105deg,#9566ff,#6d35db);color:white}.soul-connect.danger{background:linear-gradient(105deg,#f0444c,#c91f32);color:white;box-shadow:0 7px 18px #cf263433}.soul-connect:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px)}
      .soul-tiles{gap:7px;margin-top:7px}.soul-tiles .tile{min-height:48px;padding:6px 8px;border:1px solid #20222c;border-radius:10px;background:#0c0e14;text-align:center}.soul-tiles .tile-label{color:#8c95a7;font-size:7px;font-weight:620;letter-spacing:.08em}.soul-tiles .tile-value{margin-top:4px;color:#eff0f5;font-size:10px;font-weight:720}.beta-row{min-height:38px;margin-top:7px;padding:6px 10px;border:1px solid #22242e;border-radius:10px;background:#0b0d13;color:#d9dce5;font-size:10px;font-weight:640}.beta-switch{width:36px;height:20px;background:#2a2b34}.beta-switch:before{top:2px;left:2px;width:16px;height:16px}.beta-switch:checked{background:#8857e8}.beta-switch:checked:before{transform:translateX(16px)}.beta-switch:focus-visible{outline:2px solid #a77aff;outline-offset:2px}
      .soul-foot{margin:8px 1px 0;color:#747c8e;font-size:8px;line-height:1.35}.inline-status{min-height:0;margin:8px 1px 0;color:#b99aff;font:500 9px/1.4 Inter,ui-sans-serif,system-ui,sans-serif}.inline-status:empty{display:none}.inline-status[data-error=true]{color:#ff9b9f}
      .fab{width:41px;height:41px;border:1px solid #9a6dff;border-radius:13px;background:linear-gradient(140deg,#9566ff,#6d35db);color:white;font-size:16px;box-shadow:0 10px 26px #0009,0 0 18px #8857e833;transition:opacity .18s,transform .28s cubic-bezier(.2,.8,.2,1),filter .16s}.fab:hover{filter:brightness(1.1)}:host(.closed) .panel{transform:translateY(12px) scale(.98);pointer-events:none}:host(.closed) .fab{transform:translateY(0) scale(1)}
      #genix-activity-stack{position:fixed;right:max(15px,env(safe-area-inset-right,0px));bottom:max(15px,env(safe-area-inset-bottom,0px));z-index:2147483647;display:flex;width:min(300px,calc(100vw - 28px));flex-direction:column;align-items:stretch;gap:8px;pointer-events:none}
      .activity-toast{display:flex;align-items:center;gap:11px;min-height:52px;padding:10px 14px;border:1px solid #2a2835;border-left:4px solid #9566ff;border-radius:14px;background:#101117;color:#eff0f5;box-shadow:0 14px 38px #0009,0 0 24px #8857e811;font:650 12px/1.35 Inter,ui-sans-serif,system-ui,sans-serif;opacity:0;transform:translateY(22px) scale(.97);transition:opacity .28s ease,transform .38s cubic-bezier(.16,1,.3,1);overflow-wrap:anywhere}
      .activity-toast.show{opacity:1;transform:translateY(0) scale(1)}.activity-icon{display:grid;width:28px;height:28px;flex:none;place-items:center;border-radius:9px;background:#231b38;color:#b291ff;font-size:13px;font-weight:800}.activity-message{color:#f0f0f5}
      @media(max-width:600px){.panel{width:min(320px,calc(100vw - 18px));max-height:min(90vh,430px);max-height:min(90dvh,430px);border-radius:16px}.soul-head{padding:8px 12px 7px}.soul-status{margin-right:12px;margin-left:12px}.soul-form{padding-right:12px;padding-left:12px}.inline-status{margin-right:1px;margin-left:1px}.fab{width:39px;height:39px}}
      @media(prefers-reduced-motion:reduce){.panel,.fab,.activity-toast,.button,.collapse{transition:none!important}.soul-status .dot.live{animation:none}}
    `;
    root.append(redesignStyle);
    const popupStyleFix = document.createElement("style");
    popupStyleFix.textContent = `
      .panel{width:min(340px,calc(100vw - 18px));max-height:min(88vh,560px);max-height:min(88dvh,560px);border-radius:18px}
      .soul-head{min-height:58px;padding:13px 25px 11px}
      .soul-brandline{gap:10px}.soul-icon{width:29px;height:29px;border-radius:9px;font-size:17px}
      .soul-head .brand{font-size:17px}
      .soul-status{min-height:50px;margin:0 24px 10px;padding:12px 15px;border-radius:12px;font-size:15px}
      .soul-status .dot{width:10px;height:10px}
      .soul-form{flex:0 1 auto;min-height:0;padding:0 24px 23px;overflow-y:auto;scrollbar-width:none;overscroll-behavior:contain}
      .soul-form::-webkit-scrollbar{display:none;width:0;height:0}
      .soul-label{margin:15px 0 7px;font-size:10px;letter-spacing:.09em}
      .soul-field{height:44px;padding:0 15px;border-radius:11px;font-size:13px}
      .soul-row{gap:9px}.soul-button{min-height:44px;height:44px;padding:0 14px;border-radius:11px;font-size:12px}
      .soul-connect{height:49px;min-height:49px;margin-top:15px;border-radius:12px;font-size:14px}
      .soul-tiles{gap:12px;margin-top:20px}.soul-tiles .tile{min-height:77px;padding:13px 10px;border-radius:12px}
      .soul-tiles .tile-label{font-size:10px}.soul-tiles .tile-value{margin-top:9px;font-size:13px}
      .beta-row{min-height:54px;margin-top:18px;padding:10px 15px;border-radius:12px;font-size:13px}
      .beta-switch{width:40px;height:24px}.beta-switch:before{top:3px;left:3px;width:18px;height:18px}
      .inline-status{margin:8px 1px 0;font-size:9px}
      @media(max-width:600px){.panel{width:min(340px,calc(100vw - 12px));max-height:min(88vh,560px);max-height:min(88dvh,560px)}.soul-head{padding-right:25px;padding-left:25px}.soul-status{margin-right:24px;margin-left:24px}.soul-form{padding-right:24px;padding-left:24px}}
      @media(max-height:620px){.panel{max-height:calc(100dvh - 16px)}.soul-head{min-height:45px;padding-top:8px;padding-bottom:7px}.soul-status{min-height:42px;margin-bottom:6px;padding-top:8px;padding-bottom:8px;font-size:13px}.soul-label{margin-top:9px;margin-bottom:4px;font-size:8px}.soul-field,.soul-button{height:37px;min-height:37px}.soul-connect{height:42px;min-height:42px;margin-top:8px;font-size:12px}.soul-tiles{margin-top:10px}.soul-tiles .tile{min-height:62px;padding:8px}.soul-tiles .tile-value{margin-top:6px}.beta-row{min-height:45px;margin-top:10px;padding-top:7px;padding-bottom:7px}.soul-form{padding-bottom:12px}}
      @media(prefers-reduced-motion:reduce){.panel,.fab,.activity-toast,.button,.collapse{transition:none!important}}
    `;
    root.append(popupStyleFix);
    document.body.append(host);
    document.addEventListener("click", observeVisibleBetClick, true);
    document.addEventListener("click", observeGenericGameAction, true);
    const observeCashout = (event) => {
      if (eventInsideHost(event)) return;
      const target = eventElement(event, "button,[role=button],input[type=button],input[type=submit]");
      if (!target) return;
      const text = controlText(target);
      if (!/\bcash\s*out\b|\bcashout\b/i.test(text)) return;
      const game = currentGame();
      if (game === "crash") lastCrashCashoutAt = Date.now();
      if (settings.betaMode) {
        showActivityToast("CASHOUT CLICK · BETA MODE");
        recordGameAction(game, "cashout click · beta mode");
      } else if (settings.activeBet?.game === game) void finishActiveBet("cashout", { outcome: "win", ...(game === "crash" ? { gameData: readVisibleCrashState() } : {}) });
      else { showActivityToast("CASHOUT CLICK · " + String(game || "GAME").toUpperCase()); recoverFastCashout(game); }
    };
    document.addEventListener("click", observeCashout, true);
    const hostStyle = "#genix-stake-bridge-host{position:fixed;z-index:2147483646;right:max(10px,env(safe-area-inset-right,0px));bottom:max(10px,env(safe-area-inset-bottom,0px));max-width:calc(100vw - 16px);pointer-events:none}@media(max-width:600px){#genix-stake-bridge-host{bottom:max(72px,calc(env(safe-area-inset-bottom,0px) + 56px))}}";
    try {
      if (typeof GM_addStyle === "function") GM_addStyle(hostStyle);
      else if (typeof GM !== "undefined" && typeof GM.addStyle === "function") GM.addStyle(hostStyle);
      else {
        const style = document.createElement("style");
        style.textContent = hostStyle;
        (document.head || document.documentElement).append(style);
      }
    } catch (_) {
      host.style.cssText = "position:fixed;z-index:2147483646;right:10px;bottom:10px;max-width:calc(100vw - 16px);pointer-events:none";
      if (window.matchMedia?.("(max-width: 600px)").matches) host.style.bottom = "72px";
    }
    activityStack = root.querySelector("#genix-activity-stack");
    root.querySelector("#genix-connect").addEventListener("click", () => void (settings.monitoringEnabled ? disconnectPredictor() : connectPredictor()));
    const usernameInput = root.querySelector("#genix-stake-username");
    usernameInput.value = settings.usernameOverride || "";
    root.querySelector("#genix-save-username").addEventListener("click", () => void saveCustomUsername());
    usernameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void saveCustomUsername(); });
    root.querySelector("#genix-beta-mode").addEventListener("change", () => void (async (enabled) => {
      if (enabled && settings.activeBet) {
        root.querySelector("#genix-beta-mode").checked = false;
        setStatus("Finish the current tracked bet before enabling Beta Mode.", true);
        return;
      }
      if (enabled) {
        pendingBetIntents = [];
        pendingBetIntent = null;
        pendingTileClicks = [];
        pendingGameActions.clear();
        events = events.map((item) => !item.synced && item.eventType !== "game_action" ? { ...item, discarded: true } : item);
        await saveEvents();
      }
      await saveSettings({ betaMode: enabled });
      setStatus(enabled ? "Beta Mode on · bet detections are paused." : "Beta Mode off · bet detection resumed.");
      showActivityToast(enabled ? "BETA MODE ON" : "BETA MODE OFF");
      if (!enabled) { visibleActiveFingerprint = ""; void scanVisibleGameState(); }
    })(root.querySelector("#genix-beta-mode").checked));
    root.querySelectorAll("#genix-copy").forEach((button) => button.addEventListener("click", () => {
      if (!settings.authorizationToken) return;
      if (typeof GM_setClipboard === "function") GM_setClipboard(settings.authorizationToken, "text");
      else if (typeof GM !== "undefined" && typeof GM.setClipboard === "function") void GM.setClipboard(settings.authorizationToken, "text");
      else if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(settings.authorizationToken);
      setStatus("Genix token copied. Paste it into the Predictor.");
    }));
    root.querySelector("#genix-collapse").addEventListener("click", () => host.classList.add("closed"));
    root.querySelector("#genix-open").addEventListener("click", () => host.classList.remove("closed"));
    renderToken();
    renderStakeStatus();
    renderConnection();
  }

  function observeGenericGameAction(event) {
    const game = currentGame();
    if (!game || !SUPPORTED_GAMES.has(game) || eventInsideHost(event)) return;
    const target = eventElement(event, "button,[role=button],[data-testid*=tile i],[data-testid*=cell i],[aria-label*=tile i],[class*=tile i],[class*=cell i]");
    if (!target || !isVisible(target)) return;
    const action = controlText(target).replace(/\s+/g, " ").trim().slice(0, 64) || "game selection";
    if (/^(bet|play|place bet|start|start game)\b/i.test(action)) return;
    if (/\bcash\s*out\b|\bcashout\b/i.test(action)) return;
    if (game === "mines" || game === "moles") {
      if (/^random\s+pick\b/i.test(action)) {
        showActivityToast("RANDOM PICK · " + game.toUpperCase());
        recordGameAction(game, "random pick");
      }
      return;
    }
    const classText = typeof target.className === "string" ? target.className : "";
    const isBoardTile = /tile|cell|grid-item|selection/i.test(classText + " " + String(target.getAttribute("data-testid") || ""));
    const isGameAction = /higher|lower|same|skip|select|pick|random\s+pick|continue|collect|^(hit|stand|double|split)\b/i.test(action);
    const isKenoNumber = game === "keno" && /^\d{1,2}$/.test(action);
    if (!isBoardTile && !isGameAction && !isKenoNumber) return;
    showActivityToast(action.toUpperCase() + " · " + game.toUpperCase());
    if (settings.betaMode) {
      recordGameAction(game, action.toLowerCase(), { x: Math.round(Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth))) * 1000), y: Math.round(Math.max(0, Math.min(1, event.clientY / Math.max(1, window.innerHeight))) * 1000) });
      return;
    }
    const activeBet = settings.activeBet?.game === game ? settings.activeBet : null;
    const gameData = {
      ...(activeBet?.gameData || readVisibleGameData(game)),
      action,
      x: Math.round(Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth))) * 1000),
      y: Math.round(Math.max(0, Math.min(1, event.clientY / Math.max(1, window.innerHeight))) * 1000),
    };
    if (!activeBet) {
      const pending = (pendingGameActions.get(game) || []).filter((item) => Date.now() - item.at < 15000);
      pending.push({ action: action.replace(/\s+/g, " ").slice(0, 64), x: gameData.x, y: gameData.y, at: Date.now() });
      pendingGameActions.set(game, pending.slice(-16));
      return;
    }
    void queueEvent({
      username: activeBet.username,
      game,
      selectionCount: 0,
      betAmount: activeBet.betAmount,
      betEventId: activeBet.betEventId || activeBet.stakeBetId,
      betCapturedAt: activeBet.betCapturedAt,
      gameData,
    }, "game_action", { gameData, capturedAt: new Date().toISOString() });
  }

  function recoverFastCashout(game) {
    if (!CASHOUT_GAMES.has(game) || pendingCashoutGames.has(game)) return;
    pendingCashoutGames.add(game);
    const deadline = Date.now() + 1200;
    const attempt = async () => {
      if (settings.activeBet?.game === game) {
        await finishActiveBet("cashout", { outcome: "win" });
        pendingCashoutGames.delete(game);
        return;
      }
      const state = readVisibleGameState(game);
      if (state?.active && validStakeUsername(getStakeUsername())) {
        await startDetectedBet(game, {
          id: "cashout-click-" + game + "-" + crypto.randomUUID(),
          active: true,
          username: getStakeUsername(),
          count: state.count,
          amount: state.amount || "0",
          gameData: game === "crash" ? readVisibleCrashState() : state.gameData,
          source: "screen",
        });
        if (settings.activeBet?.game === game) {
          await finishActiveBet("cashout", { outcome: "win" });
          pendingCashoutGames.delete(game);
          return;
        }
      }
      if (Date.now() >= deadline) {
        pendingCashoutGames.delete(game);
        return;
      }
      window.setTimeout(() => void attempt(), 50);
    };
    void attempt();
  }

  function waitForBody(callback) {
    let mounted = false;
    const tryMount = () => {
      if (mounted || !document.body) return false;
      mounted = true;
      observer?.disconnect();
      callback();
      return true;
    };
    if (document.body) { callback(); return; }
    const observer = new MutationObserver(() => {
      tryMount();
    });
    const root = document.documentElement;
    if (root) observer.observe(root, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", tryMount, { once: true });
    window.addEventListener("load", tryMount, { once: true });
  }

  async function init() {
    installNetworkHooks();
    // Mount the connector before awaiting userscript storage APIs. Some mobile
    // managers resolve GM_getValue asynchronously after the page is visible;
    // the popup must not depend on that completing first.
    waitForBody(mountPanel);
    settings = await readSettings();
    if (!TOKEN_PATTERN.test(settings.authorizationToken)) {
      settings.authorizationToken = createAuthorizationToken();
      settings.pairingRegistered = false;
    }
    if (!validStakeUsername(settings.username)) settings.username = "";
    settings.connected = false;
    settings.stakeDomain = location.hostname;
    await writeStoredValue(SETTINGS_KEY, settings);
    await writeStoredValue("genix_stake_api_token_local_v1", "");
    await writeStoredValue("genix_stake_session_cookie_local_v1", "");
    events = await readStoredValue(EVENTS_KEY, []);
    if (!Array.isArray(events)) events = [];
    const storedCrashRounds = await readStoredValue(CRASH_ROUNDS_KEY, []);
    recentCrashRounds = Array.isArray(storedCrashRounds) ? storedCrashRounds.map(Number).filter((value) => Number.isFinite(value) && value >= 1 && value <= 100_000).slice(-10) : [];
    const finished = await readStoredValue(FINISHED_BETS_KEY, []);
    finishedStakeBetIds = new Set(Array.isArray(finished) ? finished.filter((id) => typeof id === "string") : []);
    initialized = true;
    resolveInitialized();
    renderToken();
    renderConnection();
    renderStakeStatus();
    document.addEventListener("pointerdown", observeVisibleTileClick, true);
    document.addEventListener("click", observeVisibleTileClick, true);
    const resumeSync = () => {
      if (!settings.monitoringEnabled || !settings.pairingRegistered) return;
      lastConnectionCheckAt = 0;
      void checkConnection();
      void flushEvents();
      void syncVisibleGameHeartbeat(true);
    };
    window.addEventListener("online", resumeSync);
    window.addEventListener("focus", resumeSync);
    window.addEventListener("pageshow", resumeSync);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeSync(); });
    window.addEventListener("pagehide", () => { if (settings.monitoringEnabled && settings.connected) void flushEvents(); });
    window.setInterval(() => {
      if (!settings.monitoringEnabled || !settings.pairingRegistered) return;
      const cadence = settings.connected ? 15000 : 700;
      if (Date.now() - lastConnectionCheckAt >= cadence) void checkConnection();
    }, 500);
    window.setInterval(() => void scanVisibleGameState(), 350);
    window.setInterval(() => void syncVisibleGameHeartbeat(), 250);
    window.setInterval(() => void pollStakeUsername(), 10000);
    window.setInterval(() => { if (settings.monitoringEnabled && settings.connected) void flushEvents(); }, 5000);
    if (settings.monitoringEnabled && settings.pairingRegistered && settings.authorizationToken) {
      void checkConnection();
      void pollStakeUsername();
    }
  }

  void init().catch(() => {
    // Keep the panel available even if this manager's storage API fails.
    waitForBody(mountPanel);
    if (root) setStatus("Connector storage is unavailable. Reload Stake or check userscript permissions.", true);
  });
})();
