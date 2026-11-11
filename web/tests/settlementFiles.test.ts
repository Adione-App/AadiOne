/**
 * Settlement payment reference, payment proof and statement PDF in the admin
 * and seller panels (components/SettlementFiles.tsx, pages/Settlements.tsx,
 * seller/pages/SellerSettlements.tsx) — run with `npm run test:unit`.
 * The server side: backend tests/integration/settlement-proof-statement.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_PROOF_BYTES, proofFileProblem, statementFileName } from "../src/lib/settlementFiles.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("file helpers", () => {
  const source = read("src/components/SettlementFiles.tsx");

  it("names the statement after its period in Indian time and the settlement", () => {
    assert.equal(
      statementFileName({ id: "1a2b3c4d-0000-0000-0000-000000000000", periodStart: "2026-09-30T18:30:00.000Z", periodEnd: "2026-10-31T18:29:00.000Z" }),
      "Aadione-Statement-2026-10-01-to-2026-10-31-1a2b3c4d.pdf",
    );
  });

  it("accepts only JPEG / PNG / WebP / PDF up to 5 MB as a proof, like the server", () => {
    assert.equal(proofFileProblem(null), null);
    assert.equal(proofFileProblem({ type: "image/png", size: 1000 }), null);
    assert.equal(proofFileProblem({ type: "application/pdf", size: MAX_PROOF_BYTES }), null);
    assert.match(proofFileProblem({ type: "image/gif", size: 10 })!, /JPEG, PNG or WebP/);
    assert.match(proofFileProblem({ type: "image/png", size: MAX_PROOF_BYTES + 1 })!, /5 MB/);
  });

  it("downloads through the authorised API (blob), never a public URL; Share uses the device share sheet when available", () => {
    assert.match(source, /getBlob\(`\$\{basePath\}\/\$\{settlement\.id\}\/statement\.pdf`\)/);
    assert.match(source, /getBlob\(`\$\{basePath\}\/\$\{settlement\.id\}\/payout-proof`\)/);
    assert.match(source, /navigator\.canShare\(\{ files: \[probe\] \}\)/);
    assert.match(source, /navigator\.share\(\{ files: \[file\]/);
    assert.doesNotMatch(source, /https?:\/\//);
  });
});

describe("admin panel", () => {
  const page = read("src/pages/Settlements.tsx");

  it("Mark paid records an optional transaction / UPI reference and an optional proof, uploading the proof first", () => {
    assert.match(page, /Transaction ID \/ UPI reference/);
    assert.match(page, /Payment screenshot \/ receipt/);
    const mutation = page.slice(page.indexOf("function StatusModal"), page.indexOf("function CreateModal"));
    const upload = mutation.indexOf("api.postForm(`/admin/settlements/${row.id}/payout-proof`");
    const patch = mutation.indexOf("api.patch(`/admin/settlements/${row.id}/status`, { status: to, ...(paying && trimmed ? { reference: trimmed } : {}) })");
    assert.ok(upload > 0 && patch > upload, "proof is uploaded before the status changes");
  });

  it("says plainly that payment is manual and never automatic", () => {
    assert.match(page, /Aadione never sends this payment automatically/);
  });

  it("each settlement offers the statement PDF, Share and the proof; a proof can be attached or replaced while PROCESSING / PAID", () => {
    assert.match(page, /<SettlementFileButtons settlement=\{d\} basePath="\/admin\/settlements" getBlob=\{api\.getBlob\} proofVisible compact \/>/);
    assert.match(page, /\(d\.status === 'PROCESSING' \|\| d\.status === 'PAID'\) && \(\s*<AttachProof/);
    assert.match(read("src/pages/SellerCatalogTabs.tsx"), /basePath="\/admin\/settlements"/);
  });
});

describe("seller panel", () => {
  const page = read("src/seller/pages/SellerSettlements.tsx");
  const api = read("src/seller/sellerApi.ts");

  it("shows the transaction / UPI reference of a paid settlement", () => {
    assert.match(page, /Transaction \/ UPI ref\./);
    assert.match(api, /payoutReference: raw\.payoutReference \?\? null/);
    assert.match(api, /hasPayoutProof: Boolean\(raw\.hasPayoutProof\)/);
  });

  it("downloads its own statement and sees the proof only once PAID", () => {
    assert.match(page, /basePath="\/seller\/settlements"/);
    assert.match(page, /getBlob=\{sellerApi\.getBlob\}/);
    assert.match(page, /proofVisible=\{d\.status === 'PAID'\}/);
  });
});
