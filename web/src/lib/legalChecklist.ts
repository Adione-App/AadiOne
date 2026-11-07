/**
 * What must be settled before the Privacy Policy and Terms are published
 * (Admin Panel → Information Pages). Two kinds:
 *
 *   A. facts only the proprietor can confirm — entered in Configuration (the
 *      status is live) or decided in the wording (each is a «TO CONFIRM» note
 *      in the draft, which blocks publishing until replaced);
 *   B. technical facts — what the 2026-11-07 code / configuration audit
 *      could and could not verify. "Verified" means checked in this
 *      repository or its configuration on that date; anything else stays
 *      open for the owner or the hosting dashboards.
 *
 * Nothing here is published to customers.
 */

export interface ChecklistItem {
  label: string;
  /** Configuration settings that answer it (status from the page's settings). */
  settings?: readonly string[];
  /** For items decided in the wording or verified in the audit. */
  note: string;
  /** B only: the audit's finding. */
  status?: 'verified' | 'open';
}

export const OWNER_FACTS: readonly ChecklistItem[] = [
  { label: 'Exact registered business / legal name (as on PAN / GST)', settings: ['BUSINESS_LEGAL_NAME'], note: 'Configuration → Business, Support & Grievance Officer.' },
  { label: 'Proprietor name, spelled exactly as on PAN (owner says: Madan Khunita)', settings: ['BUSINESS_PROPRIETOR_NAME'], note: 'Confirm the spelling against PAN before entering.' },
  { label: 'Registered / principal business address', settings: ['BUSINESS_ADDRESS'], note: 'As on GST registration.' },
  { label: 'GSTIN', settings: ['STORE_GSTIN'], note: 'Optional on the pages; shown when entered.' },
  { label: 'Grievance Officer name, designation and email (phone optional)', settings: ['GRIEVANCE_OFFICER_NAME', 'GRIEVANCE_OFFICER_DESIGNATION', 'GRIEVANCE_OFFICER_EMAIL'], note: 'Required to publish.' },
  { label: 'Customer support email or phone (and hours)', settings: ['SUPPORT_EMAIL', 'SUPPORT_PHONE'], note: 'At least one is required to publish.' },
  { label: 'Minimum customer age', note: 'Draft note «minimum age 18» in both pages.' },
  { label: 'Refund timelines (online and cash on delivery) and fees on partial refunds', note: 'Terms → Refunds.' },
  { label: 'Doorstep waiting time and what happens when the customer is unavailable', note: 'Terms → Delivery; Checking your order at the door.' },
  { label: 'Reporting windows, returns and replacement rules, weight differences', note: 'Terms → Wrong, damaged…; Product-specific rules; Returns and replacements.' },
  { label: 'Complaint acknowledgement / resolution commitments', note: 'Both pages; the legal adviser confirms which rules apply.' },
  { label: 'Jurisdiction (courts)', note: 'Terms → Governing law.' },
];

export const TECHNICAL_FACTS: readonly ChecklistItem[] = [
  { label: 'Database and file-storage region', status: 'verified', note: 'Supabase, AWS ap-south-1 (Mumbai) — from the production configuration hostnames, 7 Nov 2026.' },
  { label: 'Application server region (Railway)', status: 'open', note: 'Not visible from code; only a Singapore network edge was observed. Check the Railway service settings.' },
  { label: 'Database backup retention', status: 'open', note: 'Depends on the Supabase plan and any manual pg_dump copies. Check the Supabase dashboard and where local dumps are kept.' },
  { label: 'Application log retention', status: 'open', note: 'Depends on the Railway plan. Logs contain IP addresses, request paths and searches; crash reports are redacted.' },
  { label: 'Account deletion behaviour', status: 'verified', note: 'Profile, email, addresses, notifications, push tokens and cart deleted; mobile tombstoned; sessions revoked; orders, payments, refunds and consent records kept.' },
  { label: 'Payment and order record retention', status: 'open', note: 'No automatic deletion exists: kept indefinitely today. Needs a period from the CA and a purge job before the policy can promise one.' },
  { label: 'Notification token retention', status: 'verified', note: 'Removed on sign-out on that phone (retried when offline) and on account deletion; moved when another account signs in on the phone.' },
];
