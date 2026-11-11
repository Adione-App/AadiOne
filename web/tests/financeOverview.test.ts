/**
 * Admin › Financial Overview (pages/FinancialOverview.tsx, lib/financeOverview.ts,
 * components/FinanceCharts.tsx) — run with `npm run test:unit`.
 * The figures themselves: backend tests/integration/finance-overview.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bucketLabel,
  chartSeries,
  compactRupees,
  customRangeProblem,
  defaultScale,
  financePdfFileName,
  financeQuery,
  FINANCE_PERIODS,
  MAX_CHART_BARS,
  type TrendPoint,
} from "../src/lib/financeOverview.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const point = (start: string): TrendPoint => ({
  start,
  grossRevenuePaise: 1,
  netRevenuePaise: 1,
  sellerNetPaise: 1,
  aadioneGrossPaise: 1,
  aadioneNetPaise: 1,
  deliveryPaise: 0,
  platformPaise: 0,
  commissionPaise: 1,
  netCommissionPaise: 1,
  codPaise: 0,
  onlinePaise: 1,
  orders: 1,
});

describe("filters", () => {
  it("offers every required period, lifetime and a custom range", () => {
    assert.deepEqual(
      FINANCE_PERIODS.map((p) => p.key),
      ["TODAY", "YESTERDAY", "LAST_7_DAYS", "THIS_WEEK", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LIFETIME", "CUSTOM"],
    );
  });

  it("sends the same query for the page, the orders and the PDF; dates only for a custom range", () => {
    assert.equal(financeQuery({ period: "THIS_MONTH", from: "2026-01-01", to: "2026-01-31" }), "period=THIS_MONTH");
    assert.equal(financeQuery({ period: "CUSTOM", from: "2026-01-01", to: "2026-01-31", sellerId: "s1" }), "period=CUSTOM&from=2026-01-01&to=2026-01-31&sellerId=s1");
    assert.equal(financeQuery({ period: "LIFETIME" }, { page: 2, pageSize: 20 }), "period=LIFETIME&page=2&pageSize=20");
  });

  it("a custom range needs both dates, in order", () => {
    assert.match(customRangeProblem(undefined, "2026-01-01")!, /both/);
    assert.match(customRangeProblem("2026-02-01", "2026-01-01")!, /on or before/);
    assert.equal(customRangeProblem("2026-01-01", "2026-01-01"), null);
  });

  it("names the PDF after the exact view, like the server", () => {
    assert.equal(
      financePdfFileName({ period: { preset: "CUSTOM", fromDate: "2026-10-01", toDate: "2026-10-31", label: "Custom range" }, seller: { id: "x", code: "SEL-AB12", name: "A" } }),
      "Aadione-Financial-Overview-SEL-AB12-2026-10-01-to-2026-10-31.pdf",
    );
    assert.equal(
      financePdfFileName({ period: { preset: "LIFETIME", fromDate: null, toDate: null, label: "Lifetime" }, seller: null }),
      "Aadione-Financial-Overview-all-sellers-lifetime.pdf",
    );
    const server = readFileSync(path.join(ROOT, "../backend/src/modules/finance/finance-overview.service.ts"), "utf8");
    assert.match(server, /Aadione-Financial-Overview-\$\{who\}-\$\{range\}\.pdf/);
  });
});

describe("charts", () => {
  it("shows at most the latest buckets and picks a scale that fits the period", () => {
    const days = Array.from({ length: 40 }, (_, i) => point(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`));
    const trend = { daily: days, weekly: days.slice(0, 6), monthly: days.slice(0, 2) };
    const { points, hidden } = chartSeries(trend, "daily");
    assert.equal(points.length, MAX_CHART_BARS);
    assert.equal(hidden, 40 - MAX_CHART_BARS);
    assert.equal(defaultScale(trend), "weekly");
    assert.equal(defaultScale({ daily: days.slice(0, 5), weekly: [], monthly: [] }), "daily");
  });

  it("labels buckets by day or month; compact Indian amounts for the axis", () => {
    assert.equal(bucketLabel("2026-03-01", "monthly"), "Mar 26");
    assert.equal(bucketLabel("2026-03-09", "daily"), "9 Mar");
    assert.equal(compactRupees(50_00), "₹50");
    assert.equal(compactRupees(1_250_00), "₹1.25K");
    assert.equal(compactRupees(3_40_000_00), "₹3.4L");
    assert.equal(compactRupees(1_10_00_000_00), "₹1.1Cr");
    assert.equal(compactRupees(-2_000_00), "−₹2K");
  });
});

describe("page", () => {
  const page = read("src/pages/FinancialOverview.tsx");
  const app = read("src/App.tsx");

  it("is a Finance page for SETTLEMENT_READ (Admin / Super Admin), not Staff", () => {
    assert.match(app, /to: '\/finance',\n\s+label: 'Financial Overview',[\s\S]*?section: 'FINANCE',[\s\S]*?permission: Permission\.SETTLEMENT_READ,/);
    assert.match(app, /<Route path="\/finance" element=\{<FinancialOverviewPage \/>\} \/>/);
  });

  it("reads every figure from the API and downloads the PDF of the same query (authorised blob, no public URL)", () => {
    assert.match(page, /api\.get<FinanceOverview>\(`\/admin\/finance\/overview\?\$\{query\}`\)/);
    assert.match(page, /api\.getBlob\(`\/admin\/finance\/overview\.pdf\?\$\{query\}`\)/);
    assert.match(page, /financeQuery\(filter, \{ page, pageSize: 20 \}\)/);
    assert.doesNotMatch(page, /https?:\/\//);
  });

  it("shows all nine summary cards, Aadione's formula, and COD / Online as methods — not extra revenue", () => {
    for (const label of [
      "Total order revenue",
      "Seller earnings",
      "Total Aadione earnings",
      "Total COD payments",
      "Total online payments",
      "Total delivery charges",
      "Total platform fees",
      "Total seller commission",
      "Total refunds / reversals",
    ]) {
      assert.ok(page.includes(label), label);
    }
    assert.match(page, /delivery \+ platform fees \+ commission/);
    assert.match(page, /the same revenue, never added twice/);
  });
});
