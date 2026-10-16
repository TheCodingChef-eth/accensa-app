import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const { mockWithClient, mockWithMerchantClient, mockEnsureSchema, mockGetMerchantById, mockStock } =
  vi.hoisted(() => ({
    mockWithClient: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({})),
    mockWithMerchantClient: vi.fn(
      async (_merchantId: number, work: (client: unknown) => Promise<unknown>) => work({}),
    ),
    mockEnsureSchema: vi.fn(),
    mockGetMerchantById: vi.fn(),
    mockStock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({
  ensureSchema: mockEnsureSchema,
  withClient: mockWithClient,
  withMerchantClient: mockWithMerchantClient,
}));
vi.mock('@/lib/merchants', () => ({ getMerchantById: mockGetMerchantById }));
vi.mock('@/lib/inventory/reservationManager', () => ({
  InventoryReservationManager: class {
    stockLevels = mockStock;
  },
  PostgresInventoryReservationStore: class {},
}));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function inventoryGet(merchantId: string, query = '') {
  return GET(new Request(`https://accensa.test/api/inventory/${merchantId}${query}`), {
    params: Promise.resolve({ merchantId }),
  });
}

describe('GET /api/inventory/[merchantId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    mockGetMerchantById.mockResolvedValue({ id: 4 });
    mockStock.mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it.each(['abc', '-1', '0', '1.5', '9007199254740993'])(
    'returns 400 for the invalid merchant id %s',
    async (merchantId) => {
      const res = await inventoryGet(merchantId);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid merchant id' });
      expect(mockWithClient).not.toHaveBeenCalled();
    },
  );

  it('returns 503 when the database is not configured', async () => {
    delete process.env.DATABASE_URL;

    const res = await inventoryGet('4');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Inventory is unavailable' });
    expect(mockWithClient).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid SKU filter', async () => {
    const res = await inventoryGet('4', '?sku=bad%20sku');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid SKU filter' });
    expect(mockWithClient).not.toHaveBeenCalled();
  });

  it('returns 400 when more than 50 SKUs are requested', async () => {
    const query = '?' + Array.from({ length: 51 }, (_, i) => `sku=SKU-${i}`).join('&');

    const res = await inventoryGet('4', query);

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown merchant before any inventory query runs', async () => {
    mockGetMerchantById.mockResolvedValue(null);

    const res = await inventoryGet('4');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Merchant not found' });
    expect(mockGetMerchantById).toHaveBeenCalledWith(expect.anything(), 4);
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
    expect(mockStock).not.toHaveBeenCalled();
  });

  it('returns 200 with items and Cache-Control: no-store', async () => {
    const items = [{ sku: 'TEE-1', available: 3 }];
    mockStock.mockResolvedValue(items);

    const res = await inventoryGet('4', '?sku=TEE-1&sku=TEE-2');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ items });
    expect(mockStock).toHaveBeenCalledWith(4, ['TEE-1', 'TEE-2']);
  });

  it('passes a null SKU filter when none is supplied', async () => {
    await inventoryGet('4');

    expect(mockStock).toHaveBeenCalledWith(4, null);
  });

  it('returns 500, distinct from the 503, when the inventory query throws', async () => {
    mockStock.mockRejectedValue(new Error('db down'));

    const res = await inventoryGet('4');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Inventory is unavailable' });
  });
});
