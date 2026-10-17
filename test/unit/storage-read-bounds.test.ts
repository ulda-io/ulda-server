import { expect, it } from 'vitest';
import { InMemoryResourceStorage } from '../../src/storage/in-memory-resource-storage.js';
import { SdkResourceService } from '../../src/domain/sdk-resource-service.js';
import { SdkLimitError } from '../../src/protocol/sdk-commands.js';

it('bounds the entire in-memory batch, including duplicates, missing IDs and exact limits', async () => {
  const storage = new InMemoryResourceStorage();
  await storage.createBatch(Array.from({ length: 2 }, () => ({ witness: Uint8Array.of(1), payload: new Uint8Array(15) })));
  const bounds = { maxWitnessBytes: 167, maxPayloadBytes: 1_100_000, maxTotalBytes: 31 };
  for (const ids of [[1n, 2n], [1n, 1n]])
    await expect(storage.findManyByIds(ids, bounds)).rejects.toMatchObject({ code: 'rate_limited' });
  const exact = await storage.findManyByIds([1n, 2n], { ...bounds, maxTotalBytes: 32 });
  expect(exact.map(x => x?.id)).toEqual([1n, 2n]);
  expect((await storage.findManyByIds([3n, 1n], { ...bounds, maxTotalBytes: 16 })).map(x => x?.id ?? null)).toEqual([null, 1n]);
  expect(await storage.findManyByIds([1n, 2n])).toEqual(exact);
});

it('service rejects an adapter ignoring aggregate bounds without imposing wire limits on validation', async () => {
  class Unbounded extends InMemoryResourceStorage {
    override findManyByIds(ids: readonly bigint[]) { return super.findManyByIds(ids); }
  }
  const storage = new Unbounded();
  await storage.createBatch(Array.from({ length: 2 }, () => ({ witness: Uint8Array.of(1), payload: new Uint8Array(15) })));
  const service = new SdkResourceService(storage, { verify: async () => true }, { verify: async () => true });
  await expect(service.read([1n, 2n], 100, 31)).rejects.toBeInstanceOf(SdkLimitError);
  await expect(service.read([1n, 2n], 100, 32)).resolves.toHaveLength(2);
  await service.validate([{ id: 1n, witness: Uint8Array.of(2) }, { id: 2n, witness: Uint8Array.of(2) }]);
});
