// Walrus Memory on/off preference. This is the only memory-related code the dashboard loads while memory is off:
// it reads one localStorage flag per connected account and nothing else. The suggestion code (lib/memory.js) is
// imported dynamically, and only after this flag is on for the connected account.
//
// Default: OFF. Any storage error, an unknown account or a value other than the exact string "on" reads as off.

const PREFIX = 'circuitwill:walrus-memory:v1:';

export function memoryPrefKey(account) {
  const a = String(account ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  return PREFIX + a;
}

export function isMemoryEnabled(storage, account) {
  const key = memoryPrefKey(account);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

/// Returns the value actually stored (false if the storage refused it, so the toggle never shows "on" by mistake).
export function setMemoryEnabled(storage, account, on) {
  const key = memoryPrefKey(account);
  if (!key || !storage) return false;
  try {
    if (on) storage.setItem(key, 'on');
    else storage.removeItem(key);
    return storage.getItem(key) === 'on';
  } catch {
    return false;
  }
}
