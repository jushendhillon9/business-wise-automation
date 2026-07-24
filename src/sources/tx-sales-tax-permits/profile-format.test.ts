import { describe, expect, test } from "bun:test";
import { printTxPermitProfile } from "./profile-format.ts";
import { profileTxPermitObservations } from "./profile.ts";
import type { TxPermitObservation, TxPermitRawRecord } from "./types.ts";

/** Fabricated fixtures with a deliberately identifiable "leak target" string, asserted absent from all printed output. */
function observation(raw: TxPermitRawRecord): TxPermitObservation {
  return {
    source_dataset_id: "jrea-zgmq",
    source_record_id: `${raw.taxpayer_number}:${raw.outlet_number}`,
    fetched_at: "2026-07-24T00:00:00.000Z",
    query_window_start: "2026-07-17",
    query_window_end: "2026-07-24",
    requested_counties: ["043"],
    source_url: "https://data.texas.gov/api/v3/views/jrea-zgmq/query.json",
    raw
  };
}

const SECRET_TAXPAYER_NAME = "Zzz-Should-Never-Print-Fabricated-Taxpayer-Name-Zzz";
const SECRET_OUTLET_NAME = "Zzz-Should-Never-Print-Fabricated-Outlet-Name-Zzz";
const SECRET_ADDRESS = "999 Should-Never-Print-Fabricated-Street";
const SECRET_TAXPAYER_NUMBER = "99999999999";

describe("printTxPermitProfile", () => {
  test("prints only aggregate/operational information -- never a name, address, or identifier", () => {
    const observations = [
      observation({
        taxpayer_number: SECRET_TAXPAYER_NUMBER,
        outlet_number: "001",
        taxpayer_name: SECRET_TAXPAYER_NAME,
        outlet_name: SECRET_OUTLET_NAME,
        outlet_address: SECRET_ADDRESS,
        outlet_county_code: "043",
        outlet_naics_code: "722511",
        taxpayer_organization_type: "LIMITED LIABILITY CO"
      })
    ];
    const profile = profileTxPermitObservations(observations);

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printTxPermitProfile(profile);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).not.toContain(SECRET_TAXPAYER_NAME);
    expect(output).not.toContain(SECRET_OUTLET_NAME);
    expect(output).not.toContain(SECRET_ADDRESS);
    expect(output).not.toContain(SECRET_TAXPAYER_NUMBER);
    // Aggregate content should still be present.
    expect(output).toContain("Total observations: 1");
    expect(output).toContain("County counts");
  });
});
