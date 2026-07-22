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
  let loadObserved = false;
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
      if (phase !== "loading" || loadObserved) return false;
      loadObserved = true;
      try {
        options.onLoadObserved();
      } catch (error) {
        phase = "settled";
        throw error;
      }
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
    onLoadObserved() {
      import_electron.ipcRenderer.send(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, {
        nonce: authorized.nonce,
        url: unmodifiedUrl,
        lifecycle: "renderer-load-observed",
        rendererSandboxed: effectiveRendererSandboxed
      });
    },
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3Byb21vdGlvbi1oZWFsdGgtcHJlbG9hZC50cyIsICIuLi9zcmMvcmVuZGVyZXItY3J5cHRvLnRzIiwgIi4uL3NyYy9yZW5kZXJlci1zdG9yYWdlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL3Byb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1saWZlY3ljbGUudHMiLCAiLi4vc3JjL3ByZWxvYWQvcHJvbW90aW9uLXJlbmRlcmVyLW1vdW50LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgdmVyaWZ5UmVuZGVyZXJTdG9yYWdlUm9sbGJhY2sgfSBmcm9tIFwiLi9yZW5kZXJlci1zdG9yYWdlXCI7XG5pbXBvcnQgeyBjcmVhdGVQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRMaWZlY3ljbGUgfSBmcm9tIFwiLi9wcmVsb2FkL3Byb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1saWZlY3ljbGVcIjtcbmltcG9ydCB7IGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyIH0gZnJvbSBcIi4vcHJlbG9hZC9wcm9tb3Rpb24tcmVuZGVyZXItbW91bnRcIjtcblxuLy8gS2VlcCB0aGlzIGRlZGljYXRlZCBzYW5kYm94IHByZWxvYWQgYnJvd3Nlci1vbmx5LiBJbXBvcnRpbmcgdGhlIG1haW4tcHJvY2Vzc1xuLy8gcHJvbW90aW9uIG1vZHVsZSB3b3VsZCBwdWxsIG5vZGU6ZnMvY3J5cHRvL3BhdGggaW50byBhIHJlbmRlcmVyIGJ1bmRsZS5cbi8vIFNvdXJjZS1pbnRlZ3JhdGlvbiB0ZXN0cyBiaW5kIHRoZXNlIGV4YWN0IGNvbnN0YW50cyB0byB0aGUgbWFpbiBtb2R1bGUuXG5jb25zdCBQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfVVJMID0gXCJhcHA6Ly8tL2luZGV4Lmh0bWxcIjtcbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9BVVRIX0NIQU5ORUwgPSBcInR3ZWFrZXI6cHJvbW90aW9uLW9yaWdpbmFsLXJlbmRlcmVyLWF1dGhvcml6ZVwiO1xuY29uc3QgUFJPTU9USU9OX09SSUdJTkFMX1JFTkRFUkVSX0lQQ19DSEFOTkVMID0gXCJ0d2Vha2VyOnByb21vdGlvbi1vcmlnaW5hbC1yZW5kZXJlci1wcm9vZlwiO1xuY29uc3QgUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZID0gXCJ0d2Vha2VyUHJvbW90aW9uTm9uY2VcIjtcbmNvbnN0IFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9RVUVSWV9LRVlTID0gbmV3IFNldChbXCJob3N0SWRcIiwgXCJpbml0aWFsUm91dGVcIl0pO1xuY29uc3QgZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQgPSBwcm9jZXNzLnNhbmRib3hlZCA9PT0gdHJ1ZTtcblxuLy8gS2VwdCBmaXZlIHNlY29uZHMgYmVsb3cgdGhlIG1haW4tcHJvY2VzcyBtb3VudCBwaGFzZSBzbyB0aGlzIGV4YWN0LCBib3VuZFxuLy8gZmFpbHVyZSBpcyBvYnNlcnZlZCBhbmQgY2xlYW5lZCB1cCBiZWZvcmUgdGhlIG91dGVyIG1vdW50IGRlYWRsaW5lIGNhbiBmaXJlLlxuY29uc3QgTU9VTlRfVElNRU9VVF9NUyA9IDU1XzAwMDtcblxudHlwZSBBdXRob3JpemF0aW9uID0geyB2ZXJzaW9uOiAxOyBub25jZTogc3RyaW5nOyB1cmw6IHN0cmluZyB9O1xuXG5mdW5jdGlvbiBjYW5vbmljYWxPcmlnaW5hbFJlbmRlcmVyVXJsKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChcbiAgICB0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCJcbiAgICB8fCB2YWx1ZS5sZW5ndGggPT09IDBcbiAgICB8fCB2YWx1ZS5sZW5ndGggPiA4XzE5MlxuICAgIHx8IC9bXFx1MDAwMC1cXHUwMDFmXFx1MDA3Zl0vLnRlc3QodmFsdWUpXG4gICkgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJzZWQ6IFVSTDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKHZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKFxuICAgIHBhcnNlZC5wcm90b2NvbCAhPT0gXCJhcHA6XCJcbiAgICB8fCBwYXJzZWQuaG9zdG5hbWUgIT09IFwiLVwiXG4gICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBhc3N3b3JkICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnBvcnQgIT09IFwiXCJcbiAgICB8fCBwYXJzZWQucGF0aG5hbWUgIT09IFwiL2luZGV4Lmh0bWxcIlxuICAgIHx8IHBhcnNlZC5oYXNoICE9PSBcIlwiXG4gICAgfHwgcGFyc2VkLnNlYXJjaFBhcmFtcy5oYXMoUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZKVxuICAgIHx8IHBhcnNlZC50b1N0cmluZygpICE9PSB2YWx1ZVxuICApIHJldHVybiBudWxsO1xuICBjb25zdCBxdWVyeUtleXMgPSBbLi4ucGFyc2VkLnNlYXJjaFBhcmFtcy5rZXlzKCldO1xuICBpZiAoXG4gICAgcXVlcnlLZXlzLnNvbWUoKGtleSkgPT4gIVBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9RVUVSWV9LRVlTLmhhcyhrZXkpKVxuICAgIHx8IG5ldyBTZXQocXVlcnlLZXlzKS5zaXplICE9PSBxdWVyeUtleXMubGVuZ3RoXG4gICkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhvc3RJZCA9IHBhcnNlZC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpO1xuICBjb25zdCBpbml0aWFsUm91dGUgPSBwYXJzZWQuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgaWYgKGhvc3RJZCAhPT0gbnVsbCAmJiAhL15bQS1aYS16MC05Ll86LV17MSwyNTZ9JC8udGVzdChob3N0SWQpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGluaXRpYWxSb3V0ZSAhPT0gbnVsbCAmJiAoXG4gICAgaW5pdGlhbFJvdXRlLmxlbmd0aCA9PT0gMFxuICAgIHx8IGluaXRpYWxSb3V0ZS5sZW5ndGggPiAyXzA0OFxuICAgIHx8ICFpbml0aWFsUm91dGUuc3RhcnRzV2l0aChcIi9cIilcbiAgICB8fCAvW1xcdTAwMDAtXFx1MDAxZlxcdTAwN2ZdLy50ZXN0KGluaXRpYWxSb3V0ZSlcbiAgKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gcGFyc2VFeGFjdEF1dGhvcml6YXRpb24odmFsdWU6IHVua25vd24sIGV4cGVjdGVkVXJsOiBzdHJpbmcpOiBBdXRob3JpemF0aW9uIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgdmFsdWUubGVuZ3RoID09PSAwIHx8IHZhbHVlLmxlbmd0aCA+IDFfMDI0KSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKCFwYXJzZWQgfHwgdHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBudWxsO1xuICBjb25zdCByZWNvcmQgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBPYmplY3Qua2V5cyhyZWNvcmQpLnNvcnQoKS5qb2luKFwiLFwiKSA9PT0gXCJub25jZSx1cmwsdmVyc2lvblwiXG4gICAgJiYgcmVjb3JkLnZlcnNpb24gPT09IDFcbiAgICAmJiB0eXBlb2YgcmVjb3JkLm5vbmNlID09PSBcInN0cmluZ1wiXG4gICAgJiYgL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pLnRlc3QocmVjb3JkLm5vbmNlKVxuICAgICYmIHJlY29yZC51cmwgPT09IGV4cGVjdGVkVXJsXG4gICAgPyByZWNvcmQgYXMgQXV0aG9yaXphdGlvblxuICAgIDogbnVsbDtcbn1cblxuLy8gVGhpcyBlbnRyeSBpcyByZWdpc3RlcmVkIG9ubHkgZm9yIHRoZSBkaXNwb3NhYmxlIG9yaWdpbmFsLW1haW4gaGVhbHRoIG1vZGUuXG4vLyBJdCBydW5zIGJlZm9yZSBwYWdlIHBhcnNpbmcgYW5kIHRydXN0cyBubyBlbnZpcm9ubWVudCwgYXJndiwgb3IgVVJMIG5vbmNlLlxuY29uc3QgdW5tb2RpZmllZFVybCA9IGxvY2F0aW9uLmhyZWY7XG5jb25zdCBjYW5vbmljYWxVcmwgPSBjYW5vbmljYWxPcmlnaW5hbFJlbmRlcmVyVXJsKHVubW9kaWZpZWRVcmwpO1xubGV0IGF1dGhvcml6YXRpb246IHVua25vd24gPSBudWxsO1xuaWYgKGNhbm9uaWNhbFVybCAhPT0gbnVsbCkge1xuICB0cnkge1xuICAgIGF1dGhvcml6YXRpb24gPSBpcGNSZW5kZXJlci5zZW5kU3luYyhQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfQVVUSF9DSEFOTkVMLCB7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgdXJsOiBjYW5vbmljYWxVcmwsXG4gICAgICByZW5kZXJlclNhbmRib3hlZDogZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQsXG4gICAgfSk7XG4gIH0gY2F0Y2gge1xuICAgIGF1dGhvcml6YXRpb24gPSBudWxsO1xuICB9XG59XG5cbmNvbnN0IHBhcnNlZEF1dGhvcml6YXRpb24gPSBjYW5vbmljYWxVcmwgPT09IG51bGxcbiAgPyBudWxsXG4gIDogcGFyc2VFeGFjdEF1dGhvcml6YXRpb24oYXV0aG9yaXphdGlvbiwgY2Fub25pY2FsVXJsKTtcbmlmIChwYXJzZWRBdXRob3JpemF0aW9uKSB7XG4gIG9ic2VydmVPcmlnaW5hbFJlbmRlcmVyTW91bnQocGFyc2VkQXV0aG9yaXphdGlvbik7XG59XG5cbmZ1bmN0aW9uIG9ic2VydmVPcmlnaW5hbFJlbmRlcmVyTW91bnQoYXV0aG9yaXplZDogQXV0aG9yaXphdGlvbik6IHZvaWQge1xuICBjb25zdCBtb3VudCA9IGNyZWF0ZVByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyKCk7XG4gIGxldCBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wT2JzZXJ2aW5nID0gKCk6IHZvaWQgPT4ge1xuICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwibG9hZFwiLCBvbldpbmRvd0xvYWQpO1xuICAgIG9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG4gIH07XG4gIGNvbnN0IGxpZmVjeWNsZSA9IGNyZWF0ZVByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudExpZmVjeWNsZSh7XG4gICAgdGltZW91dE1zOiBNT1VOVF9USU1FT1VUX01TLFxuICAgIG9uTG9hZE9ic2VydmVkKCkge1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChQUk9NT1RJT05fT1JJR0lOQUxfUkVOREVSRVJfSVBDX0NIQU5ORUwsIHtcbiAgICAgICAgbm9uY2U6IGF1dGhvcml6ZWQubm9uY2UsXG4gICAgICAgIHVybDogdW5tb2RpZmllZFVybCxcbiAgICAgICAgbGlmZWN5Y2xlOiBcInJlbmRlcmVyLWxvYWQtb2JzZXJ2ZWRcIixcbiAgICAgICAgcmVuZGVyZXJTYW5kYm94ZWQ6IGVmZmVjdGl2ZVJlbmRlcmVyU2FuZGJveGVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgICBvbk1vdW50ZWQoKSB7XG4gICAgICBzdG9wT2JzZXJ2aW5nKCk7XG4gICAgICBpcGNSZW5kZXJlci5zZW5kKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9JUENfQ0hBTk5FTCwge1xuICAgICAgICBub25jZTogYXV0aG9yaXplZC5ub25jZSxcbiAgICAgICAgdXJsOiB1bm1vZGlmaWVkVXJsLFxuICAgICAgICBsaWZlY3ljbGU6IFwicmVuZGVyZXItbW91bnRlZFwiLFxuICAgICAgICByZW5kZXJlclNhbmRib3hlZDogZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQsXG4gICAgICAgIHJlbmRlcmVyU3RvcmFnZVNlbGZUZXN0OiB2ZXJpZnlSZW5kZXJlclN0b3JhZ2VSb2xsYmFjayhsb2NhbFN0b3JhZ2UsIGF1dGhvcml6ZWQubm9uY2UpLFxuICAgICAgfSk7XG4gICAgfSxcbiAgICBvblRpbWVvdXQoKSB7XG4gICAgICBzdG9wT2JzZXJ2aW5nKCk7XG4gICAgICBpcGNSZW5kZXJlci5zZW5kKFBST01PVElPTl9PUklHSU5BTF9SRU5ERVJFUl9JUENfQ0hBTk5FTCwge1xuICAgICAgICBub25jZTogYXV0aG9yaXplZC5ub25jZSxcbiAgICAgICAgdXJsOiB1bm1vZGlmaWVkVXJsLFxuICAgICAgICBsaWZlY3ljbGU6IFwicmVuZGVyZXItbW91bnQtdGltZW91dFwiLFxuICAgICAgICByZW5kZXJlclNhbmRib3hlZDogZWZmZWN0aXZlUmVuZGVyZXJTYW5kYm94ZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9KTtcblxuICBmdW5jdGlvbiBvbldpbmRvd0xvYWQoKTogdm9pZCB7XG4gICAgbGlmZWN5Y2xlLndpbmRvd0xvYWRlZCgpO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5zcGVjdCgpOiB2b2lkIHtcbiAgICBpZiAobGlmZWN5Y2xlLnBoYXNlKCkgPT09IFwic2V0dGxlZFwiKSByZXR1cm47XG4gICAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IG1vdW50Lm9ic2VydmUoe1xuICAgICAgcm9vdFByZXNlbnQ6IHJvb3QgIT09IG51bGwsXG4gICAgICBzdGFydHVwTG9hZGVyUHJlc2VudDogcm9vdCAhPT0gbnVsbCAmJiByb290LnF1ZXJ5U2VsZWN0b3IoXCI6c2NvcGUgPiAuc3RhcnR1cC1sb2FkZXJcIikgIT09IG51bGwsXG4gICAgICBlbGVtZW50Q2hpbGRDb3VudDogcm9vdD8uY2hpbGRyZW4ubGVuZ3RoID8/IDAsXG4gICAgfSk7XG4gICAgaWYgKHN0YXRlICE9PSBcIm1vdW50ZWRcIikgcmV0dXJuO1xuICAgIGxpZmVjeWNsZS5tb3VudE9ic2VydmVkKCk7XG4gIH1cblxuICBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKGluc3BlY3QpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgb25XaW5kb3dMb2FkLCB7IG9uY2U6IHRydWUgfSk7XG4gIC8vIFRoZSBwcmVsb2FkIG5vcm1hbGx5IHJ1bnMgYmVmb3JlIGxvYWQsIGJ1dCB0aGlzIGNsb3NlcyB0aGUgcmVnaXN0cmF0aW9uXG4gIC8vIHJhY2Ugd2l0aG91dCBncmFudGluZyBhbm90aGVyIGRlYWRsaW5lIG9yIGVtaXR0aW5nIHR3aWNlLlxuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJjb21wbGV0ZVwiKSBvbldpbmRvd0xvYWQoKTtcbiAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIGluc3BlY3QoKTtcbn1cbiIsICJjb25zdCBTSEEyNTZfSU5JVElBTCA9IG5ldyBVaW50MzJBcnJheShbXG4gIDB4NmEwOWU2NjcsIDB4YmI2N2FlODUsIDB4M2M2ZWYzNzIsIDB4YTU0ZmY1M2EsXG4gIDB4NTEwZTUyN2YsIDB4OWIwNTY4OGMsIDB4MWY4M2Q5YWIsIDB4NWJlMGNkMTksXG5dKTtcblxuY29uc3QgU0hBMjU2X1JPVU5EID0gbmV3IFVpbnQzMkFycmF5KFtcbiAgMHg0MjhhMmY5OCwgMHg3MTM3NDQ5MSwgMHhiNWMwZmJjZiwgMHhlOWI1ZGJhNSxcbiAgMHgzOTU2YzI1YiwgMHg1OWYxMTFmMSwgMHg5MjNmODJhNCwgMHhhYjFjNWVkNSxcbiAgMHhkODA3YWE5OCwgMHgxMjgzNWIwMSwgMHgyNDMxODViZSwgMHg1NTBjN2RjMyxcbiAgMHg3MmJlNWQ3NCwgMHg4MGRlYjFmZSwgMHg5YmRjMDZhNywgMHhjMTliZjE3NCxcbiAgMHhlNDliNjljMSwgMHhlZmJlNDc4NiwgMHgwZmMxOWRjNiwgMHgyNDBjYTFjYyxcbiAgMHgyZGU5MmM2ZiwgMHg0YTc0ODRhYSwgMHg1Y2IwYTlkYywgMHg3NmY5ODhkYSxcbiAgMHg5ODNlNTE1MiwgMHhhODMxYzY2ZCwgMHhiMDAzMjdjOCwgMHhiZjU5N2ZjNyxcbiAgMHhjNmUwMGJmMywgMHhkNWE3OTE0NywgMHgwNmNhNjM1MSwgMHgxNDI5Mjk2NyxcbiAgMHgyN2I3MGE4NSwgMHgyZTFiMjEzOCwgMHg0ZDJjNmRmYywgMHg1MzM4MGQxMyxcbiAgMHg2NTBhNzM1NCwgMHg3NjZhMGFiYiwgMHg4MWMyYzkyZSwgMHg5MjcyMmM4NSxcbiAgMHhhMmJmZThhMSwgMHhhODFhNjY0YiwgMHhjMjRiOGI3MCwgMHhjNzZjNTFhMyxcbiAgMHhkMTkyZTgxOSwgMHhkNjk5MDYyNCwgMHhmNDBlMzU4NSwgMHgxMDZhYTA3MCxcbiAgMHgxOWE0YzExNiwgMHgxZTM3NmMwOCwgMHgyNzQ4Nzc0YywgMHgzNGIwYmNiNSxcbiAgMHgzOTFjMGNiMywgMHg0ZWQ4YWE0YSwgMHg1YjljY2E0ZiwgMHg2ODJlNmZmMyxcbiAgMHg3NDhmODJlZSwgMHg3OGE1NjM2ZiwgMHg4NGM4NzgxNCwgMHg4Y2M3MDIwOCxcbiAgMHg5MGJlZmZmYSwgMHhhNDUwNmNlYiwgMHhiZWY5YTNmNywgMHhjNjcxNzhmMixcbl0pO1xuXG5mdW5jdGlvbiByb3RhdGVSaWdodCh2YWx1ZTogbnVtYmVyLCBhbW91bnQ6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiAodmFsdWUgPj4+IGFtb3VudCkgfCAodmFsdWUgPDwgKDMyIC0gYW1vdW50KSk7XG59XG5cbi8qKiBTeW5jaHJvbm91cyBTSEEtMjU2IGZvciB0aGUgc2FuZGJveGVkIHJlbmRlcmVyLCB3aGljaCBjYW5ub3QgaW1wb3J0IE5vZGUgYnVpbHQtaW5zLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoYTI1NkhleFV0ZjgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGlucHV0ID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHZhbHVlKTtcbiAgY29uc3QgcGFkZGVkTGVuZ3RoID0gTWF0aC5jZWlsKChpbnB1dC5sZW5ndGggKyA5KSAvIDY0KSAqIDY0O1xuICBjb25zdCBwYWRkZWQgPSBuZXcgVWludDhBcnJheShwYWRkZWRMZW5ndGgpO1xuICBwYWRkZWQuc2V0KGlucHV0KTtcbiAgcGFkZGVkW2lucHV0Lmxlbmd0aF0gPSAweDgwO1xuXG4gIGNvbnN0IGJpdExlbmd0aCA9IEJpZ0ludChpbnB1dC5sZW5ndGgpICogOG47XG4gIGNvbnN0IHZpZXcgPSBuZXcgRGF0YVZpZXcocGFkZGVkLmJ1ZmZlcik7XG4gIHZpZXcuc2V0VWludDMyKHBhZGRlZExlbmd0aCAtIDgsIE51bWJlcigoYml0TGVuZ3RoID4+IDMybikgJiAweGZmZmZmZmZmbiksIGZhbHNlKTtcbiAgdmlldy5zZXRVaW50MzIocGFkZGVkTGVuZ3RoIC0gNCwgTnVtYmVyKGJpdExlbmd0aCAmIDB4ZmZmZmZmZmZuKSwgZmFsc2UpO1xuXG4gIGNvbnN0IHN0YXRlID0gbmV3IFVpbnQzMkFycmF5KFNIQTI1Nl9JTklUSUFMKTtcbiAgY29uc3Qgd29yZHMgPSBuZXcgVWludDMyQXJyYXkoNjQpO1xuICBmb3IgKGxldCBvZmZzZXQgPSAwOyBvZmZzZXQgPCBwYWRkZWRMZW5ndGg7IG9mZnNldCArPSA2NCkge1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAxNjsgaW5kZXggKz0gMSkge1xuICAgICAgd29yZHNbaW5kZXhdID0gdmlldy5nZXRVaW50MzIob2Zmc2V0ICsgaW5kZXggKiA0LCBmYWxzZSk7XG4gICAgfVxuICAgIGZvciAobGV0IGluZGV4ID0gMTY7IGluZGV4IDwgd29yZHMubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICBjb25zdCBwcmlvcjE1ID0gd29yZHNbaW5kZXggLSAxNV0hO1xuICAgICAgY29uc3QgcHJpb3IyID0gd29yZHNbaW5kZXggLSAyXSE7XG4gICAgICBjb25zdCBzbWFsbDAgPSByb3RhdGVSaWdodChwcmlvcjE1LCA3KSBeIHJvdGF0ZVJpZ2h0KHByaW9yMTUsIDE4KSBeIChwcmlvcjE1ID4+PiAzKTtcbiAgICAgIGNvbnN0IHNtYWxsMSA9IHJvdGF0ZVJpZ2h0KHByaW9yMiwgMTcpIF4gcm90YXRlUmlnaHQocHJpb3IyLCAxOSkgXiAocHJpb3IyID4+PiAxMCk7XG4gICAgICB3b3Jkc1tpbmRleF0gPSAod29yZHNbaW5kZXggLSAxNl0hICsgc21hbGwwICsgd29yZHNbaW5kZXggLSA3XSEgKyBzbWFsbDEpID4+PiAwO1xuICAgIH1cblxuICAgIGxldCBbYSwgYiwgYywgZCwgZSwgZiwgZywgaF0gPSBzdGF0ZTtcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgd29yZHMubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgICBjb25zdCBsYXJnZTEgPSByb3RhdGVSaWdodChlISwgNikgXiByb3RhdGVSaWdodChlISwgMTEpIF4gcm90YXRlUmlnaHQoZSEsIDI1KTtcbiAgICAgIGNvbnN0IGNob29zZSA9IChlISAmIGYhKSBeICh+ZSEgJiBnISk7XG4gICAgICBjb25zdCB0ZW1wb3JhcnkxID0gKGghICsgbGFyZ2UxICsgY2hvb3NlICsgU0hBMjU2X1JPVU5EW2luZGV4XSEgKyB3b3Jkc1tpbmRleF0hKSA+Pj4gMDtcbiAgICAgIGNvbnN0IGxhcmdlMCA9IHJvdGF0ZVJpZ2h0KGEhLCAyKSBeIHJvdGF0ZVJpZ2h0KGEhLCAxMykgXiByb3RhdGVSaWdodChhISwgMjIpO1xuICAgICAgY29uc3QgbWFqb3JpdHkgPSAoYSEgJiBiISkgXiAoYSEgJiBjISkgXiAoYiEgJiBjISk7XG4gICAgICBjb25zdCB0ZW1wb3JhcnkyID0gKGxhcmdlMCArIG1ham9yaXR5KSA+Pj4gMDtcblxuICAgICAgaCA9IGc7XG4gICAgICBnID0gZjtcbiAgICAgIGYgPSBlO1xuICAgICAgZSA9IChkISArIHRlbXBvcmFyeTEpID4+PiAwO1xuICAgICAgZCA9IGM7XG4gICAgICBjID0gYjtcbiAgICAgIGIgPSBhO1xuICAgICAgYSA9ICh0ZW1wb3JhcnkxICsgdGVtcG9yYXJ5MikgPj4+IDA7XG4gICAgfVxuXG4gICAgc3RhdGVbMF0gPSAoc3RhdGVbMF0hICsgYSEpID4+PiAwO1xuICAgIHN0YXRlWzFdID0gKHN0YXRlWzFdISArIGIhKSA+Pj4gMDtcbiAgICBzdGF0ZVsyXSA9IChzdGF0ZVsyXSEgKyBjISkgPj4+IDA7XG4gICAgc3RhdGVbM10gPSAoc3RhdGVbM10hICsgZCEpID4+PiAwO1xuICAgIHN0YXRlWzRdID0gKHN0YXRlWzRdISArIGUhKSA+Pj4gMDtcbiAgICBzdGF0ZVs1XSA9IChzdGF0ZVs1XSEgKyBmISkgPj4+IDA7XG4gICAgc3RhdGVbNl0gPSAoc3RhdGVbNl0hICsgZyEpID4+PiAwO1xuICAgIHN0YXRlWzddID0gKHN0YXRlWzddISArIGghKSA+Pj4gMDtcbiAgfVxuXG4gIHJldHVybiBbLi4uc3RhdGVdLm1hcCgod29yZCkgPT4gd29yZC50b1N0cmluZygxNikucGFkU3RhcnQoOCwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuXG4vKiogR2VuZXJhdGVzIGEgVVVJRCB3aXRob3V0IHJlbHlpbmcgb24gc2FuZGJveC11bmF2YWlsYWJsZSBOb2RlIGNyeXB0by4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWN1cmVSZW5kZXJlclV1aWQoKTogc3RyaW5nIHtcbiAgY29uc3QgcHJvdmlkZXIgPSBnbG9iYWxUaGlzLmNyeXB0bztcbiAgaWYgKHR5cGVvZiBwcm92aWRlcj8ucmFuZG9tVVVJRCA9PT0gXCJmdW5jdGlvblwiKSByZXR1cm4gcHJvdmlkZXIucmFuZG9tVVVJRCgpO1xuICBpZiAodHlwZW9mIHByb3ZpZGVyPy5nZXRSYW5kb21WYWx1ZXMgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcInNlY3VyZSByZW5kZXJlciByYW5kb21uZXNzIGlzIHVuYXZhaWxhYmxlXCIpO1xuICB9XG4gIGNvbnN0IGJ5dGVzID0gcHJvdmlkZXIuZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KDE2KSk7XG4gIGJ5dGVzWzZdID0gKGJ5dGVzWzZdISAmIDB4MGYpIHwgMHg0MDtcbiAgYnl0ZXNbOF0gPSAoYnl0ZXNbOF0hICYgMHgzZikgfCAweDgwO1xuICBjb25zdCBoZXggPSBbLi4uYnl0ZXNdLm1hcCgoYnl0ZSkgPT4gYnl0ZS50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKTtcbiAgcmV0dXJuIGAke2hleC5zbGljZSgwLCA0KS5qb2luKFwiXCIpfS0ke2hleC5zbGljZSg0LCA2KS5qb2luKFwiXCIpfS0ke2hleC5zbGljZSg2LCA4KS5qb2luKFwiXCIpfS0ke2hleC5zbGljZSg4LCAxMCkuam9pbihcIlwiKX0tJHtoZXguc2xpY2UoMTApLmpvaW4oXCJcIil9YDtcbn1cbiIsICJpbXBvcnQgeyBzZWN1cmVSZW5kZXJlclV1aWQsIHNoYTI1NkhleFV0ZjggfSBmcm9tIFwiLi9yZW5kZXJlci1jcnlwdG9cIjtcblxuZXhwb3J0IGludGVyZmFjZSBTdG9yYWdlTGlrZSB7XG4gIHJlYWRvbmx5IGxlbmd0aDogbnVtYmVyO1xuICBnZXRJdGVtKGtleTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbDtcbiAga2V5KGluZGV4OiBudW1iZXIpOiBzdHJpbmcgfCBudWxsO1xuICBzZXRJdGVtKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZDtcbiAgcmVtb3ZlSXRlbShrZXk6IHN0cmluZyk6IHZvaWQ7XG59XG5cbmNvbnN0IENVUlJFTlRfSURfUFJFRklYID0gXCJjby50d2Vha2Vycy5cIjtcbmNvbnN0IExFR0FDWV9TVE9SQUdFX1BSRUZJWCA9IGAke1tcImNvZGV4XCIsIFwicHBcIl0uam9pbihcIlwiKX06c3RvcmFnZTpgO1xuY29uc3QgQ1VSUkVOVF9TVE9SQUdFX1BSRUZJWCA9IFwidHdlYWtlcjpzdG9yYWdlOlwiO1xuY29uc3QgQVJDSElWRV9TVE9SQUdFX1BSRUZJWCA9IFwidHdlYWtlcjpzdG9yYWdlLWFyY2hpdmU6XCI7XG5cbmV4cG9ydCB0eXBlIFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvblN0YXR1cyA9XG4gIHwgXCJub3RfYXBwbGljYWJsZVwiXG4gIHwgXCJhYnNlbnRcIlxuICB8IFwiY2Fub25pY2FsXCJcbiAgfCBcInByZXBhcmVkXCJcbiAgfCBcImFtYmlndW91c1wiXG4gIHwgXCJjb25mbGljdFwiXG4gIHwgXCJpbnZhbGlkX2Nhbm9uaWNhbFwiXG4gIHwgXCJpbnZhbGlkX2xlZ2FjeVwiXG4gIHwgXCJ3cml0ZV9mYWlsZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nO1xuICBjdXJyZW50S2V5OiBzdHJpbmc7XG4gIGxlZ2FjeUtleXM6IHN0cmluZ1tdO1xuICBzZWxlY3RlZExlZ2FjeUtleTogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25TdGF0dXM7XG4gIGhvbGRQcm9tb3Rpb246IGJvb2xlYW47XG4gIGNyZWF0ZWRDYW5vbmljYWw6IGJvb2xlYW47XG4gIGNhbm9uaWNhbEJlZm9yZUhhc2g6IHN0cmluZztcbiAgY2Fub25pY2FsQWZ0ZXJIYXNoOiBzdHJpbmc7XG4gIHNlbGVjdGVkTGVnYWN5SGFzaDogc3RyaW5nO1xuICBhcmNoaXZlS2V5OiBzdHJpbmcgfCBudWxsO1xuICBwaGFzZTogXCJwbGFubmVkXCIgfCBcInByZXBhcmVkXCIgfCBcImNvbW1pdHRlZFwiIHwgXCJyb2xsZWRfYmFja1wiO1xufVxuXG5pbnRlcmZhY2UgU3RvcmFnZU1pZ3JhdGlvblBsYW4ge1xuICByZWNlaXB0OiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0O1xuICBjYW5vbmljYWxSYXc6IHN0cmluZyB8IG51bGw7XG4gIHNlbGVjdGVkTGVnYWN5UmF3OiBzdHJpbmcgfCBudWxsO1xufVxuXG5mdW5jdGlvbiBwYXJzZVJlY29yZChyYXc6IHN0cmluZyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBpZiAocmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgdW5rbm93bjtcbiAgICByZXR1cm4gcGFyc2VkICE9PSBudWxsICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKVxuICAgICAgPyBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmluZ2VycHJpbnQocmF3OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJhdyA9PT0gbnVsbCA/IFwibWlzc2luZ1wiIDogc2hhMjU2SGV4VXRmOChyYXcpO1xufVxuXG5mdW5jdGlvbiBkaXNjb3ZlckxlZ2FjeVB1Ymxpc2hlcktleXMoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpOiBzdHJpbmdbXSB7XG4gIGlmICghaWQuc3RhcnRzV2l0aChDVVJSRU5UX0lEX1BSRUZJWCkpIHJldHVybiBbXTtcbiAgY29uc3Qgc3VmZml4ID0gaWQuc2xpY2UoQ1VSUkVOVF9JRF9QUkVGSVgubGVuZ3RoKTtcbiAgaWYgKCFzdWZmaXgpIHJldHVybiBbXTtcblxuICBjb25zdCBzdWZmaXhNYXJrZXIgPSBgLiR7c3VmZml4fWA7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHN0b3JhZ2UubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgY29uc3Qga2V5ID0gc3RvcmFnZS5rZXkoaW5kZXgpO1xuICAgIGlmICgha2V5Py5zdGFydHNXaXRoKExFR0FDWV9TVE9SQUdFX1BSRUZJWCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxlZ2FjeUlkID0ga2V5LnNsaWNlKExFR0FDWV9TVE9SQUdFX1BSRUZJWC5sZW5ndGgpO1xuICAgIGlmIChcbiAgICAgIGxlZ2FjeUlkICE9PSBpZFxuICAgICAgJiYgbGVnYWN5SWQuc3RhcnRzV2l0aChcImNvLlwiKVxuICAgICAgJiYgbGVnYWN5SWQuZW5kc1dpdGgoc3VmZml4TWFya2VyKVxuICAgICAgJiYgbGVnYWN5SWQuc2xpY2UoMywgLXN1ZmZpeE1hcmtlci5sZW5ndGgpLmxlbmd0aCA+IDBcbiAgICApIHtcbiAgICAgIGNhbmRpZGF0ZXMuYWRkKGtleSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4uY2FuZGlkYXRlc10uc29ydCgpO1xufVxuXG5mdW5jdGlvbiBsZWdhY3lLZXlzRm9yKGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlKTogc3RyaW5nW10ge1xuICBjb25zdCBleGFjdExlZ2FjeUtleSA9IGAke0xFR0FDWV9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IGtleXMgPSBuZXcgU2V0KGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5cyhpZCwgc3RvcmFnZSkpO1xuICBpZiAoc3RvcmFnZS5nZXRJdGVtKGV4YWN0TGVnYWN5S2V5KSAhPT0gbnVsbCkga2V5cy5hZGQoZXhhY3RMZWdhY3lLZXkpO1xuICByZXR1cm4gWy4uLmtleXNdLnNvcnQoKTtcbn1cblxuZnVuY3Rpb24gcGxhbk1pZ3JhdGlvbihcbiAgaWQ6IHN0cmluZyxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZyA9IHNlY3VyZVJlbmRlcmVyVXVpZCgpLFxuKTogU3RvcmFnZU1pZ3JhdGlvblBsYW4ge1xuICBjb25zdCBjdXJyZW50S2V5ID0gYCR7Q1VSUkVOVF9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IGNhbm9uaWNhbFJhdyA9IHN0b3JhZ2UuZ2V0SXRlbShjdXJyZW50S2V5KTtcbiAgY29uc3QgbGVnYWN5S2V5cyA9IGxlZ2FjeUtleXNGb3IoaWQsIHN0b3JhZ2UpO1xuICBjb25zdCBzZWxlY3RlZExlZ2FjeUtleSA9IGxlZ2FjeUtleXMubGVuZ3RoID09PSAxID8gbGVnYWN5S2V5c1swXSEgOiBudWxsO1xuICBjb25zdCBzZWxlY3RlZExlZ2FjeVJhdyA9IHNlbGVjdGVkTGVnYWN5S2V5ID09PSBudWxsID8gbnVsbCA6IHN0b3JhZ2UuZ2V0SXRlbShzZWxlY3RlZExlZ2FjeUtleSk7XG4gIGNvbnN0IGJhc2UgPSB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSBhcyBjb25zdCxcbiAgICB0cmFuc2FjdGlvbklkLFxuICAgIGN1cnJlbnRLZXksXG4gICAgbGVnYWN5S2V5cyxcbiAgICBzZWxlY3RlZExlZ2FjeUtleSxcbiAgICBjcmVhdGVkQ2Fub25pY2FsOiBmYWxzZSxcbiAgICBjYW5vbmljYWxCZWZvcmVIYXNoOiBmaW5nZXJwcmludChjYW5vbmljYWxSYXcpLFxuICAgIGNhbm9uaWNhbEFmdGVySGFzaDogZmluZ2VycHJpbnQoY2Fub25pY2FsUmF3KSxcbiAgICBzZWxlY3RlZExlZ2FjeUhhc2g6IGZpbmdlcnByaW50KHNlbGVjdGVkTGVnYWN5UmF3KSxcbiAgICBhcmNoaXZlS2V5OiBudWxsLFxuICAgIHBoYXNlOiBcInBsYW5uZWRcIiBhcyBjb25zdCxcbiAgfTtcblxuICBpZiAoIWlkLnN0YXJ0c1dpdGgoQ1VSUkVOVF9JRF9QUkVGSVgpKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwibm90X2FwcGxpY2FibGVcIiwgaG9sZFByb21vdGlvbjogZmFsc2UgfSwgY2Fub25pY2FsUmF3LCBzZWxlY3RlZExlZ2FjeVJhdyB9O1xuICB9XG4gIGlmIChsZWdhY3lLZXlzLmxlbmd0aCA+IDEpIHtcbiAgICByZXR1cm4geyByZWNlaXB0OiB7IC4uLmJhc2UsIHN0YXR1czogXCJhbWJpZ3VvdXNcIiwgaG9sZFByb21vdGlvbjogdHJ1ZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKGNhbm9uaWNhbFJhdyAhPT0gbnVsbCAmJiBwYXJzZVJlY29yZChjYW5vbmljYWxSYXcpID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgcmVjZWlwdDogeyAuLi5iYXNlLCBzdGF0dXM6IFwiaW52YWxpZF9jYW5vbmljYWxcIiwgaG9sZFByb21vdGlvbjogdHJ1ZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgaWYgKHNlbGVjdGVkTGVnYWN5UmF3ICE9PSBudWxsICYmIHBhcnNlUmVjb3JkKHNlbGVjdGVkTGVnYWN5UmF3KSA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcImludmFsaWRfbGVnYWN5XCIsIGhvbGRQcm9tb3Rpb246IHRydWUgfSwgY2Fub25pY2FsUmF3LCBzZWxlY3RlZExlZ2FjeVJhdyB9O1xuICB9XG4gIGlmIChjYW5vbmljYWxSYXcgIT09IG51bGwpIHtcbiAgICBjb25zdCBtaXNtYXRjaCA9IHNlbGVjdGVkTGVnYWN5UmF3ICE9PSBudWxsICYmIHNlbGVjdGVkTGVnYWN5UmF3ICE9PSBjYW5vbmljYWxSYXc7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBtaXNtYXRjaCA/IFwiY29uZmxpY3RcIiA6IFwiY2Fub25pY2FsXCIsIGhvbGRQcm9tb3Rpb246IG1pc21hdGNoIH0sXG4gICAgICBjYW5vbmljYWxSYXcsXG4gICAgICBzZWxlY3RlZExlZ2FjeVJhdyxcbiAgICB9O1xuICB9XG4gIGlmIChzZWxlY3RlZExlZ2FjeVJhdyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IHJlY2VpcHQ6IHsgLi4uYmFzZSwgc3RhdHVzOiBcImFic2VudFwiLCBob2xkUHJvbW90aW9uOiBmYWxzZSB9LCBjYW5vbmljYWxSYXcsIHNlbGVjdGVkTGVnYWN5UmF3IH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICByZWNlaXB0OiB7XG4gICAgICAuLi5iYXNlLFxuICAgICAgc3RhdHVzOiBcInByZXBhcmVkXCIsXG4gICAgICBob2xkUHJvbW90aW9uOiBmYWxzZSxcbiAgICAgIGNyZWF0ZWRDYW5vbmljYWw6IHRydWUsXG4gICAgICBjYW5vbmljYWxBZnRlckhhc2g6IGZpbmdlcnByaW50KHNlbGVjdGVkTGVnYWN5UmF3KSxcbiAgICB9LFxuICAgIGNhbm9uaWNhbFJhdyxcbiAgICBzZWxlY3RlZExlZ2FjeVJhdyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBsYW5SZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oXG4gIGlkOiBzdHJpbmcsXG4gIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlLFxuICB0cmFuc2FjdGlvbklkPzogc3RyaW5nLFxuKTogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCB7XG4gIHJldHVybiBwbGFuTWlncmF0aW9uKGlkLCBzdG9yYWdlLCB0cmFuc2FjdGlvbklkKS5yZWNlaXB0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZVJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihcbiAgaWQ6IHN0cmluZyxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4gIHRyYW5zYWN0aW9uSWQ/OiBzdHJpbmcsXG4pOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgY29uc3QgcGxhbiA9IHBsYW5NaWdyYXRpb24oaWQsIHN0b3JhZ2UsIHRyYW5zYWN0aW9uSWQpO1xuICBpZiAoIXBsYW4ucmVjZWlwdC5jcmVhdGVkQ2Fub25pY2FsIHx8IHBsYW4uc2VsZWN0ZWRMZWdhY3lSYXcgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyAuLi5wbGFuLnJlY2VpcHQsIHBoYXNlOiBcInByZXBhcmVkXCIgfTtcbiAgfVxuICB0cnkge1xuICAgIGlmIChzdG9yYWdlLmdldEl0ZW0ocGxhbi5yZWNlaXB0LmN1cnJlbnRLZXkpICE9PSBudWxsKSB7XG4gICAgICByZXR1cm4geyAuLi5wbGFuLnJlY2VpcHQsIHN0YXR1czogXCJjb25mbGljdFwiLCBob2xkUHJvbW90aW9uOiB0cnVlLCBjcmVhdGVkQ2Fub25pY2FsOiBmYWxzZSwgcGhhc2U6IFwicHJlcGFyZWRcIiB9O1xuICAgIH1cbiAgICBzdG9yYWdlLnNldEl0ZW0ocGxhbi5yZWNlaXB0LmN1cnJlbnRLZXksIHBsYW4uc2VsZWN0ZWRMZWdhY3lSYXcpO1xuICAgIGlmIChmaW5nZXJwcmludChzdG9yYWdlLmdldEl0ZW0ocGxhbi5yZWNlaXB0LmN1cnJlbnRLZXkpKSAhPT0gcGxhbi5yZWNlaXB0LmNhbm9uaWNhbEFmdGVySGFzaCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSB2ZXJpZmljYXRpb24gZmFpbGVkXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyAuLi5wbGFuLnJlY2VpcHQsIHBoYXNlOiBcInByZXBhcmVkXCIgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLnBsYW4ucmVjZWlwdCxcbiAgICAgIHN0YXR1czogXCJ3cml0ZV9mYWlsZWRcIixcbiAgICAgIGhvbGRQcm9tb3Rpb246IHRydWUsXG4gICAgICBjcmVhdGVkQ2Fub25pY2FsOiBmYWxzZSxcbiAgICAgIGNhbm9uaWNhbEFmdGVySGFzaDogZmluZ2VycHJpbnQoc3RvcmFnZS5nZXRJdGVtKHBsYW4ucmVjZWlwdC5jdXJyZW50S2V5KSksXG4gICAgICBwaGFzZTogXCJwcmVwYXJlZFwiLFxuICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1pdFJlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihcbiAgcmVjZWlwdDogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4pOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgaWYgKHJlY2VpcHQucGhhc2UgPT09IFwiY29tbWl0dGVkXCIpIHJldHVybiByZWNlaXB0O1xuICBpZiAocmVjZWlwdC5ob2xkUHJvbW90aW9uKSB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIG1pZ3JhdGlvbiBpcyBvbiBob2xkXCIpO1xuICBpZiAoZmluZ2VycHJpbnQoc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuY3VycmVudEtleSkpICE9PSByZWNlaXB0LmNhbm9uaWNhbEFmdGVySGFzaCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgY2Fub25pY2FsIHZhbHVlIGNoYW5nZWQgYmVmb3JlIGNvbW1pdFwiKTtcbiAgfVxuICBpZiAocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSA9PT0gbnVsbCkgcmV0dXJuIHsgLi4ucmVjZWlwdCwgcGhhc2U6IFwiY29tbWl0dGVkXCIgfTtcbiAgY29uc3QgbGVnYWN5UmF3ID0gc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXkpO1xuICBpZiAoZmluZ2VycHJpbnQobGVnYWN5UmF3KSAhPT0gcmVjZWlwdC5zZWxlY3RlZExlZ2FjeUhhc2ggfHwgbGVnYWN5UmF3ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicmVuZGVyZXIgc3RvcmFnZSBsZWdhY3kgdmFsdWUgY2hhbmdlZCBiZWZvcmUgY29tbWl0XCIpO1xuICB9XG4gIGNvbnN0IGFyY2hpdmVLZXkgPSBgJHtBUkNISVZFX1NUT1JBR0VfUFJFRklYfSR7cmVjZWlwdC50cmFuc2FjdGlvbklkfToke2VuY29kZVVSSUNvbXBvbmVudChyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5KX1gO1xuICBjb25zdCBhcmNoaXZlZCA9IHN0b3JhZ2UuZ2V0SXRlbShhcmNoaXZlS2V5KTtcbiAgaWYgKGFyY2hpdmVkICE9PSBudWxsICYmIGFyY2hpdmVkICE9PSBsZWdhY3lSYXcpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZW5kZXJlciBzdG9yYWdlIGFyY2hpdmUgY29sbGlzaW9uXCIpO1xuICB9XG4gIHN0b3JhZ2Uuc2V0SXRlbShhcmNoaXZlS2V5LCBsZWdhY3lSYXcpO1xuICBpZiAoc3RvcmFnZS5nZXRJdGVtKGFyY2hpdmVLZXkpICE9PSBsZWdhY3lSYXcpIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgYXJjaGl2ZSB2ZXJpZmljYXRpb24gZmFpbGVkXCIpO1xuICBzdG9yYWdlLnJlbW92ZUl0ZW0ocmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSk7XG4gIHJldHVybiB7IC4uLnJlY2VpcHQsIGFyY2hpdmVLZXksIHBoYXNlOiBcImNvbW1pdHRlZFwiIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByb2xsYmFja1JlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihcbiAgcmVjZWlwdDogUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uUmVjZWlwdCxcbiAgc3RvcmFnZTogU3RvcmFnZUxpa2UsXG4pOiBSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb25SZWNlaXB0IHtcbiAgaWYgKHJlY2VpcHQucGhhc2UgPT09IFwicm9sbGVkX2JhY2tcIikgcmV0dXJuIHJlY2VpcHQ7XG4gIGlmIChyZWNlaXB0LmFyY2hpdmVLZXkgIT09IG51bGwgJiYgcmVjZWlwdC5zZWxlY3RlZExlZ2FjeUtleSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IGFyY2hpdmVkID0gc3RvcmFnZS5nZXRJdGVtKHJlY2VpcHQuYXJjaGl2ZUtleSk7XG4gICAgaWYgKGZpbmdlcnByaW50KGFyY2hpdmVkKSAhPT0gcmVjZWlwdC5zZWxlY3RlZExlZ2FjeUhhc2ggfHwgYXJjaGl2ZWQgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgYXJjaGl2ZSBjaGFuZ2VkIGJlZm9yZSByb2xsYmFja1wiKTtcbiAgICB9XG4gICAgY29uc3QgY3VycmVudExlZ2FjeSA9IHN0b3JhZ2UuZ2V0SXRlbShyZWNlaXB0LnNlbGVjdGVkTGVnYWN5S2V5KTtcbiAgICBpZiAoY3VycmVudExlZ2FjeSAhPT0gbnVsbCAmJiBmaW5nZXJwcmludChjdXJyZW50TGVnYWN5KSAhPT0gcmVjZWlwdC5zZWxlY3RlZExlZ2FjeUhhc2gpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgbGVnYWN5IHZhbHVlIGNoYW5nZWQgYmVmb3JlIHJvbGxiYWNrXCIpO1xuICAgIH1cbiAgICBpZiAoY3VycmVudExlZ2FjeSA9PT0gbnVsbCkgc3RvcmFnZS5zZXRJdGVtKHJlY2VpcHQuc2VsZWN0ZWRMZWdhY3lLZXksIGFyY2hpdmVkKTtcbiAgICBzdG9yYWdlLnJlbW92ZUl0ZW0ocmVjZWlwdC5hcmNoaXZlS2V5KTtcbiAgfVxuICBpZiAocmVjZWlwdC5jcmVhdGVkQ2Fub25pY2FsKSB7XG4gICAgaWYgKGZpbmdlcnByaW50KHN0b3JhZ2UuZ2V0SXRlbShyZWNlaXB0LmN1cnJlbnRLZXkpKSAhPT0gcmVjZWlwdC5jYW5vbmljYWxBZnRlckhhc2gpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInJlbmRlcmVyIHN0b3JhZ2UgY2Fub25pY2FsIHZhbHVlIGNoYW5nZWQgYmVmb3JlIHJvbGxiYWNrXCIpO1xuICAgIH1cbiAgICBzdG9yYWdlLnJlbW92ZUl0ZW0ocmVjZWlwdC5jdXJyZW50S2V5KTtcbiAgfVxuICByZXR1cm4geyAuLi5yZWNlaXB0LCBwaGFzZTogXCJyb2xsZWRfYmFja1wiIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVSZW5kZXJlclN0b3JhZ2UoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpIHtcbiAgbGV0IG1pZ3JhdGlvbiA9IHByZXBhcmVSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24oaWQsIHN0b3JhZ2UpO1xuICBjb25zdCBrZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3QgcmVhZCA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0oa2V5KSkgPz8ge307XG4gIGNvbnN0IHdyaXRlID0gKHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gc3RvcmFnZS5zZXRJdGVtKGtleSwgSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQgbWlncmF0aW9uKCkgeyByZXR1cm4gbWlncmF0aW9uOyB9LFxuICAgIGNvbW1pdE1pZ3JhdGlvbjogKCkgPT4ge1xuICAgICAgbWlncmF0aW9uID0gY29tbWl0UmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKG1pZ3JhdGlvbiwgc3RvcmFnZSk7XG4gICAgICByZXR1cm4gbWlncmF0aW9uO1xuICAgIH0sXG4gICAgcm9sbGJhY2tNaWdyYXRpb246ICgpID0+IHtcbiAgICAgIG1pZ3JhdGlvbiA9IHJvbGxiYWNrUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKG1pZ3JhdGlvbiwgc3RvcmFnZSk7XG4gICAgICByZXR1cm4gbWlncmF0aW9uO1xuICAgIH0sXG4gICAgZ2V0OiA8VD4obmFtZTogc3RyaW5nLCBmYWxsYmFjaz86IFQpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICByZXR1cm4gbmFtZSBpbiBjdXJyZW50ID8gKGN1cnJlbnRbbmFtZV0gYXMgVCkgOiAoZmFsbGJhY2sgYXMgVCk7XG4gICAgfSxcbiAgICBzZXQ6IChuYW1lOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgY3VycmVudFtuYW1lXSA9IHZhbHVlO1xuICAgICAgd3JpdGUoY3VycmVudCk7XG4gICAgfSxcbiAgICBkZWxldGU6IChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICBkZWxldGUgY3VycmVudFtuYW1lXTtcbiAgICAgIHdyaXRlKGN1cnJlbnQpO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbi8qKlxuICogRXhlcmNpc2UgdGhlIGV4YWN0IHByZXBhcmUvY29tbWl0L3JvbGxiYWNrIHBhdGggdXNlZCBieSBhIHByb21vdGlvbiBwcm9iZS5cbiAqIEV2ZXJ5IHN5bnRoZXRpYyBrZXkgaXMgcmVtb3ZlZCBhbmQgdmVyaWZpZWQgYmVmb3JlIHN1Y2Nlc3MgaXMgcmV0dXJuZWQ7XG4gKiBjbGVhbnVwIGZhaWx1cmUgaXMgYSBmYWlsZWQgaGVhbHRoIHJlc3VsdCwgbmV2ZXIgYSBzaWxlbnQgcmVzaWR1ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmlmeVJlbmRlcmVyU3RvcmFnZVJvbGxiYWNrKFxuICBzdG9yYWdlOiBTdG9yYWdlTGlrZSxcbiAgbm9uY2U6IHN0cmluZyxcbik6IFwicGFzc1wiIHwgXCJmYWlsXCIge1xuICBjb25zdCBzdWZmaXggPSBgcHJvbW90aW9uLWhlYWx0aC1vcmlnaW5hbC0ke25vbmNlfWA7XG4gIGNvbnN0IGN1cnJlbnRJZCA9IGBjby50d2Vha2Vycy4ke3N1ZmZpeH1gO1xuICBjb25zdCBjdXJyZW50S2V5ID0gYCR7Q1VSUkVOVF9TVE9SQUdFX1BSRUZJWH0ke2N1cnJlbnRJZH1gO1xuICBjb25zdCBsZWdhY3lLZXkgPSBgJHtMRUdBQ1lfU1RPUkFHRV9QUkVGSVh9Y28ucHJvbW90aW9uLXByb2JlLiR7c3VmZml4fWA7XG4gIGNvbnN0IGV4cGVjdGVkQXJjaGl2ZUtleSA9IGAke0FSQ0hJVkVfU1RPUkFHRV9QUkVGSVh9JHtub25jZX06JHtlbmNvZGVVUklDb21wb25lbnQobGVnYWN5S2V5KX1gO1xuICBjb25zdCByYXcgPSBKU09OLnN0cmluZ2lmeSh7IHJldGFpbmVkOiB0cnVlLCBub25jZSB9KTtcbiAgbGV0IG93bnNQcm9iZUtleXMgPSBmYWxzZTtcbiAgbGV0IHJlc3VsdDogXCJwYXNzXCIgfCBcImZhaWxcIiA9IFwiZmFpbFwiO1xuICBsZXQgY2xlYW51cFN1Y2NlZWRlZCA9IHRydWU7XG5cbiAgdHJ5IHtcbiAgICBpZiAoc3RvcmFnZS5nZXRJdGVtKGN1cnJlbnRLZXkpICE9PSBudWxsIHx8IHN0b3JhZ2UuZ2V0SXRlbShsZWdhY3lLZXkpICE9PSBudWxsKSB7XG4gICAgICByZXN1bHQgPSBcImZhaWxcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgb3duc1Byb2JlS2V5cyA9IHRydWU7XG4gICAgICBzdG9yYWdlLnNldEl0ZW0obGVnYWN5S2V5LCByYXcpO1xuICAgICAgY29uc3QgcHJlcGFyZWQgPSBwcmVwYXJlUmVuZGVyZXJTdG9yYWdlTWlncmF0aW9uKGN1cnJlbnRJZCwgc3RvcmFnZSwgbm9uY2UpO1xuICAgICAgaWYgKHByZXBhcmVkLnN0YXR1cyAhPT0gXCJwcmVwYXJlZFwiIHx8IHByZXBhcmVkLmhvbGRQcm9tb3Rpb24gfHwgc3RvcmFnZS5nZXRJdGVtKGN1cnJlbnRLZXkpICE9PSByYXcpIHtcbiAgICAgICAgcmVzdWx0ID0gXCJmYWlsXCI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBjb21taXRSZW5kZXJlclN0b3JhZ2VNaWdyYXRpb24ocHJlcGFyZWQsIHN0b3JhZ2UpO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgY29tbWl0dGVkLnBoYXNlICE9PSBcImNvbW1pdHRlZFwiXG4gICAgICAgICAgfHwgY29tbWl0dGVkLmFyY2hpdmVLZXkgIT09IGV4cGVjdGVkQXJjaGl2ZUtleVxuICAgICAgICAgIHx8IHN0b3JhZ2UuZ2V0SXRlbShsZWdhY3lLZXkpICE9PSBudWxsXG4gICAgICAgICkge1xuICAgICAgICAgIHJlc3VsdCA9IFwiZmFpbFwiO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHJvbGxlZEJhY2sgPSByb2xsYmFja1JlbmRlcmVyU3RvcmFnZU1pZ3JhdGlvbihjb21taXR0ZWQsIHN0b3JhZ2UpO1xuICAgICAgICAgIHJlc3VsdCA9IHJvbGxlZEJhY2sucGhhc2UgPT09IFwicm9sbGVkX2JhY2tcIlxuICAgICAgICAgICAgJiYgc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgPT09IHJhd1xuICAgICAgICAgICAgJiYgc3RvcmFnZS5nZXRJdGVtKGN1cnJlbnRLZXkpID09PSBudWxsXG4gICAgICAgICAgICAmJiBzdG9yYWdlLmdldEl0ZW0oZXhwZWN0ZWRBcmNoaXZlS2V5KSA9PT0gbnVsbFxuICAgICAgICAgICAgPyBcInBhc3NcIlxuICAgICAgICAgICAgOiBcImZhaWxcIjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgcmVzdWx0ID0gXCJmYWlsXCI7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKG93bnNQcm9iZUtleXMpIHtcbiAgICAgIGNvbnN0IHJlbW92ZUFuZFZlcmlmeSA9IChrZXk6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHN0b3JhZ2UucmVtb3ZlSXRlbShrZXkpO1xuICAgICAgICAgIHJldHVybiBzdG9yYWdlLmdldEl0ZW0oa2V5KSA9PT0gbnVsbDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgY2xlYW51cFN1Y2NlZWRlZCA9IHJlbW92ZUFuZFZlcmlmeShjdXJyZW50S2V5KSAmJiBjbGVhbnVwU3VjY2VlZGVkO1xuICAgICAgY2xlYW51cFN1Y2NlZWRlZCA9IHJlbW92ZUFuZFZlcmlmeShsZWdhY3lLZXkpICYmIGNsZWFudXBTdWNjZWVkZWQ7XG4gICAgICBjbGVhbnVwU3VjY2VlZGVkID0gcmVtb3ZlQW5kVmVyaWZ5KGV4cGVjdGVkQXJjaGl2ZUtleSkgJiYgY2xlYW51cFN1Y2NlZWRlZDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0ID09PSBcInBhc3NcIiAmJiBjbGVhbnVwU3VjY2VlZGVkID8gXCJwYXNzXCIgOiBcImZhaWxcIjtcbn1cbiIsICJleHBvcnQgdHlwZSBQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRQaGFzZSA9IFwibG9hZGluZ1wiIHwgXCJtb3VudFwiIHwgXCJzZXR0bGVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50U2NoZWR1bGVyIHtcbiAgc2V0KGNhbGxiYWNrOiAoKSA9PiB2b2lkLCB0aW1lb3V0TXM6IG51bWJlcik6IHVua25vd247XG4gIGNsZWFyKGhhbmRsZTogdW5rbm93bik6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50TGlmZWN5Y2xlIHtcbiAgLyoqIFJlbWVtYmVycyBhbiBlYXJseSBtb3VudCwgYnV0IGNhbm5vdCBlbWl0IHN1Y2Nlc3MgYmVmb3JlIHdpbmRvdyBsb2FkLiAqL1xuICBtb3VudE9ic2VydmVkKCk6IGJvb2xlYW47XG4gIC8qKiBTdGFydHMgdGhlIG9uZS1zaG90IHBvc3QtbG9hZCB0aW1lb3V0IG9yIGZsdXNoZXMgYSByZW1lbWJlcmVkIG1vdW50LiAqL1xuICB3aW5kb3dMb2FkZWQoKTogYm9vbGVhbjtcbiAgc2V0dGxlKCk6IHZvaWQ7XG4gIHBoYXNlKCk6IFByb21vdGlvbk9yaWdpbmFsUmVuZGVyZXJNb3VudFBoYXNlO1xufVxuXG4vKipcbiAqIEJyb3dzZXItb25seSwgb25lLXNob3QgbGlmZWN5Y2xlIGZvciB0aGUgb3JpZ2luYWwgcmVuZGVyZXIgcHJlbG9hZCBwcm9vZi5cbiAqIEF1dGhvcml6YXRpb24gbWF5IHN0YXJ0IG9ic2VydmF0aW9uIGVhcmx5LCBidXQgdGhlIHRpbWVvdXQgY2xvY2sgYW5kIGFueVxuICogc3VjY2Vzc2Z1bCBwcm9vZiByZW1haW4gZ2F0ZWQgb24gdGhlIGRvY3VtZW50J3MgYWN0dWFsIGxvYWQgZXZlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRMaWZlY3ljbGUob3B0aW9uczoge1xuICBvbkxvYWRPYnNlcnZlZDogKCkgPT4gdm9pZDtcbiAgb25Nb3VudGVkOiAoKSA9PiB2b2lkO1xuICBvblRpbWVvdXQ6ICgpID0+IHZvaWQ7XG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICBzY2hlZHVsZXI/OiBQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRTY2hlZHVsZXI7XG59KTogUHJvbW90aW9uT3JpZ2luYWxSZW5kZXJlck1vdW50TGlmZWN5Y2xlIHtcbiAgY29uc3Qgc2NoZWR1bGVyID0gb3B0aW9ucy5zY2hlZHVsZXIgPz8ge1xuICAgIHNldChjYWxsYmFjaywgdGltZW91dE1zKSB7XG4gICAgICByZXR1cm4gc2V0VGltZW91dChjYWxsYmFjaywgdGltZW91dE1zKTtcbiAgICB9LFxuICAgIGNsZWFyKGhhbmRsZSkge1xuICAgICAgY2xlYXJUaW1lb3V0KGhhbmRsZSBhcyBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pik7XG4gICAgfSxcbiAgfTtcbiAgbGV0IHBoYXNlOiBQcm9tb3Rpb25PcmlnaW5hbFJlbmRlcmVyTW91bnRQaGFzZSA9IFwibG9hZGluZ1wiO1xuICBsZXQgbW91bnRlZCA9IGZhbHNlO1xuICBsZXQgbG9hZE9ic2VydmVkID0gZmFsc2U7XG4gIGxldCBoYW5kbGU6IHVua25vd24gPSBudWxsO1xuXG4gIGNvbnN0IHNldHRsZSA9IChjYWxsYmFjaz86ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcbiAgICBpZiAocGhhc2UgPT09IFwic2V0dGxlZFwiKSByZXR1cm47XG4gICAgaWYgKGhhbmRsZSAhPT0gbnVsbCkgc2NoZWR1bGVyLmNsZWFyKGhhbmRsZSk7XG4gICAgaGFuZGxlID0gbnVsbDtcbiAgICBwaGFzZSA9IFwic2V0dGxlZFwiO1xuICAgIGNhbGxiYWNrPy4oKTtcbiAgfTtcblxuICByZXR1cm4ge1xuICAgIG1vdW50T2JzZXJ2ZWQoKSB7XG4gICAgICBpZiAocGhhc2UgPT09IFwic2V0dGxlZFwiIHx8IG1vdW50ZWQpIHJldHVybiBmYWxzZTtcbiAgICAgIG1vdW50ZWQgPSB0cnVlO1xuICAgICAgaWYgKHBoYXNlID09PSBcIm1vdW50XCIpIHNldHRsZShvcHRpb25zLm9uTW91bnRlZCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIHdpbmRvd0xvYWRlZCgpIHtcbiAgICAgIGlmIChwaGFzZSAhPT0gXCJsb2FkaW5nXCIgfHwgbG9hZE9ic2VydmVkKSByZXR1cm4gZmFsc2U7XG4gICAgICBsb2FkT2JzZXJ2ZWQgPSB0cnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgb3B0aW9ucy5vbkxvYWRPYnNlcnZlZCgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcGhhc2UgPSBcInNldHRsZWRcIjtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBwaGFzZSA9IFwibW91bnRcIjtcbiAgICAgIGlmIChtb3VudGVkKSB7XG4gICAgICAgIHNldHRsZShvcHRpb25zLm9uTW91bnRlZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBoYW5kbGUgPSBzY2hlZHVsZXIuc2V0KCgpID0+IHtcbiAgICAgICAgICBpZiAocGhhc2UgIT09IFwibW91bnRcIikgcmV0dXJuO1xuICAgICAgICAgIGhhbmRsZSA9IG51bGw7XG4gICAgICAgICAgcGhhc2UgPSBcInNldHRsZWRcIjtcbiAgICAgICAgICBvcHRpb25zLm9uVGltZW91dCgpO1xuICAgICAgICB9LCBvcHRpb25zLnRpbWVvdXRNcyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIHNldHRsZSgpIHtcbiAgICAgIHNldHRsZSgpO1xuICAgIH0sXG4gICAgcGhhc2UoKSB7XG4gICAgICByZXR1cm4gcGhhc2U7XG4gICAgfSxcbiAgfTtcbn1cbiIsICJleHBvcnQgdHlwZSBQcm9tb3Rpb25SZW5kZXJlck1vdW50U3RhdGUgPSBcIndhaXRpbmdcIiB8IFwibW91bnRlZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFByb21vdGlvblJlbmRlcmVyUm9vdE9ic2VydmF0aW9uIHtcbiAgcm9vdFByZXNlbnQ6IGJvb2xlYW47XG4gIHN0YXJ0dXBMb2FkZXJQcmVzZW50OiBib29sZWFuO1xuICBlbGVtZW50Q2hpbGRDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByb21vdGlvblJlbmRlcmVyTW91bnRUcmFja2VyIHtcbiAgb2JzZXJ2ZShvYnNlcnZhdGlvbjogUHJvbW90aW9uUmVuZGVyZXJSb290T2JzZXJ2YXRpb24pOiBQcm9tb3Rpb25SZW5kZXJlck1vdW50U3RhdGU7XG4gIHJlc3VsdCgpOiBQcm9tb3Rpb25SZW5kZXJlck1vdW50U3RhdGU7XG59XG5cbmNvbnN0IFBST01PVElPTl9SRU5ERVJFUl9OT05DRV9RVUVSWSA9IFwidHdlYWtlclByb21vdGlvbk5vbmNlXCI7XG5jb25zdCBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUEFUVEVSTiA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tNFswLTlhLWZdezN9LVs4OWFiXVswLTlhLWZdezN9LVswLTlhLWZdezEyfSQvaTtcbmNvbnN0IFBST01PVElPTl9SRU5ERVJFUl9BVVRIX1JFU1BPTlNFX01BWF9DSEFSUyA9IDFfMDI0O1xuXG5leHBvcnQgaW50ZXJmYWNlIFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvblJlcXVlc3Qge1xuICB2ZXJzaW9uOiAxO1xuICB1cmw6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25SZXNwb25zZSB7XG4gIHZlcnNpb246IDE7XG4gIG5vbmNlOiBzdHJpbmc7XG4gIHVybDogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25BdHRlbXB0ID1cbiAgfCB7IGtpbmQ6IFwib3JkaW5hcnlcIiB9XG4gIHwgeyBraW5kOiBcImludmFsaWQtY2FuZGlkYXRlXCI7IHJlYXNvbjogc3RyaW5nIH1cbiAgfCB7XG4gICAga2luZDogXCJjYW5kaWRhdGVcIjtcbiAgICBub25jZTogc3RyaW5nO1xuICAgIHJlcXVlc3Q6IFByb21vdGlvblJlbmRlcmVyQXV0aG9yaXphdGlvblJlcXVlc3Q7XG4gIH07XG5cbi8qKlxuICogQ2xhc3NpZmllcyB0aGUgY3VycmVudCBkb2N1bWVudCBiZWZvcmUgcGFnZSBzY3JpcHRzIHJ1bi4gT3JkaW5hcnkgd2luZG93c1xuICogdGFrZSB0aGUgbm9ybWFsIHByZWxvYWQgcGF0aC4gQSBVUkwgdGhhdCBjYXJyaWVzIHRoZSByZXNlcnZlZCBwcm9vZiBxdWVyeSBpc1xuICogZmFpbC1jbG9zZWQgdW5sZXNzIGl0IGlzIHRoZSBvbmUgZXhhY3QgY2FuZGlkYXRlIGRvY3VtZW50IHNoYXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvbW90aW9uUmVuZGVyZXJBdXRob3JpemF0aW9uQXR0ZW1wdChocmVmOiBzdHJpbmcpOiBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25BdHRlbXB0IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKGhyZWYpO1xuICAgIGNvbnN0IHF1ZXJ5RW50cmllcyA9IFsuLi5wYXJzZWQuc2VhcmNoUGFyYW1zLmVudHJpZXMoKV07XG4gICAgY29uc3QgaGFzUmVzZXJ2ZWRRdWVyeSA9IHF1ZXJ5RW50cmllcy5zb21lKChba2V5XSkgPT4ga2V5ID09PSBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUlkpO1xuICAgIGlmICghaGFzUmVzZXJ2ZWRRdWVyeSkgcmV0dXJuIHsga2luZDogXCJvcmRpbmFyeVwiIH07XG4gICAgaWYgKFxuICAgICAgcGFyc2VkLnByb3RvY29sICE9PSBcImFwcDpcIlxuICAgICAgfHwgcGFyc2VkLmhvc3RuYW1lICE9PSBcIi1cIlxuICAgICAgfHwgcGFyc2VkLnVzZXJuYW1lICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGFzc3dvcmQgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wb3J0ICE9PSBcIlwiXG4gICAgICB8fCBwYXJzZWQucGF0aG5hbWUgIT09IFwiL2luZGV4Lmh0bWxcIlxuICAgICAgfHwgcGFyc2VkLmhhc2ggIT09IFwiXCJcbiAgICAgIHx8IHF1ZXJ5RW50cmllcy5sZW5ndGggIT09IDFcbiAgICAgIHx8IHF1ZXJ5RW50cmllc1swXT8uWzBdICE9PSBQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUVVFUllcbiAgICApIHJldHVybiB7IGtpbmQ6IFwiaW52YWxpZC1jYW5kaWRhdGVcIiwgcmVhc29uOiBcImNhbmRpZGF0ZSBVUkwgc2hhcGUgaW52YWxpZFwiIH07XG4gICAgY29uc3Qgbm9uY2UgPSBxdWVyeUVudHJpZXNbMF1bMV07XG4gICAgaWYgKCFQUk9NT1RJT05fUkVOREVSRVJfTk9OQ0VfUEFUVEVSTi50ZXN0KG5vbmNlKSkge1xuICAgICAgcmV0dXJuIHsga2luZDogXCJpbnZhbGlkLWNhbmRpZGF0ZVwiLCByZWFzb246IFwiY2FuZGlkYXRlIG5vbmNlIGludmFsaWRcIiB9O1xuICAgIH1cbiAgICBpZiAocGFyc2VkLnRvU3RyaW5nKCkgIT09IGhyZWYpIHtcbiAgICAgIHJldHVybiB7IGtpbmQ6IFwiaW52YWxpZC1jYW5kaWRhdGVcIiwgcmVhc29uOiBcImNhbmRpZGF0ZSBVUkwgaXMgbm90IGNhbm9uaWNhbFwiIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcImNhbmRpZGF0ZVwiLFxuICAgICAgbm9uY2UsXG4gICAgICByZXF1ZXN0OiB7IHZlcnNpb246IDEsIHVybDogaHJlZiB9LFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGtpbmQ6IFwib3JkaW5hcnlcIiB9O1xuICB9XG59XG5cbi8qKiBBY2NlcHRzIG9ubHkgdGhlIGV4YWN0IHN5bmNocm9ub3VzIG1haW4tcHJvY2VzcyBhdXRob3JpemF0aW9uIHJlc3BvbnNlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21vdGlvblJlbmRlcmVyQXV0aG9yaXplZE5vbmNlKFxuICBhdHRlbXB0OiBQcm9tb3Rpb25SZW5kZXJlckF1dGhvcml6YXRpb25BdHRlbXB0LFxuICByZXNwb25zZTogdW5rbm93bixcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoXG4gICAgYXR0ZW1wdC5raW5kICE9PSBcImNhbmRpZGF0ZVwiXG4gICAgfHwgdHlwZW9mIHJlc3BvbnNlICE9PSBcInN0cmluZ1wiXG4gICAgfHwgcmVzcG9uc2UubGVuZ3RoID09PSAwXG4gICAgfHwgcmVzcG9uc2UubGVuZ3RoID4gUFJPTU9USU9OX1JFTkRFUkVSX0FVVEhfUkVTUE9OU0VfTUFYX0NIQVJTXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBkZWNvZGVkID0gSlNPTi5wYXJzZShyZXNwb25zZSkgYXMgdW5rbm93bjtcbiAgICBpZiAoZGVjb2RlZCA9PT0gbnVsbCB8fCB0eXBlb2YgZGVjb2RlZCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KGRlY29kZWQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB2YWx1ZSA9IGRlY29kZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgaWYgKE9iamVjdC5rZXlzKHZhbHVlKS5zb3J0KCkuam9pbihcIixcIikgIT09IFwibm9uY2UsdXJsLHZlcnNpb25cIikgcmV0dXJuIG51bGw7XG4gICAgaWYgKHZhbHVlLnZlcnNpb24gIT09IDEgfHwgdHlwZW9mIHZhbHVlLm5vbmNlICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiB2YWx1ZS51cmwgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICAgIGlmICghUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1BBVFRFUk4udGVzdCh2YWx1ZS5ub25jZSkpIHJldHVybiBudWxsO1xuICAgIGlmICh2YWx1ZS5ub25jZSAhPT0gYXR0ZW1wdC5ub25jZSB8fCB2YWx1ZS51cmwgIT09IGF0dGVtcHQucmVxdWVzdC51cmwpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodmFsdWUudXJsKTtcbiAgICBjb25zdCBlbnRyaWVzID0gWy4uLnBhcnNlZC5zZWFyY2hQYXJhbXMuZW50cmllcygpXTtcbiAgICBpZiAoXG4gICAgICBwYXJzZWQucHJvdG9jb2wgIT09IFwiYXBwOlwiXG4gICAgICB8fCBwYXJzZWQuaG9zdG5hbWUgIT09IFwiLVwiXG4gICAgICB8fCBwYXJzZWQudXNlcm5hbWUgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wYXNzd29yZCAhPT0gXCJcIlxuICAgICAgfHwgcGFyc2VkLnBvcnQgIT09IFwiXCJcbiAgICAgIHx8IHBhcnNlZC5wYXRobmFtZSAhPT0gXCIvaW5kZXguaHRtbFwiXG4gICAgICB8fCBwYXJzZWQuaGFzaCAhPT0gXCJcIlxuICAgICAgfHwgZW50cmllcy5sZW5ndGggIT09IDFcbiAgICAgIHx8IGVudHJpZXNbMF0/LlswXSAhPT0gUFJPTU9USU9OX1JFTkRFUkVSX05PTkNFX1FVRVJZXG4gICAgICB8fCBlbnRyaWVzWzBdWzFdICE9PSB2YWx1ZS5ub25jZVxuICAgICAgfHwgcGFyc2VkLnRvU3RyaW5nKCkgIT09IHZhbHVlLnVybFxuICAgICkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHZhbHVlLm5vbmNlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFByb3ZlcyB0aGUgYXBwbGljYXRpb24gcmVuZGVyZXIgcmVwbGFjZWQgaXRzIHN0YXRpYyBzdGFydHVwIGxvYWRlciB3aXRoIHJlYWxcbiAqIGNvbnRlbnQuIEEgcHJlLWV4aXN0aW5nIG5vbi1lbXB0eSByb290IGlzIGluc3VmZmljaWVudDogdGhlIHRyYWNrZXIgbXVzdFxuICogZmlyc3Qgb2JzZXJ2ZSB0aGUgY2Fub25pY2FsIGxvYWRlciBhbmQgdGhlbiBvYnNlcnZlIGEgbm9uLWVtcHR5IHJlcGxhY2VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIoKTogUHJvbW90aW9uUmVuZGVyZXJNb3VudFRyYWNrZXIge1xuICBsZXQgc2F3U3RhcnR1cExvYWRlciA9IGZhbHNlO1xuICBsZXQgbW91bnRlZCA9IGZhbHNlO1xuXG4gIHJldHVybiB7XG4gICAgb2JzZXJ2ZShvYnNlcnZhdGlvbikge1xuICAgICAgaWYgKG1vdW50ZWQpIHJldHVybiBcIm1vdW50ZWRcIjtcbiAgICAgIGlmICghb2JzZXJ2YXRpb24ucm9vdFByZXNlbnQpIHJldHVybiBcIndhaXRpbmdcIjtcbiAgICAgIGlmIChvYnNlcnZhdGlvbi5zdGFydHVwTG9hZGVyUHJlc2VudCkge1xuICAgICAgICBzYXdTdGFydHVwTG9hZGVyID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIFwid2FpdGluZ1wiO1xuICAgICAgfVxuICAgICAgaWYgKHNhd1N0YXJ0dXBMb2FkZXIgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIob2JzZXJ2YXRpb24uZWxlbWVudENoaWxkQ291bnQpICYmIG9ic2VydmF0aW9uLmVsZW1lbnRDaGlsZENvdW50ID4gMCkge1xuICAgICAgICBtb3VudGVkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBtb3VudGVkID8gXCJtb3VudGVkXCIgOiBcIndhaXRpbmdcIjtcbiAgICB9LFxuICAgIHJlc3VsdCgpIHtcbiAgICAgIHJldHVybiBtb3VudGVkID8gXCJtb3VudGVkXCIgOiBcIndhaXRpbmdcIjtcbiAgICB9LFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBQUEsc0JBQTRCOzs7QUNBNUIsSUFBTSxpQkFBaUIsSUFBSSxZQUFZO0FBQUEsRUFDckM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUN0QyxDQUFDO0FBRUQsSUFBTSxlQUFlLElBQUksWUFBWTtBQUFBLEVBQ25DO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQ3BDO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUFZO0FBQUEsRUFDcEM7QUFBQSxFQUFZO0FBQUEsRUFBWTtBQUFBLEVBQVk7QUFBQSxFQUNwQztBQUFBLEVBQVk7QUFBQSxFQUFZO0FB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QUFDckUsUUFBTSxRQUFRLG9DQUFvQztBQUNsRCxNQUFJLFdBQW9DO0FBQ3hDLFFBQU0sZ0JBQWdCLE1BQVk7QUFDaEMsV0FBTyxvQkFBb0IsUUFBUSxZQUFZO0FBQy9DLGNBQVUsV0FBVztBQUFBLEVBQ3ZCO0FBQ0EsUUFBTSxZQUFZLDhDQUE4QztBQUFBLElBQzlELFdBQVc7QUFBQSxJQUNYLGlCQUFpQjtBQUNmLGtDQUFZLEtBQUsseUNBQXlDO0FBQUEsUUFDeEQsT0FBTyxXQUFXO0FBQUEsUUFDbEIsS0FBSztBQUFBLFFBQ0wsV0FBVztBQUFBLFFBQ1gsbUJBQW1CO0FBQUEsTUFDckIsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLFlBQVk7QUFDVixvQkFBYztBQUNkLGtDQUFZLEtBQUsseUNBQXlDO0FBQUEsUUFDeEQsT0FBTyxXQUFXO0FBQUEsUUFDbEIsS0FBSztBQUFBLFFBQ0wsV0FBVztBQUFBLFFBQ1gsbUJBQW1CO0FBQUEsUUFDbkIseUJBQXlCLDhCQUE4QixjQUFjLFdBQVcsS0FBSztBQUFBLE1BQ3ZGLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxZQUFZO0FBQ1Ysb0JBQWM7QUFDZCxrQ0FBWSxLQUFLLHlDQUF5QztBQUFBLFFBQ3hELE9BQU8sV0FBVztBQUFBLFFBQ2xCLEtBQUs7QUFBQSxRQUNMLFdBQVc7QUFBQSxRQUNYLG1CQUFtQjtBQUFBLE1BQ3JCLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixDQUFDO0FBRUQsV0FBUyxlQUFxQjtBQUM1QixjQUFVLGFBQWE7QUFBQSxFQUN6QjtBQUVBLFdBQVMsVUFBZ0I7QUFDdkIsUUFBSSxVQUFVLE1BQU0sTUFBTSxVQUFXO0FBQ3JDLFVBQU0sT0FBTyxTQUFTLGVBQWUsTUFBTTtBQUMzQyxVQUFNLFFBQVEsTUFBTSxRQUFRO0FBQUEsTUFDMUIsYUFBYSxTQUFTO0FBQUEsTUFDdEIsc0JBQXNCLFNBQVMsUUFBUSxLQUFLLGNBQWMsMEJBQTBCLE1BQU07QUFBQSxNQUMxRixtQkFBbUIsTUFBTSxTQUFTLFVBQVU7QUFBQSxJQUM5QyxDQUFDO0FBQ0QsUUFBSSxVQUFVLFVBQVc7QUFDekIsY0FBVSxjQUFjO0FBQUEsRUFDMUI7QUFFQSxhQUFXLElBQUksaUJBQWlCLE9BQU87QUFDdkMsU0FBTyxpQkFBaUIsUUFBUSxjQUFjLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFHNUQsTUFBSSxTQUFTLGVBQWUsV0FBWSxjQUFhO0FBQ3JELFdBQVMsUUFBUSxVQUFVLEVBQUUsV0FBVyxNQUFNLFNBQVMsS0FBSyxDQUFDO0FBQzdELFVBQVE7QUFDVjsiLAogICJuYW1lcyI6IFsiaGFuZGxlIl0KfQo=
