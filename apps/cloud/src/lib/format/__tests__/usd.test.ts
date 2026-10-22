// UX audit B0: one money formatter, no 4-decimal values or mixed "$1.6K" /
// "$1577.12" formats.
import { describe, expect, it } from "vitest";
import { fmtUsd, fmtUsdEst } from "../usd";

describe("fmtUsd", () => {
  it("shows a dash for null, undefined and 0", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(0)).toBe("—");
  });

  it("floors a real but tiny amount to <$0.01", () => {
    expect(fmtUsd(0.001)).toBe("<$0.01");
    expect(fmtUsd(0.0099)).toBe("<$0.01");
  });

  it("shows two decimals under $1,000", () => {
    expect(fmtUsd(12.4)).toBe("$12.40");
    expect(fmtUsd(0.225)).toBe("$0.23");
    expect(fmtUsd(999.99)).toBe("$999.99");
  });

  it("shows no decimals, thousands-grouped, at $1,000 and over", () => {
    expect(fmtUsd(1577.12)).toBe("$1,577");
    expect(fmtUsd(1000)).toBe("$1,000");
    expect(fmtUsd(12345.6)).toBe("$12,346");
  });

  it("handles a negative value like its positive with a leading minus", () => {
    expect(fmtUsd(-12.4)).toBe("-$12.40");
    expect(fmtUsd(-1577.12)).toBe("-$1,577");
  });
});

describe("fmtUsdEst", () => {
  it("appends est. only for a real positive value", () => {
    expect(fmtUsdEst(12.4)).toBe("$12.40 est.");
    expect(fmtUsdEst(1577.12)).toBe("$1,577 est.");
  });

  it("never appends est. to the dash case", () => {
    expect(fmtUsdEst(null)).toBe("—");
    expect(fmtUsdEst(0)).toBe("—");
  });
});
