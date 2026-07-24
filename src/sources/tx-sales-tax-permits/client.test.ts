import { describe, expect, test } from "bun:test";
import {
  assertBareArrayResponse,
  fetchTxPermitObservations,
  fetchTxPermitPage,
  TxPermitApiError,
  TxPermitAuthError
} from "./client.ts";
import type { QueryWindow } from "./query.ts";
import type { TxPermitRawRecord } from "./types.ts";

/**
 * All fixtures are fabricated (fictitious taxpayer/outlet numbers, names,
 * addresses) -- never copied real API rows. `fetchImpl` is always a stub;
 * no test in this file makes a real network call, and `sleep`/`random` are
 * always injected so retry/backoff tests never actually wait.
 */

const WINDOW: QueryWindow = { start: "2026-07-17", end: "2026-07-24" };
const COUNTIES = ["043", "057"];
const NO_WAIT = async () => {};
const FIXED_RANDOM = () => 0.5;

function fakeRow(overrides: Partial<TxPermitRawRecord> = {}): TxPermitRawRecord {
  return {
    outlet_name: "Fictitious Test Outlet",
    outlet_address: "100 Fabricated Ln",
    outlet_city: "Testville",
    outlet_county_code: "057",
    outlet_zip_code: "75001",
    outlet_naics_code: "722511",
    outlet_permit_issue_date: "2026-07-20T00:00:00.000",
    outlet_first_sales_date: "2026-07-21T00:00:00.000",
    outlet_state: "TX",
    taxpayer_name: "Fictitious Test Outlet LLC",
    taxpayer_number: "10000000001",
    outlet_number: "001",
    taxpayer_organization_type: "LIMITED LIABILITY CO",
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("assertBareArrayResponse", () => {
  test("accepts a bare top-level array", () => {
    expect(assertBareArrayResponse([fakeRow()])).toHaveLength(1);
  });

  test("rejects a { data: [...] } wrapper shape", () => {
    expect(() => assertBareArrayResponse({ data: [fakeRow()] })).toThrow(TxPermitApiError);
  });

  test("rejects a non-array, non-object top-level value", () => {
    expect(() => assertBareArrayResponse("not an array")).toThrow(/not a bare top-level JSON array/);
    expect(() => assertBareArrayResponse(null)).toThrow(TxPermitApiError);
  });
});

describe("fetchTxPermitPage", () => {
  test("fails with a clear TxPermitAuthError when no token is available", async () => {
    const previous = process.env.SOCRATA_APP_TOKEN;
    delete process.env.SOCRATA_APP_TOKEN;
    try {
      await expect(
        fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, { fetchImpl: async () => jsonResponse([]) })
      ).rejects.toThrow(TxPermitAuthError);
    } finally {
      if (previous !== undefined) process.env.SOCRATA_APP_TOKEN = previous;
    }
  });

  test("never sends a real network request during tests -- fetchImpl is always a stub", async () => {
    let called = false;
    await fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
      appToken: "test-token",
      fetchImpl: async () => {
        called = true;
        return jsonResponse([fakeRow()]);
      }
    });
    expect(called).toBe(true);
  });

  test("sends the app token via X-App-Token and never in the body", async () => {
    let capturedInit: RequestInit | undefined;
    await fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
      appToken: "super-secret-token",
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return jsonResponse([]);
      }
    });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-App-Token"]).toBe("super-secret-token");
    expect(String(capturedInit?.body)).not.toContain("super-secret-token");
  });

  test("throws when the response is a non-array top-level shape (e.g. { data: [...] })", async () => {
    await expect(
      fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
        appToken: "test-token",
        fetchImpl: async () => jsonResponse({ data: [fakeRow()] })
      })
    ).rejects.toThrow(/not a bare top-level JSON array/);
  });

  test("throws a clear error on malformed JSON", async () => {
    await expect(
      fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
        appToken: "test-token",
        fetchImpl: async () => new Response("{not valid json", { status: 200 })
      })
    ).rejects.toThrow(/malformed JSON/);
  });

  test("retries on 429 and eventually succeeds, without a real wait", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    const result = await fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
      appToken: "test-token",
      random: FIXED_RANDOM,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return jsonResponse({ error: "throttled" }, 429);
        return jsonResponse([fakeRow()]);
      }
    });
    expect(attempts).toBe(3);
    expect(sleepCalls.length).toBe(2);
    expect(result).toHaveLength(1);
  });

  test("retries on a retryable 5xx and eventually succeeds", async () => {
    let attempts = 0;
    const result = await fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
      appToken: "test-token",
      random: FIXED_RANDOM,
      sleep: NO_WAIT,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 2) return jsonResponse({ error: "server error" }, 503);
        return jsonResponse([]);
      }
    });
    expect(attempts).toBe(2);
    expect(result).toEqual([]);
  });

  test("does not retry a non-retryable 4xx error", async () => {
    let attempts = 0;
    await expect(
      fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
        appToken: "test-token",
        random: FIXED_RANDOM,
        sleep: NO_WAIT,
        fetchImpl: async () => {
          attempts += 1;
          return jsonResponse({ error: "bad request" }, 400);
        }
      })
    ).rejects.toThrow(TxPermitApiError);
    expect(attempts).toBe(1);
  });

  test("does not retry indefinitely -- bounded by maxRetries", async () => {
    let attempts = 0;
    await expect(
      fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
        appToken: "test-token",
        random: FIXED_RANDOM,
        sleep: NO_WAIT,
        maxRetries: 2,
        fetchImpl: async () => {
          attempts += 1;
          return jsonResponse({ error: "throttled" }, 429);
        }
      })
    ).rejects.toThrow(TxPermitApiError);
    // Initial attempt + 2 retries = 3 total.
    expect(attempts).toBe(3);
  });

  test("handles a request timeout as a retryable, bounded failure", async () => {
    let attempts = 0;
    await expect(
      fetchTxPermitPage(WINDOW, COUNTIES, { limit: 10, offset: 0 }, {
        appToken: "test-token",
        random: FIXED_RANDOM,
        sleep: NO_WAIT,
        maxRetries: 1,
        timeoutMs: 5,
        fetchImpl: async (_url, init) => {
          attempts += 1;
          return new Promise((_resolve, reject) => {
            const signal = (init as RequestInit).signal;
            signal?.addEventListener("abort", () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        }
      })
    ).rejects.toThrow(/timed out/);
    expect(attempts).toBe(2);
  });
});

describe("fetchTxPermitObservations", () => {
  const baseOptions = { appToken: "test-token", random: FIXED_RANDOM, sleep: NO_WAIT };

  test("parses a successful one-page response", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1" })])
    });
    expect(result.observations).toHaveLength(1);
    expect(result.pageCount).toBe(1);
    expect(result.observations[0]?.source_record_id).toBe("1:1");
  });

  test("paginates deterministically across multiple pages", async () => {
    let calls = 0;
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 5,
      pageSize: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1" }), fakeRow({ taxpayer_number: "2", outlet_number: "1" })]);
        if (calls === 2) return jsonResponse([fakeRow({ taxpayer_number: "3", outlet_number: "1" }), fakeRow({ taxpayer_number: "4", outlet_number: "1" })]);
        return jsonResponse([fakeRow({ taxpayer_number: "5", outlet_number: "1" })]);
      }
    });
    expect(result.pageCount).toBe(3);
    expect(result.observations.map((o) => o.source_record_id)).toEqual(["1:1", "2:1", "3:1", "4:1", "5:1"]);
  });

  test("stops pagination on an empty page", async () => {
    let calls = 0;
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 100,
      pageSize: 10,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse([]);
      }
    });
    expect(result.observations).toEqual([]);
    expect(result.pageCount).toBe(1);
    expect(calls).toBe(1);
  });

  test("enforces --limit across pages, never over-fetching", async () => {
    let pageIndex = 0;
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 3,
      pageSize: 2,
      fetchImpl: async () => {
        pageIndex += 1;
        return jsonResponse([
          fakeRow({ taxpayer_number: `${pageIndex}`, outlet_number: "1" }),
          fakeRow({ taxpayer_number: `${pageIndex}`, outlet_number: "2" })
        ]);
      }
    });
    expect(result.observations.length).toBe(3);
  });

  test("requests each page with the SoQL LIMIT/OFFSET matching the remaining budget, not a fixed page size", async () => {
    const requestedQueries: string[] = [];
    await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 3,
      pageSize: 2,
      fetchImpl: async (_url, init) => {
        requestedQueries.push(JSON.parse(String((init as RequestInit).body)).query as string);
        return jsonResponse([fakeRow({ taxpayer_number: `${requestedQueries.length}`, outlet_number: "1" }), fakeRow({ taxpayer_number: `${requestedQueries.length}0`, outlet_number: "1" })]);
      }
    });
    expect(requestedQueries[0]).toContain("LIMIT 2 OFFSET 0");
    // Second page should ask for only the remaining budget (3 - 2 = 1).
    expect(requestedQueries[1]).toContain("LIMIT 1 OFFSET 2");
  });

  test("drops duplicate source_record_id values seen across pages and counts them", async () => {
    let calls = 0;
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1" }), fakeRow({ taxpayer_number: "1", outlet_number: "1" })]);
        return jsonResponse([]);
      }
    });
    expect(result.observations).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  test("skips rows missing required identity fields (taxpayer_number/outlet_number) without crashing", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([fakeRow({ taxpayer_number: undefined }), fakeRow({ taxpayer_number: "1", outlet_number: "1" })])
    });
    expect(result.observations).toHaveLength(1);
    expect(result.malformedCount).toBe(1);
  });

  test("preserves leading zeros in taxpayer/outlet identifiers end to end", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([fakeRow({ taxpayer_number: "00012345", outlet_number: "007", outlet_county_code: "043" })])
    });
    expect(result.observations[0]?.source_record_id).toBe("00012345:007");
    expect(result.observations[0]?.raw.outlet_county_code).toBe("043");
  });

  test("optional fields may remain missing without affecting parsing", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () =>
        jsonResponse([
          { taxpayer_number: "1", outlet_number: "1", taxpayer_name: "Fictitious Sole Prop" }
        ])
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.raw.outlet_name).toBeUndefined();
  });

  test("tolerates schema drift -- unexpected extra fields pass through untouched", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1", some_new_field_from_the_api: "fabricated value" })])
    });
    expect((result.observations[0]?.raw as Record<string, unknown>).some_new_field_from_the_api).toBe("fabricated value");
  });

  test("attaches fetch/query metadata alongside the untouched raw record", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1" })])
    });
    const observation = result.observations[0]!;
    expect(observation.source_dataset_id).toBe("jrea-zgmq");
    expect(observation.query_window_start).toBe(WINDOW.start);
    expect(observation.query_window_end).toBe(WINDOW.end);
    expect(observation.requested_counties).toEqual(COUNTIES);
    expect(observation.raw.outlet_name).toBe("Fictitious Test Outlet");
  });

  test("raw values are never mutated from what the API returned", async () => {
    const originalRow = fakeRow({ taxpayer_number: "1", outlet_number: "1", outlet_address: "  100 Fabricated Ln  " });
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([originalRow])
    });
    expect(result.observations[0]?.raw.outlet_address).toBe("  100 Fabricated Ln  ");
  });

  test("interrupted pagination (a later page failing) surfaces the error rather than a silent partial success", async () => {
    let calls = 0;
    await expect(
      fetchTxPermitObservations(WINDOW, COUNTIES, {
        ...baseOptions,
        limit: 10,
        pageSize: 2,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return jsonResponse([fakeRow({ taxpayer_number: "1", outlet_number: "1" }), fakeRow({ taxpayer_number: "2", outlet_number: "1" })]);
          return jsonResponse({ error: "bad request" }, 400);
        }
      })
    ).rejects.toThrow(TxPermitApiError);
  });

  test("empty result set: zero observations, zero pages of data beyond the first empty page", async () => {
    const result = await fetchTxPermitObservations(WINDOW, COUNTIES, {
      ...baseOptions,
      limit: 10,
      pageSize: 10,
      fetchImpl: async () => jsonResponse([])
    });
    expect(result.observations).toEqual([]);
    expect(result.duplicateCount).toBe(0);
    expect(result.malformedCount).toBe(0);
  });
});
