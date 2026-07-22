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

// src/preload/promotion-original-renderer-lifecycle.ts
function createPromotionOriginalRendererMountLifecycle(options) {
  const scheduler = options.scheduler ?? {
    set(callback, timeoutMs) {
      return setTimeout(callback, timeoutMs);
    },
    clear(handle2) {
      clearTimeout(handle2);
    }
  };
  let phase = "loading";
  let mounted = false;
  let handle = null;
  const settle = (callback) => {
    if (phase === "settled") return;
    if (handle !== null) scheduler.clear(handle);
    handle = null;
    phase = "settled";
    callback?.();
  };
  return {
    mountObserved() {
      if (phase === "settled" || mounted) return false;
      mounted = true;
      if (phase === "mount") settle(options.onMounted);
      return true;
    },
    windowLoaded() {
      if (phase !== "loading") return false;
      phase = "mount";
      if (mounted) {
        settle(options.onMounted);
      } else {
        handle = scheduler.set(() => {
          if (phase !== "mount") return;
          handle = null;
          phase = "settled";
          options.onTimeout();
        }, options.timeoutMs);
      }
      return true;
    },
    settle() {
      settle();
    },
    phase() {
      return phase;
    }
  };
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
  let observer = null;
  const stopObserving = () => {
    window.removeEventListener("load", onWindowLoad);
    observer?.disconnect();
  };
  const lifecycle = createPromotionOriginalRendererMountLifecycle({
    timeoutMs: MOUNT_TIMEOUT_MS,
    onMounted() {
      stopObserving();
      import_electron.ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
        nonce: authorized.nonce,
        url: unmodifiedUrl,
        lifecycle: "renderer-mounted",
        rendererSandboxed: effectiveRendererSandboxed,
        rendererStorageSelfTest: verifyRendererStorageRollback(localStorage, authorized.nonce)
      });
    },
    onTimeout() {
      stopObserving();
      import_electron.ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
        nonce: authorized.nonce,
        url: unmodifiedUrl,
        lifecycle: "renderer-mount-timeout",
        rendererSandboxed: effectiveRendererSandboxed
      });
    }
  });
  function onWindowLoad() {
    lifecycle.windowLoaded();
  }
  function inspect() {
    if (lifecycle.phase() === "settled") return;
    const root = document.getElementById("root");
    const state = mount.observe({
      rootPresent: root !== null,
      startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
      elementChildCount: root?.children.length ?? 0
    });
    if (state !== "mounted") return;
    lifecycle.mountObserved();
  }
  observer = new MutationObserver(inspect);
  window.addEventListener("load", onWindowLoad, { once: true });
  if (document.readyState === "complete") onWindowLoad();
  observer.observe(document, { childList: true, subtree: true });
  inspect();
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3Byb21vdGlvbi1oZWFsdGgtcHJlbG9hZC50cyIsICIuLi9zcmMvcmVuZGVyZXItY3J5cHRvLnRzIiwgIi4uL3NyYy9yZW5kZXJlci1zdG9yYWdlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL3Byb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1saWZlY3ljbGUudHMiLCAiLi4vc3JjL3ByZWxvYWQvcHJvbW90aW9uLXJlbmRlcmVyLW1vdW50LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgdmVyaWZ5UmVuZGVyZXJTdG9yYWdlUm9sbGJhY2sgfSBmcm9tIFwiLi9yZW5kZXJlci1zdG9yYWdlXCI7XG5pbXBvcnQgeyBjcmVhdGVQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRMaWZlY3ljbGUgfSBmcm9tIFwiLi9wcmVsb2FkL3Byb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1saWZlY3ljbGVcIjtcbmltcG9ydCB7IGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyIH0gZnJvbSBcIi4vcHJlbG9hZC9wcm9tb3Rpb24tcmVuZGVyZXItbW91bnRcIjtcblxuLy8gS2VlcCB0aGlzIGRlZGljYXRlZCBzYW5kYm94IHByZWxvYWQgYnJvd3Nlci1vbmx5LiBJbXBvcnRpbmcgdGhlIG1haW4tcHJvY2Vzc1xuLy8gcHJvbW90aW9uIG1vZHVsZSB3b3VsZCBwdWxsIG5vZGU6ZnMvY3J5cHRvL3BhdGggaW50byBhIHJlbmRlcmVyIGJ1bmRsZS5cbi8vIFNvdXJjZS1pbnRlZ3JhdGlvbiB0ZXN0cyBiaW5kIHRoZXNlIGV4YWN0IGNvbnN0YW50cyB0byB0aGUgbWFpbiBtb2R1bGUuXG5jb25zdCBQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfVVJMID0gXCJhcHA6Ly8tL2luZGV4Lmh0bWxcIjtcbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9BVVRIX0NIQU5ORUwgPSBcInR3ZWFrZXI6cHJvbW90aW9uLW9yaWdpbmFsLXJlbmRlcmVyLWF1dGhvcml6ZVwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0lQQ19DSEFOTkVMID0gXCJ0d2Vha2VyOnByb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1wcm9vZlwiO1xuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZID0gXCJ0d2Vha2VyUHJvbW90aW9uTm9uY2VcIjtcbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9RVUVSWV9LRVlTID0gbmV3IFNldChbXCJob3N0SWRcIiwgXCJpbml0aWFsUm91dGVcIl0pO1xuY29uc3QgZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQgPSBwcm9jZXNzLnNhbmRib3hlZCA9PT0gdHJ1ZTtcblxuLy8gS2VwdCBmaXZlIHNlY29uZHMgYmVsb3cgdGhlIG1haW4tcHJvY2VzcyBtb3VudCBwaGFzZSBzbyB0aGlzIGV4YWN0LCBib3VuZFxuLy8gZmFpbHVyZSBpcyBvYnNlcnZlZCBhbmQgY2xlYW5lZCB1cCBiZWZvcmUgdGhlIG91dGVyIG1vdW50IGRlYWRsaW5lIGNhbiBmaXJlLlxuY29uc3QgTU9VTlRfVElNRU9VVF9NUyA9IDU1XzAwMDtcblxudHlwZSBBdXRob3JpemF0aW9uID0geyB2ZXJzaW9uOiAxOyBub25jZTogc3RyaW5nOyB1cmw6IHN0cmluZyB9O1xuXG5mdW5jdGlvbiBjYW5vbmljYWxPcmlnaW5hbFJlbmRlcmVyVXJsKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChcbiAgICB0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCJcbiAgICB8fCB2YWx1ZS5sZW5ndGggPT09IDBcbiAgICB8fCB2YWx1ZS5sZW5ndGggPiA4XzE5MlxuICAgIHx8IC9bXFx1MDAwMC1cXHUwMDFmXFx1MDA3Zl0vLnRlc3QodmFsdWUpXG4gICkgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJzZWQ6IFVSTDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKHZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKFxuICAgIHBhcnNlZC5wcm90b2NvbCAhPT0gXCJhcHA6XCJcbiAgICB8fCBwYXJzZWQuaG9zdG5hbWUgIT09IFwiLVwiXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBvcnQgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGF0aG5hbWUgIT09IFwiL2luZGV4Lmh0bWxcIlxuICAgIHx8IHBhcnNlZC5oYXNoICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnNlYXJjaFBhcmFtcy5oYXMoUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZKVxuICAgIHx8IHBhcnNlZC50b1N0cmluZygpICE9PSB2YWx1ZVxuICApIHJldHVybiBudWxsO1xuICBjb25zdCBxdWVyeUtleXMgPSBbLi4ucGFyc2VkLnNlYXJjaFBhcmFtcy5rZXlzKCldO1xuICBpZiAoXG4gICAgcXVlcnlLZXlzLnNvbWUoKGtleSkgPT4gIVBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9RVUVSWV9LRVlTLmhhcyhrZXkpKVxuICAgIHx8IG5ldyBTZXQocXVlcnlLZXlzKS5zaXplICE9PSBxdWVyeUtleXMubGVuZ3RoXG4gICkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhvc3RJZCA9IHBhcnNlZC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpO1xuICBjb25zdCBpbml0aWFsUm91dGUgPSBwYXJzZWQuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgaWYgKGhvc3RJZCAhPT0gbnVsbCAmJiAhL15bQS1aYS16MC05Ll86LV17MSwyNTZ9JC8udGVzdChob3N0SWQpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGluaXRpYWxSb3V0ZSAhPT0gbnVsbCAmJiAoXG4gICAgaW5pdGlhbFJvdXRlLmxlbmd0aCA9PT0gMFxuICAgIHx8IGluaXRpYWxSb3V0ZS5sZW5ndGggPiAyXzA0OFxuICAgIHx8ICFpbml0aWFsUm91dGUuc3RhcnRzV2l0aChcIi9cIilcbiAgICB8fCAvW1xcdTAwMDAtXFx1MDAxZlxcdTAwN2ZdLy50ZXN0KGluaXRpYWxSb3V0ZSlcbiAgKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gcGFyc2VFeGFjdEF1dGhvcml6YXRpb24odmFsdWU6IHVua25vd24sIGV4cGVjdGVkVXJsOiBzdHJpbmcpOiBBdXRob3JpemF0aW9uIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgdmFsdWUubGVuZ3RoID09PSAwIHx8IHZhbHVlLmxlbmd0aCA+IDFfMDI0KSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBudWxsO1xuICBjb25zdCByZWNvcmQgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBPYmplY3Qua2V5cyhyZWNvcmQpLnNvcnQoKS5qb2luKFwiLFwiKSA9PT0gXCJub25jZSx1cmwsdmVyc2lvblwiXG4gICAgJiYgcmVjb3JkLnZlcnNpb24gPT09IDFcbiAgICAmJiB0eXBlb2YgcmVjb3JkLm5vbmNlID09PSBcInN0cmluZ1wiXG4gICAgJiYgL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pLnRlc3QocmVjb3JkLm5vbmNlKVxuICAgICYmIHJlY29yZC51cmwgPT09IGV4cGVjdGVkVXJsXG4gICAgPyByZWNvcmQgYXMgQXV0aG9yaXphdGlvblxuICAgIDogbnVsbDtcbn1cblxuLy8gVGhpcyBlbnRyeSBpcyByZWdpc3RlcmVkIG9ubHkgZm9yIHRoZSBkaXNwb3NhYmxlIG9yaWdpbmFsLW1haW4gaGVhbHRoIG1vZGUuXG4vLyBJdCBydW5zIGJlZm9yZSBwYWdlIHBhcnNpbmcgYW5kIHRydXN0cyBubyBlbnZpcm9ubWVudCwgYXJndiwgb3IgVVJMIG5vbmNlLlxuY29uc3QgdW5tb2RpZmllZFVybCA9IGxvY2F0aW9uLmhyZWY7XG5jb25zdCBjYW5vbmljYWxVcmwgPSBjYW5vbmljYWxPcmlnaW5hbFJlbmRlcmVyVXJsKHVubW9kaWZpZWRVcmwpO1xubGV0IGF1dGhvcml6YXRpb246IHVua25vd24gPSBudWxsO1xuaWYgKGNhbm9uaWNhbFVybCAhPT0gbnVsbCkge1xuICB0cnkge1xuICAgIGF1dGhvcml6YXRpb24gPSBpcGNSZW5kZXJlci5zZW5kU3luYyhQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfQVVUSF9DSEFOTkVMLCB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgdXJsOiBjYW5vbmljYWxVcmwsXG4gICAgICByZW5kZXJlclNhbmRib3hlZDogZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQsXG4gICAgfSk7XG4gIH0gY2F0Y2gge1xuICAgIGF1dGhvcml6YXRpb24gPSBudWxsO1xuICB9XG59XG5cbmNvbnN0IHBhcnNlZEF1dGhvcml6YXRpb24gPSBjYW5vbmljYWxVcmwgPT09IG51bGxcbiAgPyBudWxsXG4gIDogcGFyc2VFeGFjdEF1dGhvcml6YXRpb24oYXV0aG9yaXphdGlvbiwgY2Fub25pY2FsVXJsKTtcbmlmIChwYXJzZWRBdXRob3JpemF0aW9uKSB7XG4gIG9ic2VydmVPcmlnaW5hbFJlbmRlcmVyTW91bnQocGFyc2VkQXV0aG9yaXphdGlvbik7XG59XG5cbmZ1bmN0aW9uIG9ic2VydmVPcmlnaW5hbFJlbmRlcmVyTW91bnQoYXV0aG9yaXplZDogQXV0aG9yaXphdGlvbik6IHZvaWQge1xuICBjb25zdCBtb3VudCA9IGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyKCk7XG4gIGxldCBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wT2JzZXJ2aW5nID0gKCk6IHZvaWQgPT4ge1xuICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibG9hZFwiLCBvbldpbmRvd0xvYWQpO1xuICAgIG9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG4gIH07XG4gIGNvbnN0IGxpZmVjeWNsZSA9IGNyZWF0ZVByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudExpZmVjeWNsZSh7XG4gICAgdGltZW91dE1zOiBNT1VOVF9USU1FT1VUX01TLFxuICAgIG9uTW91bnRlZCgpIHtcbiAgICAgIHN0b3BPYnNlcnZpbmcoKTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0lQQ19DSEFOTkVMLCB7XG4gICAgICAgIG5vbmNlOiBhdXRob3JpemVkLm5vbmNlLFxuICAgICAgICB1cmw6IHVubW9kaWZpZWRVcmwsXG4gICAgICAgIGxpZmVjeWNsZTogXCJyZW5kZXJlci1tb3VudGVkXCIsXG4gICAgICAgIHJlbmRlcmVyU2FuZGJveGVkOiBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCxcbiAgICAgICAgcmVuZGVyZXJTdG9yYWdlU2VsZlRlc3Q6IHZlcmlmeVJlbmRlcmVyU3RvcmFnZVJvbGxiYWNrKGxvY2FsU3RvcmFnZSwgYXV0aG9yaXplZC5ub25jZSksXG4gICAgICB9KTtcbiAgICB9LFxuICAgIG9uVGltZW91dCgpIHtcbiAgICAgIHN0b3BPYnNlcnZpbmcoKTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0lQQ19DSEFOTkVMLCB7XG4gICAgICAgIG5vbmNlOiBhdXRob3JpemVkLm5vbmNlLFxuICAgICAgICB1cmw6IHVubW9kaWZpZWRVcmwsXG4gICAgICAgIGxpZmVjeWNsZTogXCJyZW5kZXJlci1tb3VudC10aW1lb3V0XCIsXG4gICAgICAgIHJlbmRlcmVyU2FuZGJveGVkOiBlZmZlY3RpdmVSZW5kZXJlclNhbmRib3hlZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0pO1xuXG4gIGZ1bmN0aW9uIG9uV2luZG93TG9hZCgpOiB2b2lkIHtcbiAgICBsaWZlY3ljbGUud2luZG93TG9hZGVkKCk7XG4gIH1cblxuICBmdW5jdGlvbiBpbnNwZWN0KCk6IHZvaWQge1xuICAgIGlmIChsaWZlY3ljbGUucGhhc2UoKSA9PT0gXCJzZXR0bGVkXCIpIHJldHVybjtcbiAgICBjb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyb290XCIpO1xuICAgIGNvbnN0IHN0YXRlID0gbW91bnQub2JzZXJ2ZSh7XG4gICAgICByb290UHJlc2VudDogcm9vdCAhPT0gbnVsbCxcbiAgICAgIHN0YXJ0dXBMb2FkZXJQcmVzZW50OiByb290ICE9PSBudWxsICYmIHJvb3QucXVlcnlTZWxlY3RvcihcIjpzY29wZSA+IC5zdGFydHVwLWxvYWRlclwiKSAhPT0gbnVsbCxcbiAgICAgIGVsZW1lbnRDaGlsZENvdW50OiByb290Py5jaGlsZHJlbi5sZW5ndGggPz8gMCxcbiAgICB9KTtcbiAgICBpZiAoc3RhdGUgIT09IFwibW91bnRlZFwiKSByZXR1cm47XG4gICAgbGlmZWN5Y2xlLm1vdW50T2JzZXJ2ZWQoKTtcbiAgfVxuXG4gIG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoaW5zcGVjdCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCBvbldpbmRvd0xvYWQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgLy8gVGhlIHByZWxvYWQgbm9ybWFsbHkgcnVucyBiZWZvcmUgbG9hZCwgYnV0IHRoaXMgY2xvc2VzIHRoZSByZWdpc3RyYXRpb25cbiAgLy8gcmFjZSB3aXRob3V0IGdyYW50aW5nIGFub3RoZXIgZGVhZGxpbmUgb3IgZW1pdHRpbmcgdHdpY2UuXG4gIGlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSBcImNvbXBsZXRlXCIpIG9uV2luZG93TG9hZCgpO1xuICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgaW5zcGVjdCgpO1xufVxuIiwgImNvbnN0IFNIQTI1Nl9JTklUSUFMID0gbmV3IFVpbnQzMkFycmF5KFtcbiAgMHg2YTA5ZTY2NywgMHhiYjY3YWU4NSwgMHgzYzZlZjM3MiwgMHhhNTRmZjUzYSxcbiAgMHg1MTBlNTI3ZiwgMHg5YjA1Njg4YywgMHgxZjgzZDlhYiwgMHg1YmUwY2QxOSxcbl0pO1xuXG5jb25zdCBTSEEyNTZfUk9VTkQgPSBuZXcgVWludDMyQXJyYXkoW1xuICAweDQyOGEyZjk4LCAweDcxMzc0NDkxLCAweGI1YzBmYmNmLCAweGU5YjVkYmE1LFxuICAweDM5NTZjMjViLCAweDU5ZjExMWYxLCAweDkyM2Y4MmE0LCAweGFiMWM1ZWQ1LFxuICAweGQ4MDdhYTk4LCAweDEyODM1YjAxLCAweDI0MzE4NWJlLCAweDU1MGM3ZGMzLFxuICAweDcyYmU1ZDc0LCAweDgwZGViMWZlLCAweDliZGMwNmE3LCAweGMxOWJmMTc0LFxuICAweGU0OWI2OWMxLCAweGVmYmU0Nzg2LCAweDBmYzE5ZGM2LCAweDI0MGNhMWNjLFxuICAweDJkZTkyYzZmLCAweDRhNzQ4NGFhLCAweDVjYjBhOWRjLCAweDc2Zjk4OGRhLFxuICAweDk4M2U1MTUyLCAweGE4MzFjNjZkLCAweGIwMDMyN2M4LCAweGJmNTk3ZmM3LFxuICAweGM2ZTAwYmYzLCAweGQ1YTc5MTQ3LCAweDA2Y2E2MzUxLCAweDE0MjkyOTY3LFxuICAweDI3YjcwYTg1LCAweDJlMWIyMTM4LCAweDRkMmM2ZGZjLCAweDUzMzgwZDEzLFxuICAweDY1MGE3MzU0LCAweDc2NmEwYWJiLCAweDgxYzJjOTJlLCAweDkyNzIyYzg1LFxuICAweGEyYmZlOGExLCAweGE4MWE2NjRiLCAweGMyNGI4YjcwLCAweGM3NmM1MWEzLFxuICAweGQxOTJlODE5LCAweGQ2OTkwNjI0LCAweGY0MGUzNTg1LCAweDEwNmFhMDcwLFxuICAweDE5YTRjMTE2LCAweDFlMzc2YzA4LCAweDI3NDg3NzRjLCAweDM0YjBiY2I1LFxuICAweDM5MWMwY2IzLCAweDRlZDhhYTRhLCAweDViOWNjYTRmLCAweDY4MmU2ZmYzLFxuICAweDc0OGY4MmVlLCAweDc4YTU2MzZmLCAweDg0Yzg3ODE0LCAweDhjYzcwMjA4LFxuICAweDkwYmVmZmZhLCAweGE0NTA2Y2ViLCAweGJlZjlhM2Y3LCAweGM2NzE3OGYyLFxuXSk7XG5cbmZ1bmN0aW9uIHJvdGF0ZVJpZ2h0KHZhbHVlOiBudW1iZXIsIGFtb3VudDogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuICh2YWx1ZSA+Pj4gYW1vdW50KSB8ICh2YWx1ZSA8PCAoMzIgLSBhbW91bnQpKTtcbn1cblxuLyoqIFN5bmNocm9ub3VzIFNIQS0yNTYgZm9yIHRoZSBzYW5kYm94ZWQgcmVuZGVyZXIsIHdoaWNoIGNhbm5vdCBpbXBvcnQgTm9kZSBidWlsdC1pbnMuICovXG5leHBvcnQgZnVuY3Rpb24gc2hhMjU2SGV4VXRmOCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgaW5wdXQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodmFsdWUpO1xuICBjb25zdCBwYWRkZWRMZW5ndGggPSBNYXRoLmNlaWwoKGlucHV0Lmxlbmd0aCArIDkpIC8gNjQpICogNjQ7XG4gIGNvbnN0IHBhZGRlZCA9IG5ldyBVaW50OEFycmF5KHBhZGRlZExlbmd0aCk7XG4gIHBhZGRlZC5zZXQoaW5wdXQpO1xuICBwYWRkZWRbaW5wdXQubGVuZ3RoXSA9IDB4ODA7XG5cbiAgY29uc3QgYml0TGVuZ3RoID0gQmlnSW50KGlucHV0Lmxlbmd0aCkgKiA4bjtcbiAgY29uc3QgdmlldyA9IG5ldyBEYXRhVmlldyhwYWRkZWQuYnVmZmVyKTtcbiAgdmlldy5zZXRVaW50MzIocGFkZGVkTGVuZ3RoIC0gOCwgTnVtYmVyKChiaXRMZW5ndGggPj4gMzJuKSAmIDB4ZmZmZmZmZmZuKSwgZmFsc2UpO1xuICB2aWV3LnNldFVpbnQzMihwYWRkZWRMZW5ndGggLSA0LCBOdW1iZXIoYml0TGVuZ3RoICYgMHhmZmZmZmZmZm4pLCBmYWxzZSk7XG5cbiAgY29uc3Qgc3RhdGUgPSBuZXcgVWludDMyQXJyYXkoU0hBMjU2X0lOSVRJQUwpO1xuICBjb25zdCB3b3JkcyA9IG5ldyBVaW50MzJBcnJheSg2NCk7XG4gIGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IHBhZGRlZExlbmd0aDsgb2Zmc2V0ICs9IDY0KSB7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDE2OyBpbmRleCArPSAxKSB7XG4gICAgICB3b3Jkc1tpbmRleF0gPSB2aWV3LmdldFVpbnQzMihvZmZzZXQgKyBpbmRleCAqIDQsIGZhbHNlKTtcbiAgICB9XG4gICAgZm9yIChsZXQgaW5kZXggPSAxNjsgaW5kZXggPCB3b3Jkcy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgIGNvbnN0IHByaW9yMTUgPSB3b3Jkc1tpbmRleCAtIDE1XSE7XG4gICAgICBjb25zdCBwcmlvcjIgPSB3b3Jkc1tpbmRleCAtIDJdITtcbiAgICAgIGNvbnN0IHNtYWxsMCA9IHJvdGF0ZVJpZ2h0KHByaW9yMTUsIDcpIF4gcm90YXRlUmlnaHQocHJpb3IxNSwgMTgpIF4gKHByaW9yMTUgPj4+IDMpO1xuICAgICAgY29uc3Qgc21hbGwxID0gcm90YXRlUmlnaHQocHJpb3IyLCAxNykgXiByb3RhdGVSaWdodChwcmlvcjIsIDE5KSBeIChwcmlvcjIgPj4+IDEwKTtcbiAgICAgIHdvcmRzW2luZGV4XSA9ICh3b3Jkc1tpbmRleCAtIDE2XSEgKyBzbWFsbDAgKyB3b3Jkc1tpbmRleCAtIDddISArIHNtYWxsMSkgPj4+IDA7XG4gICAgfVxuXG4gICAgbGV0IFthLCBiLCBjLCBkLCBlLCBmLCBnLCBoXSA9IHN0YXRlO1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB3b3Jkcy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgIGNvbnN0IGxhcmdlMSA9IHJvdGF0ZVJpZ2h0KGUhLCA2KSBeIHJvdGF0ZVJpZ2h0KGUhLCAxMSkgXiByb3RhdGVSaWdodChlISwgMjUpO1xuICAgICAgY29uc3QgY2hvb3NlID0gKGUhICYgZiEpIF4gKH5lISAmIGchKTtcbiAgICAgIGNvbnN0IHRlbXBvcmFyeTEgPSAoaCEgKyBsYXJnZTEgKyBjaG9vc2UgKyBTSEEyNTZfUk9VTkRbaW5kZXhdISArIHdvcmRzW2luZGV4XSEpID4+PiAwO1xuICAgICAgY29uc3QgbGFyZ2UwID0gcm90YXRlUmlnaHQoYSEsIDIpIF4gcm90YXRlUmlnaHQoYSEsIDEzKSBeIHJvdGF0ZVJpZ2h0KGEhLCAyMik7XG4gICAgICBjb25zdCBtYWpvcml0eSA9IChhISAmIGIhKSBeIChhISAmIGMhKSBeIChiISAmIGMhKTtcbiAgICAgIGNvbnN0IHRlbXBvcmFyeTIgPSAobGFyZ2UwICsgbWFqb3JpdHkpID4+PiAwO1xuXG4gICAgICBoID0gZztcbiAgICAgIGcgPSBmO1xuICAgICAgZiA9IGU7XG4gICAgICBlID0gKGQhICsgdGVtcG9yYXJ5MSkgPj4+IDA7XG4gICAgICBkID0gYztcbiAgICAgIGMgPSBiO1xuICAgICAgYiA9IGE7XG4gICAgICBhID0gKHRlbXBvcmFyeTEgKyB0ZW1wb3JhcnkyKSA+Pj4gMDtcbiAgICB9XG5cbiAgICBzdGF0ZVswXSA9IChzdGF0ZVswXSEgKyBhISkgPj4+IDA7XG4gICAgc3RhdGVbMV0gPSAoc3RhdGVbMV0hICsgYiEpID4+PiAwO1xuICAgIHN0YXRlWzJdID0gKHN0YXRlWzJdISArIGMhKSA+Pj4gMDtcbiAgICBzdGF0ZVszXSA9IChzdGF0ZVszXSEgKyBkISkgPj4+IDA7XG4gICAgc3RhdGVbNF0gPSAoc3RhdGVbNF0hICsgZSEpID4+PiAwO1xuICAgIHN0YXRlWzVdID0gKHN0YXRlWzVdISArIGYhKSA+Pj4gMDtcbiAgICBzdGF0ZVs2XSA9IChzdGF0ZVs2XSEgKyBnISkgPj4+IDA7XG4gICAgc3RhdGVbN10gPSAoc3RhdGVbN10hICsgaCEpID4+PiAwO1xuICB9XG5cbiAgcmV0dXJuIFsuLi5zdGF0ZV0ubWFwKCh3b3JkKSA9PiB3b3JkLnRvU3RyaW5nKDE2KS5wYWRTdGFydCg4LCBcIjBcIikpLmpvaW4oXCJcIik7XG59XG5cbi8qKiBHZW5lcmF0ZXMgYSBVVUlEIHdpdGhvdXQgcmVseWluZyBvbiBzYW5kYm94LXVuYXZhaWxhYmxlIE5vZGUgY3J5cHRvLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlY3VyZVJlbmRlcmVyVXVpZCgpOiBzdHJpbmcge1xuICBjb25zdCBwcm92aWRlciA9IGdsb2JhbFRoaXMuY3J5cHRvO1xuICBpZiAodHlwZW9mIHByb3ZpZGVyPy5yYW5kb21VVUlEID09PSBcImZ1bmN0aW9uXCIpIHJldHVybiBwcm92aWRlci5yYW5kb21VVUlEKCk7XG4gIGlmICh0eXBlb2YgcHJvdmlkZXI/LmdldFJhbmRvbVZhbHVlcyAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwic2VjdXJlIHJlbmRlcmVyIHJhbmRvbW5lc3MgaXMgdW5hdmFpbGFibGVcIik7XG4gIH1cbiAgY29uc3QgYnl0ZXMgPSBwcm92aWRlci5nZXRSYW5kb21WYWx1ZXMobmV3IFVpbnQ4QXJyYXkoMTYpKTtcbiAgYnl0ZXNbNl0gPSAoYnl0ZXNbNl0hICYgMHgwZikgfCAweDQwO1xuICBieXRlc1s4XSA9IChieXRlc1s4XSEgJiAweDNmKSB8IDB4ODA7XG4gIGNvbnN0IGhleCA9IFsuLi5ieXRlc10ubWFwKChieXRlKSA9PiBieXRlLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpO1xuICByZXR1cm4gYCR7aGV4LnNsaWNlKDAsIDQpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDQsIDYpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDYsIDgpLmpvaW4oXCJcIil9LSR7aGV4LnNsaWNlKDgsIDEwKS5qb2luKFwiXCIpfS0ke2hleC5zbGljZSgxMCkuam9pbihcIlwiKX1gO1xufVxuIiwgImltcG9ydCB7IHNlY3VyZVJlbmRlcmVyVXVpZCwgc2hhMjU2SGV4VXRmOCB9IGZyb20gXCIuL3JlbmRlcmVyLWNyeXB0b1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VMaWtlIHtcbiAgcmVhZG9ubHkgbGVuZ3RoOiBudW1iZXI7XG4gIGdldEl0ZW0oa2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xuICBrZXkoaW5kZXg6IG51bWJlcik6IHN0cmluZyB8IG51bGw7XG4gIHNldEl0ZW0oa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICByZW1vdmVJdGVtKGtleTogc3RyaW5nKTogdm9pZDtcbn1cblxuY29uc3QgQ1VSUkVOVF9JRF9QUkVGSVggPSBcImNvLnR3ZWFrZXJzLlwiO1xuY29uc3QgTEVHQUNZX1NUT1JBR0VfUFJFRklYID0gYCR7W1wiY29kZXhcIiwgXCJwcFwiXS5qb2luKFwiXCIpfTpzdG9yYWdlOmA7XG5jb25zdCBDVVJSRU5UX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2U6XCI7XG5jb25zdCBBUkNISVZFX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2UtYXJjaGl2ZTpcIjtcblxuZXhwb3J0IHR5cGUgUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uU3RhdHVzID1cbiAgfCBcIm5vdF9hcHBsaWNhYmxlXCJcbiAgfCBcImFic2VudFwiXG4gIHwgXCJjYW5vbmljYWxcIlxuICB8IFwicHJlcGFyZWRcIlxuICB8IFwiYW1iaWd1b3VzXCJcbiAgfCBcImNvbmZsaWN0XCJcbiAgfCBcImludmFsaWRfY2Fub25pY2FsXCJcbiAgfCBcImludmFsaWRfbGVnYWN5XCJcbiAgfCBcIndyaXRlX2ZhaWxlZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmc7XG4gIGN1cnJlbnRLZXk6IHN0cmluZztcbiAgbGVnYWN5S2V5czogc3RyaW5nW107XG4gIHNlbGVjdGVkTGVnYWN5S2V5OiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblN0YXR1cztcbiAgaG9sZFByb21vdGlvbjogYm9vbGVhbjtcbiAgY3JlYXRlZENhbm9uaWNhbDogYm9vbGVhbjtcbiAgY2Fub25pY2FsQmVmb3JlSGFzaDogc3RyaW5nO1xuICBjYW5vbmljYWxBZnRlckhhc2g6IHN0cmluZztcbiAgc2VsZWN0ZWRMZWdhY3lIYXNoOiBzdHJpbmc7XG4gIGFyY2hpdmVLZXk6IHN0cmluZyB8IG51bGw7XG4gIHBoYXNlOiBcInBsYW5uZWRcIiB8IFwicHJlcGFyZWRcIiB8IFwiY29tbWl0dGVkXCIgfCBcInJvbGxlZF9iYWNrXCI7XG59XG5cbmludGVyZmFjZSBTdG9yYWdlTWlncmF0aW9uUGxhbiB7XG4gIHJlY2VpcHQ6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQ7XG4gIGNhbm9uaWNhbFJhdzogc3RyaW5nIHwgbnVsbDtcbiAgc2VsZWN0ZWRMZWdhY3lSYXc6IHN0cmluZyB8IG51bGw7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVjb3JkKHJhdzogc3RyaW5nIHwgbnVsbCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIHJldHVybiBwYXJzZWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpXG4gICAgICA/IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5nZXJwcmludChyYXc6IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICByZXR1cm4gcmF3ID09PSBudWxsID8gXCJtaXNzaW5nXCIgOiBzaGEyNTZIZXhVdGY4KHJhdyk7XG59XG5cbmZ1bmN0aW9uIGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5cyhpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSk6IHN0cmluZ1tdIHtcbiAgaWYgKCFpZC5zdGFydHNXaXRoKENVUlJFTlRfSURfUFJFRklYKSkgcmV0dXJuIFtdO1xuICBjb25zdCBzdWZmaXggPSBpZC5zbGljZShDVVJSRU5UX0lEX1BSRUZJWC5sZW5ndGgpO1xuICBpZiAoIXN1ZmZpeCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IHN1ZmZpeE1hcmtlciA9IGAuJHtzdWZmaXh9YDtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBrZXkgPSBzdG9yYWdlLmtleShpbmRleCk7XG4gICAgaWYgKCFrZXk/LnN0YXJ0c1dpdGgoTEVHQUNZX1NUT1JBR0VfUFJFRklYKSkgY29udGludWU7XG4gICAgY29uc3QgbGVnYWN5SWQgPSBrZXkuc2xpY2UoTEVHQUNZX1NUT1JBR0VfUFJFRklYLmxlbmd0aCk7XG4gICAgaWYgKFxuICAgICAgbGVnYWN5SWQgIT09IGlkXG4gICAgICAmJiBsZWdhY3lJZC5zdGFydHNXaXRoKFwiY28uXCIpXG4gICAgICAmJiBsZWdhY3lJZC5lbmRzV2l0aChzdWZmaXhNYXJrZXIpXG4gICAgICAmJiBsZWdhY3lJZC5zbGljZSgzLCAtc3VmZml4TWFya2VyLmxlbmd0aCkubGVuZ3RoID4gMFxuICAgICkge1xuICAgICAgY2FuZGlkYXRlcy5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi5jYW5kaWRhdGVzXS5zb3J0KCk7XG59XG5cbmZ1bmN0aW9uIGxlZ2FjeUtleXNGb3IoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGV4YWN0TGVnYWN5S2V5ID0gYCR7TEVHQUNZX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3Qga2V5cyA9IG5ldyBTZXQoZGlzY292ZXJMZWdhY3lQdWJsaXNoZXJLZXlzKGlkLCBzdG9yYWdlKSk7XG4gIGlmIChzdG9yYWdlLmdldEl0ZW0oZXhhY3RMZWdhY3lLZXkpICE9PSBudWxsKSBrZXlzLmFkZChleGFjdExlZ2FjeUtleSk7XG4gIHJldHVybiBbLi4ua2V5c10uc29ydCgpO1xufVxuXG5mdW5jdGlvbiBwbGFuTWlncmF0aW9uKFxuICBpZDogc3RyaW5nLFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nID0gc2VjdXJlUmVuZGVyZXJVdWlkKCksXG4pOiBTdG9yYWdlTWlncmF0aW9uUGxhbiB7XG4gIGNvbnN0IGN1cnJlbnRLZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3QgY2Fub25pY2FsUmF3ID0gc3RvcmFnZS5nZXRJdGVtKGN1cnJlbnRLZXkpO1xuICBjb25zdCBsZWdhY3lLZXlzID0gbGVnYWN5S2V5c0ZvcihpZCwgc3RvcmFnZSk7XG4gIGNvbnN0IHNlbGVjdGVkTGVnYWN5S2V5ID0gbGVnYWN5S2V5cy5sZW5ndGggPT09IDEgPyBsZWdhY3lLZXlzWzBdISA6IG51bGw7XG4gIGNvbnN0IHNlbGVjdGVkTGVnYWN5UmF3ID0gc2VsZWN0ZWRMZWdhY3lLZXkgPT09IG51bGwgPyBudWxsIDogc3RvcmFnZS5nZXRJdGVtKHNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgY29uc3QgYmFzZSA9IHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxIGFzIGNvbnN0LFxuICAgIHRyYW5zYWN0aW9uSWQsXG4gICAgY3VycmVudEtleSxcbiAgICBsZWdhY3lLZXlzLFxuICAgIHNlbGVjdGVkTGVnYWN5S2V5LFxuICAgIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLFxuICAgIGNhbm9uaWNhbEJlZm9yZUhhc2g6IGZpbmdlcnByaW50KGNhbm9uaWNhbFJhdyksXG4gICAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBmaW5nZXJwcmludChjYW5vbmljYWxSYXcpLFxuICAgIHNlbGVjdGVkTGVnYWN5SGFzaDogZmluZ2VycHJpbnQoc2VsZWN0ZWRMZWdhY3lSYXcpLFxuICAgIGFyY2hpdmVLZXk6IG51bGwsXG4gICAgcGhhc2U6IFwicGxhbm5lZFwiIGFzIGNvbnN0LFxuICB9O1xuXG4gIGlmICghaWQuc3RhcnRzV2l0aChDVVJSRU5UX0lEX1BSRUZJWCkpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJub3RfYXBwbGljYWJsZVwiLCBob2xkUHJvbW90aW9uOiBmYWxzZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKGxlZ2FjeUtleXMubGVuZ3RoID4gMSkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcImFtYmlndW91c1wiLCBob2xkUHJvbW90aW9uOiB0cnVlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAoY2Fub25pY2FsUmF3ICE9PSBudWxsICYmIHBhcnNlUmVjb3JkKGNhbm9uaWNhbFJhdykgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJpbnZhbGlkX2Nhbm9uaWNhbFwiLCBob2xkUHJvbW90aW9uOiB0cnVlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICBpZiAoc2VsZWN0ZWRMZWdhY3lSYXcgIT09IG51bGwgJiYgcGFyc2VSZWNvcmQoc2VsZWN0ZWRMZWdhY3lSYXcpID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiaW52YWxpZF9sZWdhY3lcIiwgaG9sZFByb21vdGlvbjogdHJ1ZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKGNhbm9uaWNhbFJhdyAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG1pc21hdGNoID0gc2VsZWN0ZWRMZWdhY3lSYXcgIT09IG51bGwgJiYgc2VsZWN0ZWRMZWdhY3lSYXcgIT09IGNhbm9uaWNhbFJhdztcbiAgICByZXR1cm4ge1xuICAgICAgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IG1pc21hdGNoID8gXCJjb25mbGljdFwiIDogXCJjYW5vbmljYWxcIiwgaG9sZFByb21vdGlvbjogbWlzbWF0Y2ggfSxcbiAgICAgIGNhbm9uaWNhbFJhdyxcbiAgICAgIHNlbGVjdGVkTGVnYWN5UmF3LFxuICAgIH07XG4gIH1cbiAgaWYgKHNlbGVjdGVkTGVnYWN5UmF3ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiYWJzZW50XCIsIGhvbGRQcm9tb3Rpb246IGZhbHNlIH0sIGNhbm9uaWNhbFJhdywgc2VsZWN0ZWRMZWdhY3lSYXcgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHJlY2VpcHQ6IHtcbiAgICAgIC4uLmJhc2UsXG4gICAgICBzdGF0dXM6IFwicHJlcGFyZWRcIixcbiAgICAgIGhvbGRQcm9tb3Rpb246IGZhbHNlLFxuICAgICAgY3JlYXRlZENhbm9uaWNhbDogdHJ1ZSxcbiAgICAgIGNhbm9uaWNhbEFmdGVySGFzaDogZmluZ2VycHJpbnQoc2VsZWN0ZWRMZWdhY3lSYXcpLFxuICAgIH0sXG4gICAgY2Fub25pY2FsUmF3LFxuICAgIHNlbGVjdGVkTGVnYWN5UmF3LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGxhblJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihcbiAgaWQ6IHN0cmluZyxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4gIHRyYW5zYWN0aW9uSWQ/OiBzdHJpbmcsXG4pOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgcmV0dXJuIHBsYW5NaWdyYXRpb24oaWQsIHN0b3JhZ2UsIHRyYW5zYWN0aW9uSWQpLnJlY2VpcHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmVwYXJlUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICBpZDogc3RyaW5nLFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgdHJhbnNhY3Rpb25JZD86IHN0cmluZyxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBjb25zdCBwbGFuID0gcGxhbk1pZ3JhdGlvbihpZCwgc3RvcmFnZSwgdHJhbnNhY3Rpb25JZCk7XG4gIGlmICghcGxhbi5yZWNlaXB0LmNyZWF0ZWRDYW5vbmljYWwgfHwgcGxhbi5zZWxlY3RlZExlZ2FjeVJhdyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgcGhhc2U6IFwicHJlcGFyZWRcIiB9O1xuICB9XG4gIHRyeSB7XG4gICAgaWYgKHN0b3JhZ2UuZ2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSkgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgc3RhdHVzOiBcImNvbmZsaWN0XCIsIGhvbGRQcm9tb3Rpb246IHRydWUsIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLCBwaGFzZTogXCJwcmVwYXJlZFwiIH07XG4gICAgfVxuICAgIHN0b3JhZ2Uuc2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSwgcGxhbi5zZWxlY3RlZExlZ2FjeVJhdyk7XG4gICAgaWYgKGZpbmdlcnByaW50KHN0b3JhZ2UuZ2V0SXRlbShwbGFuLnJlY2VpcHQuY3VycmVudEtleSkpICE9PSBwbGFuLnJlY2VpcHQuY2Fub25pY2FsQWZ0ZXJIYXNoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIHZlcmlmaWNhdGlvbiBmYWlsZWRcIik7XG4gICAgfVxuICAgIHJldHVybiB7IC4uLnBsYW4ucmVjZWlwdCwgcGhhc2U6IFwicHJlcGFyZWRcIiB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4ge1xuICAgICAgLi4ucGxhbi5yZWNlaXB0LFxuICAgICAgc3RhdHVzOiBcIndyaXRlX2ZhaWxlZFwiLFxuICAgICAgaG9sZFByb21vdGlvbjogdHJ1ZSxcbiAgICAgIGNyZWF0ZWRDYW5vbmljYWw6IGZhbHNlLFxuICAgICAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocGxhbi5yZWNlaXB0LmN1cnJlbnRLZXkpKSxcbiAgICAgIHBoYXNlOiBcInByZXBhcmVkXCIsXG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tbWl0UmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICByZWNlaXB0OiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0LFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBpZiAocmVjZWlwdC5waGFzZSA9PT0gXCJjb21taXR0ZWRcIikgcmV0dXJuIHJlY2VpcHQ7XG4gIGlmIChyZWNlaXB0LmhvbGRQcm9tb3Rpb24pIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgbWlncmF0aW9uIGlzIG9uIGhvbGRcIik7XG4gIGlmIChmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5jdXJyZW50S2V5KSkgIT09IHJlY2VpcHQuY2Fub25pY2FsQWZ0ZXJIYXNoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBjYW5vbmljYWwgdmFsdWUgY2hhbmdlZCBiZWZvcmUgY29tbWl0XCIpO1xuICB9XG4gIGlmIChyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5ID09PSBudWxsKSByZXR1cm4geyAuLi5yZWNlaXB0LCBwaGFzZTogXCJjb21taXR0ZWRcIiB9O1xuICBjb25zdCBsZWdhY3lSYXcgPSBzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSk7XG4gIGlmIChmaW5nZXJwcmludChsZWdhY3lSYXcpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCB8fCBsZWdhY3lSYXcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGxlZ2FjeSB2YWx1ZSBjaGFuZ2VkIGJlZm9yZSBjb21taXRcIik7XG4gIH1cbiAgY29uc3QgYXJjaGl2ZUtleSA9IGAke0FSQ0hJVkVfU1RPUkFHRV9QUkVGSVh9JHtyZWNlaXB0LnRyYW5zYWN0aW9uSWR9OiR7ZW5jb2RlVVJJQ29tcG9uZW50KHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpfWA7XG4gIGNvbnN0IGFyY2hpdmVkID0gc3RvcmFnZS5nZXRJdGVtKGFyY2hpdmVLZXkpO1xuICBpZiAoYXJjaGl2ZWQgIT09IG51bGwgJiYgYXJjaGl2ZWQgIT09IGxlZ2FjeVJhdykge1xuICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgYXJjaGl2ZSBjb2xsaXNpb25cIik7XG4gIH1cbiAgc3RvcmFnZS5zZXRJdGVtKGFyY2hpdmVLZXksIGxlZ2FjeVJhdyk7XG4gIGlmIChzdG9yYWdlLmdldEl0ZW0oYXJjaGl2ZUtleSkgIT09IGxlZ2FjeVJhdykgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBhcmNoaXZlIHZlcmlmaWNhdGlvbiBmYWlsZWRcIik7XG4gIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgcmV0dXJuIHsgLi4ucmVjZWlwdCwgYXJjaGl2ZUtleSwgcGhhc2U6IFwiY29tbWl0dGVkXCIgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJvbGxiYWNrUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKFxuICByZWNlaXB0OiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0LFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbik6IFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblJlY2VpcHQge1xuICBpZiAocmVjZWlwdC5waGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiKSByZXR1cm4gcmVjZWlwdDtcbiAgaWYgKHJlY2VpcHQuYXJjaGl2ZUtleSAhPT0gbnVsbCAmJiByZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5ICE9PSBudWxsKSB7XG4gICAgY29uc3QgYXJjaGl2ZWQgPSBzdG9yYWdlLmdldEl0ZW0ocmVjZWlwdC5hcmNoaXZlS2V5KTtcbiAgICBpZiAoZmluZ2VycHJpbnQoYXJjaGl2ZWQpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCB8fCBhcmNoaXZlZCA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBhcmNoaXZlIGNoYW5nZWQgYmVmb3JlIHJvbGxiYWNrXCIpO1xuICAgIH1cbiAgICBjb25zdCBjdXJyZW50TGVnYWN5ID0gc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpO1xuICAgIGlmIChjdXJyZW50TGVnYWN5ICE9PSBudWxsICYmIGZpbmdlcnByaW50KGN1cnJlbnRMZWdhY3kpICE9PSByZWNlaXB0LnNlbGVjdGVkTGVnYWN5SGFzaCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBsZWdhY3kgdmFsdWUgY2hhbmdlZCBiZWZvcmUgcm9sbGJhY2tcIik7XG4gICAgfVxuICAgIGlmIChjdXJyZW50TGVnYWN5ID09PSBudWxsKSBzdG9yYWdlLnNldEl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSwgYXJjaGl2ZWQpO1xuICAgIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LmFyY2hpdmVLZXkpO1xuICB9XG4gIGlmIChyZWNlaXB0LmNyZWF0ZWRDYW5vbmljYWwpIHtcbiAgICBpZiAoZmluZ2VycHJpbnQoc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuY3VycmVudEtleSkpICE9PSByZWNlaXB0LmNhbm9uaWNhbEFmdGVySGFzaCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBjYW5vbmljYWwgdmFsdWUgY2hhbmdlZCBiZWZvcmUgcm9sbGJhY2tcIik7XG4gICAgfVxuICAgIHN0b3JhZ2UucmVtb3ZlSXRlbShyZWNlaXB0LmN1cnJlbnRLZXkpO1xuICB9XG4gIHJldHVybiB7IC4uLnJlY2VpcHQsIHBoYXNlOiBcInJvbGxlZF9iYWNrXCIgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlbmRlcmVyU3RvcmFnZShpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSkge1xuICBsZXQgbWlncmF0aW9uID0gcHJlcGFyZVJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihpZCwgc3RvcmFnZSk7XG4gIGNvbnN0IGtleSA9IGAke0NVUlJFTlRfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCByZWFkID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHBhcnNlUmVjb3JkKHN0b3JhZ2UuZ2V0SXRlbShrZXkpKSA/PyB7fTtcbiAgY29uc3Qgd3JpdGUgPSAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBzdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICByZXR1cm4ge1xuICAgIGdldCBtaWdyYXRpb24oKSB7IHJldHVybiBtaWdyYXRpb247IH0sXG4gICAgY29tbWl0TWlncmF0aW9uOiAoKSA9PiB7XG4gICAgICBtaWdyYXRpb24gPSBjb21taXRSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24obWlncmF0aW9uLCBzdG9yYWdlKTtcbiAgICAgIHJldHVybiBtaWdyYXRpb247XG4gICAgfSxcbiAgICByb2xsYmFja01pZ3JhdGlvbjogKCkgPT4ge1xuICAgICAgbWlncmF0aW9uID0gcm9sbGJhY2tSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24obWlncmF0aW9uLCBzdG9yYWdlKTtcbiAgICAgIHJldHVybiBtaWdyYXRpb247XG4gICAgfSxcbiAgICBnZXQ6IDxUPihuYW1lOiBzdHJpbmcsIGZhbGxiYWNrPzogVCkgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIHJldHVybiBuYW1lIGluIGN1cnJlbnQgPyAoY3VycmVudFtuYW1lXSBhcyBUKSA6IChmYWxsYmFjayBhcyBUKTtcbiAgICB9LFxuICAgIHNldDogKG5hbWU6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICBjdXJyZW50W25hbWVdID0gdmFsdWU7XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGRlbGV0ZTogKG5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGRlbGV0ZSBjdXJyZW50W25hbWVdO1xuICAgICAgd3JpdGUoY3VycmVudCk7XG4gICAgfSxcbiAgICBhbGw6ICgpID0+IHJlYWQoKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBFeGVyY2lzZSB0aGUgZXhhY3QgcHJlcGFyZS9jb21taXQvcm9sbGJhY2sgcGF0aCB1c2VkIGJ5IGEgcHJvbW90aW9uIHByb2JlLlxuICogRXZlcnkgc3ludGhldGljIGtleSBpcyByZW1vdmVkIGFuZCB2ZXJpZmllZCBiZWZvcmUgc3VjY2VzcyBpcyByZXR1cm5lZDtcbiAqIGNsZWFudXAgZmFpbHVyZSBpcyBhIGZhaWxlZCBoZWFsdGggcmVzdWx0LCBuZXZlciBhIHNpbGVudCByZXNpZHVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyaWZ5UmVuZGVyZXJTdG9yYWdlUm9sbGJhY2soXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuICBub25jZTogc3RyaW5nLFxuKTogXCJwYXNzXCIgfCBcImZhaWxcIiB7XG4gIGNvbnN0IHN1ZmZpeCA9IGBwcm9tb3Rpb24taGVhbHRoLW9yaWdpbmFsLSR7bm9uY2V9YDtcbiAgY29uc3QgY3VycmVudElkID0gYGNvLnR3ZWFrZXJzLiR7c3VmZml4fWA7XG4gIGNvbnN0IGN1cnJlbnRLZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7Y3VycmVudElkfWA7XG4gIGNvbnN0IGxlZ2FjeUtleSA9IGAke0xFR0FDWV9TVE9SQUdFX1BSRUZJWH1jby5wcm9tb3Rpb24tcHJvYmUuJHtzdWZmaXh9YDtcbiAgY29uc3QgZXhwZWN0ZWRBcmNoaXZlS2V5ID0gYCR7QVJDSElWRV9TVE9SQUdFX1BSRUZJWH0ke25vbmNlfToke2VuY29kZVVSSUNvbXBvbmVudChsZWdhY3lLZXkpfWA7XG4gIGNvbnN0IHJhdyA9IEpTT04uc3RyaW5naWZ5KHsgcmV0YWluZWQ6IHRydWUsIG5vbmNlIH0pO1xuICBsZXQgb3duc1Byb2JlS2V5cyA9IGZhbHNlO1xuICBsZXQgcmVzdWx0OiBcInBhc3NcIiB8IFwiZmFpbFwiID0gXCJmYWlsXCI7XG4gIGxldCBjbGVhbnVwU3VjY2VlZGVkID0gdHJ1ZTtcblxuICB0cnkge1xuICAgIGlmIChzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgIT09IG51bGwgfHwgc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgIT09IG51bGwpIHtcbiAgICAgIHJlc3VsdCA9IFwiZmFpbFwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBvd25zUHJvYmVLZXlzID0gdHJ1ZTtcbiAgICAgIHN0b3JhZ2Uuc2V0SXRlbShsZWdhY3lLZXksIHJhdyk7XG4gICAgICBjb25zdCBwcmVwYXJlZCA9IHByZXBhcmVSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oY3VycmVudElkLCBzdG9yYWdlLCBub25jZSk7XG4gICAgICBpZiAocHJlcGFyZWQuc3RhdHVzICE9PSBcInByZXBhcmVkXCIgfHwgcHJlcGFyZWQuaG9sZFByb21vdGlvbiB8fCBzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgIT09IHJhdykge1xuICAgICAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IGNvbW1pdFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihwcmVwYXJlZCwgc3RvcmFnZSk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBjb21taXR0ZWQucGhhc2UgIT09IFwiY29tbWl0dGVkXCJcbiAgICAgICAgICB8fCBjb21taXR0ZWQuYXJjaGl2ZUtleSAhPT0gZXhwZWN0ZWRBcmNoaXZlS2V5XG4gICAgICAgICAgfHwgc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgIT09IG51bGxcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmVzdWx0ID0gXCJmYWlsXCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3Qgcm9sbGVkQmFjayA9IHJvbGxiYWNrUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKGNvbW1pdHRlZCwgc3RvcmFnZSk7XG4gICAgICAgICAgcmVzdWx0ID0gcm9sbGVkQmFjay5waGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiXG4gICAgICAgICAgICAmJiBzdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSA9PT0gcmF3XG4gICAgICAgICAgICAmJiBzdG9yYWdlLmdldEl0ZW0oY3VycmVudEtleSkgPT09IG51bGxcbiAgICAgICAgICAgICYmIHN0b3JhZ2UuZ2V0SXRlbShleHBlY3RlZEFyY2hpdmVLZXkpID09PSBudWxsXG4gICAgICAgICAgICA/IFwicGFzc1wiXG4gICAgICAgICAgICA6IFwiZmFpbFwiO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAob3duc1Byb2JlS2V5cykge1xuICAgICAgY29uc3QgcmVtb3ZlQW5kVmVyaWZ5ID0gKGtleTogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgc3RvcmFnZS5yZW1vdmVJdGVtKGtleSk7XG4gICAgICAgICAgcmV0dXJuIHN0b3JhZ2UuZ2V0SXRlbShrZXkpID09PSBudWxsO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBjbGVhbnVwU3VjY2VlZGVkID0gcmVtb3ZlQW5kVmVyaWZ5KGN1cnJlbnRLZXkpICYmIGNsZWFudXBTdWNjZWVkZWQ7XG4gICAgICBjbGVhbnVwU3VjY2VlZGVkID0gcmVtb3ZlQW5kVmVyaWZ5KGxlZ2FjeUtleSkgJiYgY2xlYW51cFN1Y2NlZWRlZDtcbiAgICAgIGNsZWFudXBTdWNjZWVkZWQgPSByZW1vdmVBbmRWZXJpZnkoZXhwZWN0ZWRBcmNoaXZlS2V5KSAmJiBjbGVhbnVwU3VjY2VlZGVkO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQgPT09IFwicGFzc1wiICYmIGNsZWFudXBTdWNjZWVkZWQgPyBcInBhc3NcIiA6IFwiZmFpbFwiO1xufVxuIiwgImV4cG9ydCB0eXBlIFByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudFBoYXNlID0gXCJsb2FkaW5nXCIgfCBcIm1vdW50XCIgfCBcInNldHRsZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRTY2hlZHVsZXIge1xuICBzZXQoY2FsbGJhY2s6ICgpID0+IHZvaWQsIHRpbWVvdXRNczogbnVtYmVyKTogdW5rbm93bjtcbiAgY2xlYXIoaGFuZGxlOiB1bmtub3duKTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRMaWZlY3ljbGUge1xuICAvKiogUmVtZW1iZXJzIGFuIGVhcmx5IG1vdW50LCBidXQgY2Fubm90IGVtaXQgc3VjY2VzcyBiZWZvcmUgd2luZG93IGxvYWQuICovXG4gIG1vdW50T2JzZXJ2ZWQoKTogYm9vbGVhbjtcbiAgLyoqIFN0YXJ0cyB0aGUgb25lLXNob3QgcG9zdC1sb2FkIHRpbWVvdXQgb3IgZmx1c2hlcyBhIHJlbWVtYmVyZWQgbW91bnQuICovXG4gIHdpbmRvd0xvYWRlZCgpOiBib29sZWFuO1xuICBzZXR0bGUoKTogdm9pZDtcbiAgcGhhc2UoKTogUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50UGhhc2U7XG59XG5cbi8qKlxuICogQnJvd3Nlci1vbmx5LCBvbmUtc2hvdCBsaWZlY3ljbGUgZm9yIHRoZSBvcmlnaW5hbCByZW5kZXJlciBwcmVsb2FkIHByb29mLlxuICogQXV0aG9yaXphdGlvbiBtYXkgc3RhcnQgb2JzZXJ2YXRpb24gZWFybHksIGJ1dCB0aGUgdGltZW91dCBjbG9jayBhbmQgYW55XG4gKiBzdWNjZXNzZnVsIHByb29mIHJlbWFpbiBnYXRlZCBvbiB0aGUgZG9jdW1lbnQncyBhY3R1YWwgbG9hZCBldmVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudExpZmVjeWNsZShvcHRpb25zOiB7XG4gIG9uTW91bnRlZDogKCkgPT4gdm9pZDtcbiAgb25UaW1lb3V0OiAoKSA9PiB2b2lkO1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgc2NoZWR1bGVyPzogUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50U2NoZWR1bGVyO1xufSk6IFByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudExpZmVjeWNsZSB7XG4gIGNvbnN0IHNjaGVkdWxlciA9IG9wdGlvbnMuc2NoZWR1bGVyID8/IHtcbiAgICBzZXQoY2FsbGJhY2ssIHRpbWVvdXRNcykge1xuICAgICAgcmV0dXJuIHNldFRpbWVvdXQoY2FsbGJhY2ssIHRpbWVvdXRNcyk7XG4gICAgfSxcbiAgICBjbGVhcihoYW5kbGUpIHtcbiAgICAgIGNsZWFyVGltZW91dChoYW5kbGUgYXMgUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4pO1xuICAgIH0sXG4gIH07XG4gIGxldCBwaGFzZTogUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50UGhhc2UgPSBcImxvYWRpbmdcIjtcbiAgbGV0IG1vdW50ZWQgPSBmYWxzZTtcbiAgbGV0IGhhbmRsZTogdW5rbm93biA9IG51bGw7XG5cbiAgY29uc3Qgc2V0dGxlID0gKGNhbGxiYWNrPzogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xuICAgIGlmIChwaGFzZSA9PT0gXCJzZXR0bGVkXCIpIHJldHVybjtcbiAgICBpZiAoaGFuZGxlICE9PSBudWxsKSBzY2hlZHVsZXIuY2xlYXIoaGFuZGxlKTtcbiAgICBoYW5kbGUgPSBudWxsO1xuICAgIHBoYXNlID0gXCJzZXR0bGVkXCI7XG4gICAgY2FsbGJhY2s/LigpO1xuICB9O1xuXG4gIHJldHVybiB7XG4gICAgbW91bnRPYnNlcnZlZCgpIHtcbiAgICAgIGlmIChwaGFzZSA9PT0gXCJzZXR0bGVkXCIgfHwgbW91bnRlZCkgcmV0dXJuIGZhbHNlO1xuICAgICAgbW91bnRlZCA9IHRydWU7XG4gICAgICBpZiAocGhhc2UgPT09IFwibW91bnRcIikgc2V0dGxlKG9wdGlvbnMub25Nb3VudGVkKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gICAgd2luZG93TG9hZGVkKCkge1xuICAgICAgaWYgKHBoYXNlICE9PSBcImxvYWRpbmdcIikgcmV0dXJuIGZhbHNlO1xuICAgICAgcGhhc2UgPSBcIm1vdW50XCI7XG4gICAgICBpZiAobW91bnRlZCkge1xuICAgICAgICBzZXR0bGUob3B0aW9ucy5vbk1vdW50ZWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaGFuZGxlID0gc2NoZWR1bGVyLnNldCgoKSA9PiB7XG4gICAgICAgICAgaWYgKHBoYXNlICE9PSBcIm1vdW50XCIpIHJldHVybjtcbiAgICAgICAgICBoYW5kbGUgPSBudWxsO1xuICAgICAgICAgIHBoYXNlID0gXCJzZXR0bGVkXCI7XG4gICAgICAgICAgb3B0aW9ucy5vblRpbWVvdXQoKTtcbiAgICAgICAgfSwgb3B0aW9ucy50aW1lb3V0TXMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICBzZXR0bGUoKSB7XG4gICAgICBzZXR0bGUoKTtcbiAgICB9LFxuICAgIHBoYXNlKCkge1xuICAgICAgcmV0dXJuIHBoYXNlO1xuICAgIH0sXG4gIH07XG59XG4iLCAiZXhwb3J0IHR5cGUgUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlID0gXCJ3YWl0aW5nXCIgfCBcIm1vdW50ZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlclJvb3RPYnNlcnZhdGlvbiB7XG4gIHJvb3RQcmVzZW50OiBib29sZWFuO1xuICBzdGFydHVwTG9hZGVyUHJlc2VudDogYm9vbGVhbjtcbiAgZWxlbWVudENoaWxkQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlck1vdW50VHJhY2tlciB7XG4gIG9ic2VydmUob2JzZXJ2YXRpb246IFByb21vdGlvblJlbmRlcmVyUm9vdE9ic2VydmF0aW9uKTogUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlO1xuICByZXN1bHQoKTogUHJvbW90aW9uUmVuZGVyZXJNb3VudFN0YXRlO1xufVxuXG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkgPSBcInR3ZWFrZXJQcm9tb3Rpb25Ob25jZVwiO1xuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1BBVFRFUk4gPSAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LTRbMC05YS1mXXszfS1bODlhYl1bMC05YS1mXXszfS1bMC05YS1mXXsxMn0kL2k7XG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfQVVUSF9SRVNQT05TRV9NQVhfQ0hBUlMgPSAxXzAyNDtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25SZXF1ZXN0IHtcbiAgdmVyc2lvbjogMTtcbiAgdXJsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uUmVzcG9uc2Uge1xuICB2ZXJzaW9uOiAxO1xuICBub25jZTogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCA9XG4gIHwgeyBraW5kOiBcIm9yZGluYXJ5XCIgfVxuICB8IHsga2luZDogXCJpbnZhbGlkLWNhbmRpZGF0ZVwiOyByZWFzb246IHN0cmluZyB9XG4gIHwge1xuICAgIGtpbmQ6IFwiY2FuZGlkYXRlXCI7XG4gICAgbm9uY2U6IHN0cmluZztcbiAgICByZXF1ZXN0OiBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25SZXF1ZXN0O1xuICB9O1xuXG4vKipcbiAqIENsYXNzaWZpZXMgdGhlIGN1cnJlbnQgZG9jdW1lbnQgYmVmb3JlIHBhZ2Ugc2NyaXB0cyBydW4uIE9yZGluYXJ5IHdpbmRvd3NcbiAqIHRha2UgdGhlIG5vcm1hbCBwcmVsb2FkIHBhdGguIEEgVVJMIHRoYXQgY2FycmllcyB0aGUgcmVzZXJ2ZWQgcHJvb2YgcXVlcnkgaXNcbiAqIGZhaWwtY2xvc2VkIHVubGVzcyBpdCBpcyB0aGUgb25lIGV4YWN0IGNhbmRpZGF0ZSBkb2N1bWVudCBzaGFwZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvbkF0dGVtcHQoaHJlZjogc3RyaW5nKTogUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTChocmVmKTtcbiAgICBjb25zdCBxdWVyeUVudHJpZXMgPSBbLi4ucGFyc2VkLnNlYXJjaFBhcmFtcy5lbnRyaWVzKCldO1xuICAgIGNvbnN0IGhhc1Jlc2VydmVkUXVlcnkgPSBxdWVyeUVudHJpZXMuc29tZSgoW2tleV0pID0+IGtleSA9PT0gUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZKTtcbiAgICBpZiAoIWhhc1Jlc2VydmVkUXVlcnkpIHJldHVybiB7IGtpbmQ6IFwib3JkaW5hcnlcIiB9O1xuICAgIGlmIChcbiAgICAgIHBhcnNlZC5wcm90b2NvbCAhPT0gXCJhcHA6XCJcbiAgICAgIHx8IHBhcnNlZC5ob3N0bmFtZSAhPT0gXCItXCJcbiAgICAgIHx8IHBhcnNlZC51c2VybmFtZSAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucG9ydCAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBhdGhuYW1lICE9PSBcIi9pbmRleC5odG1sXCJcbiAgICAgIHx8IHBhcnNlZC5oYXNoICE9PSBcIlwiXG4gICAgICB8fCBxdWVyeUVudHJpZXMubGVuZ3RoICE9PSAxXG4gICAgICB8fCBxdWVyeUVudHJpZXNbMF0/LlswXSAhPT0gUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZXG4gICAgKSByZXR1cm4geyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCIsIHJlYXNvbjogXCJjYW5kaWRhdGUgVVJMIHNoYXBlIGludmFsaWRcIiB9O1xuICAgIGNvbnN0IG5vbmNlID0gcXVlcnlFbnRyaWVzWzBdWzFdO1xuICAgIGlmICghUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1BBVFRFUk4udGVzdChub25jZSkpIHtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwiaW52YWxpZC1jYW5kaWRhdGVcIiwgcmVhc29uOiBcImNhbmRpZGF0ZSBub25jZSBpbnZhbGlkXCIgfTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC50b1N0cmluZygpICE9PSBocmVmKSB7XG4gICAgICByZXR1cm4geyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCIsIHJlYXNvbjogXCJjYW5kaWRhdGUgVVJMIGlzIG5vdCBjYW5vbmljYWxcIiB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJjYW5kaWRhdGVcIixcbiAgICAgIG5vbmNlLFxuICAgICAgcmVxdWVzdDogeyB2ZXJzaW9uOiAxLCB1cmw6IGhyZWYgfSxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBraW5kOiBcIm9yZGluYXJ5XCIgfTtcbiAgfVxufVxuXG4vKiogQWNjZXB0cyBvbmx5IHRoZSBleGFjdCBzeW5jaHJvbm91cyBtYWluLXByb2Nlc3MgYXV0aG9yaXphdGlvbiByZXNwb25zZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6ZWROb25jZShcbiAgYXR0ZW1wdDogUHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdCxcbiAgcmVzcG9uc2U6IHVua25vd24sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKFxuICAgIGF0dGVtcHQua2luZCAhPT0gXCJjYW5kaWRhdGVcIlxuICAgIHx8IHR5cGVvZiByZXNwb25zZSAhPT0gXCJzdHJpbmdcIlxuICAgIHx8IHJlc3BvbnNlLmxlbmd0aCA9PT0gMFxuICAgIHx8IHJlc3BvbnNlLmxlbmd0aCA+IFBST01PVElPTl9SRU5ERVJFUl9BVVRIX1JFU1BPTlNFX01BWF9DSEFSU1xuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgZGVjb2RlZCA9IEpTT04ucGFyc2UocmVzcG9uc2UpIGFzIHVua25vd247XG4gICAgaWYgKGRlY29kZWQgPT09IG51bGwgfHwgdHlwZW9mIGRlY29kZWQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShkZWNvZGVkKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdmFsdWUgPSBkZWNvZGVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChPYmplY3Qua2V5cyh2YWx1ZSkuc29ydCgpLmpvaW4oXCIsXCIpICE9PSBcIm5vbmNlLHVybCx2ZXJzaW9uXCIpIHJldHVybiBudWxsO1xuICAgIGlmICh2YWx1ZS52ZXJzaW9uICE9PSAxIHx8IHR5cGVvZiB2YWx1ZS5ub25jZSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdmFsdWUudXJsICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIVBST01PVElPTl9SRU5ERVJFUl9OT05DRV9QQVRURVJOLnRlc3QodmFsdWUubm9uY2UpKSByZXR1cm4gbnVsbDtcbiAgICBpZiAodmFsdWUubm9uY2UgIT09IGF0dGVtcHQubm9uY2UgfHwgdmFsdWUudXJsICE9PSBhdHRlbXB0LnJlcXVlc3QudXJsKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHZhbHVlLnVybCk7XG4gICAgY29uc3QgZW50cmllcyA9IFsuLi5wYXJzZWQuc2VhcmNoUGFyYW1zLmVudHJpZXMoKV07XG4gICAgaWYgKFxuICAgICAgcGFyc2VkLnByb3RvY29sICE9PSBcImFwcDpcIlxuICAgICAgfHwgcGFyc2VkLmhvc3RuYW1lICE9PSBcIi1cIlxuICAgICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wb3J0ICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGF0aG5hbWUgIT09IFwiL2luZGV4Lmh0bWxcIlxuICAgICAgfHwgcGFyc2VkLmhhc2ggIT09IFwiXCJcbiAgICAgIHx8IGVudHJpZXMubGVuZ3RoICE9PSAxXG4gICAgICB8fCBlbnRyaWVzWzBdPy5bMF0gIT09IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9RVUVSWVxuICAgICAgfHwgZW50cmllc1swXVsxXSAhPT0gdmFsdWUubm9uY2VcbiAgICAgIHx8IHBhcnNlZC50b1N0cmluZygpICE9PSB2YWx1ZS51cmxcbiAgICApIHJldHVybiBudWxsO1xuICAgIHJldHVybiB2YWx1ZS5ub25jZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBQcm92ZXMgdGhlIGFwcGxpY2F0aW9uIHJlbmRlcmVyIHJlcGxhY2VkIGl0cyBzdGF0aWMgc3RhcnR1cCBsb2FkZXIgd2l0aCByZWFsXG4gKiBjb250ZW50LiBBIHByZS1leGlzdGluZyBub24tZW1wdHkgcm9vdCBpcyBpbnN1ZmZpY2llbnQ6IHRoZSB0cmFja2VyIG11c3RcbiAqIGZpcnN0IG9ic2VydmUgdGhlIGNhbm9uaWNhbCBsb2FkZXIgYW5kIHRoZW4gb2JzZXJ2ZSBhIG5vbi1lbXB0eSByZXBsYWNlbWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyKCk6IFByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyIHtcbiAgbGV0IHNhd1N0YXJ0dXBMb2FkZXIgPSBmYWxzZTtcbiAgbGV0IG1vdW50ZWQgPSBmYWxzZTtcblxuICByZXR1cm4ge1xuICAgIG9ic2VydmUob2JzZXJ2YXRpb24pIHtcbiAgICAgIGlmIChtb3VudGVkKSByZXR1cm4gXCJtb3VudGVkXCI7XG4gICAgICBpZiAoIW9ic2VydmF0aW9uLnJvb3RQcmVzZW50KSByZXR1cm4gXCJ3YWl0aW5nXCI7XG4gICAgICBpZiAob2JzZXJ2YXRpb24uc3RhcnR1cExvYWRlclByZXNlbnQpIHtcbiAgICAgICAgc2F3U3RhcnR1cExvYWRlciA9IHRydWU7XG4gICAgICAgIHJldHVybiBcIndhaXRpbmdcIjtcbiAgICAgIH1cbiAgICAgIGlmIChzYXdTdGFydHVwTG9hZGVyICYmIE51bWJlci5pc1NhZmVJbnRlZ2VyKG9ic2VydmF0aW9uLmVsZW1lbnRDaGlsZENvdW50KSAmJiBvYnNlcnZhdGlvbi5lbGVtZW50Q2hpbGRDb3VudCA+IDApIHtcbiAgICAgICAgbW91bnRlZCA9IHRydWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gbW91bnRlZCA/IFwibW91bnRlZFwiIDogXCJ3YWl0aW5nXCI7XG4gICAgfSxcbiAgICByZXN1bHQoKSB7XG4gICAgICByZXR1cm4gbW91bnRlZCA/IFwibW91bnRlZFwiIDogXCJ3YWl0aW5nXCI7XG4gICAgfSxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUFBLHNCQUE0Qjs7O0FDQTVCLElBQU0saUJBQWlCLElBQUksWUFBWTtBQUFBLEVBQ3JDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFDdEMsQ0FBQztBQUVELElBQU0sZUFBZSxJQUFJLFlBQVk7QUFBQSxFQUNuQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUN0QyxDQUFDO0FBRUQsU0FBUyxZQUFZLE9BQWUsUUFBd0I7QUFDMUQsU0FBUSxVQUFVLFNBQVcsU0FBVSxLQUFLO0FBQzlDO0FBR08sU0FBUyxjQUFjLE9BQXVCO0FB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
