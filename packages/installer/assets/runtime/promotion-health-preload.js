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
var MOUNT_TIMEOUT_MS = 2e4;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3Byb21vdGlvbi1oZWFsdGgtcHJlbG9hZC50cyIsICIuLi9zcmMvcmVuZGVyZXItY3J5cHRvLnRzIiwgIi4uL3NyYy9yZW5kZXJlci1zdG9yYWdlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL3Byb21vdGlvbi1yZW5kZXJlci1tb3VudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHZlcmlmeVJlbmRlcmVyU3RvcmFnZVJvbGxiYWNrIH0gZnJvbSBcIi4vcmVuZGVyZXItc3RvcmFnZVwiO1xuaW1wb3J0IHsgY3JlYXRlUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIgfSBmcm9tIFwiLi9wcmVsb2FkL3Byb21vdGlvbi1yZW5kZXJlci1tb3VudFwiO1xuXG4vLyBLZWVwIHRoaXMgZGVkaWNhdGVkIHNhbmRib3ggcHJlbG9hZCBicm93c2VyLW9ubHkuIEltcG9ydGluZyB0aGUgbWFpbi1wcm9jZXNzXG4vLyBwcm9tb3Rpb24gbW9kdWxlIHdvdWxkIHB1bGwgbm9kZTpmcy9jcnlwdG8vcGF0aCBpbnRvIGEgcmVuZGVyZXIgYnVuZGxlLlxuLy8gU291cmNlLWludGVncmF0aW9uIHRlc3RzIGJpbmQgdGhlc2UgZXhhY3QgY29uc3RhbnRzIHRvIHRoZSBtYWluIG1vZHVsZS5cbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9VUkwgPSBcImFwcDovLy0vaW5kZXguaHRtbFwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0FVVEhfQ0hBTk5FTCA9IFwidHdlYWtlcjpwcm9tb3Rpb24tb3JpZ2luYWwtcmVuZGVyZXItYXV0aG9yaXplXCI7XG5jb25zdCBQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfSVBDX0NIQU5ORUwgPSBcInR3ZWFrZXI6cHJvbW90aW9uLW9yaWdpbmFsLXJlbmRlcmVyLXByb29mXCI7XG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkgPSBcInR3ZWFrZXJQcm9tb3Rpb25Ob25jZVwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX1FVRVJZX0tFWVMgPSBuZXcgU2V0KFtcImhvc3RJZFwiLCBcImluaXRpYWxSb3V0ZVwiXSk7XG5jb25zdCBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCA9IHByb2Nlc3Muc2FuZGJveGVkID09PSB0cnVlO1xuXG5jb25zdCBNT1VOVF9USU1FT1VUX01TID0gMjBfMDAwO1xuXG50eXBlIEF1dGhvcml6YXRpb24gPSB7IHZlcnNpb246IDE7IG5vbmNlOiBzdHJpbmc7IHVybDogc3RyaW5nIH07XG5cbmZ1bmN0aW9uIGNhbm9uaWNhbE9yaWdpbmFsUmVuZGVyZXJVcmwodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKFxuICAgIHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHZhbHVlLmxlbmd0aCA9PT0gMFxuICAgIHx8IHZhbHVlLmxlbmd0aCA+IDhfMTkyXG4gICAgfHwgL1tcXHUwMDAwLVxcdTAwMWZcXHUwMDdmXS8udGVzdCh2YWx1ZSlcbiAgKSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcnNlZDogVVJMO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoXG4gICAgcGFyc2VkLnByb3RvY29sICE9PSBcImFwcDpcIlxuICAgIHx8IHBhcnNlZC5ob3N0bmFtZSAhPT0gXCItXCJcbiAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucG9ydCAhPT0gXCJcIlxuICAgIHx8IHBhcnNlZC5wYXRobmFtZSAhPT0gXCIvaW5kZXguaHRtbFwiXG4gICAgfHwgcGFyc2VkLmhhc2ggIT09IFwiXCJcbiAgICB8fCBwYXJzZWQuc2VhcmNoUGFyYW1zLmhhcyhQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkpXG4gICAgfHwgcGFyc2VkLnRvU3RyaW5nKCkgIT09IHZhbHVlXG4gICkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5S2V5cyA9IFsuLi5wYXJzZWQuc2VhcmNoUGFyYW1zLmtleXMoKV07XG4gIGlmIChcbiAgICBxdWVyeUtleXMuc29tZSgoa2V5KSA9PiAhUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX1FVRVJZX0tFWVMuaGFzKGtleSkpXG4gICAgfHwgbmV3IFNldChxdWVyeUtleXMpLnNpemUgIT09IHF1ZXJ5S2V5cy5sZW5ndGhcbiAgKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgaG9zdElkID0gcGFyc2VkLnNlYXJjaFBhcmFtcy5nZXQoXCJob3N0SWRcIik7XG4gIGNvbnN0IGluaXRpYWxSb3V0ZSA9IHBhcnNlZC5zZWFyY2hQYXJhbXMuZ2V0KFwiaW5pdGlhbFJvdXRlXCIpO1xuICBpZiAoaG9zdElkICE9PSBudWxsICYmICEvXltBLVphLXowLTkuXzotXXsxLDI1Nn0kLy50ZXN0KGhvc3RJZCkpIHJldHVybiBudWxsO1xuICBpZiAoaW5pdGlhbFJvdXRlICE9PSBudWxsICYmIChcbiAgICBpbml0aWFsUm91dGUubGVuZ3RoID09PSAwXG4gICAgfHwgaW5pdGlhbFJvdXRlLmxlbmd0aCA+IDJfMDQ4XG4gICAgfHwgIWluaXRpYWxSb3V0ZS5zdGFydHNXaXRoKFwiL1wiKVxuICAgIHx8IC9bXFx1MDAwMC1cXHUwMDFmXFx1MDA3Zl0vLnRlc3QoaW5pdGlhbFJvdXRlKVxuICApKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBwYXJzZUV4YWN0QXV0aG9yaXphdGlvbih2YWx1ZTogdW5rbm93biwgZXhwZWN0ZWRVcmw6IHN0cmluZyk6IEF1dGhvcml6YXRpb24gfCBudWxsIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS5sZW5ndGggPT09IDAgfHwgdmFsdWUubGVuZ3RoID4gMV8wMjQpIHJldHVybiBudWxsO1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAoIXBhcnNlZCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHJlY29yZCA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIE9iamVjdC5rZXlzKHJlY29yZCkuc29ydCgpLmpvaW4oXCIsXCIpID09PSBcIm5vbmNlLHVybCx2ZXJzaW9uXCJcbiAgICAmJiByZWNvcmQudmVyc2lvbiA9PT0gMVxuICAgICYmIHR5cGVvZiByZWNvcmQubm9uY2UgPT09IFwic3RyaW5nXCJcbiAgICAmJiAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LTRbMC05YS1mXXszfS1bODlhYl1bMC05YS1mXXszfS1bMC05YS1mXXsxMn0kL2kudGVzdChyZWNvcmQubm9uY2UpXG4gICAgJiYgcmVjb3JkLnVybCA9PT0gZXhwZWN0ZWRVcmxcbiAgICA/IHJlY29yZCBhcyBBdXRob3JpemF0aW9uXG4gICAgOiBudWxsO1xufVxuXG4vLyBUaGlzIGVudHJ5IGlzIHJlZ2lzdGVyZWQgb25seSBmb3IgdGhlIGRpc3Bvc2FibGUgb3JpZ2luYWwtbWFpbiBoZWFsdGggbW9kZS5cbi8vIEl0IHJ1bnMgYmVmb3JlIHBhZ2UgcGFyc2luZyBhbmQgdHJ1c3RzIG5vIGVudmlyb25tZW50LCBhcmd2LCBvciBVUkwgbm9uY2UuXG5jb25zdCB1bm1vZGlmaWVkVXJsID0gbG9jYXRpb24uaHJlZjtcbmNvbnN0IGNhbm9uaWNhbFVybCA9IGNhbm9uaWNhbE9yaWdpbmFsUmVuZGVyZXJVcmwodW5tb2RpZmllZFVybCk7XG5sZXQgYXV0aG9yaXphdGlvbjogdW5rbm93biA9IG51bGw7XG5pZiAoY2Fub25pY2FsVXJsICE9PSBudWxsKSB7XG4gIHRyeSB7XG4gICAgYXV0aG9yaXphdGlvbiA9IGlwY1JlbmRlcmVyLnNlbmRTeW5jKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9BVVRIX0NIQU5ORUwsIHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICB1cmw6IGNhbm9uaWNhbFVybCxcbiAgICAgIHJlbmRlcmVyU2FuZGJveGVkOiBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCxcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgYXV0aG9yaXphdGlvbiA9IG51bGw7XG4gIH1cbn1cblxuY29uc3QgcGFyc2VkQXV0aG9yaXphdGlvbiA9IGNhbm9uaWNhbFVybCA9PT0gbnVsbFxuICA/IG51bGxcbiAgOiBwYXJzZUV4YWN0QXV0aG9yaXphdGlvbihhdXRob3JpemF0aW9uLCBjYW5vbmljYWxVcmwpO1xuaWYgKHBhcnNlZEF1dGhvcml6YXRpb24pIHtcbiAgb2JzZXJ2ZU9yaWdpbmFsUmVuZGVyZXJNb3VudChwYXJzZWRBdXRob3JpemF0aW9uKTtcbn1cblxuZnVuY3Rpb24gb2JzZXJ2ZU9yaWdpbmFsUmVuZGVyZXJNb3VudChhdXRob3JpemVkOiBBdXRob3JpemF0aW9uKTogdm9pZCB7XG4gIGNvbnN0IG1vdW50ID0gY3JlYXRlUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIoKTtcbiAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihpbnNwZWN0KTtcbiAgY29uc3QgdGltZW91dCA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcbiAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgIHNldHRsZWQgPSB0cnVlO1xuICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgfSwgTU9VTlRfVElNRU9VVF9NUyk7XG5cbiAgZnVuY3Rpb24gaW5zcGVjdCgpOiB2b2lkIHtcbiAgICBpZiAoc2V0dGxlZCkgcmV0dXJuO1xuICAgIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIik7XG4gICAgY29uc3Qgc3RhdGUgPSBtb3VudC5vYnNlcnZlKHtcbiAgICAgIHJvb3RQcmVzZW50OiByb290ICE9PSBudWxsLFxuICAgICAgc3RhcnR1cExvYWRlclByZXNlbnQ6IHJvb3QgIT09IG51bGwgJiYgcm9vdC5xdWVyeVNlbGVjdG9yKFwiOnNjb3BlID4gLnN0YXJ0dXAtbG9hZGVyXCIpICE9PSBudWxsLFxuICAgICAgZWxlbWVudENoaWxkQ291bnQ6IHJvb3Q/LmNoaWxkcmVuLmxlbmd0aCA/PyAwLFxuICAgIH0pO1xuICAgIGlmIChzdGF0ZSAhPT0gXCJtb3VudGVkXCIpIHJldHVybjtcbiAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICBvYnNlcnZlci5kaXNjb25uZWN0KCk7XG4gICAgd2luZG93LmNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9JUENfQ0hBTk5FTCwge1xuICAgICAgbm9uY2U6IGF1dGhvcml6ZWQubm9uY2UsXG4gICAgICB1cmw6IHVubW9kaWZpZWRVcmwsXG4gICAgICBsaWZlY3ljbGU6IFwicmVuZGVyZXItbW91bnRlZFwiLFxuICAgICAgcmVuZGVyZXJTYW5kYm94ZWQ6IGVmZmVjdGl2ZVJlbmRlcmVyU2FuZGJveGVkLFxuICAgICAgcmVuZGVyZXJTdG9yYWdlU2VsZlRlc3Q6IHZlcmlmeVJlbmRlcmVyU3RvcmFnZVJvbGxiYWNrKGxvY2FsU3RvcmFnZSwgYXV0aG9yaXplZC5ub25jZSksXG4gICAgfSk7XG4gIH1cblxuICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgaW5zcGVjdCgpO1xufVxuIiwgImNvbnN0IFNIQTI1Nl9JTklUSUFMID0gbmV3IFVpbnQzMkFycmF5KFtcbiAgMHg2YTA5ZTY2NywgMHhiYjY3YWU4NSwgMHgzYzZlZjM3MiwgMHhhNTRmZjUzYSxcbiAgMHg1MTBlNTI3ZiwgMHg5YjA1Njg4YywgMHgxZjgzZDlhYiwgMHg1YmUwY2QxOSxcbl0pO1xuXG5jb25zdCBTSEEyNTZfUk9VTkQgPSBuZXcgVWludDMyQXJyYXkoW1xuICAweDQyOGEyZjk4LCAweDcxMzc0NDkxLCAweGI1YzBmYmNmLCAweGU5YjVkYmE1LFxuICAweDM5NTZjMjViLCAweDU5ZjExMWYxLCAweDkyM2Y4MmE0LCAweGFiMWM1ZWQ1LFxuICAweGQ4MDdhYTk4LCAweDEyODM1YjAxLCAweDI0MzE4NWJlLCAweDU1MGM3ZGMzLFxuICAweDcyYmU1ZDc0LCAweDgwZGViMWZlLCAweDliZGMwNmE3LCAweGMxOWJmMTc0LFxuICAweGU0OWI2OWMxLCAweGVmYmU0Nzg2LCAweDBmYzE5ZGM2LCAweDI0MGNhMWNjLFxuICAweDJkZTkyYzZmLCAweDRhNzQ4NGFhLCAweDVjYjBhOWRjLCAweDc2Zjk4OGRhLFxuICAweDk4M2U1MTUyLCAweGE4MzFjNjZkLCAweGIwMDMyN2M4LCAweGJmNTk3ZmM3LFxuICAweGM2ZTAwYmYzLCAweGQ1YTc5MTQ3LCAweDA2Y2E2MzUxLCAweDE0MjkyOTY3LFxuICAweDI3YjcwYTg1LCAweDJlMWIyMTM4LCAweDRkMmM2ZGZjLCAweDUzMzgwZDEzLFxuICAweDY1MGE3MzU0LCAweDc2NmEwYWJiLCAweDgxYzJjOTJlLCAweDkyNzIyYzg1LFxuICAweGEyYmZlOGExLCAweGE4MWE2NjRiLCAweGMyNGI4YjcwLCAweGM3NmM1MWEzLFxuICAweGQxOTJlODE5LCAweGQ2OTkwNjI0LCAweGY0MGUzNTg1LCAweDEwNmFhMDcwLFxuICAweDE5YTRjMTE2LCAweDFlMzc2YzA4LCAweDI3NDg3NzRjLCAweDM0YjBiY2I1LFxuICAweDM5MWMwY2IzLCAweDRlZDhhYTRhLCAweDViOWNjYTRmLCAweDY4MmU2ZmYzLFxuICAweDc0OGY4MmVlLCAweDc4YTU2MzZmLCAweDg0Yzg3ODE0LCAweDhjYzcwMjA4LFxuICAweDkwYmVmZmZhLCAweGE0NTA2Y2ViLCAweGJlZjlhM2Y3LCAweGM2NzE3OGYyLFxuXSk7XG5cbmZ1bmN0aW9uIHJvdGF0ZVJpZ2h0KHZhbHVlOiBudW1iZXIsIGFtb3VudDogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuICh2YWx1ZSA+Pj4gYW1vdW50KSB8ICh2YWx1ZSA8PCAoMzIgLSBhbW91bnQpKTtcbn1cblxuLyoqIFN5bmNocm9ub3VzIFNIQS0yNTYgZm9yIHRoZSBzYW5kYm94ZWQgcmVuZGVyZXIsIHdoaWNoIGNhbm5vdCBpbXBvcnQgTm9kZSBidWlsdC1pbnMuICovXG5leHBvcnQgZnVuY3Rpb24gc2hhMjU2SGV4VXRmOCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgaW5wdXQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmFsdWUpO1xuICBjb25zdCBwYWRkZWRMZW5ndGggPSBNYXRoLmNlaWwoKGlucHV0Lmxlbmd0aCArIDkpIC8gNjQpICogNjQ7XG4gIGNvbnN0IHBhZGRlZCA9IG5ldyBVaW50OEFycmF5KHBhZGRlZExlbmd0aCk7XG4gIHBhZGRlZC5zZXQoaW5wdXQpO1xuICBwYWRkZWRbaW5wdXQubGVuZ3RoXSA9IDB4ODA7XG5cbiAgY29uc3QgYml0TGVuZ3RoID0gQmlnSW50KGlucHV0Lmxlbmd0aCkgKiA4bjtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwYWRkZWQuYnVmZmVyKTtcbiAgdmlldy5zZXRVaW50MzIocGFkZGVkTGVuZ3RoIC0gOCwgTnVtYmVyKChiaXRMZW5ndGggPj4gMzJuKSAmIDB4ZmZmZmZmZmZuKSwgZmFsc2UpO1xuICB2aWV3LnNldFVpbnQzMihwYWRkZWRMZW5ndGggLSA0LCBOdW1iZXIoYml0TGVuZ3RoICYgMHhmZmZmZmZmZm4pLCBmYWxzZSk7XG5cbiAgY29uc3Qgc3RhdGUgPSBuZXcgVWludDMyQXJyYXkoU0hBMjU2X0lOSVRJQUwpO1xuICBjb25zdCB3b3JkcyA9IG5ldyBVaW50MzJBcnJheSg2NCk7XG4gIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IHBhZGRlZExlbmd0aDsgb2Zmc2V0ICs9IDY0KSB7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDE2OyBpbmRleCArPSAxKSB7XG4gICAgICB3b3Jkc1tpbmRleF0gPSB2aWV3LmdldFVpbnQzMihvZmZzZXQgKyBpbmRleCAqIDQsIGZhbHNlKTtcbiAgICB9XG4gICAgZm9yIChsZXQgaW5kZXggPSAxNjsgaW5kZXggPCB3b3Jkcy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgIGNvbnN0IHByaW9yMTUgPSB3b3Jkc1tpbmRleCAtIDE1XSE7XG4gICAgICBjb25zdCBwcmlvcjIgPSB3b3Jkc1tpbmRleCAtIDJdITtcbiAgICAgIGNvbnN0IHNtYWxsMCA9IHJvdGF0ZVJpZ2h0KHByaW9yMTUsIDcpIF4gcm90YXRlUmlnaHQocHJpb3IxNSwgMTgpIF4gKHByaW9yMTUgPj4+IDMpO1xuICAgICAgY29uc3Qgc21hbGwxID0gcm90YXRlUmlnaHQocHJpb3IyLCAxNykgXiByb3RhdGVSaWdodChwcmlvcjIsIDE5KSBeIChwcmlvcjIgPj4+IDEwKTtcbiAgICAgIHdvcmRzW2luZGV4XSA9ICh3b3Jkc1tpbmRleCAtIDE2XSEgKyBzbWFsbDAgKyB3b3Jkc1tpbmRleCAtIDddISArIHNtYWxsMSkgPj4+IDA7XG4gICAgfVxuXG4gICAgbGV0IFthLCBiLCBjLCBkLCBlLCBmLCBnLCBoXSA9IHN0YXRlO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB3b3Jkcy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgIGNvbnN0IGxhcmdlMSA9IHJvdGF0ZVJpZ2h0KGUhLCA2KSBeIHJvdGF0ZVJpZ2h0KGUhLCAxMSkgXiByb3RhdGVSaWdodChlISwgMjUpO1xuICAgICAgY29uc3QgY2hvb3NlID0gKGUhICYgZiEpIF4gKH5lISAmIGchKTtcbiAgICAgIGNvbnN0IHRlbXBvcmFyeTEgPSAoaCEgKyBsYXJnZTEgKyBjaG9vc2UgKyBTSEEyNTZfUk9VTkRbaW5kZXhdISArIHdvcmRzW2luZGV4XSEpID4+PiAwO1xuICAgICAgY29uc3QgbGFyZ2UwID0gcm90YXRlUmlnaHQoYSEsIDIpIF4gcm90YXRlUmlnaHQoYSEsIDEzKSBeIHJvdGF0ZVJpZ2h0KGEhLCAyMik7XG4gICAgICBjb25zdCBtYWpvcml0eSA9IChhISAmIGIhKSBeIChhISAmIGMhKSBeIChiISAmIGMhKTtcbiAgICAgIGNvbnN0IHRlbXBvcmFyeTIgPSAobGFyZ2UwICsgbWFqb3JpdHkpID4+PiAwO1xuXG4gICAgICBoID0gZztcbiAgICAgIGcgPSBmO1xuICAgICAgZiA9IGU7XG4gICAgICBlID0gKGQhICsgdGVtcG9yYXJ5MSkgPj4+IDA7XG4gICAgICBkID0gYztcbiAgICAgIGMgPSBiO1xuICAgICAgYiA9IGE7XG4gICAgICBhID0gKHRlbXBvcmFyeTEgKyB0ZW1wb3JhcnkyKSA+Pj4gMDtcbiAgICB9XG5cbiAgICBzdGF0ZVswXSA9IChzdGF0ZVswXSEgKyBhISkgPj4+IDA7XG4gICAgc3RhdGVbMV0gPSAoc3RhdGVbMV0hICsgYiEpID4+PiAwO1xuICAgIHN0YXRlWzJdID0gKHN0YXRlWzJdISArIGMhKSA+Pj4gMDtcbiAgICBzdGF0ZVszXSA9IChzdGF0ZVszXSEgKyBkISkgPj4+IDA7XG4gICAgc3RhdGVbNF0gPSAoc3RhdGVbNF0hICsgZSEpID4+PiAwO1xuICAgIHN0YXRlWzVdID0gKHN0YXRlWzVdISArIGYhKSA+Pj4gMDtcbiAgICBzdGF0ZVs2XSA9IChzdGF0ZVs2XSEgKyBnISkgPj4+IDA7XG4gICAgc3RhdGVbN10gPSAoc3RhdGVbN10hICsgaCEpID4+PiAwO1xuICB9XG5cbiAgcmV0dXJuIFsuLi5zdGF0ZV0ubWFwKCh3b3JkKSA9PiB3b3JkLnRvU3RyaW5nKDE2KS5wYWRTdGFydCg4LCBcIjBcIikpLmpvaW4oXCJcIik7XG59XG5cbi8qKiBHZW5lcmF0ZXMgYSBVVUlEIHdpdGhvdXQgcmVseWluZyBvbiBzYW5kYm94LXVuYXZhaWxhYmxlIE5vZGUgY3J5cHRvLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlY3VyZVJlbmRlcmVyVXVpZCgpOiBzdHJpbmcge1xuICBjb25zdCBwcm92aWRlciA9IGdsb2JhbFRoaXMuY3J5cHRvO1xuICBpZiAodHlwZW9mIHByb3ZpZGVyPy5yYW5kb21VVUlEID09PSBcImZ1bmN0aW9uXCIpIHJldHVybiBwcm92aWRlci5yYW5kb21VVUlEKCk7XG4gIGlmICh0eXBlb2YgcHJvdmlkZXI/LmdldFJhbmRvbVZhbHVlcyAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwic2VjdXJlIHJlbmRlcmVyIHJhbmRvbW5lc3MgaXMgdW5hdmFpbGFibGVcIik7XG4gIH1cbiAgY29uc3QgYnl0ZXMgPSBwcm92aWRlci5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkoMTYpKTtcbiAgYnl0ZXNbNl0gPSAoYnl0ZXNbNl0hICYgMHgwZikgfCAweDQwO1xuICBieXRlc1s4XSA9IChieXRlc1s4XSEgJiAweDNmKSB8IDB4ODA7XG4gIGNvbnN0IGhleCA9IFsuLi5ieXRlc10ubWFwKChieXRlKSA9PiBieXRlLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpO1xuICByZXR1cm4gYCR7aGV4LnNsaWNlKDAsIDQpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDQsIDYpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDYsIDgpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDgsIDEwKS5qb2luKFwiXCIpfS0ke2hleC5zbGljZSgxMCkuam9pbihcIlwiKX1gO1xufVxuIiwgImltcG9ydCB7IHNlY3VyZVJlbmRlcmVyVXVpZCwgc2hhMjU2SGV4VXRmOCB9IGZyb20gXCIuL3JlbmRlcmVyLWNyeXB0b1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VMaWtlIHtcbiAgcmVhZG9ubHkgbGVuZ3RoOiBudW1iZXI7XG4gIGdldEl0ZW0oa2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xuICBrZXkoaW5kZXg6IG51bWJlcik6IHN0cmluZyB8IG51bGw7XG4gIHNldEl0ZW0oa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICByZW1vdmVJdGVtKGtleTogc3RyaW5nKTogdm9pZDtcbn1cblxuY29uc3QgQ1VSUkVOVF9JRF9QUkVGSVggPSBcImNvLnR3ZWFrZXJzLlwiO1xuY29uc3QgTEVHQUNZX1NUT1JBR0VfUFJFRklYID0gYCR7W1wiY29kZXhcIiwgXCJwcFwiXS5qb2luKFwiXCIpfTpzdG9yYWdlOmA7XG5jb25zdCBDVVJSRU5UX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2U6XCI7XG5jb25zdCBBUkNISVZFX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2UtYXJjaGl2ZTpcIjtcblxuZXhwb3J0IHR5cGUgUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uU3RhdHVzID1cbiAgfCBcIm5vdF9hcHBsaWNhYmxlXCJcbiAgfCBcImFic2VudFwiXG4gIHwgXCJjYW5vbmljYWxcIlxuICB8IFwicHJlcGFyZWRcIlxuICB8IFwiYW1iaWd1b3VzXCJcbiAgfCBcImNvbmZsaWN0XCJcbiAgfCBcImludmFsaWRfY2Fub25pY2FsXCJcbiAgfCBcImludmFsaWRfbGVnYWN5XCJcbiAgfCBcIndyaXRlX2ZhaWxlZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmc7XG4gIGN1cnJlbnRLZXk6IHN0cmluZztcbiAgbGVnYWN5S2V5czogc3RyaW5nW107XG4gIHNlbGVjdGVkTGVnYWN5S2V5OiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblN0YXR1cztcbiAgaG9sZFByb21vdGlvbjogYm9vbGVhbjtcbiAgY3JlYXRlZENhbm9uaWNhbDogYm9vbGVhbjtcbiAgY2Fub25pY2FsQmVmb3JlSGFzaDogc3RyaW5nO1xuICBjYW5vbmljYWxBZnRlckhhc2g6IHN0cmluZztcbiAgc2VsZWN0ZWRMZWdhY3lIYXNoOiBzdHJpbmc7XG4gIGFyY2hpdmVLZXk6IHN0cmluZyB8IG51bGw7XG4gIHBoYXNlOiBcInBsYW5uZWRcIiB8IFwicHJlcGFyZWRcIiB8IFwiY29tbWl0dGVkXCIgfCBcInJvbGxlZF9iYWNrXCI7XG59XG5cbmludGVyZmFjZSBTdG9yYWdlTWlncmF0aW9uUGxhbiB7XG4gIHJlY2VpcHQ6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQ7XG4gIGNhbm9uaWNhbFJhdzogc3RyaW5nIHwgbnVsbDtcbiAgc2VsZWN0ZWRMZWdhY3lSYXc6IHN0cmluZyB8IG51bGw7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVjb3JkKHJhdzogc3RyaW5nIHwgbnVsbCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIHJldHVybiBwYXJzZWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpXG4gICAgICA/IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5nZXJwcmludChyYXc6IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gcmF3ID09PSBudWxsID8gXCJtaXNzaW5nXCIgOiBzaGEyNTZIZXhVdGY4KHJhdyk7XG59XG5cbmZ1bmN0aW9uIGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5cyhpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSk6IHN0cmluZ1tdIHtcbiAgaWYgKCFpZC5zdGFydHNXaXRoKENVUlJFTlRfSURfUFJFRklYKSkgcmV0dXJuIFtdO1xuICBjb25zdCBzdWZmaXggPSBpZC5zbGljZShDVVJSRU5UX0lEX1BSRUZJWC5sZW5ndGgpO1xuICBpZiAoIXN1ZmZpeCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IHN1ZmZpeE1hcmtlciA9IGAuJHtzdWZmaXh9YDtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBrZXkgPSBzdG9yYWdlLmtleShpbmRleCk7XG4gICAgaWYgKCFrZXk/LnN0YXJ0c1dpdGgoTEVHQUNZX1NUT1JBR0VfUFJFRklYKSkgY29udGludWU7XG4gICAgY29uc3QgbGVnYWN5SWQgPSBrZXkuc2xpY2UoTEVHQUNZX1NUT1JBR0VfUFJFRklYLmxlbmd0aCk7XG4gICAgaWYgKFxuICAgICAgbGVnYWN5SWQgIT09IGlkXG4gICAgICAmJiBsZWdhY3lJZC5zdGFydHNXaXRoKFwiY28uXCIpXG4gICAgICAmJiBsZWdhY3lJZC5lbmRzV2l0aChzdWZmaXhNYXJrZXIpXG4gICAgICAmJiBsZWdhY3lJZC5zbGljZSgzLCAtc3VmZml4TWFya2VyLmxlbmd0aCkubGVuZ3RoID4gMFxuICAgICkge1xuICAgICAgY2FuZGlkYXRlcy5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi5jYW5kaWRhdGVzXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxlZ2FjeUtleXNGb3IoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4YWN0TGVnYWN5S2V5ID0gYCR7TEVHQUNZX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3Qga2V5cyA9IG5ldyBTZXQoZGlzY292ZXJMZWdhY3lQdWJsaXNoZXJLZXlzKGlkLCBzdG9yYWdlKSk7XG4gIGlmIChzdG9yYWdlLmdldEl0ZW0oZXhhY3RMZWdhY3lLZXkpICE9PSBudWxsKSBrZXlzLmFkZChleGFjdExlZ2FjeUtleSk7XG4gIHJldHVybiBbLi4ua2V5c10uc29ydCgpO1xufVxuXG5mdW5jdGlvbiBwbGFuTWlncmF0aW9uKFxuICBpZDogc3RyaW5nLFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nID0gc2VjdXJlUmVuZGVyZXJVdWlkKCksXG4pOiBTdG9yYWdlTWlncmF0aW9uUGxhbiB7XG4gIGNvbnN0IGN1cnJlbnRLZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3QgY2Fub25pY2FsUmF3ID0gc3RvcmFnZS5nZXRJdGVtKGN1cnJlbnRLZXkpO1xuICBjb25zdCBsZWdhY3lLZXlzID0gbGVnYWN5S2V5c0ZvcihpZCwgc3RvcmFnZSk7XG4gIGNvbnN0IHNlbGVjdGVkTGVnYWN5S2V5ID0gbGVnYWN5S2V5cy5sZW5ndGggPT09IDEgPyBsZWdhY3lLZXlzWzBdISA6IG51bGw7XG4gIGNvbnN0IHNlbGVjdGVkTGVnYWN5UmF3ID0gc2VsZWN0ZWRMZWdhY3lLZXkgPT09IG51bGwgPyBudWxsIDogc3RvcmFnZS5nZXRJdGVtKHNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgY29uc3QgYmFzZSA9IHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxIGFzIGNvbnN0LFxuICAgIHRyYW5zYWN0aW9uSWQsXG4gICAgY3VycmVudEtleSxcbiAgICBsZWdhY3lLZXlzLFxuICAgIHNlbGVjdGVkTGVnYWN5S2V5LFxuICAgIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uaWNhbEJlZm9yZUhhc2g6IGZpbmdlcnByaW50KGNhbm9uaWNhbFJhdyksXG4gICAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBmaW5nZXJwcmludChjYW5vbmljYWxSYXcpLFxuICAgIHNlbGVjdGVkTGVnYWN5SGFzaDogZmluZ2VycHJpbnQoc2VsZWN0ZWRMZWdhY3lSYXcpLFxuICAgIGFyY2hpdmVLZXk6IG51bGwsXG4gICAgcGhhc2U6IFwicGxhbm5lZFwiIGFzIGNvbnN0LFxuICB9O1xuXG4gIGlmICghaWQuc3RhcnRzV2l0aChDVVJSRU5UX0lEX1BSRUZJWCkpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJub3RfYXBwbGljYWJsZVwiLCBob2xkUHJvbW90aW9uOiBmYWxzZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKGxlZ2FjeUtleXMubGVuZ3RoID4gMSkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcImFtYmlndW91c1wiLCBob2xkUHJvbW90aW9uOiB0cnVlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAoY2Fub25pY2FsUmF3ICE9PSBudWxsICYmIHBhcnNlUmVjb3JkKGNhbm9uaWNhbFJhdykgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJpbnZhbGlkX2Nhbm9uaWNhbFwiLCBob2xkUHJvbW90aW9uOiB0cnVlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAoc2VsZWN0ZWRMZWdhY3lSYXcgIT09IG51bGwgJiYgcGFyc2VSZWNvcmQoc2VsZWN0ZWRMZWdhY3lSYXcpID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiaW52YWxpZF9sZWdhY3lcIiwgaG9sZFByb21vdGlvbjogdHJ1ZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKGNhbm9uaWNhbFJhdyAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG1pc21hdGNoID0gc2VsZWN0ZWRMZWdhY3lSYXcgIT09IG51bGwgJiYgc2VsZWN0ZWRMZWdhY3lSYXcgIT09IGNhbm9uaWNhbFJhdztcbiAgICByZXR1cm4ge1xuICAgICAgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IG1pc21hdGNoID8gXCJjb25mbGljdFwiIDogXCJjYW5vbmljYWxcIiwgaG9sZFByb21vdGlvbjogbWlzbWF0Y2ggfSxcbiAgICAgIGNhbm9uaWNhbFJhdyxcbiAgICAgIHNlbGVjdGVkTGVnYWN5UmF3LFxuICAgIH07XG4gIH1cbiAgaWYgKHNlbGVjdGVkTGVnYWN5UmF3ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiYWJzZW50XCIsIGhvbGRQcm9tb3Rpb246IGZhbHNlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJlY2VpcHQ6IHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICBzdGF0dXM6IFwicHJlcGFyZWRcIixcbiAgICAgIGhvbGRQcm9tb3Rpb246IGZhbHNlLFxuICAgICAgY3JlYXRlZENhbm9uaWNhbDogdHJ1ZSxcbiAgICAgIGNhbm9uaWNhbEFmdGVySGFzaDogZmluZ2VycHJpbnQoc2VsZWN0ZWRMZWdhY3lSYXcpLFxuICAgIH0sXG4gICAgY2Fub25pY2FsUmF3LFxuICAgIHNlbGVjdGVkTGVnYWN5UmF3LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGxhblJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihcbiAgaWQ6IHN0cmluZyxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4gIHRyYW5zYWN0aW9uSWQ/OiBzdHJpbmcsXG4pOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgcmV0dXJuIHBsYW5NaWdyYXRpb24oaWQsIHN0b3JhZ2UsIHRyYW5zYWN0aW9uSWQpLnJlY2VpcHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmVwYXJlUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICBpZDogc3RyaW5nLFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgdHJhbnNhY3Rpb25JZD86IHN0cmluZyxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBjb25zdCBwbGFuID0gcGxhbk1pZ3JhdGlvbihpZCwgc3RvcmFnZSwgdHJhbnNhY3Rpb25JZCk7XG4gIGlmICghcGxhbi5yZWNlaXB0LmNyZWF0ZWRDYW5vbmljYWwgfHwgcGxhbi5zZWxlY3RlZExlZ2FjeVJhdyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgcGhhc2U6IFwicHJlcGFyZWRcIiB9O1xuICB9XG4gIHRyeSB7XG4gICAgaWYgKHN0b3JhZ2UuZ2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSkgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgc3RhdHVzOiBcImNvbmZsaWN0XCIsIGhvbGRQcm9tb3Rpb246IHRydWUsIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLCBwaGFzZTogXCJwcmVwYXJlZFwiIH07XG4gICAgfVxuICAgIHN0b3JhZ2Uuc2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSwgcGxhbi5zZWxlY3RlZExlZ2FjeVJhdyk7XG4gICAgaWYgKGZpbmdlcnByaW50KHN0b3JhZ2UuZ2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSkpICE9PSBwbGFuLnJlY2VpcHQuY2Fub25pY2FsQWZ0ZXJIYXNoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIHZlcmlmaWNhdGlvbiBmYWlsZWRcIik7XG4gICAgfVxuICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgcGhhc2U6IFwicHJlcGFyZWRcIiB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4ge1xuICAgICAgLi4ucGxhbi5yZWNlaXB0LFxuICAgICAgc3RhdHVzOiBcIndyaXRlX2ZhaWxlZFwiLFxuICAgICAgaG9sZFByb21vdGlvbjogdHJ1ZSxcbiAgICAgIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLFxuICAgICAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocGxhbi5yZWNlaXB0LmN1cnJlbnRLZXkpKSxcbiAgICAgIHBoYXNlOiBcInByZXBhcmVkXCIsXG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tbWl0UmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICByZWNlaXB0OiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0LFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBpZiAocmVjZWlwdC5waGFzZSA9PT0gXCJjb21taXR0ZWRcIikgcmV0dXJuIHJlY2VpcHQ7XG4gIGlmIChyZWNlaXB0LmhvbGRQcm9tb3Rpb24pIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgbWlncmF0aW9uIGlzIG9uIGhvbGRcIik7XG4gIGlmIChmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5jdXJyZW50S2V5KSkgIT09IHJlY2VpcHQuY2Fub25pY2FsQWZ0ZXJIYXNoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBjYW5vbmljYWwgdmFsdWUgY2hhbmdlZCBiZWZvcmUgY29tbWl0XCIpO1xuICB9XG4gIGlmIChyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5ID09PSBudWxsKSByZXR1cm4geyAuLi5yZWNlaXB0LCBwaGFzZTogXCJjb21taXR0ZWRcIiB9O1xuICBjb25zdCBsZWdhY3lSYXcgPSBzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSk7XG4gIGlmIChmaW5nZXJwcmludChsZWdhY3lSYXcpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCB8fCBsZWdhY3lSYXcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGxlZ2FjeSB2YWx1ZSBjaGFuZ2VkIGJlZm9yZSBjb21taXRcIik7XG4gIH1cbiAgY29uc3QgYXJjaGl2ZUtleSA9IGAke0FSQ0hJVkVfU1RPUkFHRV9QUkVGSVh9JHtyZWNlaXB0LnRyYW5zYWN0aW9uSWR9OiR7ZW5jb2RlVVJJQ29tcG9uZW50KHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpfWA7XG4gIGNvbnN0IGFyY2hpdmVkID0gc3RvcmFnZS5nZXRJdGVtKGFyY2hpdmVLZXkpO1xuICBpZiAoYXJjaGl2ZWQgIT09IG51bGwgJiYgYXJjaGl2ZWQgIT09IGxlZ2FjeVJhdykge1xuICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgYXJjaGl2ZSBjb2xsaXNpb25cIik7XG4gIH1cbiAgc3RvcmFnZS5zZXRJdGVtKGFyY2hpdmVLZXksIGxlZ2FjeVJhdyk7XG4gIGlmIChzdG9yYWdlLmdldEl0ZW0oYXJjaGl2ZUtleSkgIT09IGxlZ2FjeVJhdykgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBhcmNoaXZlIHZlcmlmaWNhdGlvbiBmYWlsZWRcIik7XG4gIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgcmV0dXJuIHsgLi4ucmVjZWlwdCwgYXJjaGl2ZUtleSwgcGhhc2U6IFwiY29tbWl0dGVkXCIgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJvbGxiYWNrUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICByZWNlaXB0OiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0LFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBpZiAocmVjZWlwdC5waGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiKSByZXR1cm4gcmVjZWlwdDtcbiAgaWYgKHJlY2VpcHQuYXJjaGl2ZUtleSAhPT0gbnVsbCAmJiByZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5ICE9PSBudWxsKSB7XG4gICAgY29uc3QgYXJjaGl2ZWQgPSBzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5hcmNoaXZlS2V5KTtcbiAgICBpZiAoZmluZ2VycHJpbnQoYXJjaGl2ZWQpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCB8fCBhcmNoaXZlZCA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBhcmNoaXZlIGNoYW5nZWQgYmVmb3JlIHJvbGxiYWNrXCIpO1xuICAgIH1cbiAgICBjb25zdCBjdXJyZW50TGVnYWN5ID0gc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpO1xuICAgIGlmIChjdXJyZW50TGVnYWN5ICE9PSBudWxsICYmIGZpbmdlcnByaW50KGN1cnJlbnRMZWdhY3kpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBsZWdhY3kgdmFsdWUgY2hhbmdlZCBiZWZvcmUgcm9sbGJhY2tcIik7XG4gICAgfVxuICAgIGlmIChjdXJyZW50TGVnYWN5ID09PSBudWxsKSBzdG9yYWdlLnNldEl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSwgYXJjaGl2ZWQpO1xuICAgIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LmFyY2hpdmVLZXkpO1xuICB9XG4gIGlmIChyZWNlaXB0LmNyZWF0ZWRDYW5vbmljYWwpIHtcbiAgICBpZiAoZmluZ2VycHJpbnQoc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuY3VycmVudEtleSkpICE9PSByZWNlaXB0LmNhbm9uaWNhbEFmdGVySGFzaCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBjYW5vbmljYWwgdmFsdWUgY2hhbmdlZCBiZWZvcmUgcm9sbGJhY2tcIik7XG4gICAgfVxuICAgIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LmN1cnJlbnRLZXkpO1xuICB9XG4gIHJldHVybiB7IC4uLnJlY2VpcHQsIHBoYXNlOiBcInJvbGxlZF9iYWNrXCIgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlbmRlcmVyU3RvcmFnZShpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSkge1xuICBsZXQgbWlncmF0aW9uID0gcHJlcGFyZVJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihpZCwgc3RvcmFnZSk7XG4gIGNvbnN0IGtleSA9IGAke0NVUlJFTlRfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCByZWFkID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHBhcnNlUmVjb3JkKHN0b3JhZ2UuZ2V0SXRlbShrZXkpKSA/PyB7fTtcbiAgY29uc3Qgd3JpdGUgPSAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBzdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICByZXR1cm4ge1xuICAgIGdldCBtaWdyYXRpb24oKSB7IHJldHVybiBtaWdyYXRpb247IH0sXG4gICAgY29tbWl0TWlncmF0aW9uOiAoKSA9PiB7XG4gICAgICBtaWdyYXRpb24gPSBjb21taXRSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24obWlncmF0aW9uLCBzdG9yYWdlKTtcbiAgICAgIHJldHVybiBtaWdyYXRpb247XG4gICAgfSxcbiAgICByb2xsYmFja01pZ3JhdGlvbjogKCkgPT4ge1xuICAgICAgbWlncmF0aW9uID0gcm9sbGJhY2tSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24obWlncmF0aW9uLCBzdG9yYWdlKTtcbiAgICAgIHJldHVybiBtaWdyYXRpb247XG4gICAgfSxcbiAgICBnZXQ6IDxUPihuYW1lOiBzdHJpbmcsIGZhbGxiYWNrPzogVCkgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIHJldHVybiBuYW1lIGluIGN1cnJlbnQgPyAoY3VycmVudFtuYW1lXSBhcyBUKSA6IChmYWxsYmFjayBhcyBUKTtcbiAgICB9LFxuICAgIHNldDogKG5hbWU6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICBjdXJyZW50W25hbWVdID0gdmFsdWU7XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGRlbGV0ZTogKG5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGRlbGV0ZSBjdXJyZW50W25hbWVdO1xuICAgICAgd3JpdGUoY3VycmVudCk7XG4gICAgfSxcbiAgICBhbGw6ICgpID0+IHJlYWQoKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBFeGVyY2lzZSB0aGUgZXhhY3QgcHJlcGFyZS9jb21taXQvcm9sbGJhY2sgcGF0aCB1c2VkIGJ5IGEgcHJvbW90aW9uIHByb2JlLlxuICogRXZlcnkgc3ludGhldGljIGtleSBpcyByZW1vdmVkIGFuZCB2ZXJpZmllZCBiZWZvcmUgc3VjY2VzcyBpcyByZXR1cm5lZDtcbiAqIGNsZWFudXAgZmFpbHVyZSBpcyBhIGZhaWxlZCBoZWFsdGggcmVzdWx0LCBuZXZlciBhIHNpbGVudCByZXNpZHVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyaWZ5UmVuZGVyZXJTdG9yYWdlUm9sbGJhY2soXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuICBub25jZTogc3RyaW5nLFxuKTogXCJwYXNzXCIgfCBcImZhaWxcIiB7XG4gIGNvbnN0IHN1ZmZpeCA9IGBwcm9tb3Rpb24taGVhbHRoLW9yaWdpbmFsLSR7bm9uY2V9YDtcbiAgY29uc3QgY3VycmVudElkID0gYGNvLnR3ZWFrZXJzLiR7c3VmZml4fWA7XG4gIGNvbnN0IGN1cnJlbnRLZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7Y3VycmVudElkfWA7XG4gIGNvbnN0IGxlZ2FjeUtleSA9IGAke0xFR0FDWV9TVE9SQUdFX1BSRUZJWH1jby5wcm9tb3Rpb24tcHJvYmUuJHtzdWZmaXh9YDtcbiAgY29uc3QgZXhwZWN0ZWRBcmNoaXZlS2V5ID0gYCR7QVJDSElWRV9TVE9SQUdFX1BSRUZJWH0ke25vbmNlfToke2VuY29kZVVSSUNvbXBvbmVudChsZWdhY3lLZXkpfWA7XG4gIGNvbnN0IHJhdyA9IEpTT04uc3RyaW5naWZ5KHsgcmV0YWluZWQ6IHRydWUsIG5vbmNlIH0pO1xuICBsZXQgb3duc1Byb2JlS2V5cyA9IGZhbHNlO1xuICBsZXQgcmVzdWx0OiBcInBhc3NcIiB8IFwiZmFpbFwiID0gXCJmYWlsXCI7XG4gIGxldCBjbGVhbnVwU3VjY2VlZGVkID0gdHJ1ZTtcblxuICB0cnkge1xuICAgIGlmIChzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgIT09IG51bGwgfHwgc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgIT09IG51bGwpIHtcbiAgICAgIHJlc3VsdCA9IFwiZmFpbFwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBvd25zUHJvYmVLZXlzID0gdHJ1ZTtcbiAgICAgIHN0b3JhZ2Uuc2V0SXRlbShsZWdhY3lLZXksIHJhdyk7XG4gICAgICBjb25zdCBwcmVwYXJlZCA9IHByZXBhcmVSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oY3VycmVudElkLCBzdG9yYWdlLCBub25jZSk7XG4gICAgICBpZiAocHJlcGFyZWQuc3RhdHVzICE9PSBcInByZXBhcmVkXCIgfHwgcHJlcGFyZWQuaG9sZFByb21vdGlvbiB8fCBzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgIT09IHJhdykge1xuICAgICAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IGNvbW1pdFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihwcmVwYXJlZCwgc3RvcmFnZSk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBjb21taXR0ZWQucGhhc2UgIT09IFwiY29tbWl0dGVkXCJcbiAgICAgICAgICB8fCBjb21taXR0ZWQuYXJjaGl2ZUtleSAhPT0gZXhwZWN0ZWRBcmNoaXZlS2V5XG4gICAgICAgICAgfHwgc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgIT09IG51bGxcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmVzdWx0ID0gXCJmYWlsXCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3Qgcm9sbGVkQmFjayA9IHJvbGxiYWNrUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKGNvbW1pdHRlZCwgc3RvcmFnZSk7XG4gICAgICAgICAgcmVzdWx0ID0gcm9sbGVkQmFjay5waGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiXG4gICAgICAgICAgICAmJiBzdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSA9PT0gcmF3XG4gICAgICAgICAgICAmJiBzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgPT09IG51bGxcbiAgICAgICAgICAgICYmIHN0b3JhZ2UuZ2V0SXRlbShleHBlY3RlZEFyY2hpdmVLZXkpID09PSBudWxsXG4gICAgICAgICAgICA/IFwicGFzc1wiXG4gICAgICAgICAgICA6IFwiZmFpbFwiO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAob3duc1Byb2JlS2V5cykge1xuICAgICAgY29uc3QgcmVtb3ZlQW5kVmVyaWZ5ID0gKGtleTogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgc3RvcmFnZS5yZW1vdmVJdGVtKGtleSk7XG4gICAgICAgICAgcmV0dXJuIHN0b3JhZ2UuZ2V0SXRlbShrZXkpID09PSBudWxsO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGVhbnVwU3VjY2VlZGVkID0gcmVtb3ZlQW5kVmVyaWZ5KGN1cnJlbnRLZXkpICYmIGNsZWFudXBTdWNjZWVkZWQ7XG4gICAgICBjbGVhbnVwU3VjY2VlZGVkID0gcmVtb3ZlQW5kVmVyaWZ5KGxlZ2FjeUtleSkgJiYgY2xlYW51cFN1Y2NlZWRlZDtcbiAgICAgIGNsZWFudXBTdWNjZWVkZWQgPSByZW1vdmVBbmRWZXJpZnkoZXhwZWN0ZWRBcmNoaXZlS2V5KSAmJiBjbGVhbnVwU3VjY2VlZGVkO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQgPT09IFwicGFzc1wiICYmIGNsZWFudXBTdWNjZWVkZWQgPyBcInBhc3NcIiA6IFwiZmFpbFwiO1xufVxuIiwgImV4cG9ydCB0eXBlIFByb21vdGlvblJlbmRlcmVyTW91bnRTdGF0ZSA9IFwid2FpdGluZ1wiIHwgXCJtb3VudGVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uUmVuZGVyZXJSb290T2JzZXJ2YXRpb24ge1xuICByb290UHJlc2VudDogYm9vbGVhbjtcbiAgc3RhcnR1cExvYWRlclByZXNlbnQ6IGJvb2xlYW47XG4gIGVsZW1lbnRDaGlsZENvdW50OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIge1xuICBvYnNlcnZlKG9ic2VydmF0aW9uOiBQcm9tb3Rpb25SZW5kZXJlclJvb3RPYnNlcnZhdGlvbik6IFByb21vdGlvblJlbmRlcmVyTW91bnRTdGF0ZTtcbiAgcmVzdWx0KCk6IFByb21vdGlvblJlbmRlcmVyTW91bnRTdGF0ZTtcbn1cblxuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZID0gXCJ0d2Vha2VyUHJvbW90aW9uTm9uY2VcIjtcbmNvbnN0IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9QQVRURVJOID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pO1xuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX0FVVEhfUkVTUE9OU0VfTUFYX0NIQVJTID0gMV8wMjQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uUmVxdWVzdCB7XG4gIHZlcnNpb246IDE7XG4gIHVybDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvblJlc3BvbnNlIHtcbiAgdmVyc2lvbjogMTtcbiAgbm9uY2U6IHN0cmluZztcbiAgdXJsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvbkF0dGVtcHQgPVxuICB8IHsga2luZDogXCJvcmRpbmFyeVwiIH1cbiAgfCB7IGtpbmQ6IFwiaW52YWxpZC1jYW5kaWRhdGVcIjsgcmVhc29uOiBzdHJpbmcgfVxuICB8IHtcbiAgICBraW5kOiBcImNhbmRpZGF0ZVwiO1xuICAgIG5vbmNlOiBzdHJpbmc7XG4gICAgcmVxdWVzdDogUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uUmVxdWVzdDtcbiAgfTtcblxuLyoqXG4gKiBDbGFzc2lmaWVzIHRoZSBjdXJyZW50IGRvY3VtZW50IGJlZm9yZSBwYWdlIHNjcmlwdHMgcnVuLiBPcmRpbmFyeSB3aW5kb3dzXG4gKiB0YWtlIHRoZSBub3JtYWwgcHJlbG9hZCBwYXRoLiBBIFVSTCB0aGF0IGNhcnJpZXMgdGhlIHJlc2VydmVkIHByb29mIHF1ZXJ5IGlzXG4gKiBmYWlsLWNsb3NlZCB1bmxlc3MgaXQgaXMgdGhlIG9uZSBleGFjdCBjYW5kaWRhdGUgZG9jdW1lbnQgc2hhcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25BdHRlbXB0KGhyZWY6IHN0cmluZyk6IFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvbkF0dGVtcHQge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwoaHJlZik7XG4gICAgY29uc3QgcXVlcnlFbnRyaWVzID0gWy4uLnBhcnNlZC5zZWFyY2hQYXJhbXMuZW50cmllcygpXTtcbiAgICBjb25zdCBoYXNSZXNlcnZlZFF1ZXJ5ID0gcXVlcnlFbnRyaWVzLnNvbWUoKFtrZXldKSA9PiBrZXkgPT09IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9RVUVSWSk7XG4gICAgaWYgKCFoYXNSZXNlcnZlZFF1ZXJ5KSByZXR1cm4geyBraW5kOiBcIm9yZGluYXJ5XCIgfTtcbiAgICBpZiAoXG4gICAgICBwYXJzZWQucHJvdG9jb2wgIT09IFwiYXBwOlwiXG4gICAgICB8fCBwYXJzZWQuaG9zdG5hbWUgIT09IFwiLVwiXG4gICAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wYXNzd29yZCAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBvcnQgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wYXRobmFtZSAhPT0gXCIvaW5kZXguaHRtbFwiXG4gICAgICB8fCBwYXJzZWQuaGFzaCAhPT0gXCJcIlxuICAgICAgfHwgcXVlcnlFbnRyaWVzLmxlbmd0aCAhPT0gMVxuICAgICAgfHwgcXVlcnlFbnRyaWVzWzBdPy5bMF0gIT09IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9RVUVSWVxuICAgICkgcmV0dXJuIHsga2luZDogXCJpbnZhbGlkLWNhbmRpZGF0ZVwiLCByZWFzb246IFwiY2FuZGlkYXRlIFVSTCBzaGFwZSBpbnZhbGlkXCIgfTtcbiAgICBjb25zdCBub25jZSA9IHF1ZXJ5RW50cmllc1swXVsxXTtcbiAgICBpZiAoIVBST01PVElPTl9SRU5ERVJFUl9OT05DRV9QQVRURVJOLnRlc3Qobm9uY2UpKSB7XG4gICAgICByZXR1cm4geyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCIsIHJlYXNvbjogXCJjYW5kaWRhdGUgbm9uY2UgaW52YWxpZFwiIH07XG4gICAgfVxuICAgIGlmIChwYXJzZWQudG9TdHJpbmcoKSAhPT0gaHJlZikge1xuICAgICAgcmV0dXJuIHsga2luZDogXCJpbnZhbGlkLWNhbmRpZGF0ZVwiLCByZWFzb246IFwiY2FuZGlkYXRlIFVSTCBpcyBub3QgY2Fub25pY2FsXCIgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwiY2FuZGlkYXRlXCIsXG4gICAgICBub25jZSxcbiAgICAgIHJlcXVlc3Q6IHsgdmVyc2lvbjogMSwgdXJsOiBocmVmIH0sXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsga2luZDogXCJvcmRpbmFyeVwiIH07XG4gIH1cbn1cblxuLyoqIEFjY2VwdHMgb25seSB0aGUgZXhhY3Qgc3luY2hyb25vdXMgbWFpbi1wcm9jZXNzIGF1dGhvcml6YXRpb24gcmVzcG9uc2UuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemVkTm9uY2UoXG4gIGF0dGVtcHQ6IFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvbkF0dGVtcHQsXG4gIHJlc3BvbnNlOiB1bmtub3duLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChcbiAgICBhdHRlbXB0LmtpbmQgIT09IFwiY2FuZGlkYXRlXCJcbiAgICB8fCB0eXBlb2YgcmVzcG9uc2UgIT09IFwic3RyaW5nXCJcbiAgICB8fCByZXNwb25zZS5sZW5ndGggPT09IDBcbiAgICB8fCByZXNwb25zZS5sZW5ndGggPiBQUk9NT1RJT05fUkVOREVSRVJfQVVUSF9SRVNQT05TRV9NQVhfQ0hBUlNcbiAgKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGRlY29kZWQgPSBKU09OLnBhcnNlKHJlc3BvbnNlKSBhcyB1bmtub3duO1xuICAgIGlmIChkZWNvZGVkID09PSBudWxsIHx8IHR5cGVvZiBkZWNvZGVkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkoZGVjb2RlZCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHZhbHVlID0gZGVjb2RlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBpZiAoT2JqZWN0LmtleXModmFsdWUpLnNvcnQoKS5qb2luKFwiLFwiKSAhPT0gXCJub25jZSx1cmwsdmVyc2lvblwiKSByZXR1cm4gbnVsbDtcbiAgICBpZiAodmFsdWUudmVyc2lvbiAhPT0gMSB8fCB0eXBlb2YgdmFsdWUubm9uY2UgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIHZhbHVlLnVybCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gICAgaWYgKCFQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUEFUVEVSTi50ZXN0KHZhbHVlLm5vbmNlKSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKHZhbHVlLm5vbmNlICE9PSBhdHRlbXB0Lm5vbmNlIHx8IHZhbHVlLnVybCAhPT0gYXR0ZW1wdC5yZXF1ZXN0LnVybCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTCh2YWx1ZS51cmwpO1xuICAgIGNvbnN0IGVudHJpZXMgPSBbLi4ucGFyc2VkLnNlYXJjaFBhcmFtcy5lbnRyaWVzKCldO1xuICAgIGlmIChcbiAgICAgIHBhcnNlZC5wcm90b2NvbCAhPT0gXCJhcHA6XCJcbiAgICAgIHx8IHBhcnNlZC5ob3N0bmFtZSAhPT0gXCItXCJcbiAgICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucG9ydCAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhdGhuYW1lICE9PSBcIi9pbmRleC5odG1sXCJcbiAgICAgIHx8IHBhcnNlZC5oYXNoICE9PSBcIlwiXG4gICAgICB8fCBlbnRyaWVzLmxlbmd0aCAhPT0gMVxuICAgICAgfHwgZW50cmllc1swXT8uWzBdICE9PSBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUllcbiAgICAgIHx8IGVudHJpZXNbMF1bMV0gIT09IHZhbHVlLm5vbmNlXG4gICAgICB8fCBwYXJzZWQudG9TdHJpbmcoKSAhPT0gdmFsdWUudXJsXG4gICAgKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gdmFsdWUubm9uY2U7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogUHJvdmVzIHRoZSBhcHBsaWNhdGlvbiByZW5kZXJlciByZXBsYWNlZCBpdHMgc3RhdGljIHN0YXJ0dXAgbG9hZGVyIHdpdGggcmVhbFxuICogY29udGVudC4gQSBwcmUtZXhpc3Rpbmcgbm9uLWVtcHR5IHJvb3QgaXMgaW5zdWZmaWNpZW50OiB0aGUgdHJhY2tlciBtdXN0XG4gKiBmaXJzdCBvYnNlcnZlIHRoZSBjYW5vbmljYWwgbG9hZGVyIGFuZCB0aGVuIG9ic2VydmUgYSBub24tZW1wdHkgcmVwbGFjZW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQcm9tb3Rpb25SZW5kZXJlck1vdW50VHJhY2tlcigpOiBQcm9tb3Rpb25SZW5kZXJlck1vdW50VHJhY2tlciB7XG4gIGxldCBzYXdTdGFydHVwTG9hZGVyID0gZmFsc2U7XG4gIGxldCBtb3VudGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIHtcbiAgICBvYnNlcnZlKG9ic2VydmF0aW9uKSB7XG4gICAgICBpZiAobW91bnRlZCkgcmV0dXJuIFwibW91bnRlZFwiO1xuICAgICAgaWYgKCFvYnNlcnZhdGlvbi5yb290UHJlc2VudCkgcmV0dXJuIFwid2FpdGluZ1wiO1xuICAgICAgaWYgKG9ic2VydmF0aW9uLnN0YXJ0dXBMb2FkZXJQcmVzZW50KSB7XG4gICAgICAgIHNhd1N0YXJ0dXBMb2FkZXIgPSB0cnVlO1xuICAgICAgICByZXR1cm4gXCJ3YWl0aW5nXCI7XG4gICAgICB9XG4gICAgICBpZiAoc2F3U3RhcnR1cExvYWRlciAmJiBOdW1iZXIuaXNTYWZlSW50ZWdlcihvYnNlcnZhdGlvbi5lbGVtZW50Q2hpbGRDb3VudCkgJiYgb2JzZXJ2YXRpb24uZWxlbWVudENoaWxkQ291bnQgPiAwKSB7XG4gICAgICAgIG1vdW50ZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1vdW50ZWQgPyBcIm1vdW50ZWRcIiA6IFwid2FpdGluZ1wiO1xuICAgIH0sXG4gICAgcmVzdWx0KCkge1xuICAgICAgcmV0dXJuIG1vdW50ZWQgPyBcIm1vdW50ZWRcIiA6IFwid2FpdGluZ1wiO1xuICAgIH0sXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFBQSxzQkFBNEI7OztBQ0E1QixJQUFNLGlCQUFpQixJQUFJLFlBQVk7QUFBQSxFQUNyQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQ3RDLENBQUM7QUFFRCxJQUFNLGVBQWUsSUFBSSxZQUFZO0FBQUEsRUFDbkM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtB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SyxFQUFFLEtBQUssR0FBRyxNQUFNLHVCQUMzQyxPQUFPLFlBQVksS0FDbkIsT0FBTyxPQUFPLFVBQVUsWUFDeEIseUVBQXlFLEtBQUssT0FBTyxLQUFLLEtBQzFGLE9BQU8sUUFBUSxjQUNoQixTQUNBO0FBQ047QUFJQSxJQUFNLGdCQUFnQixTQUFTO0FBQy9CLElBQU0sZUFBZSw2QkFBNkIsYUFBYTtBQUMvRCxJQUFJLGdCQUF5QjtBQUM3QixJQUFJLGlCQUFpQixNQUFNO0FBQ3pCLE1BQUk7QUFDRixvQkFBZ0IsNEJBQVksU0FBUywwQ0FBMEM7QUFBQSxNQUM3RSxTQUFTO0FBQUEsTUFDVCxLQUFLO0FBQUEsTUFDTCxtQkFBbUI7QUFBQSxJQUNyQixDQUFDO0FBQUEsRUFDSCxRQUFRO0FBQ04sb0JBQWdCO0FBQUEsRUFDbEI7QUFDRjtBQUVBLElBQU0sc0JBQXNCLGlCQUFpQixPQUN6QyxPQUNBLHdCQUF3QixlQUFlLFlBQVk7QUFDdkQsSUFBSSxxQkFBcUI7QUFDdkIsK0JBQTZCLG1CQUFtQjtBQUNsRDtBQUVBLFNBQVMsNkJBQTZCLFlBQWlDO0FBQ3JFLFFBQU0sUUFBUSxvQ0FBb0M7QUFDbEQsTUFBSSxVQUFVO0FBQ2QsUUFBTSxXQUFXLElBQUksaUJBQWlCLE9BQU87QUFDN0MsUUFBTSxVQUFVLE9BQU8sV0FBVyxNQUFNO0FBQ3RDLFFBQUksUUFBUztBQUNiLGNBQVU7QUFDVixhQUFTLFdBQVc7QUFBQSxFQUN0QixHQUFHLGdCQUFnQjtBQUVuQixXQUFTLFVBQWdCO0FBQ3ZCLFFBQUksUUFBUztBQUNiLFVBQU0sT0FBTyxTQUFTLGVBQWUsTUFBTTtBQUMzQyxVQUFNLFFBQVEsTUFBTSxRQUFRO0FBQUEsTUFDMUIsYUFBYSxTQUFTO0FBQUEsTUFDdEIsc0JBQXNCLFNBQVMsUUFBUSxLQUFLLGNBQWMsMEJBQTBCLE1BQU07QUFBQSxNQUMxRixtQkFBbUIsTUFBTSxTQUFTLFVBQVU7QUFBQSxJQUM5QyxDQUFDO0FBQ0QsUUFBSSxVQUFVLFVBQVc7QUFDekIsY0FBVTtBQUNWLGFBQVMsV0FBVztBQUNwQixXQUFPLGFBQWEsT0FBTztBQUMzQixnQ0FBWSxLQUFLLHlDQUF5QztBQUFBLE1BQ3hELE9BQU8sV0FBVztBQUFBLE1BQ2xCLEtBQUs7QUFBQSxNQUNMLFdBQVc7QUFBQSxNQUNYLG1CQUFtQjtBQUFBLE1BQ25CLHlCQUF5Qiw4QkFBOEIsY0FBYyxXQUFXLEtBQUs7QUFBQSxJQUN2RixDQUFDO0FBQUEsRUFDSDtBQUVBLFdBQVMsUUFBUSxVQUFVLEVBQUUsV0FBVyxNQUFNLFNBQVMsS0FBSyxDQUFDO0FBQzdELFVBQVE7QUFDVjsiLAogICJuYW1lcyI6IFtdCn0K
