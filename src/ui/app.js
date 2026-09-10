// State store over the config JSON (single source of truth, raid-calc.md §6).
// The config is immutable-by-convention: get() returns a deep clone, set() takes a mutator that
// must return a new config object (or mutate a clone). Undo/redo keep a bounded history.

const HISTORY_LIMIT = 100;

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

export function createStore(
  initialConfig,
  { storageKey = "raid_calc:config" } = {},
) {
  let config = deepClone(initialConfig);
  let past = [];
  let future = [];
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn(config);
  }

  return {
    get() {
      return deepClone(config);
    },
    // mutator: (configClone) => configClone | newConfig ; validates via opts.validate (throws)
    set(mutator, { recordHistory = true } = {}) {
      const next = mutator(deepClone(config));
      if (!next || typeof next !== "object") {
        throw new Error("store.set: mutator must return a config object");
      }
      if (recordHistory) {
        past.push(deepClone(config));
        if (past.length > HISTORY_LIMIT) past.shift();
      }
      config = deepClone(next);
      future = [];
      emit();
      return config;
    },
    replace(configObj, { recordHistory = true } = {}) {
      if (recordHistory) {
        past.push(deepClone(config));
        if (past.length > HISTORY_LIMIT) past.shift();
      }
      config = deepClone(configObj);
      future = [];
      emit();
      return config;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    undo() {
      if (past.length === 0) return false;
      future.push(deepClone(config));
      config = past.pop();
      emit();
      return true;
    },
    redo() {
      if (future.length === 0) return false;
      past.push(deepClone(config));
      config = future.pop();
      emit();
      return true;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    reset(configObj) {
      past = [];
      future = [];
      config = deepClone(configObj);
      emit();
      return config;
    },
    // persistence
    saveLocal() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(config));
      } catch {
        /* private mode / quota: autosave is best-effort */
      }
    },
    loadLocal() {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    clearLocal() {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    },
  };
}

export function downloadConfig(config, filename = "raid_calc_config.json") {
  const blob = new Blob([JSON.stringify(config, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function readConfigFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch (err) {
        reject(new Error(`invalid JSON in config file: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error("failed to read config file"));
    reader.readAsText(file);
  });
}
