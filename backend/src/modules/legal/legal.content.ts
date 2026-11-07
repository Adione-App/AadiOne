/**
 * Legal content.
 *
 * Served both as JSON (for the in-app screens) and as a plain public HTML page
 * — Google Play requires a privacy policy at a URL that works without logging
 * in, and a link into the app does not satisfy that.
 *
 * Written specifically for what AdiOne actually does. Two things it is careful
 * NOT to claim, because they would be untrue for this build:
 *   - it does not promise round-the-clock support (the shop trades 8am-10pm);
 *   - it does not claim card details are stored securely, because none are
 *     ever collected — UPI payments happen entirely inside the customer's own
 *     bank app.
 *
 * NOT LEGAL ADVICE. Have a lawyer review before launch, and fill in the
 * placeholders marked {{ }} with the registered business details.
 */

import type { InfoPageContent, InfoPageSlug } from '../../shared';

export interface LegalDocument {
  slug: string;
  title: string;
  updatedAt: string;
  /** Markdown-ish sections the app renders natively. */
  sections: { heading: string; body: string[] }[];
}

const LAST_UPDATED = '2026-08-15';

/** Replaced from Configuration at request time so contact details stay current. */
export const PLACEHOLDERS = {
  BUSINESS_NAME: '{{BUSINESS_NAME}}',
  BUSINESS_ADDRESS: '{{BUSINESS_ADDRESS}}',
  SUPPORT_EMAIL: '{{SUPPORT_EMAIL}}',
  SUPPORT_PHONE: '{{SUPPORT_PHONE}}',
  STORE_HOURS: '{{STORE_HOURS}}',
} as const;

export const PRIVACY_POLICY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy Policy',
  updatedAt: LAST_UPDATED,
  sections: [
    {
      heading: 'Who we are',
      body: [
        `AdiOne is a local grocery delivery service operated by ${PLACEHOLDERS.BUSINESS_NAME}, ${PLACEHOLDERS.BUSINESS_ADDRESS}.`,
        `This policy explains what personal information we collect, why we collect it, and what you can do about it. If anything here is unclear, write to ${PLACEHOLDERS.SUPPORT_EMAIL} or call ${PLACEHOLDERS.SUPPORT_PHONE}.`,
      ],
    },
    {
      heading: 'What we collect',
      body: [
        'Your mobile number. This is how you sign in, and how our delivery partner reaches you if they cannot find your address.',
        'Your name and email address, if you choose to give them. Neither is required to place an order.',
        'Your delivery addresses, including the map location you select. We need the location because we can only deliver within a fixed distance of our shop, and the distance is measured from those coordinates.',
        'Your orders: what you bought, when, how much you paid and how you paid.',
        'Basic technical information — app version, device type and error logs — used to fix problems.',
      ],
    },
    {
      heading: 'What we deliberately do NOT collect',
      body: [
        'We never see or store your card number, UPI PIN, bank details or passwords for any payment app. When you pay online, the payment happens entirely inside your own UPI or banking app. We only learn that you told us you paid, and we confirm it against our own bank records.',
        'We do not track your location in the background. Location is read only when you open the app or add an address, and only if you allow it.',
        'We do not sell your personal information to anyone, and we do not share it for advertising.',
      ],
    },
    {
      heading: 'Why we use it',
      body: [
        'To deliver your order to the right place, and to let the delivery partner contact you.',
        'To check whether we deliver to your area at all.',
        'To send you updates about your order — confirmed, packed, out for delivery, delivered.',
        'To keep records of sales, which we are required to retain for tax and accounting purposes.',
        'To detect and prevent fraud and abuse of the service.',
      ],
    },
    {
      heading: 'Who we share it with',
      body: [
        'Our delivery partners see your name, phone number and delivery address for the order they are delivering, and nothing else.',
        'Our SMS provider receives your mobile number in order to send the one-time password.',
        'We may disclose information where the law requires it.',
        'That is the complete list. There is no advertising network, data broker or analytics company involved.',
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        'Your account details are kept while your account is open.',
        'Order records are kept for eight years after the order, because tax law requires it. After you delete your account those records remain, but they are no longer linked to a name, phone number or address.',
        'One-time passwords are kept for five minutes and are stored in a form that cannot be reversed.',
      ],
    },
    {
      heading: 'Deleting your account',
      body: [
        'You can delete your account at any time from Account → Personal Information → Delete Account.',
        'When you do, we permanently erase your name, email address, all saved addresses, your notifications and your device registrations. Your mobile number is replaced with an untraceable placeholder, so the account cannot be recovered and the number becomes free to use again.',
        'Past order records are retained for the tax period described above, in an anonymised form. Nothing in them identifies you.',
        'Deletion is immediate and cannot be undone. If an order is currently in progress, please wait until it is delivered or cancelled.',
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'You can see and correct your details in the app at any time.',
        'You can ask us for a copy of the information we hold about you.',
        'You can withdraw location permission from your phone settings; the app will still work, and you can type your address instead.',
        `To exercise any of these, contact ${PLACEHOLDERS.SUPPORT_EMAIL}.`,
      ],
    },
    {
      heading: 'Keeping it safe',
      body: [
        'All traffic between the app and our servers is encrypted.',
        'Passwords and one-time codes are stored only in hashed form and can never be read back.',
        'Access to customer data is limited to the shop staff who need it to fulfil orders.',
        'No system is perfectly secure. If a breach affects you, we will tell you.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'AdiOne is not intended for children under 18. We do not knowingly collect information from them.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If we change this policy we will update the date at the top and, for significant changes, tell you in the app.',
      ],
    },
  ],
};

export const TERMS_AND_CONDITIONS: LegalDocument = {
  slug: 'terms',
  title: 'Terms & Conditions',
  updatedAt: LAST_UPDATED,
  sections: [
    {
      heading: 'Agreement',
      body: [
        `By using AdiOne you agree to these terms. The service is operated by ${PLACEHOLDERS.BUSINESS_NAME}.`,
      ],
    },
    {
      heading: 'Your account',
      body: [
        'You sign in with your mobile number and a one-time password. Keep that code to yourself — we will never call or message you asking for it. Anyone with the code can access your account.',
        'You are responsible for orders placed from your account.',
        'You must give a real, reachable mobile number. If our delivery partner cannot reach you, we may be unable to complete the delivery.',
      ],
    },
    {
      heading: 'Where we deliver',
      body: [
        'We deliver only within a set distance of our shop. The app checks this before you order and will tell you plainly if you are outside the area.',
        'The delivery area may change. It is always the app that decides, at the moment you place the order.',
      ],
    },
    {
      heading: 'Prices, availability and your order',
      body: [
        'All prices are in Indian Rupees and include applicable taxes.',
        'Prices and availability can change. The price you pay is the one shown when you place the order and confirm it.',
        'Stock is limited and shared with walk-in customers. Occasionally an item sells out between you adding it and checking out. If that happens we will tell you before you pay, never after.',
        'Placing an order is an offer to buy. The order is accepted once the shop confirms it. We may decline an order — for example if an item is unavailable, the address is unreachable, or we suspect misuse. If we decline an order you have already paid for, we refund it in full.',
        'Product photographs are for identification. Packaging and pack design may differ from the image.',
      ],
    },
    {
      heading: 'Delivery time',
      body: [
        'The delivery time shown is an estimate, calculated from distance, how many items you ordered and how busy the shop is. It is not a guarantee.',
        `We deliver during shop hours: ${PLACEHOLDERS.STORE_HOURS}. Orders placed outside those hours are handled when we next open.`,
        'Weather, traffic and other things outside our control can delay a delivery.',
      ],
    },
    {
      heading: 'Payment',
      body: [
        'You can pay by UPI or by cash on delivery.',
        'UPI payments are made directly to our UPI address from your own payment app. We do not process or store any payment credentials. Because a direct UPI transfer sends us no automatic confirmation, we verify each payment against our bank records before we begin preparing your order. This usually takes a few minutes during shop hours.',
        'Cash on delivery is not available on every order — some items and some order values are excluded. The app will tell you the reason if it is unavailable.',
        'For cash on delivery, please pay the exact amount shown. You will be asked for a short delivery code at the door, which confirms your order reached you.',
      ],
    },
    {
      heading: 'Cancellations and refunds',
      body: [
        'You can cancel from the app until the shop starts preparing your order. After that, please call us and we will help if we can.',
        'We may cancel an order if we cannot fulfil it. You will be told why.',
        'If you paid online and the order is cancelled or declined, we refund the full amount. Refunds for direct UPI payments are sent back to the account you paid from and typically arrive within three to five working days.',
        'If something arrives damaged, spoiled or wrong, contact us the same day with a photograph and we will replace it or refund it.',
      ],
    },
    {
      heading: 'Using the service properly',
      body: [
        'Do not place fake orders, or orders you do not intend to accept. Repeated refusal of cash-on-delivery orders may result in cash on delivery being disabled on your account.',
        'Do not attempt to interfere with, overload or gain unauthorised access to the service.',
        'We may suspend or close an account that is being misused.',
      ],
    },
    {
      heading: 'Our responsibility',
      body: [
        'We take care to describe products accurately and to deliver in good condition.',
        'We are not responsible for losses beyond the value of the affected order, except where the law does not allow us to limit that.',
        'Nothing in these terms removes any right you have under Indian consumer law.',
      ],
    },
    {
      heading: 'Changes and contact',
      body: [
        'We may update these terms. Continuing to use the app after a change means you accept the updated terms.',
        `Questions, complaints or grievances: ${PLACEHOLDERS.SUPPORT_EMAIL}, or call ${PLACEHOLDERS.SUPPORT_PHONE}. We aim to respond within two working days.`,
        'These terms are governed by the laws of India.',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
  privacy: PRIVACY_POLICY,
  terms: TERMS_AND_CONDITIONS,
};

/**
 * The wording above, in the information-page format, served while an admin
 * has not yet published a page of their own (content/info-page.service.ts).
 *
 * OUTDATED (2026-11-07 audit): it describes the earlier single-shop service
 * ("AdiOne", direct UPI to the shop, an 8-year anonymised retention that the
 * system does not perform). It is kept only so the public privacy URL never
 * breaks; the admin page warns about it, and publishing the reviewed Aadione
 * pages replaces it everywhere at once.
 * The text is unchanged; its contact details now come from Admin
 * Configuration with NO invented fallback (a line whose setting is empty is
 * left out), and the business-name token is the configured brand.
 */
const legacyText = (text: string): string =>
  text
    .split(PLACEHOLDERS.BUSINESS_NAME)
    .join('{{BUSINESS_TRADE_NAME}}')
    .split(PLACEHOLDERS.STORE_HOURS)
    .join('the opening hours each seller shows in the app');

function legacyContent(document: LegalDocument): InfoPageContent {
  return {
    title: document.title,
    effectiveDate: '',
    sections: document.sections.map((section) => ({
      heading: section.heading,
      blocks: section.body.map((text) => ({ type: 'paragraph' as const, text: legacyText(text) })),
    })),
  };
}

/** Built-in wording per page; the About page has none (the app shows its own screen until one is published). */
export const BUILTIN_INFO_PAGES: Partial<Record<InfoPageSlug, { updatedAt: string; content: InfoPageContent }>> = {
  privacy: { updatedAt: LAST_UPDATED, content: legacyContent(PRIVACY_POLICY) },
  terms: { updatedAt: LAST_UPDATED, content: legacyContent(TERMS_AND_CONDITIONS) },
};
