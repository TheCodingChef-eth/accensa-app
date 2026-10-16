import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const { mockWithClient, mockWithMerchantClient, mockEnsureSchema, mockGetMerchant, mockSummary } =
  vi.hoisted(() => ({
    mockWithClient: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({})),
    mockWithMerchantClient: vi.fn(
      async (_merchantId: number, work: (client: unknown) => Promise<unknown>) => work({}),
    ),
    mockEnsureSchema: vi.fn(),
    mockGetMerchant: vi.fn(),
    mockSummary: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({
  ensureSchema: mockEnsureSchema,
  withClient: mockWithClient,
  withMerchantClient: mockWithMerchantClient,
}));
vi.mock('@/lib/merchants', () => ({ getMerchantFromRequest: mockGetMerchant }));
vi.mock('@/lib/webhooks', () => ({ webhookSummary: mockSummary }));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_WEBHOOK_URL = process.env.WEBHOOK_URL;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function webhooksGet() {
  return GET(new Request('https://accensa.test/api/webhooks'));
}

describe('GET /api/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    process.env.WEBHOOK_URL = 'https://merchant.test/hook';
    mockGetMerchant.mockResolvedValue({ id: 7 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv('DATABASE_URL', ORIGINAL_DATABASE_URL);
    restoreEnv('WEBHOOK_URL', ORIGINAL_WEBHOOK_URL);
    vi.restoreAllMocks();
  });

  it('returns 401 when no merchant can be resolved for the caller', async () => {
    mockGetMerchant.mockResolvedValue(null);

    const res = await webhooksGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
  });

  it('returns 500 when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;

    const res = await webhooksGet();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'DATABASE_URL is not configured' });
    expect(mockWithClient).not.toHaveBeenCalled();
  });

  it('returns the configured: false default without reading delivery state when no webhook URL is stored', async () => {
    delete process.env.WEBHOOK_URL;

    const res = await webhooksGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      pending: 0,
      failed: 0,
      deadLetter: 0,
      delivered: 0,
      lag: 0,
      recentFailed: [],
      recentDeliveries: [],
    });
    expect(mockWithMerchantClient).not.toHaveBeenCalled();
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('returns configured: true with the summary keys the banner reads', async () => {
    const recentFailed = [
      { id: 3, paymentTxHash: 'abc', attempts: 5, lastStatusCode: 500, lastError: 'boom' },
    ];
    mockSummary.mockResolvedValue({
      pending: 2,
      failed: 1,
      deadLetter: 1,
      delivered: 9,
      lag: 12,
      recentFailed,
      recentDeliveries: [],
    });

    const res = await webhooksGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.pending).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.delivered).toBe(9);
    expect(body.recentFailed).toEqual(recentFailed);
    expect(mockWithMerchantClient).toHaveBeenCalledWith(7, expect.any(Function));
    expect(mockSummary).toHaveBeenCalledWith(expect.anything(), 7);
    expect(mockEnsureSchema).toHaveBeenCalled();
  });

  it('returns a generic 500 when the merchant client throws', async () => {
    mockWithMerchantClient.mockRejectedValueOnce(new Error('connection reset'));

    const res = await webhooksGet();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
  });
});
