import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const {
  mockWithClient,
  mockWithMerchantClient,
  mockEnsureSchema,
  mockGetMerchantById,
  mockReserve,
  mockAllow,
} = vi.hoisted(() => ({
  mockWithClient: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({})),
  mockWithMerchantClient: vi.fn(
    async (_merchantId: number, work: (client: unknown) => Promise<unknown>) => work({}),
  ),
  mockEnsureSchema: vi.fn(),
  mockGetMerchantById: vi.fn(),
  mockReserve: vi.fn(),
  mockAllow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  ensureSchema: mockEnsureSchema,
  withClient: mockWithClient,
  withMerchantClient: mockWithMerchantClient,
}));
vi.mock('@/lib/merchants', () => ({ getMerchantById: mockGetMerchantById }));
vi.mock('@/lib/inventory/reservationManager', () => ({
  InventoryReservationManager: class {
    reserve = mockReserve;
  },
  PostgresInventoryReservationStore: class {},
}));
vi.mock('@/lib/inventory/reservation-rate-limit', () => ({
  allowInventoryReservation: mockAllow,
}));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const VALID_BODY = {
  merchantId: 4,
  checkoutId: 'chk_1',
  items: [{ sku: 'TEE-1', quantity: 1 }],
};

function reservationPost(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://accensa.test/api/inventory/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/inventory/reservations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    mockAllow.mockResolvedValue(true);
    mockGetMerchantById.mockResolvedValue({ id: 4 });
    mockReserve.mockResolvedValue({ ok: true, reservationId: 'res_1' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it('returns 503 when the database is not configured', async () => {
    delete process.env.DATABASE_URL;

    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Inventory is unavailable' });
    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await reservationPost('not json');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 Invalid reservation request when the payload is not an object', async () => {
    const res = await reservationPost('null');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid reservation request' });
  });

  it('returns 400 Invalid reservation request when required fields are missing or mistyped', async () => {
    const res = await reservationPost({ merchantId: '4', checkoutId: 'chk_1', items: [] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid reservation request' });
    expect(mockAllow).not.toHaveBeenCalled();
  });

  it('returns 429 and creates no reservation when the rate limiter refuses', async () => {
    mockAllow.mockResolvedValue(false);

    const res = await reservationPost(VALID_BODY, { 'x-real-ip': '203.0.113.9' });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many reservation attempts' });
    expect(mockAllow).toHaveBeenCalledWith(4, '203.0.113.9');
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
  });

  it('keys the limiter on the first x-forwarded-for hop, then on "unknown"', async () => {
    await reservationPost(VALID_BODY, { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
    await reservationPost(VALID_BODY);

    expect(mockAllow).toHaveBeenNthCalledWith(1, 4, '198.51.100.1');
    expect(mockAllow).toHaveBeenNthCalledWith(2, 4, 'unknown');
  });

  it('returns 404 for an unknown merchant', async () => {
    mockGetMerchantById.mockResolvedValue(null);

    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Merchant not found' });
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('returns 201 with Cache-Control: no-store on a created hold', async () => {
    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, reservationId: 'res_1' });
    expect(mockReserve).toHaveBeenCalledWith({
      merchantId: 4,
      checkoutId: 'chk_1',
      items: VALID_BODY.items,
    });
  });

  it.each([
    ['item_not_found', 404],
    ['checkout_expired', 410],
    ['insufficient_stock', 409],
  ])('maps a refused reservation (%s) to %i', async (reason, status) => {
    mockReserve.mockResolvedValue({ ok: false, reason });

    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, reason });
  });

  it('passes a thrown domain TypeError through as a 400 carrying its message', async () => {
    mockReserve.mockRejectedValue(
      new TypeError('items must contain between 1 and 50 inventory lines'),
    );

    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'items must contain between 1 and 50 inventory lines',
    });
  });

  it('returns 500, distinct from the 503, for an unexpected throw', async () => {
    mockReserve.mockRejectedValue(new Error('db down'));

    const res = await reservationPost(VALID_BODY);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Inventory is unavailable' });
  });
});
