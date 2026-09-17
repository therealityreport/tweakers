import { createHash } from "node:crypto";

export const ACCOUNTS_NATIVE_MAIN_KEY = "__tweakersAccountsNativeMainV1";
export const ACCOUNTS_NATIVE_MAIN_PATH = ".vite/build/main-D87AK7lw.js";
export const ACCOUNTS_NATIVE_SHARED_PATH = ".vite/build/src-J2PvP4xj.js";
export const ACCOUNTS_NATIVE_MAIN_PATHS = [ACCOUNTS_NATIVE_MAIN_PATH, ACCOUNTS_NATIVE_SHARED_PATH] as const;
const MAIN_HASHES = [
  "440f7b699361ec30aa29e9517055e06d85f5e2da00a58a1ff4673e3c4cb0628f",
  "8bfd0184e3e9b31d45d963e0dd4be4a0dc17b34732e5399ea90880b048100340",
];
const SHARED_HASH = "4cc980cd737b02f999b9fe8d9757c37d2ce86c928043f19f46d56cc52bce8f66";
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");

/** Prepare native account-home overrides together with the renderer hooks. */
export function patchAccountsNativeMainSources(sources: ReadonlyMap<string, string>, hookSetSha256: string): Map<string, string> {
  let main = sources.get(ACCOUNTS_NATIVE_MAIN_PATH);
  let shared = sources.get(ACCOUNTS_NATIVE_SHARED_PATH);
  if (!main || !shared || !MAIN_HASHES.includes(hash(main)) || hash(shared) !== SHARED_HASH) {
    throw new Error("This desktop's native account browser helpers have not been reviewed.");
  }
  if ([...sources].filter(([path, source]) => /^\.vite\/build\/main-[^/]+\.js$/.test(path) && source.includes("async function Ms({appServerConnection:e,")).length !== 1) {
    throw new Error("More than one native account browser helper matched.");
  }
  const edit = (anchor: string, replacement: string) => {
    if (main!.split(anchor).length !== 2) throw new Error("Native account browser helper anchor changed.");
    main = main!.replace(anchor, replacement);
  };
  edit('"get-global-state":async({key:e})=>({value:this.getGlobalStateValue(e)})',
    '"get-global-state":async({key:e})=>{await __twAccountsDesktopProjects.ensure(this,e);return{value:this.getGlobalStateValue(e)}}');
  edit('"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{let i=',
    '"workspace-root-options":async({canonicalizeRoots:e,hostId:t,signal:r})=>{if(t===`local`)await __twAccountsDesktopProjects.ensure(this);let i=');
  edit('async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();let r=',
    'async initializeProjects(e){await Promise.allSettled(this.pendingProjectWrites.values()),e.throwIfAborted();let t=await this.connection.codexHome();e.throwIfAborted();await __twAccountsDesktopProjects.ensureBackend(this,t);e.throwIfAborted();let r=');
  edit('await DOe(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())',
    'await DOe(this.pendingProjectWrites,e,async()=>{r.throwIfAborted(),await __twAccountsDesktopProjects.ensureWrite(this),r.throwIfAborted(),this.projectSupport===`supported`&&(await t(r),r.throwIfAborted())');
  edit('getInitialSidebarBootstrap(){let e=this.threadCatalogSyncManager;',
    'getInitialSidebarBootstrap(){void __twAccountsDesktopProjects.ensure(this.fetchHandler).catch(()=>{});let e=this.threadCatalogSyncManager;');
  edit("async function Ms({appServerConnection:e,", "async function Ms({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("_=await Eo({appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,", "_=await Eo({codexHome:__twAccountsHome,appServerConnection:e,desktopFeatureAvailability:m,marketplaces:g,");
  edit("async function Eo({appServerConnection:e,", "async function Eo({codexHome:__twAccountsHome,appServerConnection:e,");
  edit("let s=n.ci(),c=n.hc(a.i.resolve()),l=Zr(o)", "let s=__twAccountsHome??n.ci(),c=n.hc(a.i.resolve()),l=Zr(o)");
  const removalAnchor = "a.length===0&&!o||($Y.info(`chrome_native_host_manifest_remove_requested`";
  if (shared.split(removalAnchor).length !== 2) throw new Error("Native browser consumer preservation anchor changed.");
  shared = shared.replace(removalAnchor, "if(e.preserveRetainedConsumers===!0)return __twAccountsPreserveNativeConsumers({manifestPaths:a,nativeHostName:t,pluginCacheRoot:r});" + removalAnchor);
  shared += nativeAccountsConsumerPreservationSource();
  main += nativeAccountsDesktopProjectsSource();
  main += nativeAccountsMainRegistrationSource(hookSetSha256);
  return new Map([[ACCOUNTS_NATIVE_MAIN_PATH, main], [ACCOUNTS_NATIVE_SHARED_PATH, shared]]);
}

export function nativeAccountsMainRegistrationSource(hookSetSha256: string): string {
  return `\n;((__name)=>{Object.defineProperty(globalThis,${JSON.stringify(ACCOUNTS_NATIVE_MAIN_KEY)},{value:{version:1,hookSetSha256:${JSON.stringify(hookSetSha256)},refreshProjects:()=>__twAccountsDesktopProjects.refresh(),create:(input)=>(${nativeAccountsMainFactory.toString()})(input,{sync:(options)=>new As(options).syncAfterPluginChange(),install:(options)=>n.in(options),uninstall:(options)=>n.on(options),appVersion:l.app.getVersion(),isPackaged:l.app.isPackaged,resourcesPath:process.resourcesPath})},configurable:false,writable:false});})((fn)=>fn);\n`;
}

export function nativeAccountsDesktopProjectsSource(): string {
  return `\n;var __twAccountsDesktopProjects=((__name)=>(${nativeAccountsDesktopProjects.toString()})({enabled:()=>globalThis.__tweakersAccountsDesktopProjectsEnabledV1?.()===true,hostKey:()=>\`local:\${n.ci()}\`,onFocus:(fn)=>l.app.on("browser-window-focus",fn)}))((fn)=>fn);\n`;
}

/** Read overlays keep the native project consumers and their normal write paths. */
export function nativeAccountsDesktopProjects(native: any): any {
  const keys = new Set([
    "local-projects", "thread-project-assignments", "project-order", "pinned-project-ids",
    "sidebar-project-thread-orders", "electron-saved-workspace-roots", "electron-workspace-root-labels",
    "project-appearances", "app-server-project-id-by-legacy-project-id-by-host",
  ]);
  const records = new Map<any, any>();
  const overrideKey = "tweakers-accounts-project-overrides-v1";
  const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const remoteProjectIds = (value: any) => new Set(Array.isArray(value) && value.length <= 512
    ? value.filter((entry) => object(entry) && typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 512).map((entry) => entry.id) : []);
  const enabled = () => { try { return native.enabled() === true; } catch { return false; } };
  const merge = (key: string, projected: any, local: any, host: string) => {
    if (projected === undefined) return local;
    if (Array.isArray(projected)) return [...new Set([...(Array.isArray(local) ? local : []), ...projected])];
    if (object(projected)) {
      if (key === "app-server-project-id-by-legacy-project-id-by-host") {
        return { ...(object(local) ? local : {}), ...projected, [host]: { ...(object(local?.[host]) ? local[host] : {}), ...(object(projected[host]) ? projected[host] : {}) } };
      }
      if (key === "local-projects") return clone(projected);
      return { ...(object(local) ? local : {}), ...projected };
    }
    return local ?? projected;
  };
  const notify = (record: any) => {
    if (!record.controller) return;
    record.controller.windowManager.sendMessageToAllWindows({ type: "global-state-updated", keys: [...keys] });
    record.controller.windowManager.sendMessageToAllWindows({ type: "workspace-root-options-updated" });
  };
  const recordFor = (store: any, connection: any, hostKey: string, controller?: any) => {
    let record = records.get(store);
    if (record) { if (controller) record.controller = controller; return record; }
    if (!store || typeof store.get !== "function" || typeof store.getStored !== "function" || typeof store.set !== "function") throw new Error("Native project state is unavailable.");
    const get = store.get, set = store.set;
    const saved = store.getStored(overrideKey);
    if (saved !== undefined && (saved?.version !== 1 || !object(saved.fields)
      || Object.keys(saved.fields).some((key) => !keys.has(key)) || Buffer.byteLength(JSON.stringify(saved), "utf8") > 8 * 1024 * 1024)) throw new Error("Native project overrides are invalid.");
    const fields = clone(saved?.fields ?? {});
    for (const field of Object.values(fields) as any[]) {
      if (!object(field) || Object.keys(field).some((key) => !["value", "removed", "nestedRemoved", "identities"].includes(key))
        || !Array.isArray(field.removed) || field.removed.some((id: any) => typeof id !== "string") || !(object(field.value) || Array.isArray(field.value))
        || (field.nestedRemoved !== undefined && (!object(field.nestedRemoved) || Object.values(field.nestedRemoved).some((entries: any) =>
          !(Array.isArray(entries) && entries.every((id: any) => typeof id === "string"))
          && !(object(entries) && Object.values(entries).every((id: any) => typeof id === "string")))))
        || (field.identities !== undefined && (!object(field.identities) || Object.values(field.identities).some((entries: any) =>
          !object(entries) || Object.values(entries).some((id: any) => typeof id !== "string"))))) throw new Error("Native project overrides are invalid.");
    }
    record = { controller, connection, hostKey, fields, store, values: null, fingerprint: null, pending: null, refreshedAt: 0, generation: 0, verified: false, rawGet: get, rawSet: set };
    records.set(store, record);
    const baseline = (key: string, local: any) => merge(key, record.values?.[key], local, record.hostKey);
    const applyField = (key: string, value: any, field: any) => {
      if (!field) return clone(value);
      const removed = new Set(field.removed);
      if (Array.isArray(field.value)) return [...new Set([...field.value, ...(Array.isArray(value) ? value : []).filter((entry: any) => !removed.has(entry))])];
      const merged = { ...(object(value) ? value : {}), ...field.value };
      if (key === "app-server-project-id-by-legacy-project-id-by-host") {
        for (const host of new Set([...Object.keys(object(value) ? value : {}), ...Object.keys(field.value)])) {
          if (!object(value?.[host]) && !object(field.value?.[host])) continue;
          const hostMap = { ...(object(value?.[host]) ? value[host] : {}), ...(object(field.value?.[host]) ? field.value[host] : {}) };
          const nested = field.nestedRemoved?.[host];
          for (const id of Array.isArray(nested) ? nested : object(nested) ? Object.keys(nested) : []) delete hostMap[id];
          merged[host] = hostMap;
        }
      }
      for (const entry of removed) delete merged[entry as string];
      return merged;
    };
    const effective = (key: string, local: any) => {
      let value = applyField(key, baseline(key, local), record.fields[key]);
      const map = key === "app-server-project-id-by-legacy-project-id-by-host" ? value
        : applyField("app-server-project-id-by-legacy-project-id-by-host", baseline("app-server-project-id-by-legacy-project-id-by-host", get.call(store, "app-server-project-id-by-legacy-project-id-by-host")), record.fields["app-server-project-id-by-legacy-project-id-by-host"]);
      const projectedProjects = key === "local-projects" ? value
        : applyField("local-projects", baseline("local-projects", get.call(store, "local-projects")), record.fields["local-projects"]);
      const projectRows = new Set(object(projectedProjects) ? Object.keys(projectedProjects) : []);
      const localProjectIds = new Set(object(map?.[record.hostKey]) ? Object.keys(map[record.hostKey]).filter((projectId) => projectRows.has(projectId)) : []);
      const remoteIds = remoteProjectIds(get.call(store, "remote-projects"));
      const projectIds = new Set([...localProjectIds, ...remoteIds]);
      if (key === "app-server-project-id-by-legacy-project-id-by-host" && object(value?.[record.hostKey])) value = { ...value,
        [record.hostKey]: Object.fromEntries(Object.entries(value[record.hostKey]).filter(([projectId]) => localProjectIds.has(projectId))) };
      if (key === "local-projects" && object(value)) value = Object.fromEntries(Object.entries(value).filter(([projectId]) => localProjectIds.has(projectId)));
      if ((key === "project-order" || key === "pinned-project-ids") && Array.isArray(value)) value = value.filter((projectId: any) => projectIds.has(projectId));
      if ((key === "sidebar-project-thread-orders" || key === "project-appearances") && object(value)) value = Object.fromEntries(Object.entries(value).filter(([projectId]) => projectIds.has(projectId)));
      if (key === "thread-project-assignments" && object(value)) value = Object.fromEntries(Object.entries(value).filter(([, assignment]: any) => object(assignment)
        && (assignment.projectKind === "remote" ? remoteIds.has(assignment.projectId) : assignment.projectKind === "local" && localProjectIds.has(assignment.projectId))));
      if (key === "electron-workspace-root-labels" && object(value)) {
        const roots = new Set(effective("electron-saved-workspace-roots", get.call(store, "electron-saved-workspace-roots")) ?? []);
        value = Object.fromEntries(Object.entries(value).filter(([root]) => roots.has(root)));
      }
      return clone(value);
    };
    store.get = function(key: string, ...args: any[]) {
      const local = get.call(this, key, ...args);
      if (this !== store || !enabled() || !record.values || !keys.has(key)) return local;
      return effective(key, local);
    };
    store.set = function(key: string, value: any, ...args: any[]) {
      if (this !== store || !enabled() || !keys.has(key)) return set.call(this, key, value, ...args);
      if (!record.values || !record.verified) throw new Error("Account projects are unavailable; changes are disabled until refresh succeeds.");
      const base = baseline(key, get.call(store, key));
      const intended = value ?? (Array.isArray(base) ? [] : {});
      let field;
      if (Array.isArray(intended) && Array.isArray(base)) {
        const keep = new Set(intended);
        field = { value: clone(intended), removed: base.filter((id: any) => !keep.has(id)) };
      } else if (object(intended) && (base === undefined || object(base))) {
        const delta: any = {};
        if (key === "app-server-project-id-by-legacy-project-id-by-host") {
          const nestedRemoved: any = {};
          for (const [host, entries] of Object.entries(intended)) {
            if (!object(entries) || !object(base?.[host])) { if (JSON.stringify(entries) !== JSON.stringify(base?.[host])) delta[host] = entries; continue; }
            const intendedEntries = entries as Record<string, unknown>, baseEntries = base[host] as Record<string, unknown>;
            const changed = Object.fromEntries(Object.entries(intendedEntries).filter(([id, entry]) => JSON.stringify(entry) !== JSON.stringify(baseEntries[id])));
            if (Object.keys(changed).length > 0) delta[host] = changed;
            const removed = Object.fromEntries(Object.entries(baseEntries).filter(([id]) => !Object.hasOwn(intendedEntries, id)));
            if (Object.keys(removed).length > 0) nestedRemoved[host] = removed;
          }
          field = { value: clone(delta), removed: Object.keys(base ?? {}).filter((host) => !Object.hasOwn(intended, host)), nestedRemoved,
            identities: Object.fromEntries(Object.entries(intended).filter(([, entries]) => object(entries)).map(([host, entries]) => [host, clone(entries)])) };
        } else {
          for (const [id, entry] of Object.entries(intended)) if (JSON.stringify(entry) !== JSON.stringify(base?.[id])) delta[id] = entry;
          field = { value: clone(delta), removed: Object.keys(base ?? {}).filter((id) => !Object.hasOwn(intended, id)) };
        }
      } else throw new Error("Native project override shape changed.");
      const next = { ...record.fields, [key]: field };
      const saved = { version: 1, fields: next };
      if (Buffer.byteLength(JSON.stringify(saved), "utf8") > 8 * 1024 * 1024) throw new Error("Native project overrides exceed the supported size.");
      const result = set.call(store, overrideKey, saved);
      record.fields = next;
      notify(record);
      return result;
    };
    return record;
  };
  const bindRecord = (record: any, connection: any, hostKey: string) => {
    if (record.connection === connection && record.hostKey === hostKey) return;
    const sameHome = record.hostKey === hostKey;
    record.generation++; record.connection = connection; record.hostKey = hostKey; record.pending = null; record.refreshedAt = 0; record.verified = false;
    if (!sameHome) { record.values = null; record.fingerprint = null; }
  };
  const normalizeProjection = (record: any, result: any) => {
    const values = clone(result.values), projectIdMap = clone(result.projectIdMap);
    const mapField = record.fields["app-server-project-id-by-legacy-project-id-by-host"];
    const localMap = { ...(object(record.rawGet.call(record.store, "app-server-project-id-by-legacy-project-id-by-host")?.[record.hostKey])
      ? record.rawGet.call(record.store, "app-server-project-id-by-legacy-project-id-by-host")[record.hostKey] : {}), ...(object(mapField?.identities?.[record.hostKey]) ? mapField.identities[record.hostKey] : {}),
      ...(object(mapField?.value?.[record.hostKey]) ? mapField.value[record.hostKey] : {}) };
    const nested = mapField?.nestedRemoved?.[record.hostKey];
    for (const id of Array.isArray(nested) ? nested : object(nested) ? Object.keys(nested) : []) delete localMap[id];
    const projectField = record.fields["local-projects"], localProjects = { ...(object(record.rawGet.call(record.store, "local-projects")) ? record.rawGet.call(record.store, "local-projects") : {}), ...(object(projectField?.value) ? projectField.value : {}) };
    for (const id of projectField?.removed ?? []) delete localProjects[id];
    const aliases: any = {};
    for (const [publicId, nativeId] of Object.entries(projectIdMap)) {
      const removedAliases = object(nested) ? Object.entries(nested).filter(([, mappedNativeId]) => mappedNativeId === nativeId).map(([legacyId]) => legacyId) : [];
      const candidates = [...Object.entries(localMap).filter(([legacyId, mappedNativeId]) => legacyId !== publicId && mappedNativeId === nativeId && Object.hasOwn(localProjects, legacyId)).map(([legacyId]) => legacyId), ...removedAliases];
      if (candidates.length === 1 && !Object.hasOwn(projectIdMap, candidates[0])) aliases[publicId] = candidates[0];
    }
    const rename = (id: any) => (typeof id === "string" ? aliases[id] : undefined) ?? id;
    if (object(values["local-projects"])) values["local-projects"] = Object.fromEntries(Object.entries(values["local-projects"]).map(([id, project]: any) => {
      const renamed = rename(id); return [renamed, object(project) ? { ...project, id: renamed } : project];
    }));
    for (const key of ["project-order", "pinned-project-ids"]) if (Array.isArray(values[key])) values[key] = values[key].map(rename);
    for (const key of ["sidebar-project-thread-orders", "project-appearances"]) if (object(values[key])) values[key] = Object.fromEntries(Object.entries(values[key]).map(([id, entry]) => [rename(id), entry]));
    if (object(values["thread-project-assignments"])) values["thread-project-assignments"] = Object.fromEntries(Object.entries(values["thread-project-assignments"]).map(([id, assignment]: any) => [id,
      object(assignment) && assignment.projectKind === "local" ? { ...assignment, projectId: rename(assignment.projectId) } : assignment]));
    return { values, projectIdMap: Object.fromEntries(Object.entries(projectIdMap).map(([id, nativeId]) => [rename(id), nativeId])) };
  };
  const reconcileFields = (record: any, values: any) => {
    const valid = new Set(Object.keys(values["local-projects"] ?? {}));
    const remoteIds = remoteProjectIds(record.rawGet.call(record.store, "remote-projects")), allIds = new Set([...valid, ...remoteIds]);
    const fields = clone(record.fields); let changed = false;
    const filterObject = (key: string, keep: (id: string, value: any) => boolean) => {
      const field = fields[key]; if (!object(field?.value)) return;
      const value = Object.fromEntries(Object.entries(field.value).filter(([id, entry]) => keep(id, entry)));
      if (JSON.stringify(value) !== JSON.stringify(field.value)) { field.value = value; changed = true; }
    };
    filterObject("local-projects", (id) => valid.has(id));
    for (const key of ["sidebar-project-thread-orders", "project-appearances"]) filterObject(key, (id) => allIds.has(id));
    filterObject("thread-project-assignments", (_id, assignment) => object(assignment) && (assignment.projectKind === "remote" ? remoteIds.has(assignment.projectId) : assignment.projectKind === "local" && valid.has(assignment.projectId)));
    const mapField = fields["app-server-project-id-by-legacy-project-id-by-host"];
    if (object(mapField?.value?.[record.hostKey])) {
      const currentNative = new Set(Object.values(values["app-server-project-id-by-legacy-project-id-by-host"]?.[record.hostKey] ?? {}));
      const mapped = Object.fromEntries(Object.entries(mapField.value[record.hostKey]).filter(([id, nativeId]) => valid.has(id) && currentNative.has(nativeId)));
      if (JSON.stringify(mapped) !== JSON.stringify(mapField.value[record.hostKey])) { mapField.value[record.hostKey] = mapped; changed = true; }
    }
    if (object(mapField?.identities?.[record.hostKey])) {
      const currentNative = new Set(Object.values(values["app-server-project-id-by-legacy-project-id-by-host"]?.[record.hostKey] ?? {}));
      const identities = Object.fromEntries(Object.entries(mapField.identities[record.hostKey]).filter(([id, nativeId]) => valid.has(id) && currentNative.has(nativeId)));
      if (JSON.stringify(identities) !== JSON.stringify(mapField.identities[record.hostKey])) { mapField.identities[record.hostKey] = identities; changed = true; }
    }
    for (const key of ["project-order", "pinned-project-ids"]) {
      const field = fields[key]; if (!Array.isArray(field?.value)) continue;
      const value = field.value.filter((id: any) => allIds.has(id));
      if (value.length !== field.value.length) { field.value = value; changed = true; }
    }
    if (changed) {
      const saved = { version: 1, fields };
      if (Buffer.byteLength(JSON.stringify(saved), "utf8") > 8 * 1024 * 1024) throw new Error("Native project overrides exceed the supported size.");
      record.rawSet.call(record.store, overrideKey, saved); record.fields = fields;
    }
  };
  const ensureRecord = async (record: any, force = false) => {
    if (force) { record.generation++; record.pending = null; record.verified = false; }
    if (record.pending) return record.pending;
    if (!force && Date.now() - record.refreshedAt < 5_000) return;
    const generation = record.generation, connection = record.connection;
    const pending = (async () => {
      try {
        const result = await connection.sendAppServerRequest("tweakers/desktopProjects/read", {});
        if (!enabled() || generation !== record.generation || connection !== record.connection) return;
        if (result?.version !== 1 || !object(result.values) || !object(result.projectIdMap)
          || Object.keys(result.values).some((name) => !keys.has(name)) || Buffer.byteLength(JSON.stringify(result), "utf8") > 8 * 1024 * 1024) throw new Error("Native project projection is unavailable.");
        const normalized = normalizeProjection(record, result);
        const values = { ...normalized.values, "app-server-project-id-by-legacy-project-id-by-host": { [record.hostKey]: normalized.projectIdMap } };
        reconcileFields(record, values);
        const fingerprint = JSON.stringify(values);
        const changed = record.fingerprint !== fingerprint;
        record.values = values; record.fingerprint = fingerprint; record.refreshedAt = Date.now(); record.verified = true;
        if (changed) notify(record);
      } catch {
        if (generation !== record.generation || connection !== record.connection) return;
        record.verified = false; record.refreshedAt = Date.now();
      }
    })();
    record.pending = pending;
    return pending.finally(() => { if (record.pending === pending) record.pending = null; });
  };
  const ensure = async (controller: any, key?: string) => {
    if (!enabled() || (key !== undefined && !keys.has(key))) return;
    const record = records.get(controller.globalState);
    if (!record) throw new Error("Account projects are unavailable; project initialization will retry.");
    record.controller = controller;
    await ensureRecord(record);
    if (!record.values) throw new Error("Account projects are unavailable; project initialization will retry.");
  };
  const ensureBackend = async (backend: any, home: string) => {
    if (!enabled() || backend.cache.hostId !== "local") return;
    const record = recordFor(backend.globalState, backend.connection, `local:${home}`);
    bindRecord(record, backend.connection, `local:${home}`);
    await ensureRecord(record);
    if (!record.values || !record.verified) throw new Error("Account projects are unavailable; project initialization will retry.");
  };
  const ensureWrite = async (backend: any) => {
    const home = await backend.connection.codexHome();
    if (typeof home !== "string" || !home.startsWith("/")) throw new Error("Account project connection home is unavailable.");
    return ensureBackend(backend, home);
  };
  const refresh = () => {
    for (const record of records.values()) {
      if (enabled()) void ensureRecord(record, true);
      else { record.generation++; record.pending = null; record.values = null; record.fingerprint = null; record.refreshedAt = 0; record.verified = false; notify(record); }
    }
  };
  native.onFocus(refresh);
  return { ensure, ensureBackend, ensureWrite, refresh };
}

/** Trusted main-world functions; renderer messages cannot supply homes or functions. */
export function nativeAccountsMainFactory(input: any, native: any): any {
  if (!input || typeof input.codexHome !== "string" || !input.codexHome.startsWith("/")
    || typeof input.appServerVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(input.appServerVersion)
    || typeof input.request !== "function" || typeof input.assertCurrent !== "function") throw new Error("Accounts browser binding is unavailable.");
  const codexHome = input.codexHome;
  const request = async (method: string, params: unknown) => {
    input.assertCurrent();
    const result = await input.request(method, params);
    input.assertCurrent();
    return result;
  };
  const connection = {
    hostConfig: { id: "local", display_name: "Local", kind: "local" },
    appServerVersion: input.appServerVersion,
    listPlugins: (params: unknown) => request("plugin/list", params),
    sendAppServerRequest: request,
  };
  return {
    async sync() {
      input.assertCurrent();
      await native.sync({ appServerConnection: connection, codexHome, appVersion: native.appVersion, isPackaged: native.isPackaged, resourcesPath: native.resourcesPath, reloadUserConfig: false });
      input.assertCurrent();
      return { ok: true };
    },
    async install(params: any) {
      input.assertCurrent();
      if (params?.hostId !== "local" || typeof params.marketplacePath !== "string" || !params.marketplacePath.startsWith("/") || typeof params.pluginName !== "string") throw new Error("Accounts browser install is unavailable for this execution host.");
      await native.install({ codexHome, marketplacePath: params.marketplacePath, pluginName: params.pluginName, resourcesPath: native.resourcesPath });
      input.assertCurrent();
      return { ok: true };
    },
    async uninstall(params: any) {
      input.assertCurrent();
      if (params?.hostId !== "local" || typeof params.marketplaceName !== "string" || typeof params.pluginName !== "string") throw new Error("Accounts browser removal is unavailable for this execution host.");
      await native.uninstall({ codexHome, marketplaceName: params.marketplaceName, pluginName: params.pluginName, preserveRetainedConsumers: true });
      input.assertCurrent();
      return { ok: true };
    },
  };
}


/** Uses the reviewed registry and manifest writers without reinstalling or stopping a host. */
export function nativeAccountsConsumerPreservationSource(): string {
  return `\n;var __twAccountsPreserveNativeConsumers=((__name)=>(input)=>(${preserveNativeBrowserConsumers.toString()})(input,{fs:l.default,path:i,registryPath:KX,readRegistry:IX,parseConsumer:UX,ownsManifest:mZ,write:tZ,removeRegistration:MZ,description:lX,uid:process.getuid?.(),Buffer}))((fn)=>fn);\n`;
}

export async function preserveNativeBrowserConsumers(input: any, native: any): Promise<void> {
  const { fs, path } = native;
  const registryPath = native.registryPath();
  const snapshot = registryPath === null ? { resources: { entries: [] } } : await native.readRegistry(registryPath);
  if (snapshot.contents !== undefined) {
    let parsed;
    try { parsed = JSON.parse(snapshot.contents); } catch { throw new Error("Browser consumer registry is malformed. Refresh before retrying removal."); }
    if (!parsed || parsed.schemaVersion !== snapshot.resources.schemaVersion || !Array.isArray(parsed.entries)
      || parsed.entries.length !== snapshot.resources.entries.length) throw new Error("Browser consumer registry is malformed. Refresh before retrying removal.");
  }
  const contained = (file: string, root: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  const validate = async (entry: any) => {
    const consumer = native.parseConsumer(entry);
    if (!consumer || !consumer.nativeHostNames.includes(input.nativeHostName)
      || !path.isAbsolute(consumer.paths.codexHome) || !path.isAbsolute(consumer.paths.extensionHostPath)) return null;
    const cache = path.join(consumer.paths.codexHome, "plugins", "cache");
    if (!contained(consumer.paths.extensionHostPath, cache)) return null;
    try {
      const realCache = await fs.realpath(cache);
      const executable = await fs.realpath(consumer.paths.extensionHostPath);
      if (!contained(executable, realCache)) return null;
      const stat = await fs.lstat(executable);
      if (!stat.isFile() || native.uid === undefined || stat.uid !== native.uid || !(stat.mode & 0o111) || (stat.mode & 0o002)) return null;
      return { consumer, executable };
    } catch (error: any) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) return null;
      throw error;
    }
  };
  const survivors = (await Promise.all(snapshot.resources.entries.map(validate))).filter(Boolean)
    .sort((a: any, b: any) => a.consumer.entryId < b.consumer.entryId ? -1 : a.consumer.entryId > b.consumer.entryId ? 1 : a.executable < b.executable ? -1 : a.executable > b.executable ? 1 : 0);
  const selected = survivors[0];
  const extensionIds = [...new Set(survivors.flatMap((entry: any) => entry.consumer.extensionIds))].sort();
  const unchanged = async () => {
    if (registryPath === null) return;
    let contents;
    try { contents = await fs.readFile(registryPath, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    if (contents !== snapshot.contents) throw new Error("Browser consumer registry changed. Refresh before retrying removal.");
  };
  let removed = 0;
  for (const manifestPath of input.manifestPaths) {
    await unchanged();
    if (!await native.ownsManifest({ manifestPath, pluginCacheRoot: input.pluginCacheRoot })) continue;
    if (selected) {
      // Revalidate every executable whose extension IDs authorize this host.
      for (const survivor of survivors) {
        const current = await validate(survivor.consumer);
        if (!current || current.executable !== survivor.executable) throw new Error("Browser consumer executable changed. Refresh before retrying removal.");
      }
      const manifest = { allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`), description: native.description,
        name: input.nativeHostName, path: selected.executable, type: "stdio" };
      await unchanged();
      if (!await native.ownsManifest({ manifestPath, pluginCacheRoot: input.pluginCacheRoot })) continue;
      await unchanged();
      await native.write(manifestPath, native.Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    } else {
      await unchanged();
      if (!await native.ownsManifest({ manifestPath, pluginCacheRoot: input.pluginCacheRoot })) continue;
      await unchanged();
      await fs.rm(manifestPath, { force: true });
      removed++;
    }
  }
  if (!selected && removed > 0 && removed === input.manifestPaths.length) {
    await unchanged();
    await native.removeRegistration(input.nativeHostName);
  }
}
