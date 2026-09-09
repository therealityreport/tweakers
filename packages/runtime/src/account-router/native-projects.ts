import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { assertPrivateRegularFile, writePrivateJsonAtomicBounded } from "./state-store";
import { isOpaqueAccountId, isPlainRecord, type OpaqueAccountId } from "./types";

const FILE = "native-project-links.v1.json";
const MAX_BYTES = 1024 * 1024;
const MAX_LINKS = 512;
interface ProjectContent { name: string; roots: Array<{ path: string }> }
interface Link { sourceProjectId: string; account: OpaqueAccountId; targetProjectId: string | null; imported: ProjectContent; digest: string | null }
type NativeProjectRequest = (account: OpaqueAccountId, method: string, params: Record<string, unknown>) => Promise<unknown | null>;

/** A small native project-ID mapping; never contains transcripts, thread IDs, or profile data. */
export class NativeProjectLinksV1 {
  private readonly links: Link[];
  private failed = false;
  private readonly inFlight = new Map<string, Promise<string | null>>();
  constructor(private readonly root: string, private readonly metadataAccountId: OpaqueAccountId, private readonly secret: Buffer, private readonly request: NativeProjectRequest) {
    if (!isOpaqueAccountId(metadataAccountId) || secret.length !== 32) throw new Error("invalid native project registry identity");
    const path = join(root, FILE);
    if (!existsSync(path)) { this.links = []; return; }
    assertPrivateRegularFile(path, MAX_BYTES);
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainRecord(value) || Object.keys(value).sort().join() !== "links,metadataAccountId,version" || value.version !== 1 || value.metadataAccountId !== metadataAccountId || !Array.isArray(value.links) || value.links.length > MAX_LINKS) throw new Error("invalid native project registry");
    this.links = value.links.map((entry): Link => {
      if (!isPlainRecord(entry) || Object.keys(entry).sort().join() !== "account,digest,imported,sourceProjectId,targetProjectId" || !validId(entry.sourceProjectId) || !isOpaqueAccountId(entry.account) || entry.account === metadataAccountId || !(entry.targetProjectId === null || validId(entry.targetProjectId)) || !(entry.digest === null || (typeof entry.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(entry.digest)))) throw new Error("invalid native project link");
      const imported = content(entry.imported); if (!imported) throw new Error("invalid native project content");
      return { sourceProjectId: entry.sourceProjectId, account: entry.account, targetProjectId: entry.targetProjectId, digest: entry.digest, imported };
    });
    if (new Set(this.links.map((l) => `${l.account}\0${l.sourceProjectId}`)).size !== this.links.length) throw new Error("duplicate native project link");
    const targets = this.links.filter((l) => l.targetProjectId !== null).map((l) => `${l.account}\0${l.targetProjectId}`);
    if (new Set(targets).size !== targets.length) throw new Error("ambiguous native project link");
  }

  projectForAccount(sourceProjectId: string, account: OpaqueAccountId): string | null {
    if (this.failed || !validId(sourceProjectId)) return null;
    return account === this.metadataAccountId ? sourceProjectId : this.links.find((l) => l.account === account && l.sourceProjectId === sourceProjectId)?.targetProjectId ?? null;
  }

  publicProjectId(account: OpaqueAccountId, nativeProjectId: string): string | null {
    if (this.failed || !validId(nativeProjectId)) return null;
    return account === this.metadataAccountId ? nativeProjectId : this.links.find((l) => l.account === account && l.targetProjectId === nativeProjectId)?.sourceProjectId ?? null;
  }

  ensureProjectForAccount(sourceProjectId: string, account: OpaqueAccountId): Promise<string | null> {
    if (this.failed || !validId(sourceProjectId) || !isOpaqueAccountId(account)) return Promise.resolve(null);
    const key = `${account}\0${sourceProjectId}`;
    const running = this.inFlight.get(key); if (running) return running;
    const work = this.ensure(sourceProjectId, account).catch(() => null).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work); return work;
  }

  private async ensure(sourceProjectId: string, account: OpaqueAccountId): Promise<string | null> {
    const original = project(await this.request(this.metadataAccountId, "project/read", { projectId: sourceProjectId }), sourceProjectId);
    if (!original) return null;
    if (account === this.metadataAccountId) return sourceProjectId;
    let link = this.links.find((l) => l.sourceProjectId === sourceProjectId && l.account === account);
    if (!link) {
      if (this.links.length >= MAX_LINKS) return null;
      link = { sourceProjectId, account, targetProjectId: null, imported: original.content, digest: null };
      this.links.push(link); this.persist();
    }
    if (!link.targetProjectId) {
      // Preserve the first request exactly across ambiguous responses/restarts.
      const idempotencyKey = createHmac("sha256", this.secret).update(`native-project:v1\0${this.metadataAccountId}\0${account}\0${sourceProjectId}`).digest("hex");
      const result = project(await this.request(account, "project/import", { ...link.imported, metadata: {}, threads: null, idempotencyKey }));
      if (!result || digest(result.content) !== digest(link.imported)) return null;
      if (this.links.some((other) => other !== link && other.account === account && other.targetProjectId === result.id)) return null;
      link.targetProjectId = result.id; link.digest = digest(result.content); this.persist();
    }
    // Re-read target so external deletion/edits cannot leave a stale proven mapping.
    const current = project(await this.request(account, "project/read", { projectId: link.targetProjectId }), link.targetProjectId);
    if (!current) return null;
    const expected = digest(original.content);
    if (digest(current.content) !== expected) {
      const updated = project(await this.request(account, "project/update", { projectId: link.targetProjectId, ...original.content, metadata: {} }), link.targetProjectId);
      if (!updated || digest(updated.content) !== expected) return null;
    }
    if (link.digest !== expected) { link.digest = expected; this.persist(); }
    return link.targetProjectId;
  }

  private persist(): void {
    try { writePrivateJsonAtomicBounded(this.root, FILE, { version: 1, metadataAccountId: this.metadataAccountId, links: this.links }, MAX_BYTES); }
    catch (error) { this.failed = true; throw error; }
  }
}

function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
function content(value: unknown): ProjectContent | null {
  if (!isPlainRecord(value) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 512 || /[\u0000-\u001f\u007f]/.test(value.name) || !Array.isArray(value.roots) || value.roots.length > 32) return null;
  const roots: Array<{ path: string }> = [];
  for (const root of value.roots) {
    if (!isPlainRecord(root) || Object.keys(root).join() !== "path" || typeof root.path !== "string" || root.path.length > 4096 || !isAbsolute(root.path) || normalize(root.path) !== root.path || /[\u0000-\u001f\u007f]/.test(root.path)) return null;
    roots.push({ path: root.path });
  }
  if (new Set(roots.map((r) => r.path)).size !== roots.length) return null;
  const result = { name: value.name, roots }; return Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024 ? result : null;
}
function project(value: unknown, expectedId?: string): { id: string; content: ProjectContent } | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.project) || !validId(value.project.id) || (expectedId !== undefined && value.project.id !== expectedId)) return null;
  const parsed = content(value.project); return parsed ? { id: value.project.id, content: parsed } : null;
}
function digest(value: ProjectContent): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
