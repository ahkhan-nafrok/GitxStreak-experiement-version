// lib/tokenVault.js
// Handles the ONE genuinely sensitive thing GITSTREAK touches: the GitHub
// token. Design, agreed on in the idea phase:
//
//   - An AES-GCM key is generated via WebCrypto as NON-EXTRACTABLE. That
//     means the key can be used (encrypt/decrypt) by this code, but its raw
//     bytes can never be read out — not by this file, not by anything else.
//   - That key is stored in IndexedDB (not chrome.storage.local), so it
//     survives browser/PC restarts with zero re-entry, ever.
//   - The GitHub token itself is encrypted with that key before it touches
//     chrome.storage.local. What sits on disk there is ciphertext + IV only.
//   - The token never touches content.js or any page-facing context — this
//     module is only ever imported from popup-context view files.
//
// This file is the ONLY place that generates/loads the vault key or touches
// the encrypted token blob. Everything else (pulseView.js, projectsView.js,
// settingsView.js) goes through getToken() / saveToken() / revokeToken().

import { fetchWithTimeout } from "./net.js"; // invariant 11: every fetch has a deadline

const DB_NAME = "gitstreak_vault";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_RECORD_ID = "token-key";
const STORAGE_KEY = "ghTokenEncrypted";

// ---------------------------------------------------------------------------
// IndexedDB plumbing — minimal, promise-wrapped. This is the only place in
// the codebase that touches indexedDB, mirroring how storageAdapter.js is
// the only place that touches chrome.storage.
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("Couldn't open the local vault database: " + req.error?.message));
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(new Error("Vault read failed: " + req.error?.message));
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error("Vault write failed: " + tx.error?.message));
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error("Vault delete failed: " + tx.error?.message));
  });
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/**
 * Loads the vault's AES-GCM key from IndexedDB, generating a new
 * non-extractable one on first use. The generated CryptoKey object is
 * stored directly in IndexedDB via structured clone (supported for
 * non-extractable CryptoKeys) — there is no code path that ever calls
 * crypto.subtle.exportKey on it.
 */
async function getOrCreateKey() {
  const existing = await idbGet(KEY_RECORD_ID);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false /* extractable */, [
    "encrypt",
    "decrypt",
  ]);
  await idbSet(KEY_RECORD_ID, key);
  return key;
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encrypt(plaintext) {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: toBase64(new Uint8Array(ciphertextBuf)),
    iv: toBase64(iv),
  };
}

async function decrypt({ ciphertext, iv }) {
  const key = await getOrCreateKey();
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );
  return new TextDecoder().decode(plainBuf);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypts and stores a GitHub token. Overwrites any previous token.
 */
export async function saveToken(adapter, token) {
  const trimmed = (token || "").trim();
  if (!trimmed) throw new Error("Token can't be empty.");
  const encrypted = await encrypt(trimmed);
  await adapter.set({ [STORAGE_KEY]: encrypted });
}

/**
 * Returns the decrypted token, or null if none is saved. A corrupted or
 * undecryptable blob (e.g. the IndexedDB key was cleared independently of
 * chrome.storage — a real possibility if the user clears one but not the
 * other via browser settings) fails safe: treated as "no token", not thrown
 * as an error that would break every view that calls this.
 */
export async function getToken(adapter) {
  const data = await adapter.get([STORAGE_KEY]);
  const blob = data[STORAGE_KEY];
  if (!blob || !blob.ciphertext || !blob.iv) return null;
  try {
    return await decrypt(blob);
  } catch (e) {
    console.warn("Token vault: stored token could not be decrypted, treating as absent.", e.message);
    return null;
  }
}

/**
 * Wipes both the encrypted token (chrome.storage.local) and the vault key
 * (IndexedDB) — a full local revoke. Does NOT revoke the token on GitHub's
 * side; that has to be done at github.com/settings/tokens.
 */
export async function revokeToken(adapter) {
  await adapter.set({ [STORAGE_KEY]: null });
  await idbDelete(KEY_RECORD_ID);
}

/** A short, non-sensitive display form: "ghp_••••1a2b" — never the full token. */
export function maskToken(token) {
  if (!token || token.length < 8) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

/**
 * Validates a token against GitHub and reports back what it can actually
 * do, so an over-scoped token is caught in Settings before it's saved, not
 * discovered later. Classic PATs return their scopes in the
 * x-oauth-scopes response header; fine-grained PATs don't expose scopes
 * this way, so `scopes` is null for those — validity is still confirmed via
 * the 200 response, just without a scope list to show.
 */
export async function testConnection(token) {
  const trimmed = (token || "").trim();
  if (!trimmed) throw new Error("Enter a token first.");

  const res = await fetchWithTimeout("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${trimmed}`, Accept: "application/vnd.github+json" },
  });

  if (res.status === 401) throw new Error("GitHub rejected this token (401) — check it was copied correctly.");
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);

  const user = await res.json();
  const scopesHeader = res.headers.get("x-oauth-scopes");
  const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()).filter(Boolean) : null;

  return {
    login: user.login,
    scopes, // null for fine-grained tokens — GitHub doesn't expose scopes for those via this header
    isFineGrained: scopes === null,
  };
}
