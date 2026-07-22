"use strict";

// src/promotion-health-preload.ts
var import_electron = require("electron");

// src/renderer-crypto.ts
var SHA256_INITIAL = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_ROUND = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function rotateRight(value, amount) {
  return value >>> amount | value << 32 - amount;
}
function sha256HexUtf8(value) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 128;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);
  const state = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < words.length; index += 1) {
      const prior15 = words[index - 15];
      const prior2 = words[index - 2];
      const small0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ prior15 >>> 3;
      const small1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ prior2 >>> 10;
      words[index] = words[index - 16] + small0 + words[index - 7] + small1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < words.length; index += 1) {
      const large1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = e & f ^ ~e & g;
      const temporary1 = h + large1 + choose + SHA256_ROUND[index] + words[index] >>> 0;
      const large0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temporary2 = large0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temporary1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2 >>> 0;
    }
    state[0] = state[0] + a >>> 0;
    state[1] = state[1] + b >>> 0;
    state[2] = state[2] + c >>> 0;
    state[3] = state[3] + d >>> 0;
    state[4] = state[4] + e >>> 0;
    state[5] = state[5] + f >>> 0;
    state[6] = state[6] + g >>> 0;
    state[7] = state[7] + h >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}
function secureRendererUuid() {
  const provider = globalThis.crypto;
  if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  if (typeof provider?.getRandomValues !== "function") {
    throw new Error("secure renderer randomness is unavailable");
  }
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// src/renderer-storage.ts
var CURRENT_ID_PREFIX = "co.tweakers.";
var LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
var CURRENT_STORAGE_PREFIX = "tweaker:storage:";
var ARCHIVE_STORAGE_PREFIX = "tweaker:storage-archive:";
function parseRecord(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function fingerprint(raw) {
  return raw === null ? "missing" : sha256HexUtf8(raw);
}
function discoverLegacyPublisherKeys(id, storage) {
  if (!id.startsWith(CURRENT_ID_PREFIX)) return [];
  const suffix = id.slice(CURRENT_ID_PREFIX.length);
  if (!suffix) return [];
  const suffixMarker = `.${suffix}`;
  const candidates = /* @__PURE__ */ new Set();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const legacyId = key.slice(LEGACY_STORAGE_PREFIX.length);
    if (legacyId !== id && legacyId.startsWith("co.") && legacyId.endsWith(suffixMarker) && legacyId.slice(3, -suffixMarker.length).length > 0) {
      candidates.add(key);
    }
  }
  return [...candidates].sort();
}
function legacyKeysFor(id, storage) {
  const exactLegacyKey = `${LEGACY_STORAGE_PREFIX}${id}`;
  const keys = new Set(discoverLegacyPublisherKeys(id, storage));
  if (storage.getItem(exactLegacyKey) !== null) keys.add(exactLegacyKey);
  return [...keys].sort();
}
function planMigration(id, storage, transactionId = secureRendererUuid()) {
  const currentKey = `${CURRENT_STORAGE_PREFIX}${id}`;
  const canonicalRaw = storage.getItem(currentKey);
  const legacyKeys = legacyKeysFor(id, storage);
  const selectedLegacyKey = legacyKeys.length === 1 ? legacyKeys[0] : null;
  const selectedLegacyRaw = selectedLegacyKey === null ? null : storage.getItem(selectedLegacyKey);
  const base = {
    schemaVersion: 1,
    transactionId,
    currentKey,
    legacyKeys,
    selectedLegacyKey,
    createdCanonical: false,
    canonicalBeforeHash: fingerprint(canonicalRaw),
    canonicalAfterHash: fingerprint(canonicalRaw),
    selectedLegacyHash: fingerprint(selectedLegacyRaw),
    archiveKey: null,
    phase: "planned"
  };
  if (!id.startsWith(CURRENT_ID_PREFIX)) {
    return { receipt: { ...base, status: "not_applicable", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  if (legacyKeys.length > 1) {
    return { receipt: { ...base, status: "ambiguous", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null && parseRecord(canonicalRaw) === null) {
    return { receipt: { ...base, status: "invalid_canonical", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (selectedLegacyRaw !== null && parseRecord(selectedLegacyRaw) === null) {
    return { receipt: { ...base, status: "invalid_legacy", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null) {
    const mismatch = selectedLegacyRaw !== null && selectedLegacyRaw !== canonicalRaw;
    return {
      receipt: { ...base, status: mismatch ? "conflict" : "canonical", holdPromotion: mismatch },
      canonicalRaw,
      selectedLegacyRaw
    };
  }
  if (selectedLegacyRaw === null) {
    return { receipt: { ...base, status: "absent", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  return {
    receipt: {
      ...base,
      status: "prepared",
      holdPromotion: false,
      createdCanonical: true,
      canonicalAfterHash: fingerprint(selectedLegacyRaw)
    },
    canonicalRaw,
    selectedLegacyRaw
  };
}
function prepareRendererStorageMigration(id, storage, transactionId) {
  const plan = planMigration(id, storage, transactionId);
  if (!plan.receipt.createdCanonical || plan.selectedLegacyRaw === null) {
    return { ...plan.receipt, phase: "prepared" };
  }
  try {
    if (storage.getItem(plan.receipt.currentKey) !== null) {
      return { ...plan.receipt, status: "conflict", holdPromotion: true, createdCanonical: false, phase: "prepared" };
    }
    storage.setItem(plan.receipt.currentKey, plan.selectedLegacyRaw);
    if (fingerprint(storage.getItem(plan.receipt.currentKey)) !== plan.receipt.canonicalAfterHash) {
      throw new Error("renderer storage verification failed");
    }
    return { ...plan.receipt, phase: "prepared" };
  } catch {
    return {
      ...plan.receipt,
      status: "write_failed",
      holdPromotion: true,
      createdCanonical: false,
      canonicalAfterHash: fingerprint(storage.getItem(plan.receipt.currentKey)),
      phase: "prepared"
    };
  }
}
function commitRendererStorageMigration(receipt, storage) {
  if (receipt.phase === "committed") return receipt;
  if (receipt.holdPromotion) throw new Error("renderer storage migration is on hold");
  if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
    throw new Error("renderer storage canonical value changed before commit");
  }
  if (receipt.selectedLegacyKey === null) return { ...receipt, phase: "committed" };
  const legacyRaw = storage.getItem(receipt.selectedLegacyKey);
  if (fingerprint(legacyRaw) !== receipt.selectedLegacyHash || legacyRaw === null) {
    throw new Error("renderer storage legacy value changed before commit");
  }
  const archiveKey = `${ARCHIVE_STORAGE_PREFIX}${receipt.transactionId}:${encodeURIComponent(receipt.selectedLegacyKey)}`;
  const archived = storage.getItem(archiveKey);
  if (archived !== null && archived !== legacyRaw) {
    throw new Error("renderer storage archive collision");
  }
  storage.setItem(archiveKey, legacyRaw);
  if (storage.getItem(archiveKey) !== legacyRaw) throw new Error("renderer storage archive verification failed");
  storage.removeItem(receipt.selectedLegacyKey);
  return { ...receipt, archiveKey, phase: "committed" };
}
function rollbackRendererStorageMigration(receipt, storage) {
  if (receipt.phase === "rolled_back") return receipt;
  if (receipt.archiveKey !== null && receipt.selectedLegacyKey !== null) {
    const archived = storage.getItem(receipt.archiveKey);
    if (fingerprint(archived) !== receipt.selectedLegacyHash || archived === null) {
      throw new Error("renderer storage archive changed before rollback");
    }
    const currentLegacy = storage.getItem(receipt.selectedLegacyKey);
    if (currentLegacy !== null && fingerprint(currentLegacy) !== receipt.selectedLegacyHash) {
      throw new Error("renderer storage legacy value changed before rollback");
    }
    if (currentLegacy === null) storage.setItem(receipt.selectedLegacyKey, archived);
    storage.removeItem(receipt.archiveKey);
  }
  if (receipt.createdCanonical) {
    if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
      throw new Error("renderer storage canonical value changed before rollback");
    }
    storage.removeItem(receipt.currentKey);
  }
  return { ...receipt, phase: "rolled_back" };
}
function verifyRendererStorageRollback(storage, nonce) {
  const suffix = `promotion-health-original-${nonce}`;
  const currentId = `co.tweakers.${suffix}`;
  const currentKey = `${CURRENT_STORAGE_PREFIX}${currentId}`;
  const legacyKey = `${LEGACY_STORAGE_PREFIX}co.promotion-probe.${suffix}`;
  const expectedArchiveKey = `${ARCHIVE_STORAGE_PREFIX}${nonce}:${encodeURIComponent(legacyKey)}`;
  const raw = JSON.stringify({ retained: true, nonce });
  let ownsProbeKeys = false;
  let result = "fail";
  let cleanupSucceeded = true;
  try {
    if (storage.getItem(currentKey) !== null || storage.getItem(legacyKey) !== null) {
      result = "fail";
    } else {
      ownsProbeKeys = true;
      storage.setItem(legacyKey, raw);
      const prepared = prepareRendererStorageMigration(currentId, storage, nonce);
      if (prepared.status !== "prepared" || prepared.holdPromotion || storage.getItem(currentKey) !== raw) {
        result = "fail";
      } else {
        const committed = commitRendererStorageMigration(prepared, storage);
        if (committed.phase !== "committed" || committed.archiveKey !== expectedArchiveKey || storage.getItem(legacyKey) !== null) {
          result = "fail";
        } else {
          const rolledBack = rollbackRendererStorageMigration(committed, storage);
          result = rolledBack.phase === "rolled_back" && storage.getItem(legacyKey) === raw && storage.getItem(currentKey) === null && storage.getItem(expectedArchiveKey) === null ? "pass" : "fail";
        }
      }
    }
  } catch {
    result = "fail";
  } finally {
    if (ownsProbeKeys) {
      const removeAndVerify = (key) => {
        try {
          storage.removeItem(key);
          return storage.getItem(key) === null;
        } catch {
          return false;
        }
      };
      cleanupSucceeded = removeAndVerify(currentKey) && cleanupSucceeded;
      cleanupSucceeded = removeAndVerify(legacyKey) && cleanupSucceeded;
      cleanupSucceeded = removeAndVerify(expectedArchiveKey) && cleanupSucceeded;
    }
  }
  return result === "pass" && cleanupSucceeded ? "pass" : "fail";
}

// src/preload/promotion-renderer-mount.ts
function createPromotionRendererMountTracker() {
  let sawStartupLoader = false;
  let mounted = false;
  return {
    observe(observation) {
      if (mounted) return "mounted";
      if (!observation.rootPresent) return "waiting";
      if (observation.startupLoaderPresent) {
        sawStartupLoader = true;
        return "waiting";
      }
      if (sawStartupLoader && Number.isSafeInteger(observation.elementChildCount) && observation.elementChildCount > 0) {
        mounted = true;
      }
      return mounted ? "mounted" : "waiting";
    },
    result() {
      return mounted ? "mounted" : "waiting";
    }
  };
}

// src/promotion-health-preload.ts
var PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL = "tweaker:promotion-original-renderer-authorize";
var PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL = "tweaker:promotion-original-renderer-proof";
var PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
var PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS = /* @__PURE__ */ new Set(["hostId", "initialRoute"]);
var effectiveRendererSandboxed = process.sandboxed === true;
var MOUNT_TIMEOUT_MS = 55e3;
function canonicalOriginalRendererUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "app:" || parsed.hostname !== "-" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/index.html" || parsed.hash !== "" || parsed.searchParams.has(PROMOTION_RENDERER_NONCE_QUERY) || parsed.toString() !== value) return null;
  const queryKeys = [...parsed.searchParams.keys()];
  if (queryKeys.some((key) => !PROMOTION_ORIGINAL_RENDERER_QUERY_KEYS.has(key)) || new Set(queryKeys).size !== queryKeys.length) return null;
  const hostId = parsed.searchParams.get("hostId");
  const initialRoute = parsed.searchParams.get("initialRoute");
  if (hostId !== null && !/^[A-Za-z0-9._:-]{1,256}$/.test(hostId)) return null;
  if (initialRoute !== null && (initialRoute.length === 0 || initialRoute.length > 2048 || !initialRoute.startsWith("/") || /[\u0000-\u001f\u007f]/.test(initialRoute))) return null;
  return value;
}
function parseExactAuthorization(value, expectedUrl) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  return Object.keys(record).sort().join(",") === "nonce,url,version" && record.version === 1 && typeof record.nonce === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.nonce) && record.url === expectedUrl ? record : null;
}
var unmodifiedUrl = location.href;
var canonicalUrl = canonicalOriginalRendererUrl(unmodifiedUrl);
var authorization = null;
if (canonicalUrl !== null) {
  try {
    authorization = import_electron.ipcRenderer.sendSync(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, {
      version: 1,
      url: canonicalUrl,
      rendererSandboxed: effectiveRendererSandboxed
    });
  } catch {
    authorization = null;
  }
}
var parsedAuthorization = canonicalUrl === null ? null : parseExactAuthorization(authorization, canonicalUrl);
if (parsedAuthorization) {
  observeOriginalRendererMount(parsedAuthorization);
}
function observeOriginalRendererMount(authorized) {
  const mount = createPromotionRendererMountTracker();
  let settled = false;
  const observer = new MutationObserver(inspect);
  const timeout = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    import_electron.ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
      nonce: authorized.nonce,
      url: unmodifiedUrl,
      lifecycle: "renderer-mount-timeout",
      rendererSandboxed: effectiveRendererSandboxed
    });
  }, MOUNT_TIMEOUT_MS);
  function inspect() {
    if (settled) return;
    const root = document.getElementById("root");
    const state = mount.observe({
      rootPresent: root !== null,
      startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
      elementChildCount: root?.children.length ?? 0
    });
    if (state !== "mounted") return;
    settled = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    import_electron.ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
      nonce: authorized.nonce,
      url: unmodifiedUrl,
      lifecycle: "renderer-mounted",
      rendererSandboxed: effectiveRendererSandboxed,
      rendererStorageSelfTest: verifyRendererStorageRollback(localStorage, authorized.nonce)
    });
  }
  observer.observe(document, { childList: true, subtree: true });
  inspect();
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3Byb21vdGlvbi1oZWFsdGgtcHJlbG9hZC50cyIsICIuLi9zcmMvcmVuZGVyZXItY3J5cHRvLnRzIiwgIi4uL3NyYy9yZW5kZXJlci1zdG9yYWdlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL3Byb21vdGlvbi1yZW5kZXJlci1tb3VudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHZlcmlmeVJlbmRlcmVyU3RvcmFnZVJvbGxiYWNrIH0gZnJvbSBcIi4vcmVuZGVyZXItc3RvcmFnZVwiO1xuaW1wb3J0IHsgY3JlYXRlUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIgfSBmcm9tIFwiLi9wcmVsb2FkL3Byb21vdGlvbi1yZW5kZXJlci1tb3VudFwiO1xuXG4vLyBLZWVwIHRoaXMgZGVkaWNhdGVkIHNhbmRib3ggcHJlbG9hZCBicm93c2VyLW9ubHkuIEltcG9ydGluZyB0aGUgbWFpbi1wcm9jZXNzXG4vLyBwcm9tb3Rpb24gbW9kdWxlIHdvdWxkIHB1bGwgbm9kZTpmcy9jcnlwdG8vcGF0aCBpbnRvIGEgcmVuZGVyZXIgYnVuZGxlLlxuLy8gU291cmNlLWludGVncmF0aW9uIHRlc3RzIGJpbmQgdGhlc2UgZXhhY3QgY29uc3RhbnRzIHRvIHRoZSBtYWluIG1vZHVsZS5cbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9VUkwgPSBcImFwcDovLy0vaW5kZXguaHRtbFwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0FVVEhfQ0hBTk5FTCA9IFwidHdlYWtlcjpwcm9tb3Rpb24tb3JpZ2luYWwtcmVuZGVyZXItYXV0aG9yaXplXCI7XG5jb25zdCBQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfSVBDX0NIQU5ORUwgPSBcInR3ZWFrZXI6cHJvbW90aW9uLW9yaWdpbmFsLXJlbmRlcmVyLXByb29mXCI7XG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkgPSBcInR3ZWFrZXJQcm9tb3Rpb25Ob25jZVwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX1FVRVJZX0tFWVMgPSBuZXcgU2V0KFtcImhvc3RJZFwiLCBcImluaXRpYWxSb3V0ZVwiXSk7XG5jb25zdCBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCA9IHByb2Nlc3Muc2FuZGJveGVkID09PSB0cnVlO1xuXG4vLyBLZXB0IGJlbG93IHRoZSBtYWluLXByb2Nlc3MgY29tcGxldGlvbiBwaGFzZSBzbyB0aGlzIGV4YWN0LCBib3VuZCBmYWlsdXJlIGlzXG4vLyBvYnNlcnZlZCBhbmQgY2xlYW5lZCB1cCBiZWZvcmUgdGhlIG91dGVyIGNvbXBsZXRpb24gZGVhZGxpbmUgY2FuIGZpcmUuXG5jb25zdCBNT1VOVF9USU1FT1VUX01TID0gNTVfMDAwO1xuXG50eXBlIEF1dGhvcml6YXRpb24gPSB7IHZlcnNpb246IDE7IG5vbmNlOiBzdHJpbmc7IHVybDogc3RyaW5nIH07XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbE9yaWdpbmFsUmVuZGVyZXJVcmwodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKFxuICAgIHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHZhbHVlLmxlbmd0aCA9PT0gMFxuICAgIHx8IHZhbHVlLmxlbmd0aCA+IDhfMTkyXG4gICAgfHwgL1tcXHUwMDAwLVxcdTAwMWZcXHUwMDdmXS8udGVzdCh2YWx1ZSlcbiAgKSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcnNlZDogVVJMO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoXG4gICAgcGFyc2VkLnByb3RvY29sICE9PSBcImFwcDpcIlxuICAgIHx8IHBhcnNlZC5ob3N0bmFtZSAhPT0gXCItXCJcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucG9ydCAhPT0gXCJcIlxuICAgIHx8IHBhcnNlZC5wYXRobmFtZSAhPT0gXCIvaW5kZXguaHRtbFwiXG4gICAgfHwgcGFyc2VkLmhhc2ggIT09IFwiXCJcbiAgICB8fCBwYXJzZWQuc2VhcmNoUGFyYW1zLmhhcyhQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkpXG4gICAgfHwgcGFyc2VkLnRvU3RyaW5nKCkgIT09IHZhbHVlXG4gICkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5S2V5cyA9IFsuLi5wYXJzZWQuc2VhcmNoUGFyYW1zLmtleXMoKV07XG4gIGlmIChcbiAgICBxdWVyeUtleXMuc29tZSgoa2V5KSA9PiAhUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX1FVRVJZX0tFWVMuaGFzKGtleSkpXG4gICAgfHwgbmV3IFNldChxdWVyeUtleXMpLnNpemUgIT09IHF1ZXJ5S2V5cy5sZW5ndGhcbiAgKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaG9zdElkID0gcGFyc2VkLnNlYXJjaFBhcmFtcy5nZXQoXCJob3N0SWRcIik7XG4gIGNvbnN0IGluaXRpYWxSb3V0ZSA9IHBhcnNlZC5zZWFyY2hQYXJhbXMuZ2V0KFwiaW5pdGlhbFJvdXRlXCIpO1xuICBpZiAoaG9zdElkICE9PSBudWxsICYmICEvXltBLVphLXowLTkuXzotXXsxLDI1Nn0kLy50ZXN0KGhvc3RJZCkpIHJldHVybiBudWxsO1xuICBpZiAoaW5pdGlhbFJvdXRlICE9PSBudWxsICYmIChcbiAgICBpbml0aWFsUm91dGUubGVuZ3RoID09PSAwXG4gICAgfHwgaW5pdGlhbFJvdXRlLmxlbmd0aCA+IDJfMDQ4XG4gICAgfHwgIWluaXRpYWxSb3V0ZS5zdGFydHNXaXRoKFwiL1wiKVxuICAgIHx8IC9bXFx1MDAwMC1cXHUwMDFmXFx1MDA3Zl0vLnRlc3QoaW5pdGlhbFJvdXRlKVxuICApKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBwYXJzZUV4YWN0QXV0aG9yaXphdGlvbih2YWx1ZTogdW5rbm93biwgZXhwZWN0ZWRVcmw6IHN0cmluZyk6IEF1dGhvcml6YXRpb24gfCBudWxsIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS5sZW5ndGggPT09IDAgfHwgdmFsdWUubGVuZ3RoID4gMV8wMjQpIHJldHVybiBudWxsO1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIXBhcnNlZCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJlY29yZCA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIE9iamVjdC5rZXlzKHJlY29yZCkuc29ydCgpLmpvaW4oXCIsXCIpID09PSBcIm5vbmNlLHVybCx2ZXJzaW9uXCJcbiAgICAmJiByZWNvcmQudmVyc2lvbiA9PT0gMVxuICAgICYmIHR5cGVvZiByZWNvcmQubm9uY2UgPT09IFwic3RyaW5nXCJcbiAgICAmJiAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LTRbMC05YS1mXXszfS1bODlhYl1bMC05YS1mXXszfS1bMC05YS1mXXsxMn0kL2kudGVzdChyZWNvcmQubm9uY2UpXG4gICAgJiYgcmVjb3JkLnVybCA9PT0gZXhwZWN0ZWRVcmxcbiAgICA/IHJlY29yZCBhcyBBdXRob3JpemF0aW9uXG4gICAgOiBudWxsO1xufVxuXG4vLyBUaGlzIGVudHJ5IGlzIHJlZ2lzdGVyZWQgb25seSBmb3IgdGhlIGRpc3Bvc2FibGUgb3JpZ2luYWwtbWFpbiBoZWFsdGggbW9kZS5cbi8vIEl0IHJ1bnMgYmVmb3JlIHBhZ2UgcGFyc2luZyBhbmQgdHJ1c3RzIG5vIGVudmlyb25tZW50LCBhcmd2LCBvciBVUkwgbm9uY2UuXG5jb25zdCB1bm1vZGlmaWVkVXJsID0gbG9jYXRpb24uaHJlZjtcbmNvbnN0IGNhbm9uaWNhbFVybCA9IGNhbm9uaWNhbE9yaWdpbmFsUmVuZGVyZXJVcmwodW5tb2RpZmllZFVybCk7XG5sZXQgYXV0aG9yaXphdGlvbjogdW5rbm93biA9IG51bGw7XG5pZiAoY2Fub25pY2FsVXJsICE9PSBudWxsKSB7XG4gIHRyeSB7XG4gICAgYXV0aG9yaXphdGlvbiA9IGlwY1JlbmRlcmVyLnNlbmRTeW5jKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9BVVRIX0NIQU5ORUwsIHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICB1cmw6IGNhbm9uaWNhbFVybCxcbiAgICAgIHJlbmRlcmVyU2FuZGJveGVkOiBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCxcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgYXV0aG9yaXphdGlvbiA9IG51bGw7XG4gIH1cbn1cblxuY29uc3QgcGFyc2VkQXV0aG9yaXphdGlvbiA9IGNhbm9uaWNhbFVybCA9PT0gbnVsbFxuICA/IG51bGxcbiAgOiBwYXJzZUV4YWN0QXV0aG9yaXphdGlvbihhdXRob3JpemF0aW9uLCBjYW5vbmljYWxVcmwpO1xuaWYgKHBhcnNlZEF1dGhvcml6YXRpb24pIHtcbiAgb2JzZXJ2ZU9yaWdpbmFsUmVuZGVyZXJNb3VudChwYXJzZWRBdXRob3JpemF0aW9uKTtcbn1cblxuZnVuY3Rpb24gb2JzZXJ2ZU9yaWdpbmFsUmVuZGVyZXJNb3VudChhdXRob3JpemVkOiBBdXRob3JpemF0aW9uKTogdm9pZCB7XG4gIGNvbnN0IG1vdW50ID0gY3JlYXRlUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIoKTtcbiAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihpbnNwZWN0KTtcbiAgY29uc3QgdGltZW91dCA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcbiAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgIHNldHRsZWQgPSB0cnVlO1xuICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9JUENfQ0hBTk5FTCwge1xuICAgICAgbm9uY2U6IGF1dGhvcml6ZWQubm9uY2UsXG4gICAgICB1cmw6IHVubW9kaWZpZWRVcmwsXG4gICAgICBsaWZlY3ljbGU6IFwicmVuZGVyZXItbW91bnQtdGltZW91dFwiLFxuICAgICAgcmVuZGVyZXJTYW5kYm94ZWQ6IGVmZmVjdGl2ZVJlbmRlcmVyU2FuZGJveGVkLFxuICAgIH0pO1xuICB9LCBNT1VOVF9USU1FT1VUX01TKTtcblxuICBmdW5jdGlvbiBpbnNwZWN0KCk6IHZvaWQge1xuICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IG1vdW50Lm9ic2VydmUoe1xuICAgICAgcm9vdFByZXNlbnQ6IHJvb3QgIT09IG51bGwsXG4gICAgICBzdGFydHVwTG9hZGVyUHJlc2VudDogcm9vdCAhPT0gbnVsbCAmJiByb290LnF1ZXJ5U2VsZWN0b3IoXCI6c2NvcGUgPiAuc3RhcnR1cC1sb2FkZXJcIikgIT09IG51bGwsXG4gICAgICBlbGVtZW50Q2hpbGRDb3VudDogcm9vdD8uY2hpbGRyZW4ubGVuZ3RoID8/IDAsXG4gICAgfSk7XG4gICAgaWYgKHN0YXRlICE9PSBcIm1vdW50ZWRcIikgcmV0dXJuO1xuICAgIHNldHRsZWQgPSB0cnVlO1xuICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0lQQ19DSEFOTkVMLCB7XG4gICAgICBub25jZTogYXV0aG9yaXplZC5ub25jZSxcbiAgICAgIHVybDogdW5tb2RpZmllZFVybCxcbiAgICAgIGxpZmVjeWNsZTogXCJyZW5kZXJlci1tb3VudGVkXCIsXG4gICAgICByZW5kZXJlclNhbmRib3hlZDogZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQsXG4gICAgICByZW5kZXJlclN0b3JhZ2VTZWxmVGVzdDogdmVyaWZ5UmVuZGVyZXJTdG9yYWdlUm9sbGJhY2sobG9jYWxTdG9yYWdlLCBhdXRob3JpemVkLm5vbmNlKSxcbiAgICB9KTtcbiAgfVxuXG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICBpbnNwZWN0KCk7XG59XG4iLCAiY29uc3QgU0hBMjU2X0lOSVRJQUwgPSBuZXcgVWludDMyQXJyYXkoW1xuICAweDZhMDllNjY3LCAweGJiNjdhZTg1LCAweDNjNmVmMzcyLCAweGE1NGZmNTNhLFxuICAweDUxMGU1MjdmLCAweDliMDU2ODhjLCAweDFmODNkOWFiLCAweDViZTBjZDE5LFxuXSk7XG5cbmNvbnN0IFNIQTI1Nl9ST1VORCA9IG5ldyBVaW50MzJBcnJheShbXG4gIDB4NDI4YTJmOTgsIDB4NzEzNzQ0OTEsIDB4YjVjMGZiY2YsIDB4ZTliNWRiYTUsXG4gIDB4Mzk1NmMyNWIsIDB4NTlmMTExZjEsIDB4OTIzZjgyYTQsIDB4YWIxYzVlZDUsXG4gIDB4ZDgwN2FhOTgsIDB4MTI4MzViMDEsIDB4MjQzMTg1YmUsIDB4NTUwYzdkYzMsXG4gIDB4NzJiZTVkNzQsIDB4ODBkZWIxZmUsIDB4OWJkYzA2YTcsIDB4YzE5YmYxNzQsXG4gIDB4ZTQ5YjY5YzEsIDB4ZWZiZTQ3ODYsIDB4MGZjMTlkYzYsIDB4MjQwY2ExY2MsXG4gIDB4MmRlOTJjNmYsIDB4NGE3NDg0YWEsIDB4NWNiMGE5ZGMsIDB4NzZmOTg4ZGEsXG4gIDB4OTgzZTUxNTIsIDB4YTgzMWM2NmQsIDB4YjAwMzI3YzgsIDB4YmY1OTdmYzcsXG4gIDB4YzZlMDBiZjMsIDB4ZDVhNzkxNDcsIDB4MDZjYTYzNTEsIDB4MTQyOTI5NjcsXG4gIDB4MjdiNzBhODUsIDB4MmUxYjIxMzgsIDB4NGQyYzZkZmMsIDB4NTMzODBkMTMsXG4gIDB4NjUwYTczNTQsIDB4NzY2YTBhYmIsIDB4ODFjMmM5MmUsIDB4OTI3MjJjODUsXG4gIDB4YTJiZmU4YTEsIDB4YTgxYTY2NGIsIDB4YzI0YjhiNzAsIDB4Yzc2YzUxYTMsXG4gIDB4ZDE5MmU4MTksIDB4ZDY5OTA2MjQsIDB4ZjQwZTM1ODUsIDB4MTA2YWEwNzAsXG4gIDB4MTlhNGMxMTYsIDB4MWUzNzZjMDgsIDB4Mjc0ODc3NGMsIDB4MzRiMGJjYjUsXG4gIDB4MzkxYzBjYjMsIDB4NGVkOGFhNGEsIDB4NWI5Y2NhNGYsIDB4NjgyZTZmZjMsXG4gIDB4NzQ4ZjgyZWUsIDB4NzhhNTYzNmYsIDB4ODRjODc4MTQsIDB4OGNjNzAyMDgsXG4gIDB4OTBiZWZmZmEsIDB4YTQ1MDZjZWIsIDB4YmVmOWEzZjcsIDB4YzY3MTc4ZjIsXG5dKTtcblxuZnVuY3Rpb24gcm90YXRlUmlnaHQodmFsdWU6IG51bWJlciwgYW1vdW50OiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gKHZhbHVlID4+PiBhbW91bnQpIHwgKHZhbHVlIDw8ICgzMiAtIGFtb3VudCkpO1xufVxuXG4vKiogU3luY2hyb25vdXMgU0hBLTI1NiBmb3IgdGhlIHNhbmRib3hlZCByZW5kZXJlciwgd2hpY2ggY2Fubm90IGltcG9ydCBOb2RlIGJ1aWx0LWlucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGEyNTZIZXhVdGY4KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBpbnB1dCA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh2YWx1ZSk7XG4gIGNvbnN0IHBhZGRlZExlbmd0aCA9IE1hdGguY2VpbCgoaW5wdXQubGVuZ3RoICsgOSkgLyA2NCkgKiA2NDtcbiAgY29uc3QgcGFkZGVkID0gbmV3IFVpbnQ4QXJyYXkocGFkZGVkTGVuZ3RoKTtcbiAgcGFkZGVkLnNldChpbnB1dCk7XG4gIHBhZGRlZFtpbnB1dC5sZW5ndGhdID0gMHg4MDtcblxuICBjb25zdCBiaXRMZW5ndGggPSBCaWdJbnQoaW5wdXQubGVuZ3RoKSAqIDhuO1xuICBjb25zdCB2aWV3ID0gbmV3IERhdGFWaWV3KHBhZGRlZC5idWZmZXIpO1xuICB2aWV3LnNldFVpbnQzMihwYWRkZWRMZW5ndGggLSA4LCBOdW1iZXIoKGJpdExlbmd0aCA+PiAzMm4pICYgMHhmZmZmZmZmZm4pLCBmYWxzZSk7XG4gIHZpZXcuc2V0VWludDMyKHBhZGRlZExlbmd0aCAtIDQsIE51bWJlcihiaXRMZW5ndGggJiAweGZmZmZmZmZmbiksIGZhbHNlKTtcblxuICBjb25zdCBzdGF0ZSA9IG5ldyBVaW50MzJBcnJheShTSEEyNTZfSU5JVElBTCk7XG4gIGNvbnN0IHdvcmRzID0gbmV3IFVpbnQzMkFycmF5KDY0KTtcbiAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgcGFkZGVkTGVuZ3RoOyBvZmZzZXQgKz0gNjQpIHtcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMTY7IGluZGV4ICs9IDEpIHtcbiAgICAgIHdvcmRzW2luZGV4XSA9IHZpZXcuZ2V0VWludDMyKG9mZnNldCArIGluZGV4ICogNCwgZmFsc2UpO1xuICAgIH1cbiAgICBmb3IgKGxldCBpbmRleCA9IDE2OyBpbmRleCA8IHdvcmRzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgY29uc3QgcHJpb3IxNSA9IHdvcmRzW2luZGV4IC0gMTVdITtcbiAgICAgIGNvbnN0IHByaW9yMiA9IHdvcmRzW2luZGV4IC0gMl0hO1xuICAgICAgY29uc3Qgc21hbGwwID0gcm90YXRlUmlnaHQocHJpb3IxNSwgNykgXiByb3RhdGVSaWdodChwcmlvcjE1LCAxOCkgXiAocHJpb3IxNSA+Pj4gMyk7XG4gICAgICBjb25zdCBzbWFsbDEgPSByb3RhdGVSaWdodChwcmlvcjIsIDE3KSBeIHJvdGF0ZVJpZ2h0KHByaW9yMiwgMTkpIF4gKHByaW9yMiA+Pj4gMTApO1xuICAgICAgd29yZHNbaW5kZXhdID0gKHdvcmRzW2luZGV4IC0gMTZdISArIHNtYWxsMCArIHdvcmRzW2luZGV4IC0gN10hICsgc21hbGwxKSA+Pj4gMDtcbiAgICB9XG5cbiAgICBsZXQgW2EsIGIsIGMsIGQsIGUsIGYsIGcsIGhdID0gc3RhdGU7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHdvcmRzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgY29uc3QgbGFyZ2UxID0gcm90YXRlUmlnaHQoZSEsIDYpIF4gcm90YXRlUmlnaHQoZSEsIDExKSBeIHJvdGF0ZVJpZ2h0KGUhLCAyNSk7XG4gICAgICBjb25zdCBjaG9vc2UgPSAoZSEgJiBmISkgXiAofmUhICYgZyEpO1xuICAgICAgY29uc3QgdGVtcG9yYXJ5MSA9IChoISArIGxhcmdlMSArIGNob29zZSArIFNIQTI1Nl9ST1VORFtpbmRleF0hICsgd29yZHNbaW5kZXhdISkgPj4+IDA7XG4gICAgICBjb25zdCBsYXJnZTAgPSByb3RhdGVSaWdodChhISwgMikgXiByb3RhdGVSaWdodChhISwgMTMpIF4gcm90YXRlUmlnaHQoYSEsIDIyKTtcbiAgICAgIGNvbnN0IG1ham9yaXR5ID0gKGEhICYgYiEpIF4gKGEhICYgYyEpIF4gKGIhICYgYyEpO1xuICAgICAgY29uc3QgdGVtcG9yYXJ5MiA9IChsYXJnZTAgKyBtYWpvcml0eSkgPj4+IDA7XG5cbiAgICAgIGggPSBnO1xuICAgICAgZyA9IGY7XG4gICAgICBmID0gZTtcbiAgICAgIGUgPSAoZCEgKyB0ZW1wb3JhcnkxKSA+Pj4gMDtcbiAgICAgIGQgPSBjO1xuICAgICAgYyA9IGI7XG4gICAgICBiID0gYTtcbiAgICAgIGEgPSAodGVtcG9yYXJ5MSArIHRlbXBvcmFyeTIpID4+PiAwO1xuICAgIH1cblxuICAgIHN0YXRlWzBdID0gKHN0YXRlWzBdISArIGEhKSA+Pj4gMDtcbiAgICBzdGF0ZVsxXSA9IChzdGF0ZVsxXSEgKyBiISkgPj4+IDA7XG4gICAgc3RhdGVbMl0gPSAoc3RhdGVbMl0hICsgYyEpID4+PiAwO1xuICAgIHN0YXRlWzNdID0gKHN0YXRlWzNdISArIGQhKSA+Pj4gMDtcbiAgICBzdGF0ZVs0XSA9IChzdGF0ZVs0XSEgKyBlISkgPj4+IDA7XG4gICAgc3RhdGVbNV0gPSAoc3RhdGVbNV0hICsgZiEpID4+PiAwO1xuICAgIHN0YXRlWzZdID0gKHN0YXRlWzZdISArIGchKSA+Pj4gMDtcbiAgICBzdGF0ZVs3XSA9IChzdGF0ZVs3XSEgKyBoISkgPj4+IDA7XG4gIH1cblxuICByZXR1cm4gWy4uLnN0YXRlXS5tYXAoKHdvcmQpID0+IHdvcmQudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDgsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cblxuLyoqIEdlbmVyYXRlcyBhIFVVSUQgd2l0aG91dCByZWx5aW5nIG9uIHNhbmRib3gtdW5hdmFpbGFibGUgTm9kZSBjcnlwdG8uICovXG5leHBvcnQgZnVuY3Rpb24gc2VjdXJlUmVuZGVyZXJVdWlkKCk6IHN0cmluZyB7XG4gIGNvbnN0IHByb3ZpZGVyID0gZ2xvYmFsVGhpcy5jcnlwdG87XG4gIGlmICh0eXBlb2YgcHJvdmlkZXI/LnJhbmRvbVVVSUQgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHByb3ZpZGVyLnJhbmRvbVVVSUQoKTtcbiAgaWYgKHR5cGVvZiBwcm92aWRlcj8uZ2V0UmFuZG9tVmFsdWVzICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzZWN1cmUgcmVuZGVyZXIgcmFuZG9tbmVzcyBpcyB1bmF2YWlsYWJsZVwiKTtcbiAgfVxuICBjb25zdCBieXRlcyA9IHByb3ZpZGVyLmdldFJhbmRvbVZhbHVlcyhuZXcgVWludDhBcnJheSgxNikpO1xuICBieXRlc1s2XSA9IChieXRlc1s2XSEgJiAweDBmKSB8IDB4NDA7XG4gIGJ5dGVzWzhdID0gKGJ5dGVzWzhdISAmIDB4M2YpIHwgMHg4MDtcbiAgY29uc3QgaGV4ID0gWy4uLmJ5dGVzXS5tYXAoKGJ5dGUpID0+IGJ5dGUudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSk7XG4gIHJldHVybiBgJHtoZXguc2xpY2UoMCwgNCkuam9pbihcIlwiKX0tJHtoZXguc2xpY2UoNCwgNikuam9pbihcIlwiKX0tJHtoZXguc2xpY2UoNiwgOCkuam9pbihcIlwiKX0tJHtoZXguc2xpY2UoOCwgMTApLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDEwKS5qb2luKFwiXCIpfWA7XG59XG4iLCAiaW1wb3J0IHsgc2VjdXJlUmVuZGVyZXJVdWlkLCBzaGEyNTZIZXhVdGY4IH0gZnJvbSBcIi4vcmVuZGVyZXItY3J5cHRvXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZUxpa2Uge1xuICByZWFkb25seSBsZW5ndGg6IG51bWJlcjtcbiAgZ2V0SXRlbShrZXk6IHN0cmluZyk6IHN0cmluZyB8IG51bGw7XG4gIGtleShpbmRleDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbDtcbiAgc2V0SXRlbShrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQ7XG4gIHJlbW92ZUl0ZW0oa2V5OiBzdHJpbmcpOiB2b2lkO1xufVxuXG5jb25zdCBDVVJSRU5UX0lEX1BSRUZJWCA9IFwiY28udHdlYWtlcnMuXCI7XG5jb25zdCBMRUdBQ1lfU1RPUkFHRV9QUkVGSVggPSBgJHtbXCJjb2RleFwiLCBcInBwXCJdLmpvaW4oXCJcIil9OnN0b3JhZ2U6YDtcbmNvbnN0IENVUlJFTlRfU1RPUkFHRV9QUkVGSVggPSBcInR3ZWFrZXI6c3RvcmFnZTpcIjtcbmNvbnN0IEFSQ0hJVkVfU1RPUkFHRV9QUkVGSVggPSBcInR3ZWFrZXI6c3RvcmFnZS1hcmNoaXZlOlwiO1xuXG5leHBvcnQgdHlwZSBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25TdGF0dXMgPVxuICB8IFwibm90X2FwcGxpY2FibGVcIlxuICB8IFwiYWJzZW50XCJcbiAgfCBcImNhbm9uaWNhbFwiXG4gIHwgXCJwcmVwYXJlZFwiXG4gIHwgXCJhbWJpZ3VvdXNcIlxuICB8IFwiY29uZmxpY3RcIlxuICB8IFwiaW52YWxpZF9jYW5vbmljYWxcIlxuICB8IFwiaW52YWxpZF9sZWdhY3lcIlxuICB8IFwid3JpdGVfZmFpbGVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZztcbiAgY3VycmVudEtleTogc3RyaW5nO1xuICBsZWdhY3lLZXlzOiBzdHJpbmdbXTtcbiAgc2VsZWN0ZWRMZWdhY3lLZXk6IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uU3RhdHVzO1xuICBob2xkUHJvbW90aW9uOiBib29sZWFuO1xuICBjcmVhdGVkQ2Fub25pY2FsOiBib29sZWFuO1xuICBjYW5vbmljYWxCZWZvcmVIYXNoOiBzdHJpbmc7XG4gIGNhbm9uaWNhbEFmdGVySGFzaDogc3RyaW5nO1xuICBzZWxlY3RlZExlZ2FjeUhhc2g6IHN0cmluZztcbiAgYXJjaGl2ZUtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGhhc2U6IFwicGxhbm5lZFwiIHwgXCJwcmVwYXJlZFwiIHwgXCJjb21taXR0ZWRcIiB8IFwicm9sbGVkX2JhY2tcIjtcbn1cblxuaW50ZXJmYWNlIFN0b3JhZ2VNaWdyYXRpb25QbGFuIHtcbiAgcmVjZWlwdDogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdDtcbiAgY2Fub25pY2FsUmF3OiBzdHJpbmcgfCBudWxsO1xuICBzZWxlY3RlZExlZ2FjeVJhdzogc3RyaW5nIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gcGFyc2VSZWNvcmQocmF3OiBzdHJpbmcgfCBudWxsKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgcmV0dXJuIHBhcnNlZCAhPT0gbnVsbCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZClcbiAgICAgID8gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbmdlcnByaW50KHJhdzogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIHJldHVybiByYXcgPT09IG51bGwgPyBcIm1pc3NpbmdcIiA6IHNoYTI1NkhleFV0ZjgocmF3KTtcbn1cblxuZnVuY3Rpb24gZGlzY292ZXJMZWdhY3lQdWJsaXNoZXJLZXlzKGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlKTogc3RyaW5nW10ge1xuICBpZiAoIWlkLnN0YXJ0c1dpdGgoQ1VSUkVOVF9JRF9QUkVGSVgpKSByZXR1cm4gW107XG4gIGNvbnN0IHN1ZmZpeCA9IGlkLnNsaWNlKENVUlJFTlRfSURfUFJFRklYLmxlbmd0aCk7XG4gIGlmICghc3VmZml4KSByZXR1cm4gW107XG5cbiAgY29uc3Qgc3VmZml4TWFya2VyID0gYC4ke3N1ZmZpeH1gO1xuICBjb25zdCBjYW5kaWRhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBzdG9yYWdlLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IGtleSA9IHN0b3JhZ2Uua2V5KGluZGV4KTtcbiAgICBpZiAoIWtleT8uc3RhcnRzV2l0aChMRUdBQ1lfU1RPUkFHRV9QUkVGSVgpKSBjb250aW51ZTtcbiAgICBjb25zdCBsZWdhY3lJZCA9IGtleS5zbGljZShMRUdBQ1lfU1RPUkFHRV9QUkVGSVgubGVuZ3RoKTtcbiAgICBpZiAoXG4gICAgICBsZWdhY3lJZCAhPT0gaWRcbiAgICAgICYmIGxlZ2FjeUlkLnN0YXJ0c1dpdGgoXCJjby5cIilcbiAgICAgICYmIGxlZ2FjeUlkLmVuZHNXaXRoKHN1ZmZpeE1hcmtlcilcbiAgICAgICYmIGxlZ2FjeUlkLnNsaWNlKDMsIC1zdWZmaXhNYXJrZXIubGVuZ3RoKS5sZW5ndGggPiAwXG4gICAgKSB7XG4gICAgICBjYW5kaWRhdGVzLmFkZChrZXkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLmNhbmRpZGF0ZXNdLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gbGVnYWN5S2V5c0ZvcihpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZXhhY3RMZWdhY3lLZXkgPSBgJHtMRUdBQ1lfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCBrZXlzID0gbmV3IFNldChkaXNjb3ZlckxlZ2FjeVB1Ymxpc2hlcktleXMoaWQsIHN0b3JhZ2UpKTtcbiAgaWYgKHN0b3JhZ2UuZ2V0SXRlbShleGFjdExlZ2FjeUtleSkgIT09IG51bGwpIGtleXMuYWRkKGV4YWN0TGVnYWN5S2V5KTtcbiAgcmV0dXJuIFsuLi5rZXlzXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIHBsYW5NaWdyYXRpb24oXG4gIGlkOiBzdHJpbmcsXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuICB0cmFuc2FjdGlvbklkOiBzdHJpbmcgPSBzZWN1cmVSZW5kZXJlclV1aWQoKSxcbik6IFN0b3JhZ2VNaWdyYXRpb25QbGFuIHtcbiAgY29uc3QgY3VycmVudEtleSA9IGAke0NVUlJFTlRfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCBjYW5vbmljYWxSYXcgPSBzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSk7XG4gIGNvbnN0IGxlZ2FjeUtleXMgPSBsZWdhY3lLZXlzRm9yKGlkLCBzdG9yYWdlKTtcbiAgY29uc3Qgc2VsZWN0ZWRMZWdhY3lLZXkgPSBsZWdhY3lLZXlzLmxlbmd0aCA9PT0gMSA/IGxlZ2FjeUtleXNbMF0hIDogbnVsbDtcbiAgY29uc3Qgc2VsZWN0ZWRMZWdhY3lSYXcgPSBzZWxlY3RlZExlZ2FjeUtleSA9PT0gbnVsbCA/IG51bGwgOiBzdG9yYWdlLmdldEl0ZW0oc2VsZWN0ZWRMZWdhY3lLZXkpO1xuICBjb25zdCBiYXNlID0ge1xuICAgIHNjaGVtYVZlcnNpb246IDEgYXMgY29uc3QsXG4gICAgdHJhbnNhY3Rpb25JZCxcbiAgICBjdXJyZW50S2V5LFxuICAgIGxlZ2FjeUtleXMsXG4gICAgc2VsZWN0ZWRMZWdhY3lLZXksXG4gICAgY3JlYXRlZENhbm9uaWNhbDogZmFsc2UsXG4gICAgY2Fub25pY2FsQmVmb3JlSGFzaDogZmluZ2VycHJpbnQoY2Fub25pY2FsUmF3KSxcbiAgICBjYW5vbmljYWxBZnRlckhhc2g6IGZpbmdlcnByaW50KGNhbm9uaWNhbFJhdyksXG4gICAgc2VsZWN0ZWRMZWdhY3lIYXNoOiBmaW5nZXJwcmludChzZWxlY3RlZExlZ2FjeVJhdyksXG4gICAgYXJjaGl2ZUtleTogbnVsbCxcbiAgICBwaGFzZTogXCJwbGFubmVkXCIgYXMgY29uc3QsXG4gIH07XG5cbiAgaWYgKCFpZC5zdGFydHNXaXRoKENVUlJFTlRfSURfUFJFRklYKSkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcIm5vdF9hcHBsaWNhYmxlXCIsIGhvbGRQcm9tb3Rpb246IGZhbHNlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAobGVnYWN5S2V5cy5sZW5ndGggPiAxKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiYW1iaWd1b3VzXCIsIGhvbGRQcm9tb3Rpb246IHRydWUgfSwgY2Fub25pY2FsUmF3LCBzZWxlY3RlZExlZ2FjeVJhdyB9O1xuICB9XG4gIGlmIChjYW5vbmljYWxSYXcgIT09IG51bGwgJiYgcGFyc2VSZWNvcmQoY2Fub25pY2FsUmF3KSA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcImludmFsaWRfY2Fub25pY2FsXCIsIGhvbGRQcm9tb3Rpb246IHRydWUgfSwgY2Fub25pY2FsUmF3LCBzZWxlY3RlZExlZ2FjeVJhdyB9O1xuICB9XG4gIGlmIChzZWxlY3RlZExlZ2FjeVJhdyAhPT0gbnVsbCAmJiBwYXJzZVJlY29yZChzZWxlY3RlZExlZ2FjeVJhdykgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJpbnZhbGlkX2xlZ2FjeVwiLCBob2xkUHJvbW90aW9uOiB0cnVlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAoY2Fub25pY2FsUmF3ICE9PSBudWxsKSB7XG4gICAgY29uc3QgbWlzbWF0Y2ggPSBzZWxlY3RlZExlZ2FjeVJhdyAhPT0gbnVsbCAmJiBzZWxlY3RlZExlZ2FjeVJhdyAhPT0gY2Fub25pY2FsUmF3O1xuICAgIHJldHVybiB7XG4gICAgICByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogbWlzbWF0Y2ggPyBcImNvbmZsaWN0XCIgOiBcImNhbm9uaWNhbFwiLCBob2xkUHJvbW90aW9uOiBtaXNtYXRjaCB9LFxuICAgICAgY2Fub25pY2FsUmF3LFxuICAgICAgc2VsZWN0ZWRMZWdhY3lSYXcsXG4gICAgfTtcbiAgfVxuICBpZiAoc2VsZWN0ZWRMZWdhY3lSYXcgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJhYnNlbnRcIiwgaG9sZFByb21vdGlvbjogZmFsc2UgfSwgY2Fub25pY2FsUmF3LCBzZWxlY3RlZExlZ2FjeVJhdyB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgcmVjZWlwdDoge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIHN0YXR1czogXCJwcmVwYXJlZFwiLFxuICAgICAgaG9sZFByb21vdGlvbjogZmFsc2UsXG4gICAgICBjcmVhdGVkQ2Fub25pY2FsOiB0cnVlLFxuICAgICAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBmaW5nZXJwcmludChzZWxlY3RlZExlZ2FjeVJhdyksXG4gICAgfSxcbiAgICBjYW5vbmljYWxSYXcsXG4gICAgc2VsZWN0ZWRMZWdhY3lSYXcsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwbGFuUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICBpZDogc3RyaW5nLFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgdHJhbnNhY3Rpb25JZD86IHN0cmluZyxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICByZXR1cm4gcGxhbk1pZ3JhdGlvbihpZCwgc3RvcmFnZSwgdHJhbnNhY3Rpb25JZCkucmVjZWlwdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oXG4gIGlkOiBzdHJpbmcsXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuICB0cmFuc2FjdGlvbklkPzogc3RyaW5nLFxuKTogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCB7XG4gIGNvbnN0IHBsYW4gPSBwbGFuTWlncmF0aW9uKGlkLCBzdG9yYWdlLCB0cmFuc2FjdGlvbklkKTtcbiAgaWYgKCFwbGFuLnJlY2VpcHQuY3JlYXRlZENhbm9uaWNhbCB8fCBwbGFuLnNlbGVjdGVkTGVnYWN5UmF3ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgLi4ucGxhbi5yZWNlaXB0LCBwaGFzZTogXCJwcmVwYXJlZFwiIH07XG4gIH1cbiAgdHJ5IHtcbiAgICBpZiAoc3RvcmFnZS5nZXRJdGVtKHBsYW4ucmVjZWlwdC5jdXJyZW50S2V5KSAhPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHsgLi4ucGxhbi5yZWNlaXB0LCBzdGF0dXM6IFwiY29uZmxpY3RcIiwgaG9sZFByb21vdGlvbjogdHJ1ZSwgY3JlYXRlZENhbm9uaWNhbDogZmFsc2UsIHBoYXNlOiBcInByZXBhcmVkXCIgfTtcbiAgICB9XG4gICAgc3RvcmFnZS5zZXRJdGVtKHBsYW4ucmVjZWlwdC5jdXJyZW50S2V5LCBwbGFuLnNlbGVjdGVkTGVnYWN5UmF3KTtcbiAgICBpZiAoZmluZ2VycHJpbnQoc3RvcmFnZS5nZXRJdGVtKHBsYW4ucmVjZWlwdC5jdXJyZW50S2V5KSkgIT09IHBsYW4ucmVjZWlwdC5jYW5vbmljYWxBZnRlckhhc2gpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgLi4ucGxhbi5yZWNlaXB0LCBwaGFzZTogXCJwcmVwYXJlZFwiIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7XG4gICAgICAuLi5wbGFuLnJlY2VpcHQsXG4gICAgICBzdGF0dXM6IFwid3JpdGVfZmFpbGVkXCIsXG4gICAgICBob2xkUHJvbW90aW9uOiB0cnVlLFxuICAgICAgY3JlYXRlZENhbm9uaWNhbDogZmFsc2UsXG4gICAgICBjYW5vbmljYWxBZnRlckhhc2g6IGZpbmdlcnByaW50KHN0b3JhZ2UuZ2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSkpLFxuICAgICAgcGhhc2U6IFwicHJlcGFyZWRcIixcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21taXRSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oXG4gIHJlY2VpcHQ6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQsXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuKTogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCB7XG4gIGlmIChyZWNlaXB0LnBoYXNlID09PSBcImNvbW1pdHRlZFwiKSByZXR1cm4gcmVjZWlwdDtcbiAgaWYgKHJlY2VpcHQuaG9sZFByb21vdGlvbikgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBtaWdyYXRpb24gaXMgb24gaG9sZFwiKTtcbiAgaWYgKGZpbmdlcnByaW50KHN0b3JhZ2UuZ2V0SXRlbShyZWNlaXB0LmN1cnJlbnRLZXkpKSAhPT0gcmVjZWlwdC5jYW5vbmljYWxBZnRlckhhc2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGNhbm9uaWNhbCB2YWx1ZSBjaGFuZ2VkIGJlZm9yZSBjb21taXRcIik7XG4gIH1cbiAgaWYgKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkgPT09IG51bGwpIHJldHVybiB7IC4uLnJlY2VpcHQsIHBoYXNlOiBcImNvbW1pdHRlZFwiIH07XG4gIGNvbnN0IGxlZ2FjeVJhdyA9IHN0b3JhZ2UuZ2V0SXRlbShyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgaWYgKGZpbmdlcnByaW50KGxlZ2FjeVJhdykgIT09IHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lIYXNoIHx8IGxlZ2FjeVJhdyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgbGVnYWN5IHZhbHVlIGNoYW5nZWQgYmVmb3JlIGNvbW1pdFwiKTtcbiAgfVxuICBjb25zdCBhcmNoaXZlS2V5ID0gYCR7QVJDSElWRV9TVE9SQUdFX1BSRUZJWH0ke3JlY2VpcHQudHJhbnNhY3Rpb25JZH06JHtlbmNvZGVVUklDb21wb25lbnQocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSl9YDtcbiAgY29uc3QgYXJjaGl2ZWQgPSBzdG9yYWdlLmdldEl0ZW0oYXJjaGl2ZUtleSk7XG4gIGlmIChhcmNoaXZlZCAhPT0gbnVsbCAmJiBhcmNoaXZlZCAhPT0gbGVnYWN5UmF3KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBhcmNoaXZlIGNvbGxpc2lvblwiKTtcbiAgfVxuICBzdG9yYWdlLnNldEl0ZW0oYXJjaGl2ZUtleSwgbGVnYWN5UmF3KTtcbiAgaWYgKHN0b3JhZ2UuZ2V0SXRlbShhcmNoaXZlS2V5KSAhPT0gbGVnYWN5UmF3KSB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGFyY2hpdmUgdmVyaWZpY2F0aW9uIGZhaWxlZFwiKTtcbiAgc3RvcmFnZS5yZW1vdmVJdGVtKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpO1xuICByZXR1cm4geyAuLi5yZWNlaXB0LCBhcmNoaXZlS2V5LCBwaGFzZTogXCJjb21taXR0ZWRcIiB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcm9sbGJhY2tSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oXG4gIHJlY2VpcHQ6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQsXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuKTogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCB7XG4gIGlmIChyZWNlaXB0LnBoYXNlID09PSBcInJvbGxlZF9iYWNrXCIpIHJldHVybiByZWNlaXB0O1xuICBpZiAocmVjZWlwdC5hcmNoaXZlS2V5ICE9PSBudWxsICYmIHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkgIT09IG51bGwpIHtcbiAgICBjb25zdCBhcmNoaXZlZCA9IHN0b3JhZ2UuZ2V0SXRlbShyZWNlaXB0LmFyY2hpdmVLZXkpO1xuICAgIGlmIChmaW5nZXJwcmludChhcmNoaXZlZCkgIT09IHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lIYXNoIHx8IGFyY2hpdmVkID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGFyY2hpdmUgY2hhbmdlZCBiZWZvcmUgcm9sbGJhY2tcIik7XG4gICAgfVxuICAgIGNvbnN0IGN1cnJlbnRMZWdhY3kgPSBzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSk7XG4gICAgaWYgKGN1cnJlbnRMZWdhY3kgIT09IG51bGwgJiYgZmluZ2VycHJpbnQoY3VycmVudExlZ2FjeSkgIT09IHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lIYXNoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGxlZ2FjeSB2YWx1ZSBjaGFuZ2VkIGJlZm9yZSByb2xsYmFja1wiKTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnRMZWdhY3kgPT09IG51bGwpIHN0b3JhZ2Uuc2V0SXRlbShyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5LCBhcmNoaXZlZCk7XG4gICAgc3RvcmFnZS5yZW1vdmVJdGVtKHJlY2VpcHQuYXJjaGl2ZUtleSk7XG4gIH1cbiAgaWYgKHJlY2VpcHQuY3JlYXRlZENhbm9uaWNhbCkge1xuICAgIGlmIChmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5jdXJyZW50S2V5KSkgIT09IHJlY2VpcHQuY2Fub25pY2FsQWZ0ZXJIYXNoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGNhbm9uaWNhbCB2YWx1ZSBjaGFuZ2VkIGJlZm9yZSByb2xsYmFja1wiKTtcbiAgICB9XG4gICAgc3RvcmFnZS5yZW1vdmVJdGVtKHJlY2VpcHQuY3VycmVudEtleSk7XG4gIH1cbiAgcmV0dXJuIHsgLi4ucmVjZWlwdCwgcGhhc2U6IFwicm9sbGVkX2JhY2tcIiB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlKSB7XG4gIGxldCBtaWdyYXRpb24gPSBwcmVwYXJlUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKGlkLCBzdG9yYWdlKTtcbiAgY29uc3Qga2V5ID0gYCR7Q1VSUkVOVF9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4gcGFyc2VSZWNvcmQoc3RvcmFnZS5nZXRJdGVtKGtleSkpID8/IHt9O1xuICBjb25zdCB3cml0ZSA9ICh2YWx1ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gIHJldHVybiB7XG4gICAgZ2V0IG1pZ3JhdGlvbigpIHsgcmV0dXJuIG1pZ3JhdGlvbjsgfSxcbiAgICBjb21taXRNaWdyYXRpb246ICgpID0+IHtcbiAgICAgIG1pZ3JhdGlvbiA9IGNvbW1pdFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihtaWdyYXRpb24sIHN0b3JhZ2UpO1xuICAgICAgcmV0dXJuIG1pZ3JhdGlvbjtcbiAgICB9LFxuICAgIHJvbGxiYWNrTWlncmF0aW9uOiAoKSA9PiB7XG4gICAgICBtaWdyYXRpb24gPSByb2xsYmFja1JlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihtaWdyYXRpb24sIHN0b3JhZ2UpO1xuICAgICAgcmV0dXJuIG1pZ3JhdGlvbjtcbiAgICB9LFxuICAgIGdldDogPFQ+KG5hbWU6IHN0cmluZywgZmFsbGJhY2s/OiBUKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgcmV0dXJuIG5hbWUgaW4gY3VycmVudCA/IChjdXJyZW50W25hbWVdIGFzIFQpIDogKGZhbGxiYWNrIGFzIFQpO1xuICAgIH0sXG4gICAgc2V0OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGN1cnJlbnRbbmFtZV0gPSB2YWx1ZTtcbiAgICAgIHdyaXRlKGN1cnJlbnQpO1xuICAgIH0sXG4gICAgZGVsZXRlOiAobmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgZGVsZXRlIGN1cnJlbnRbbmFtZV07XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGFsbDogKCkgPT4gcmVhZCgpLFxuICB9O1xufVxuXG4vKipcbiAqIEV4ZXJjaXNlIHRoZSBleGFjdCBwcmVwYXJlL2NvbW1pdC9yb2xsYmFjayBwYXRoIHVzZWQgYnkgYSBwcm9tb3Rpb24gcHJvYmUuXG4gKiBFdmVyeSBzeW50aGV0aWMga2V5IGlzIHJlbW92ZWQgYW5kIHZlcmlmaWVkIGJlZm9yZSBzdWNjZXNzIGlzIHJldHVybmVkO1xuICogY2xlYW51cCBmYWlsdXJlIGlzIGEgZmFpbGVkIGhlYWx0aCByZXN1bHQsIG5ldmVyIGEgc2lsZW50IHJlc2lkdWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZnlSZW5kZXJlclN0b3JhZ2VSb2xsYmFjayhcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4gIG5vbmNlOiBzdHJpbmcsXG4pOiBcInBhc3NcIiB8IFwiZmFpbFwiIHtcbiAgY29uc3Qgc3VmZml4ID0gYHByb21vdGlvbi1oZWFsdGgtb3JpZ2luYWwtJHtub25jZX1gO1xuICBjb25zdCBjdXJyZW50SWQgPSBgY28udHdlYWtlcnMuJHtzdWZmaXh9YDtcbiAgY29uc3QgY3VycmVudEtleSA9IGAke0NVUlJFTlRfU1RPUkFHRV9QUkVGSVh9JHtjdXJyZW50SWR9YDtcbiAgY29uc3QgbGVnYWN5S2V5ID0gYCR7TEVHQUNZX1NUT1JBR0VfUFJFRklYfWNvLnByb21vdGlvbi1wcm9iZS4ke3N1ZmZpeH1gO1xuICBjb25zdCBleHBlY3RlZEFyY2hpdmVLZXkgPSBgJHtBUkNISVZFX1NUT1JBR0VfUFJFRklYfSR7bm9uY2V9OiR7ZW5jb2RlVVJJQ29tcG9uZW50KGxlZ2FjeUtleSl9YDtcbiAgY29uc3QgcmF3ID0gSlNPTi5zdHJpbmdpZnkoeyByZXRhaW5lZDogdHJ1ZSwgbm9uY2UgfSk7XG4gIGxldCBvd25zUHJvYmVLZXlzID0gZmFsc2U7XG4gIGxldCByZXN1bHQ6IFwicGFzc1wiIHwgXCJmYWlsXCIgPSBcImZhaWxcIjtcbiAgbGV0IGNsZWFudXBTdWNjZWVkZWQgPSB0cnVlO1xuXG4gIHRyeSB7XG4gICAgaWYgKHN0b3JhZ2UuZ2V0SXRlbShjdXJyZW50S2V5KSAhPT0gbnVsbCB8fCBzdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSAhPT0gbnVsbCkge1xuICAgICAgcmVzdWx0ID0gXCJmYWlsXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIG93bnNQcm9iZUtleXMgPSB0cnVlO1xuICAgICAgc3RvcmFnZS5zZXRJdGVtKGxlZ2FjeUtleSwgcmF3KTtcbiAgICAgIGNvbnN0IHByZXBhcmVkID0gcHJlcGFyZVJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihjdXJyZW50SWQsIHN0b3JhZ2UsIG5vbmNlKTtcbiAgICAgIGlmIChwcmVwYXJlZC5zdGF0dXMgIT09IFwicHJlcGFyZWRcIiB8fCBwcmVwYXJlZC5ob2xkUHJvbW90aW9uIHx8IHN0b3JhZ2UuZ2V0SXRlbShjdXJyZW50S2V5KSAhPT0gcmF3KSB7XG4gICAgICAgIHJlc3VsdCA9IFwiZmFpbFwiO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgY29tbWl0dGVkID0gY29tbWl0UmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKHByZXBhcmVkLCBzdG9yYWdlKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGNvbW1pdHRlZC5waGFzZSAhPT0gXCJjb21taXR0ZWRcIlxuICAgICAgICAgIHx8IGNvbW1pdHRlZC5hcmNoaXZlS2V5ICE9PSBleHBlY3RlZEFyY2hpdmVLZXlcbiAgICAgICAgICB8fCBzdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSAhPT0gbnVsbFxuICAgICAgICApIHtcbiAgICAgICAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCByb2xsZWRCYWNrID0gcm9sbGJhY2tSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oY29tbWl0dGVkLCBzdG9yYWdlKTtcbiAgICAgICAgICByZXN1bHQgPSByb2xsZWRCYWNrLnBoYXNlID09PSBcInJvbGxlZF9iYWNrXCJcbiAgICAgICAgICAgICYmIHN0b3JhZ2UuZ2V0SXRlbShsZWdhY3lLZXkpID09PSByYXdcbiAgICAgICAgICAgICYmIHN0b3JhZ2UuZ2V0SXRlbShjdXJyZW50S2V5KSA9PT0gbnVsbFxuICAgICAgICAgICAgJiYgc3RvcmFnZS5nZXRJdGVtKGV4cGVjdGVkQXJjaGl2ZUtleSkgPT09IG51bGxcbiAgICAgICAgICAgID8gXCJwYXNzXCJcbiAgICAgICAgICAgIDogXCJmYWlsXCI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIHJlc3VsdCA9IFwiZmFpbFwiO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChvd25zUHJvYmVLZXlzKSB7XG4gICAgICBjb25zdCByZW1vdmVBbmRWZXJpZnkgPSAoa2V5OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBzdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTtcbiAgICAgICAgICByZXR1cm4gc3RvcmFnZS5nZXRJdGVtKGtleSkgPT09IG51bGw7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGNsZWFudXBTdWNjZWVkZWQgPSByZW1vdmVBbmRWZXJpZnkoY3VycmVudEtleSkgJiYgY2xlYW51cFN1Y2NlZWRlZDtcbiAgICAgIGNsZWFudXBTdWNjZWVkZWQgPSByZW1vdmVBbmRWZXJpZnkobGVnYWN5S2V5KSAmJiBjbGVhbnVwU3VjY2VlZGVkO1xuICAgICAgY2xlYW51cFN1Y2NlZWRlZCA9IHJlbW92ZUFuZFZlcmlmeShleHBlY3RlZEFyY2hpdmVLZXkpICYmIGNsZWFudXBTdWNjZWVkZWQ7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdCA9PT0gXCJwYXNzXCIgJiYgY2xlYW51cFN1Y2NlZWRlZCA/IFwicGFzc1wiIDogXCJmYWlsXCI7XG59XG4iLCAiZXhwb3J0IHR5cGUgUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlID0gXCJ3YWl0aW5nXCIgfCBcIm1vdW50ZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlclJvb3RPYnNlcnZhdGlvbiB7XG4gIHJvb3RQcmVzZW50OiBib29sZWFuO1xuICBzdGFydHVwTG9hZGVyUHJlc2VudDogYm9vbGVhbjtcbiAgZWxlbWVudENoaWxkQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlck1vdW50VHJhY2tlciB7XG4gIG9ic2VydmUob2JzZXJ2YXRpb246IFByb21vdGlvblJlbmRlcmVyUm9vdE9ic2VydmF0aW9uKTogUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlO1xuICByZXN1bHQoKTogUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlO1xufVxuXG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkgPSBcInR3ZWFrZXJQcm9tb3Rpb25Ob25jZVwiO1xuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1BBVFRFUk4gPSAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LTRbMC05YS1mXXszfS1bODlhYl1bMC05YS1mXXszfS1bMC05YS1mXXsxMn0kL2k7XG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfQVVUSF9SRVNQT05TRV9NQVhfQ0hBUlMgPSAxXzAyNDtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25SZXF1ZXN0IHtcbiAgdmVyc2lvbjogMTtcbiAgdXJsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uUmVzcG9uc2Uge1xuICB2ZXJzaW9uOiAxO1xuICBub25jZTogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCA9XG4gIHwgeyBraW5kOiBcIm9yZGluYXJ5XCIgfVxuICB8IHsga2luZDogXCJpbnZhbGlkLWNhbmRpZGF0ZVwiOyByZWFzb246IHN0cmluZyB9XG4gIHwge1xuICAgIGtpbmQ6IFwiY2FuZGlkYXRlXCI7XG4gICAgbm9uY2U6IHN0cmluZztcbiAgICByZXF1ZXN0OiBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25SZXF1ZXN0O1xuICB9O1xuXG4vKipcbiAqIENsYXNzaWZpZXMgdGhlIGN1cnJlbnQgZG9jdW1lbnQgYmVmb3JlIHBhZ2Ugc2NyaXB0cyBydW4uIE9yZGluYXJ5IHdpbmRvd3NcbiAqIHRha2UgdGhlIG5vcm1hbCBwcmVsb2FkIHBhdGguIEEgVVJMIHRoYXQgY2FycmllcyB0aGUgcmVzZXJ2ZWQgcHJvb2YgcXVlcnkgaXNcbiAqIGZhaWwtY2xvc2VkIHVubGVzcyBpdCBpcyB0aGUgb25lIGV4YWN0IGNhbmRpZGF0ZSBkb2N1bWVudCBzaGFwZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvbkF0dGVtcHQoaHJlZjogc3RyaW5nKTogUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTChocmVmKTtcbiAgICBjb25zdCBxdWVyeUVudHJpZXMgPSBbLi4ucGFyc2VkLnNlYXJjaFBhcmFtcy5lbnRyaWVzKCldO1xuICAgIGNvbnN0IGhhc1Jlc2VydmVkUXVlcnkgPSBxdWVyeUVudHJpZXMuc29tZSgoW2tleV0pID0+IGtleSA9PT0gUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZKTtcbiAgICBpZiAoIWhhc1Jlc2VydmVkUXVlcnkpIHJldHVybiB7IGtpbmQ6IFwib3JkaW5hcnlcIiB9O1xuICAgIGlmIChcbiAgICAgIHBhcnNlZC5wcm90b2NvbCAhPT0gXCJhcHA6XCJcbiAgICAgIHx8IHBhcnNlZC5ob3N0bmFtZSAhPT0gXCItXCJcbiAgICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucG9ydCAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhdGhuYW1lICE9PSBcIi9pbmRleC5odG1sXCJcbiAgICAgIHx8IHBhcnNlZC5oYXNoICE9PSBcIlwiXG4gICAgICB8fCBxdWVyeUVudHJpZXMubGVuZ3RoICE9PSAxXG4gICAgICB8fCBxdWVyeUVudHJpZXNbMF0/LlswXSAhPT0gUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZXG4gICAgKSByZXR1cm4geyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCIsIHJlYXNvbjogXCJjYW5kaWRhdGUgVVJMIHNoYXBlIGludmFsaWRcIiB9O1xuICAgIGNvbnN0IG5vbmNlID0gcXVlcnlFbnRyaWVzWzBdWzFdO1xuICAgIGlmICghUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1BBVFRFUk4udGVzdChub25jZSkpIHtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwiaW52YWxpZC1jYW5kaWRhdGVcIiwgcmVhc29uOiBcImNhbmRpZGF0ZSBub25jZSBpbnZhbGlkXCIgfTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC50b1N0cmluZygpICE9PSBocmVmKSB7XG4gICAgICByZXR1cm4geyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCIsIHJlYXNvbjogXCJjYW5kaWRhdGUgVVJMIGlzIG5vdCBjYW5vbmljYWxcIiB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJjYW5kaWRhdGVcIixcbiAgICAgIG5vbmNlLFxuICAgICAgcmVxdWVzdDogeyB2ZXJzaW9uOiAxLCB1cmw6IGhyZWYgfSxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBraW5kOiBcIm9yZGluYXJ5XCIgfTtcbiAgfVxufVxuXG4vKiogQWNjZXB0cyBvbmx5IHRoZSBleGFjdCBzeW5jaHJvbm91cyBtYWluLXByb2Nlc3MgYXV0aG9yaXphdGlvbiByZXNwb25zZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6ZWROb25jZShcbiAgYXR0ZW1wdDogUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCxcbiAgcmVzcG9uc2U6IHVua25vd24sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKFxuICAgIGF0dGVtcHQua2luZCAhPT0gXCJjYW5kaWRhdGVcIlxuICAgIHx8IHR5cGVvZiByZXNwb25zZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHJlc3BvbnNlLmxlbmd0aCA9PT0gMFxuICAgIHx8IHJlc3BvbnNlLmxlbmd0aCA+IFBST01PVElPTl9SRU5ERVJFUl9BVVRIX1JFU1BPTlNFX01BWF9DSEFSU1xuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgZGVjb2RlZCA9IEpTT04ucGFyc2UocmVzcG9uc2UpIGFzIHVua25vd247XG4gICAgaWYgKGRlY29kZWQgPT09IG51bGwgfHwgdHlwZW9mIGRlY29kZWQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShkZWNvZGVkKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdmFsdWUgPSBkZWNvZGVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChPYmplY3Qua2V5cyh2YWx1ZSkuc29ydCgpLmpvaW4oXCIsXCIpICE9PSBcIm5vbmNlLHVybCx2ZXJzaW9uXCIpIHJldHVybiBudWxsO1xuICAgIGlmICh2YWx1ZS52ZXJzaW9uICE9PSAxIHx8IHR5cGVvZiB2YWx1ZS5ub25jZSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdmFsdWUudXJsICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIVBST01PVElPTl9SRU5ERVJFUl9OT05DRV9QQVRURVJOLnRlc3QodmFsdWUubm9uY2UpKSByZXR1cm4gbnVsbDtcbiAgICBpZiAodmFsdWUubm9uY2UgIT09IGF0dGVtcHQubm9uY2UgfHwgdmFsdWUudXJsICE9PSBhdHRlbXB0LnJlcXVlc3QudXJsKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHZhbHVlLnVybCk7XG4gICAgY29uc3QgZW50cmllcyA9IFsuLi5wYXJzZWQuc2VhcmNoUGFyYW1zLmVudHJpZXMoKV07XG4gICAgaWYgKFxuICAgICAgcGFyc2VkLnByb3RvY29sICE9PSBcImFwcDpcIlxuICAgICAgfHwgcGFyc2VkLmhvc3RuYW1lICE9PSBcIi1cIlxuICAgICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wb3J0ICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGF0aG5hbWUgIT09IFwiL2luZGV4Lmh0bWxcIlxuICAgICAgfHwgcGFyc2VkLmhhc2ggIT09IFwiXCJcbiAgICAgIHx8IGVudHJpZXMubGVuZ3RoICE9PSAxXG4gICAgICB8fCBlbnRyaWVzWzBdPy5bMF0gIT09IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9RVUVSWVxuICAgICAgfHwgZW50cmllc1swXVsxXSAhPT0gdmFsdWUubm9uY2VcbiAgICAgIHx8IHBhcnNlZC50b1N0cmluZygpICE9PSB2YWx1ZS51cmxcbiAgICApIHJldHVybiBudWxsO1xuICAgIHJldHVybiB2YWx1ZS5ub25jZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBQcm92ZXMgdGhlIGFwcGxpY2F0aW9uIHJlbmRlcmVyIHJlcGxhY2VkIGl0cyBzdGF0aWMgc3RhcnR1cCBsb2FkZXIgd2l0aCByZWFsXG4gKiBjb250ZW50LiBBIHByZS1leGlzdGluZyBub24tZW1wdHkgcm9vdCBpcyBpbnN1ZmZpY2llbnQ6IHRoZSB0cmFja2VyIG11c3RcbiAqIGZpcnN0IG9ic2VydmUgdGhlIGNhbm9uaWNhbCBsb2FkZXIgYW5kIHRoZW4gb2JzZXJ2ZSBhIG5vbi1lbXB0eSByZXBsYWNlbWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyKCk6IFByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyIHtcbiAgbGV0IHNhd1N0YXJ0dXBMb2FkZXIgPSBmYWxzZTtcbiAgbGV0IG1vdW50ZWQgPSBmYWxzZTtcblxuICByZXR1cm4ge1xuICAgIG9ic2VydmUob2JzZXJ2YXRpb24pIHtcbiAgICAgIGlmIChtb3VudGVkKSByZXR1cm4gXCJtb3VudGVkXCI7XG4gICAgICBpZiAoIW9ic2VydmF0aW9uLnJvb3RQcmVzZW50KSByZXR1cm4gXCJ3YWl0aW5nXCI7XG4gICAgICBpZiAob2JzZXJ2YXRpb24uc3RhcnR1cExvYWRlclByZXNlbnQpIHtcbiAgICAgICAgc2F3U3RhcnR1cExvYWRlciA9IHRydWU7XG4gICAgICAgIHJldHVybiBcIndhaXRpbmdcIjtcbiAgICAgIH1cbiAgICAgIGlmIChzYXdTdGFydHVwTG9hZGVyICYmIE51bWJlci5pc1NhZmVJbnRlZ2VyKG9ic2VydmF0aW9uLmVsZW1lbnRDaGlsZENvdW50KSAmJiBvYnNlcnZhdGlvbi5lbGVtZW50Q2hpbGRDb3VudCA+IDApIHtcbiAgICAgICAgbW91bnRlZCA9IHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gbW91bnRlZCA/IFwibW91bnRlZFwiIDogXCJ3YWl0aW5nXCI7XG4gICAgfSxcbiAgICByZXN1bHQoKSB7XG4gICAgICByZXR1cm4gbW91bnRlZCA/IFwibW91bnRlZFwiIDogXCJ3YWl0aW5nXCI7XG4gICAgfSxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUFBLHNCQUE0Qjs7O0FDQTVCLElBQU0saUJBQWlCLElBQUksWUFBWTtBQUFBLEVBQ3JDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFDdEMsQ0FBQztBQUVELElBQU0sZUFBZSxJQUFJLFlBQVk7QUFBQSxFQUNuQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztB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
