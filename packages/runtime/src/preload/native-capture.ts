import type { NativeCaptureApi } from "@therealityreport/tweakers-sdk";

type Adapter = NativeCaptureApi;

/** This adapter delegates to Codex's existing RPC services; it never captures. */
export function createNativeCaptureBridge() {
  let adapter: Adapter | null = null;
  let inFlight = 0;
  const call = async <T>(operation: (active: Adapter) => Promise<T>): Promise<T> => {
    if (!adapter) throw new Error("Native Codex capture services are unavailable in this window");
    if (inFlight >= 4) throw new Error("Native capture services are busy");
    inFlight++;
    const active = adapter;
    const pending = Promise.resolve().then(() => operation(active)).finally(() => { inFlight--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native capture service did not respond")), 5_000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const api: NativeCaptureApi = {
    appshots: {
      getState: () => call(active => active.appshots.getState()),
      setHotkey: hotkey => {
        if (hotkey !== null && hotkey !== "DoubleCommand") return Promise.reject(new Error("Unsupported native shortcut"));
        return call(active => active.appshots.setHotkey(hotkey));
      },
    },
    computerHistory: { getState: () => call(active => active.computerHistory.getState()) },
  };
  return {
    api,
    transport: {
      register(value: Adapter): boolean {
        if (adapter || typeof value?.appshots?.getState !== "function"
          || typeof value?.appshots?.setHotkey !== "function"
          || typeof value?.computerHistory?.getState !== "function") return false;
        adapter = value;
        return true;
      },
    },
  };
}

export const nativeCaptureBridge = createNativeCaptureBridge();
