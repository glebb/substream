import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbCatalogStore } from "./indexed-db-catalog.ts";
import { createIndexedDbCatalogRepository, createIndexedDbCatalogRepositoryFactory } from "./catalogue-repository.ts";

afterEach(() => { vi.restoreAllMocks(); });

describe("catalogue repository lifecycle", () => {
  it("releases an opening database when its screen closes, and can reopen", async () => {
    let finish!: (store: IndexedDbCatalogStore) => void;
    const obsolete = { close: vi.fn() } as unknown as IndexedDbCatalogStore;
    const current = { close: vi.fn(), groups: vi.fn(async () => []) } as unknown as IndexedDbCatalogStore;
    const open = vi.spyOn(IndexedDbCatalogStore, "open")
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(current);
    const repository = createIndexedDbCatalogRepository();
    const pending = repository.open();
    repository.close();
    await repository.open();
    finish(obsolete);
    await expect(pending).rejects.toThrow("cancelled");
    expect(obsolete.close).toHaveBeenCalledOnce();
    expect(await repository.groups()).toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    repository.close();
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("keeps an overlapping session usable when another session closes", async () => {
    const factory = createIndexedDbCatalogRepositoryFactory();
    const first = await factory.open();
    const second = await factory.open();

    first.close();
    await expect(second.groups()).resolves.toEqual([]);
    await expect(second.metadata()).resolves.toMatchObject({ status: "empty", itemCount: 0 });
    second.close();
  });
});
