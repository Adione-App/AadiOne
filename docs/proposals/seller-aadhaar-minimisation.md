# Proposal: minimise Aadhaar data in seller onboarding

Status: **proposal for owner and lawyer review — nothing implemented, no data changed.**

## What the system does today (verified in code, 12 Nov 2026)

| What | Where | Required? | How it is protected |
| --- | --- | --- | --- |
| Full 12-digit Aadhaar number | `seller_profiles.aadhaar_number` (plain text column) | **Optional** ("Aadhaar (optional)" in the onboarding form; the onboarding checklist requires only PAN) | Shown masked (`••••••••1234`) everywhere except an admin "Show" that is written to the audit log; redacted from server logs (`common/logger.ts`); never in audit rows |
| Full 12-digit Aadhaar number again | `seller_documents.document_number` for each `AADHAAR_CARD` row | Only if the seller uploads an Aadhaar card (then the number is required for that upload) | Same masking / audited reveal |
| Copy of the Aadhaar card (PDF) | Private storage (`S3_PRIVATE_BUCKET` / `storage-private/`), never a public URL | Optional | Downloaded only through authorised admin / seller routes |
| Earlier Aadhaar uploads | Every re-upload **inserts a new row**; the earlier row, its full number and its PDF are **kept** (`addDocument`: "the earlier row stays as history") | — | As above |

Nothing deletes an Aadhaar number or card after verification, after rejection, after replacement, or after a store closes (only permanent seller removal deletes them).

## What is unnecessary

1. **The full number at all.** Onboarding never needs it: PAN is the required identity document, and no code uses the Aadhaar number for anything except displaying it masked. Storing 12 digits where the last 4 serve every current screen is excess.
2. **Two copies** of the same number (profile and document row).
3. **Superseded and rejected uploads** — the full number and the card PDF stay after a newer upload replaced them or after verification finished.
4. **An unmasked card image.** UIDAI's guidance favours a *masked Aadhaar* (first 8 digits hidden) when a copy is needed at all.

The Aadhaar Act, 2016 (s.29) and its regulations restrict how entities other than authorised requesting entities collect, store and use Aadhaar numbers. Whether Aadione may keep full numbers, and on what basis, is a **lawyer's question** — this proposal only shows how to stop needing them.

## Proposed, safer design (for approval — not built)

1. **Do not collect the full number.** Accept only the last 4 digits (or none) in the profile, and only a *masked Aadhaar* PDF for the document (validated as a PDF as today; an admin checks the masking during verification). Or drop Aadhaar entirely and rely on PAN (+ GST / FSSAI where applicable).
2. **One place only:** keep the last 4 digits on the document row; remove the profile column (migration, after step 4).
3. **Retention:** after a document is VERIFIED, delete superseded Aadhaar rows' PDFs and numbers after a fixed period (owner + lawyer decide, e.g. 30 days); delete rejected uploads after the seller resubmits.
4. **Existing data (needs separate approval, with a backup first):** a one-time script that replaces stored full numbers with the masked form (`XXXXXXXX1234`) in both columns, and lists — never deletes without approval — superseded Aadhaar PDFs.
5. Update the Seller Privacy Policy to say exactly what is kept and for how long.

Effort: small (validation rule, form field, one migration, one script, one job). Onboarding of existing approved sellers is unaffected.

## Read-only check for the owner (production, counts only — no numbers are shown)

```sql
BEGIN TRANSACTION READ ONLY;
SELECT COUNT(*) FILTER (WHERE aadhaar_number IS NOT NULL) AS profiles_with_full_aadhaar,
       COUNT(*) AS profiles
FROM seller_profiles;

SELECT status, COUNT(*) AS aadhaar_documents,
       COUNT(*) FILTER (WHERE document_number IS NOT NULL) AS with_number
FROM seller_documents
WHERE type = 'AADHAAR_CARD'
GROUP BY status;

-- Aadhaar uploads that a later upload of the same seller has replaced.
SELECT COUNT(*) AS superseded_aadhaar_uploads
FROM seller_documents d
WHERE d.type = 'AADHAAR_CARD'
  AND EXISTS (SELECT 1 FROM seller_documents n WHERE n.seller_id = d.seller_id AND n.type = d.type AND n.created_at > d.created_at);
ROLLBACK;
```
