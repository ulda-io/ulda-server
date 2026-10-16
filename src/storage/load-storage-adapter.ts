import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ResourceStorage } from "../domain/ports.js";

type StorageFactory = () => ResourceStorage | Promise<ResourceStorage>;

function isStorage(candidate: unknown): candidate is ResourceStorage {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  return [
    "ping",
    "close",
    "create",
    "createBatch",
    "applyBatch",
    "findById",
    "findManyByIds",
    "update",
    "delete",
  ].every(
    (name) => typeof value[name] === "function",
  );
}

/**
 * Loads a developer-supplied adapter module. The module may export either a
 * `createStorage` factory or a default factory/storage object.
 */
export async function loadStorageAdapter(specifier: string): Promise<ResourceStorage> {
  const importTarget = isAbsolute(specifier)
    ? pathToFileURL(specifier).href
    : specifier.startsWith(".")
      ? pathToFileURL(resolve(specifier)).href
      : specifier;
  const module = await import(importTarget) as {
    createStorage?: StorageFactory;
    default?: StorageFactory | ResourceStorage;
  };
  const exported = module.createStorage ?? module.default;
  const candidate = typeof exported === "function"
    ? await exported()
    : exported;

  if (!isStorage(candidate)) {
    throw new Error(
      "Storage adapter must export createStorage() or a default ResourceStorage object with aligned reads and atomic createBatch/applyBatch support.",
    );
  }
  return candidate;
}
