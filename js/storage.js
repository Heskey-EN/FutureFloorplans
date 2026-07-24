const DB_NAME = 'future-floor-plans';
const STORE = 'plans';
const PLAN_KEY = 'active-plan';
const FALLBACK_KEY = 'future-floor-plans.active-plan';

function database() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

export async function loadPlan() {
  try {
    const plan = await withStore('readonly', store => store.get(PLAN_KEY));
    return plan || null;
  } catch {
    try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null'); } catch { return null; }
  }
}

export async function savePlan(plan) {
  try {
    await withStore('readwrite', store => store.put(plan, PLAN_KEY));
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(plan));
    return 'indexeddb';
  } catch {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(plan));
    return 'localstorage';
  }
}
