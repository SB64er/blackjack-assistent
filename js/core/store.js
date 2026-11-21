// Lokaler Speicher (localStorage) mit Fehlertoleranz.
// Alle Daten bleiben auf dem Gerät. Nichts wird an Server übertragen.

const PREFIX = 'bjassist.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignorieren */
  }
}

// Bittet den Browser, den lokalen Speicher nicht automatisch zu löschen.
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* nicht unterstützt */
  }
  return false;
}
