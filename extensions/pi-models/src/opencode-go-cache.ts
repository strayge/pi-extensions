import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type GoAllowance,
  goAnnotations,
  parseGoAllowances,
  validateGoAllowances,
} from "./opencode-go.ts";
import type { ModelLike } from "./sort.ts";

export const GO_CATALOG_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/component/go-models.ts";
export const GO_CACHE_MAX_AGE = 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;

interface CatalogCache {
  version: 1;
  checkedAt: number;
  etag?: string;
  models: GoAllowance[];
}

/** Failed or incompatible refreshes must not replace the last validated provider catalog. */
export class GoCatalogCache {
  private readonly file: string;
  private readonly fetcher: typeof fetch;
  private cache?: CatalogCache;
  private loaded?: Promise<void>;
  private pending?: Promise<void>;
  private controller?: AbortController;
  private retryAt = 0;
  private disposed = false;

  constructor(file = join(getAgentDir(), "opencode-go-models.json"), fetcher = fetch) {
    this.file = file;
    this.fetcher = fetcher;
  }

  load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  annotations(models: readonly ModelLike[]): Record<string, string> {
    if (!this.cache) return {};
    return goAnnotations(
      models,
      this.cache.models,
      Date.now() - this.cache.checkedAt > GO_CACHE_MAX_AGE,
    );
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.update().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }

  private async read(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (
        value?.version !== 1 ||
        typeof value.checkedAt !== "number" ||
        !Number.isFinite(value.checkedAt) ||
        value.checkedAt < 0 ||
        value.checkedAt > Date.now() ||
        (value.etag !== undefined && typeof value.etag !== "string")
      )
        return;
      this.cache = {
        version: 1,
        checkedAt: value.checkedAt,
        etag: value.etag,
        models: validateGoAllowances(value.models),
      };
    } catch {
      // An absent or damaged cache must not stop model selection.
    }
  }

  private async update(): Promise<void> {
    await this.load();
    if (
      this.disposed ||
      Date.now() < this.retryAt ||
      (this.cache && Date.now() - this.cache.checkedAt <= GO_CACHE_MAX_AGE)
    )
      return;
    this.controller = new AbortController();
    try {
      const response = await this.fetcher(GO_CATALOG_URL, {
        headers: this.cache?.etag ? { "If-None-Match": this.cache.etag } : {},
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
      });
      let next: CatalogCache;
      if (response.status === 304 && this.cache) {
        next = { ...this.cache, checkedAt: Date.now() };
      } else {
        if (!response.ok) throw new Error(`OpenCode Go catalog HTTP ${response.status}`);
        const models = parseGoAllowances(await response.text());
        next = {
          version: 1,
          checkedAt: Date.now(),
          etag: response.headers.get("etag") ?? undefined,
          models,
        };
      }
      if (this.disposed) return;
      this.cache = next;
      await this.save(next);
    } catch {
      this.retryAt = Date.now() + RETRY_DELAY;
    } finally {
      this.controller = undefined;
    }
  }

  private async save(cache: CatalogCache): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
