/**
 * The Aadione starting wording for the information pages (the legal
 * documents and About Aadione).
 *
 * NEVER shown to customers by itself. An admin loads a template into the
 * draft (Admin Panel → Information Pages), reviews it, replaces every
 * «TO CONFIRM: …» marker with the owner's decision, and publishes; a page
 * still containing a marker cannot be published (info-page.service.ts).
 *
 * Written from what the system actually does (audits of 2026-11-03 and
 * 2026-11-07), and nothing more:
 *   - sign-in by mobile number + OTP sent through MSG91; guests may browse;
 *     one customer account per mobile number;
 *   - multi-seller cart; sellers see the customer's name, mobile and the
 *     items ordered from them; delivery agents see the delivery details;
 *   - delivery only to admin-approved village + PIN code pairs; fees from
 *     distance slabs, minimum order, free-delivery threshold and platform fee
 *     from Admin Configuration (tokens below);
 *   - online payment through Cashfree (no payment credentials reach
 *     Aadione); an online order is placed only after the server verifies the
 *     payment; a late or duplicate capture is refunded automatically; COD
 *     where offered, with a delivery code;
 *   - customer cancel until the seller starts preparing (default
 *     CANCELLATION_ALLOWED_UNTIL); a cancelled or rejected paid seller order
 *     is refunded automatically; other refunds are handled by support (in-app
 *     refund requests are switched off); COD refunds by UPI / bank transfer;
 *   - a coupon is given back only when the WHOLE order is cancelled or its
 *     payment fails, with its original expiry and limits;
 *   - Firebase push only (order, payment, refund and back-in-stock alerts);
 *     no email or SMS marketing, no analytics or advertising SDKs; crash
 *     reports are redacted and written to the server log only;
 *   - wishlist and recent searches stay on the phone; the cart is stored on
 *     the server;
 *   - account deletion as implemented in auth.service deleteAccount (orders
 *     keep their delivery details; nothing is "anonymised").
 *
 * Law: the IT Act 2000 / SPDI Rules 2011 apply today; the DPDP Act 2023 and
 * DPDP Rules 2025 (notified November 2025) phase in, most duties from May
 * 2027 — the wording says so and claims nothing more. The Consumer
 * Protection (E-Commerce) Rules 2020 apply; their 2026 amendment starts
 * 1 January 2027 and is NOT described as in force.
 *
 * Every business / contact detail is a {{TOKEN}} filled from Admin
 * Configuration when the page is read — a line whose setting is empty is left
 * out. Not legal advice: a qualified Indian lawyer reviews before publishing.
 */

import type { InfoPageContent, InfoPageSlug } from '../../shared';

const p = (text: string) => ({ type: 'paragraph' as const, text });
const list = (...items: string[]) => ({ type: 'bullets' as const, items });

const CONTACT_LINES = list(
  'Email: {{SUPPORT_EMAIL}}',
  'Phone: {{SUPPORT_PHONE}}',
  'WhatsApp: {{SUPPORT_WHATSAPP}}',
  'Support hours: {{SUPPORT_HOURS}}',
  'Website: {{BUSINESS_WEBSITE}}',
);

const GRIEVANCE_LINES = list(
  'Name: {{GRIEVANCE_OFFICER_NAME}}',
  'Designation: {{GRIEVANCE_OFFICER_DESIGNATION}}',
  'Email: {{GRIEVANCE_OFFICER_EMAIL}}',
  'Phone: {{GRIEVANCE_OFFICER_PHONE}}',
  'Address: {{GRIEVANCE_OFFICER_ADDRESS}}',
);

const OPERATOR_LINES = list(
  'Operated by: {{BUSINESS_LEGAL_NAME}}',
  'Proprietor: {{BUSINESS_PROPRIETOR_NAME}}',
  'Business structure: {{BUSINESS_TYPE}}',
  'Principal place of business: {{BUSINESS_ADDRESS}}',
  'GSTIN: {{GSTIN}}',
  'Website: {{BUSINESS_WEBSITE}}',
);

const COMPLAINT_TIMELINE = p(
  'We acknowledge every complaint within 48 hours and aim to resolve it within one month of receiving it. «TO CONFIRM: legal adviser to confirm the timelines that apply to Aadione — the Consumer Protection (E-Commerce) Rules, 2020 set 48 hours / one month; if Aadione is also an intermediary under the IT (Intermediary Guidelines) Rules, 2021, the shorter 24 hours / 15 days may apply.»',
);

export const PRIVACY_TEMPLATE: InfoPageContent = {
  title: 'Privacy Policy',
  effectiveDate: '',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('{{BUSINESS_TRADE_NAME}} ("Aadione", "we", "us") is a hyperlocal online marketplace. Customers use the Aadione app to order from independent local sellers — shops, restaurants and other businesses near them — and orders are delivered to their door.'),
        OPERATOR_LINES,
        p('This Privacy Policy explains what personal information we collect from customers when you use the Aadione app or our website, why we collect it, who can see it, how long we keep it and the choices you have. It does not cover the business information sellers give us to run their stores.'),
      ],
    },
    {
      heading: 'The law that applies',
      blocks: [
        p('We handle personal information under the laws of India, currently including the Information Technology Act, 2000 and the Information Technology (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011.'),
        p('The Digital Personal Data Protection Act, 2023 and the Digital Personal Data Protection Rules, 2025 were notified in November 2025 and come into force in phases; most of the obligations they place on businesses apply from May 2027. We will update this policy, and ask for your consent in the way those rules require, as their provisions come into force.'),
      ],
    },
    {
      heading: 'Information we collect',
      blocks: [
        p('Account information:'),
        list(
          'Your mobile number. It is needed to create an account and to sign in with a one-time password (OTP).',
          'Your name, and your email address if you choose to add one.',
          'Your referral code and referral rewards, if you use Refer & Earn.',
        ),
        p('Delivery addresses and location:'),
        list(
          'Saved addresses: the recipient\'s name and mobile number, house and street details, landmark, village or town, district, state, PIN code, an optional label (such as Home) and the map location (GPS coordinates) of the address.',
          'Your phone\'s location, only while you use the app and only if you allow it. We use it to check whether we deliver to you, to help you fill in your address, and to work out delivery charges and estimated delivery time. When you order to your current location, that location and its accuracy are saved with the order.',
          'We do not collect your location in the background.',
        ),
        p('Orders, cart and payments:'),
        list(
          'Your cart, stored on our servers while you are signed in so that it is available when you come back.',
          'Each order: the items, sellers, prices, discounts and coupons, delivery and platform fees, the total, any note you add, and the delivery details (recipient name, mobile number, address, landmark and delivery location).',
          'The order\'s status history, cancellations and refunds.',
          'Online payments are processed by Cashfree Payments. To open the payment screen we share the order amount and reference, your name, your mobile number and your email address (if you have added one) with Cashfree. From Cashfree we receive the payment status, amount, payment method type (for example UPI), payment and order references, and the reason if a payment fails.',
          'We never receive or store your card number, CVV, UPI PIN, net banking password or other payment credentials.',
          'For cash-on-delivery orders we record the amount due and whether it was collected. If a cash-on-delivery order is refunded, our support team asks for the UPI ID or bank account to send the refund to; it is used only for that refund, and we record the transfer reference.',
        ),
        p('Support and complaints:'),
        list('What you tell our support team or Grievance Officer, such as complaint details and any photos you send of a damaged or wrong item.'),
        p('Your acceptance of our policies:'),
        list('When you tap "I agree" to this Privacy Policy and our Terms in the app, we record which versions you accepted, when, and whether you used the Android or iOS app. We do not record this just because you signed in.'),
        p('Device and technical information:'),
        list(
          'A push notification token for your phone, if you allow notifications.',
          'Crash reports: if the app stops working, it sends a short error report (the error, the screen, the app version and whether the phone is Android or iOS). Email addresses, phone numbers and sign-in tokens are removed before it is stored, and it is written only to our server log.',
          'Each time you sign in: the time, your IP address and the type of app or browser used, kept with that sign-in until a week after it expires, to keep your account secure.',
          'Your IP address and server request logs (the pages and searches requested), used for security, to prevent misuse and to fix problems.',
        ),
        p('Kept only on your phone: your wishlist and recent searches are stored on your device and are not sent to us.'),
        p('Our website does not use advertising or analytics cookies (see our Cookie Policy). It is delivered through Cloudflare, and it loads its fonts from Google Fonts; both receive your IP address to deliver the pages.'),
        p('We do not use advertising identifiers, advertising networks or third-party analytics tools, and the app does not access your contacts, photos or files — except a photo you choose to send to our support team.'),
      ],
    },
    {
      heading: 'How we use your information',
      blocks: [
        list(
          'To create and secure your account and sign you in with an OTP.',
          'To show the sellers and products available where you are, and to check that we deliver to your address.',
          'To pass your order to the seller, have it delivered, and let the seller and the delivery agent contact you about it.',
          'To take payments, collect cash on delivery, and handle cancellations and refunds.',
          'To send you notifications about your orders, payments and refunds, and back-in-stock alerts you ask for.',
          'To answer your questions, complaints and grievances.',
          'To detect and prevent fraud, misuse and security threats.',
          'To keep the records required by tax, accounting and other laws.',
          'To find and fix errors and keep the app working.',
        ),
        p('We do not sell your personal information, and we do not use it for advertising by others. We do not send marketing messages by SMS or email.'),
      ],
    },
    {
      heading: 'Who can see or receive your information',
      blocks: [
        p('Only what each party needs to do its part:'),
        list(
          'Sellers: the seller preparing your order sees your name, mobile number and the items you ordered from them.',
          'Delivery agents: the delivery agent assigned to your order sees your name, mobile number, delivery address and location, the order details and any cash-on-delivery amount.',
          'Aadione team: our support and operations staff can see the information needed to run the service and help you; access depends on their role.',
          'MSG91: receives your mobile number to send your OTP.',
          'Cashfree Payments: processes online payments and refunds, as described above.',
          'Google Firebase Cloud Messaging: delivers push notifications to your phone using its notification token.',
          'Our hosting, database, storage and caching providers (including Railway and Supabase), which run our servers and store our data for us.',
          'Government, regulatory or law enforcement authorities, or a court, when the law requires it, and where needed to protect the rights, property or safety of our customers, sellers, delivery agents or Aadione.',
        ),
        p('Our service providers may use your information only to provide their service to us.'),
      ],
    },
    {
      heading: 'Where your information is stored',
      blocks: [
        p('Your information is stored and processed on servers run by our service providers. «TO CONFIRM: our database and file storage (Supabase) are in Mumbai, India (AWS ap-south-1, verified from configuration on 7 November 2026); confirm the region of the Railway application servers in the Railway dashboard (only a Singapore network edge was observed), and whether to name the regions here.»'),
      ],
    },
    {
      heading: 'How we protect your information',
      blocks: [
        list(
          'All communication between the app, the website and our servers is encrypted in transit (HTTPS).',
          'One-time passwords are short-lived and stored only in a form that cannot be read back.',
          'Access to customer information is limited by role to the people who need it.',
          'Payment credentials are handled by Cashfree and never reach our systems.',
        ),
        p('No system is completely secure. If a security incident affects your personal information, we will act promptly and inform you and the authorities where the law requires it.'),
      ],
    },
    {
      heading: 'How long we keep your information',
      blocks: [
        list(
          'Account details, saved addresses, your cart and notifications: while your account is open; they are deleted when you delete your account.',
          'Push notification tokens: until you sign out on that phone or delete your account.',
          'Records of the policy versions you accepted: «TO CONFIRM: kept for the same period as order records, as evidence of what you agreed to.»',
          'One-time passwords: a few minutes.',
          'Order, payment and refund records, including the delivery details saved with each order: «TO CONFIRM: retention period, with the CA — for example the period required by GST and income-tax law — and when they are deleted after it.»',
          'Server logs, crash reports and backups: «TO CONFIRM: how long Railway keeps logs and how long database backups are kept.»',
        ),
      ],
    },
    {
      heading: 'Deleting your account',
      blocks: [
        p('You can delete your account in the app from Account → Personal Information → Delete Account. An account cannot be deleted while one of its orders is still in progress.'),
        p('When you delete your account:'),
        list(
          'Your name, email address, saved addresses, notifications, notification tokens and active cart are deleted.',
          'The record of which policy versions you accepted, and when, is kept as evidence of what you agreed to.',
          'Your mobile number is removed from the account, you are signed out on every phone, and the account can no longer be used.',
          'Records of past orders, payments and refunds — including the delivery details (name, mobile number and address) saved with each order — are kept for the period described above, because the law and dispute resolution require them. They are not used to contact you or for marketing.',
          'Your wishlist and recent searches are only on your phone; uninstalling the app or clearing its data removes them.',
        ),
        p('If you cannot use the app, write to the Grievance Officer and we will delete the account for you. We may need to confirm that the request comes from the account holder.'),
      ],
    },
    {
      heading: 'Your choices and rights',
      blocks: [
        list(
          'You can see and update your name, email address and saved addresses in the app.',
          'You can turn off location access in your phone\'s settings and enter your address by hand instead.',
          'You can turn off notifications in your phone\'s settings.',
          'You can ask the Grievance Officer for a copy of the personal information we hold about you, to correct it, or to delete it, and you can complain about how it is handled.',
        ),
        p('When the rights given by the Digital Personal Data Protection Act, 2023 apply, you can also exercise them by writing to the Grievance Officer.'),
      ],
    },
    {
      heading: 'Children',
      blocks: [
        p('Aadione accounts are meant for people aged 18 and above. «TO CONFIRM: minimum age 18.» We do not knowingly collect personal information from children. If you believe a child has created an account, please contact the Grievance Officer.'),
      ],
    },
    {
      heading: 'Grievance Officer',
      blocks: [
        p('If you have a concern or complaint about how your personal information is handled, please contact our Grievance Officer:'),
        GRIEVANCE_LINES,
        COMPLAINT_TIMELINE,
      ],
    },
    {
      heading: 'Changes to this policy',
      blocks: [
        p('We may update this Privacy Policy when our service or the law changes. Each update is published as a new version with its "Last updated" date, and we will tell you in the app about significant changes. Where the law requires your consent to a change, we will ask for it.'),
      ],
    },
    {
      heading: 'Contact us',
      blocks: [p('For any question about this Privacy Policy:'), CONTACT_LINES],
    },
  ],
};

export const TERMS_TEMPLATE: InfoPageContent = {
  title: 'Terms & Conditions',
  effectiveDate: '',
  sections: [
    {
      heading: 'About these terms',
      blocks: [
        p('These Terms & Conditions ("Terms") apply when you use the {{BUSINESS_TRADE_NAME}} ("Aadione", "we", "us") app or website to browse, order and have orders delivered.'),
        OPERATOR_LINES,
        p('When you sign in, the app asks you to read and accept these Terms and our Privacy Policy; it asks again when an important change is published. Nothing in these Terms limits the rights you have under the Consumer Protection Act, 2019, the Consumer Protection (E-Commerce) Rules, 2020 or any other law.'),
      ],
    },
    {
      heading: 'Your account',
      blocks: [
        list(
          'You can browse sellers, products and restaurants without an account. You need an account to add items to your cart, place orders, save addresses and track orders.',
          'Accounts are for people aged 18 and above. «TO CONFIRM: minimum age 18.»',
          'You sign in with your mobile number and a one-time password (OTP). One mobile number has one customer account.',
          'Keep your OTP to yourself — Aadione will never ask you for it. You are responsible for what is done from your account; tell us at once if you think someone else has used it.',
          'Please give accurate details and a mobile number on which you can be reached about your orders.',
          'You can delete your account at any time, as described in our Privacy Policy.',
        ),
      ],
    },
    {
      heading: 'The Aadione marketplace',
      blocks: [
        p('Aadione is an online marketplace. Products are sold by independent local sellers — such as grocery stores, restaurants and cafes, and fashion, electronics, home and other shops. The seller\'s name is shown on a restaurant\'s page and in your order, and your purchase of a product is from that seller.'),
        p('Under "Seller details" on a restaurant\'s page or in your order, you can see the seller\'s business name, store address and — where the seller has provided one — its customer-care contact, and a food seller\'s FSSAI number.'),
        p('Aadione provides the app and website, collects online payments through Cashfree, arranges delivery and handles customer support and complaints.'),
        p('Each seller is responsible for the products it sells — their quality, safety, description, labelling, price and legal compliance, including food safety licensing for food sellers — and for preparing accepted orders. Aadione is responsible for the services it provides and for handling your complaints, and works with the seller to resolve them.'),
      ],
    },
    {
      heading: 'Products, prices and availability',
      blocks: [
        list(
          'All prices are in Indian Rupees and include applicable taxes. The price that applies is the one shown when you place your order.',
          'Some products come in sizes or variants (for example weight, pack size or clothing size). Each has its own price and stock; please check you have chosen the one you want.',
          'Product images are for identification; packaging may differ.',
          'Stock is limited and can change. If an item becomes unavailable before you pay, the app tells you and it stays in your cart. If a seller cannot supply an item you have paid for, that amount is refunded.',
          'Each seller has its own opening hours. While a seller is closed, its products can be viewed but not ordered. Ordering on Aadione may also be paused at times, for example outside operating hours or during maintenance.',
          'While you complete an online payment, the items in your order are held for you for a short time. If the payment is not completed in that time, the hold ends and your items stay in your cart.',
        ),
      ],
    },
    {
      heading: 'Delivery area, charges and timing',
      blocks: [
        list(
          'We deliver only to the villages, towns and PIN codes shown as served in the app. The app checks your address before you order.',
          'The delivery charge depends on the distance to your address and is shown in your cart before you pay.',
          'The minimum order value is currently {{MIN_ORDER_VALUE}}.',
          'Delivery is free on orders of {{FREE_DELIVERY_THRESHOLD}} or more.',
          'A platform fee of {{PLATFORM_FEE}} applies per order.',
          'Every charge is shown in the cart and at checkout before you pay. Charges can change from time to time; the ones shown when you order apply to that order.',
          'Delivery times shown in the app are estimates, not guarantees. Weather, traffic, seller preparation time and other circumstances can cause delays.',
          'Please give a complete and correct address and be available, and reachable on your mobile number, when your order arrives. «TO CONFIRM: what happens if the customer cannot be reached or is not available at the address — how long the delivery agent waits, whether a second attempt is made, and whether any amount is refunded for an undelivered prepaid order.»',
        ),
      ],
    },
    {
      heading: 'Placing an order',
      blocks: [
        list(
          'Please check your cart, address and charges before you confirm.',
          'An online-paid order is placed only after our server has verified your payment with Cashfree. A success message on the payment screen alone does not place an order; while a payment is still being confirmed, the app shows it as pending.',
          'A cash-on-delivery order is placed when you confirm it.',
          'Each checkout creates at most one order, even if you tap more than once or your connection drops.',
          'A seller, or Aadione, may decline an order or part of it — for example if an item is unavailable, the seller is closed, the address cannot be served, or we suspect misuse. We will tell you, and any amount you paid for the declined part is refunded.',
        ),
      ],
    },
    {
      heading: 'Payments',
      blocks: [
        list(
          'Online payments are processed by Cashfree Payments using the methods shown on the payment screen (for example UPI). Aadione never sees or stores your card or UPI credentials. Cashfree\'s own terms also apply to your payment.',
          'If a payment is still pending, please wait for it to be confirmed before paying again.',
          'If a payment fails, no order is placed and your items stay in your cart. If money was taken for a payment that did not place an order, or you were charged twice or after the order was already paid, the extra payment is refunded automatically to the original payment method. For a failed UPI payment, your bank is also required to reverse the debit within the timelines set by the Reserve Bank of India.',
          'Cash on delivery is available only when it is shown at checkout. It may be limited by order value, by your first order, or by seller or product. Please pay the exact amount shown. You may be asked for a delivery code at your door, which confirms that the order reached you.',
        ),
      ],
    },
    {
      heading: 'Cancelling an order',
      blocks: [
        list(
          'Before an online payment is confirmed, you can stop at any time; nothing is charged and your items stay in your cart.',
          'After your order is placed, you can cancel it from the order screen until the seller starts preparing it. Once preparation has started it can no longer be cancelled in the app — please contact support and we will help if it can still be stopped.',
          'If a seller or Aadione cancels your order, or part of it, we tell you why.',
          'Aadione does not charge a cancellation fee.',
          'If you paid online, the amount for a cancelled order — or the cancelled part — is refunded automatically to your original payment method. See "Refunds" below.',
        ),
      ],
    },
    {
      heading: 'Refunds',
      blocks: [
        p('You are refunded when:'),
        list(
          'you or a seller cancels a paid order, or part of it;',
          'a seller cannot supply an item you paid for;',
          'a payment was taken twice, late, or without placing an order; or',
          'our support team accepts a complaint about a wrong, damaged, missing or defective item.',
        ),
        p('How refunds work:'),
        list(
          'The refund is the amount you actually paid for the affected items, after any discount or coupon.',
          'Delivery and platform fees are refunded when the whole order is cancelled or not delivered. «TO CONFIRM: whether delivery and platform fees are also refunded when only part of an order is cancelled or refunded — recommended: no.»',
          'Online payments are refunded through Cashfree to your original payment method. A refund for a cancellation starts automatically; any other refund is started within «TO CONFIRM: 2 working days» of our support team approving it. The time it then takes to reach your account depends on your bank or payment provider.',
          'Cash-on-delivery orders are refunded by UPI or bank transfer to the details you give our support team, within «TO CONFIRM: 5 working days» of approval.',
          'Refunds other than for cancellations are arranged by our customer support team — please contact them with your order number. We will tell you when your refund has been processed.',
        ),
      ],
    },
    {
      heading: 'Checking your order at the door',
      blocks: [
        p('When your order arrives, you may check it in front of the delivery agent before accepting it. «TO CONFIRM: that delivery agents follow this practice — the app does not record a check at the door or an item handed back; keep the Refund & Cancellation and Shipping & Delivery policies the same.»'),
        list(
          'Check that the items and quantities match your order, that seals and packaging are intact, and that nothing is visibly damaged, leaking or spoiled.',
          'Factory-sealed electronics are checked from the outside only; the seal is not opened at the door.',
          'The delivery agent waits a reasonable time while you check. «TO CONFIRM: waiting time, for example about 5 minutes.»',
          'If an item is wrong, damaged or visibly spoiled, you can hand that item back and accept the rest. The delivery agent informs our support team, which records it and arranges your refund or replacement as described in these Terms.',
          'For a cash-on-delivery order, please pay the amount shown; the amount for a returned item is refunded to you afterwards.',
          'If an item is missing, tell the delivery agent or contact support straight away.',
        ),
        p('If you do not check at the door, or a problem could not reasonably be seen then, you can still report it as described in the next section.'),
      ],
    },
    {
      heading: 'Wrong, damaged, missing or defective items',
      blocks: [
        p('Please contact customer support with your order number as soon as you can, ideally within:'),
        list(
          'Missing or wrong items: «TO CONFIRM: 24 hours» of delivery.',
          'Fresh and perishable items (vegetables, fruit, dairy, bakery and similar) that are damaged, spoiled or expired: «TO CONFIRM: 24 hours» of delivery.',
          'Food and restaurant orders: «TO CONFIRM: 2 hours» of delivery.',
          'Damaged or expired packaged groceries and household items: «TO CONFIRM: 48 hours» of delivery.',
          'Clothing, electronics and other goods that are defective, not as described, or not the size, colour or model you ordered: «TO CONFIRM: 7 days» of delivery, unused and with original tags and packaging.',
        ),
        p('We may ask for photos or a video, and we may ask you to hand the item back to a delivery agent. Our support team reviews each report with the seller and tells you the outcome. If a report is not accepted, we explain why, and you can take it to the Grievance Officer.'),
        p('Reporting after these times does not take away any right you have by law — please still contact us and we will look into it. Defective, deficient, spurious or not-as-described goods are always eligible for a remedy as the law requires.'),
      ],
    },
    {
      heading: 'Product-specific rules',
      blocks: [
        p('Groceries and fresh produce:'),
        list(
          'Fresh produce varies naturally in size, colour and weight; items sold by weight may differ slightly from the weight ordered. «TO CONFIRM: whether any weight difference is adjusted in the price.»',
          'Please check best-before and expiry dates on delivery, and report any problem within the time above.',
        ),
        p('Food and restaurant orders:'),
        list(
          'Food is prepared by the restaurant or cafe you order from, which is responsible for its preparation, hygiene, ingredients and food safety licensing.',
          'Veg and non-veg marks, ingredients and descriptions are provided by the restaurant. If you have an allergy or dietary need, please check with the restaurant or our support before ordering; we cannot guarantee that an item is free of any ingredient.',
          'Once a restaurant has started preparing your food, the order cannot be cancelled in the app.',
        ),
        p('Clothing and fashion:'),
        list(
          'Sizes, colours and measurements are described by the seller. Please check them before you order.',
          'If you receive a different size, colour or item from the one you ordered, or it is defective, it is covered under "Wrong, damaged, missing or defective items".',
        ),
        p('Electronics:'),
        list(
          'Any warranty is provided by the manufacturer or the seller, as stated on the product or its packaging. Please keep the invoice and packaging for warranty claims.',
          'Electronics that arrive damaged, defective or not as described are covered under "Wrong, damaged, missing or defective items".',
        ),
      ],
    },
    {
      heading: 'Returns and replacements',
      blocks: [
        list(
          'Perishable items, food orders and opened hygiene or consumable products cannot be returned because you have changed your mind. Wrong, damaged or defective items are always covered as described above.',
          '«TO CONFIRM: change-of-mind returns for other goods (for example clothing in the wrong size you chose) — recommended: not offered at launch, and stated clearly here.»',
          'Where the same item is available from the seller and our support team can arrange it, we may offer a replacement. A replacement is never forced on you: for a wrong, damaged, defective or missing item you can always choose a refund instead. «TO CONFIRM: replacements offered "where available", or refunds only.»',
        ),
      ],
    },
    {
      heading: 'Coupons, offers and referrals',
      blocks: [
        list(
          'Coupons and offers are subject to the conditions shown with them, such as validity dates, minimum order value and usage limits. A coupon can be used only while it is valid.',
          'Coupons have no cash value and cannot be exchanged for money.',
          'If a whole order that used a coupon is cancelled, or its payment fails, the coupon use is given back: you can use the same coupon again until its original expiry date and within its usual limits. Its validity is not extended.',
          'If only part of such an order is cancelled, the coupon stays applied to the order, and the refund is the amount you actually paid for the cancelled items after the discount.',
          'Where Refer & Earn is offered, referral rewards are given according to the conditions shown in the app.',
          'We may withdraw a coupon, offer or reward that is misused.',
        ),
      ],
    },
    {
      heading: 'Your responsibilities',
      blocks: [
        list(
          'Give a correct delivery address and be reachable on your mobile number while your order is on its way.',
          'Do not place false orders, repeatedly refuse cash-on-delivery orders, or misuse coupons, referrals or refunds.',
          'Treat sellers, delivery agents and support staff with respect.',
          'Do not try to interfere with, copy, overload or gain unauthorised access to the app, the website or our systems.',
        ),
        p('We may limit cash on delivery for, suspend or close an account that is misused, after telling you why where possible.'),
      ],
    },
    {
      heading: 'Sellers\' responsibilities',
      blocks: [
        p('Sellers on Aadione agree to list accurate product information and prices, supply products of the quality described, comply with the law, prepare accepted orders on time, and cooperate with Aadione in resolving customer complaints and refunds.'),
      ],
    },
    {
      heading: 'Intellectual property',
      blocks: [
        p('The Aadione name, logo, app, website and content created by Aadione belong to the operator of Aadione. Product names, images and descriptions belong to the sellers or their owners. You may not copy or use them except to use Aadione as intended.'),
      ],
    },
    {
      heading: 'Our responsibility',
      blocks: [
        p('We are responsible for the services we provide. As far as the law allows, we are not responsible for losses that were not reasonably foreseeable or that are caused by events beyond our reasonable control. Nothing in these Terms limits any liability that cannot be limited by law or any right you have under the Consumer Protection Act, 2019.'),
      ],
    },
    {
      heading: 'Complaints and grievance redressal',
      blocks: [
        p('For any problem, please contact customer support first (details below). If you are not satisfied with the answer, or for any complaint, you can write to our Grievance Officer:'),
        GRIEVANCE_LINES,
        COMPLAINT_TIMELINE,
        p('You can also contact the National Consumer Helpline or approach the appropriate Consumer Commission under the Consumer Protection Act, 2019. «TO CONFIRM: National Consumer Helpline number and website, checked on the official government source.»'),
      ],
    },
    {
      heading: 'Governing law and jurisdiction',
      blocks: [
        p('These Terms are governed by the laws of India. Subject to your right to approach a Consumer Commission, disputes are subject to the courts at «TO CONFIRM: city / district, for example Rajsamand, Rajasthan».'),
      ],
    },
    {
      heading: 'Changes to these terms',
      blocks: [
        p('We may update these Terms. Each update is published as a new version with its "Last updated" date, and we will tell you in the app about significant changes. An order is governed by the Terms in force when it was placed.'),
      ],
    },
    {
      heading: 'Contact us',
      blocks: [CONTACT_LINES],
    },
  ],
};

export const ABOUT_TEMPLATE: InfoPageContent = {
  title: 'About Aadione',
  effectiveDate: '',
  sections: [
    {
      heading: 'What is Aadione?',
      blocks: [
        p('{{BUSINESS_TRADE_NAME}} is a hyperlocal online marketplace. It brings the shops, restaurants and other local businesses around you into one app, so you can browse, order and pay in one place and have your order delivered to your door.'),
      ],
    },
    {
      heading: 'What you can order',
      blocks: [
        list(
          'Groceries and daily needs, including fresh fruit and vegetables.',
          'Food from local restaurants and cafes.',
          'Fashion, electronics and other products from local stores.',
        ),
        p('What you can order depends on the sellers serving your area and their opening hours.'),
      ],
    },
    {
      heading: 'How Aadione works',
      blocks: [
        list(
          'Set your delivery address — the app shows the sellers and products available to you.',
          'Add items from one or more sellers to a single cart.',
          'See every charge — prices, delivery charge and any fees — before you pay.',
          'Pay online through Cashfree, or choose cash on delivery where it is offered.',
          'Follow your order in the app until it reaches you.',
        ),
      ],
    },
    {
      heading: 'Local sellers',
      blocks: [
        p('Aadione is built for local businesses. Grocery stores, restaurants, cafes and other shops list their own products, set their own prices and opening hours, and prepare your orders. Aadione helps them reach customers online.'),
      ],
    },
    {
      heading: 'Delivery',
      blocks: [
        p('We deliver to the villages and towns shown as served in the app. You can check your order at the door, and our support team is there if something is not right.'),
      ],
    },
    {
      heading: 'Our approach',
      blocks: [
        list(
          'Clear prices: every charge is shown before you pay.',
          'Safe payments: online payments are processed by Cashfree; Aadione never sees your card or UPI details.',
          'Real support: your questions and complaints are handled by our support team and Grievance Officer.',
        ),
      ],
    },
    {
      heading: 'Our mission',
      blocks: [p('To make local shopping simple — bringing the shops and restaurants of your town to your phone, and helping local businesses grow online.')],
    },
    {
      heading: 'Contact us',
      blocks: [
        CONTACT_LINES,
        list('Business: {{BUSINESS_LEGAL_NAME}}', 'Proprietor: {{BUSINESS_PROPRIETOR_NAME}}', 'Address: {{BUSINESS_ADDRESS}}', 'GSTIN: {{GSTIN}}'),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Refund & Cancellation, Shipping & Delivery, Cookies (customers / websites)  */
/* -------------------------------------------------------------------------- */
//
// These restate, as stand-alone policies, rules the Terms already contain —
// the SAME rules and the same «TO CONFIRM» decisions. Once one of them is
// published, keep the Terms' matching section consistent with it (or shorten
// it to a reference): two documents must never say different things.

export const REFUND_POLICY_TEMPLATE: InfoPageContent = {
  title: 'Refund & Cancellation Policy',
  effectiveDate: '',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('This policy explains how you can cancel an order placed on {{BUSINESS_TRADE_NAME}} ("Aadione"), when you are refunded and how refunds reach you. It is part of our Terms & Conditions; nothing in it limits the rights you have under the Consumer Protection Act, 2019 or the Consumer Protection (E-Commerce) Rules, 2020.'),
        OPERATOR_LINES,
      ],
    },
    {
      heading: 'Cancelling an order',
      blocks: [
        list(
          'Before an online payment is confirmed, you can stop at any time; nothing is charged and your items stay in your cart.',
          'After your order is placed, you can cancel it from the order screen until the seller starts preparing it. Once preparation has started it can no longer be cancelled in the app — please contact support and we will help if it can still be stopped.',
          'A seller, or Aadione, may cancel an order or part of it — for example if an item is unavailable, the seller is closed or the address cannot be served. We tell you why.',
          'Aadione does not charge a cancellation fee.',
        ),
      ],
    },
    {
      heading: 'When you are refunded',
      blocks: [
        list(
          'You or a seller cancels a paid order, or part of it.',
          'A seller cannot supply an item you paid for.',
          'A payment was taken twice, late, or without placing an order.',
          'Our support team accepts a complaint about a wrong, damaged, missing or defective item.',
        ),
      ],
    },
    {
      heading: 'How much is refunded',
      blocks: [
        list(
          'The amount you actually paid for the affected items, after any discount or coupon.',
          'Delivery and platform fees are refunded when the whole order is cancelled or not delivered. «TO CONFIRM: whether delivery and platform fees are also refunded when only part of an order is cancelled or refunded — recommended: no. Keep the same answer as the Terms.»',
          'If a whole order that used a coupon is cancelled, or its payment fails, the coupon use is given back until the coupon\'s original expiry date. If only part of the order is cancelled, the coupon stays applied.',
        ),
      ],
    },
    {
      heading: 'How and when refunds reach you',
      blocks: [
        list(
          'Online payments are refunded through Cashfree Payments to your original payment method. A refund for a cancellation starts automatically; any other refund is started within «TO CONFIRM: 2 working days» of our support team approving it.',
          'Cash-on-delivery orders are refunded by UPI or bank transfer to the details you give our support team, within «TO CONFIRM: 5 working days» of approval. Those details are used only for that refund.',
          'After a refund is started, the time it takes to reach your account depends on your bank or payment provider. For a failed UPI payment, your bank must also reverse the debit within the timelines set by the Reserve Bank of India.',
          'We tell you in the app when a refund is started and when it is completed.',
        ),
      ],
    },
    {
      heading: 'Wrong, damaged, missing or defective items',
      blocks: [
        p('You may check your order in front of the delivery agent and hand back an item that is wrong, damaged or visibly spoiled. «TO CONFIRM: the same door-check practice as the Terms.» Otherwise, please contact customer support with your order number as soon as you can, ideally within:'),
        list(
          'Missing or wrong items: «TO CONFIRM: 24 hours» of delivery.',
          'Fresh and perishable items: «TO CONFIRM: 24 hours» of delivery.',
          'Food and restaurant orders: «TO CONFIRM: 2 hours» of delivery.',
          'Packaged groceries and household items: «TO CONFIRM: 48 hours» of delivery.',
          'Clothing, electronics and other goods: «TO CONFIRM: 7 days» of delivery, unused and with original tags and packaging.',
        ),
        p('We may ask for photos or a video. Our support team reviews each report with the seller and tells you the outcome; if it is not accepted, we explain why and you can take it to the Grievance Officer. Reporting later does not take away any right you have by law.'),
        // Fact (refund-requests-availability.ts: CUSTOMER_REFUND_REQUESTS_ENABLED = false). Update this line if in-app requests are switched on.
        p('Refund requests are made through our customer support team, not in the app — please contact them with your order number.'),
      ],
    },
    {
      heading: 'Returns and replacements',
      blocks: [
        list(
          'Perishable items, food orders and opened hygiene or consumable products cannot be returned because you have changed your mind.',
          '«TO CONFIRM: change-of-mind returns for other goods — recommended: not offered at launch, and stated clearly here.»',
          'A replacement is never forced on you: for a wrong, damaged, defective or missing item you can always choose a refund instead.',
        ),
      ],
    },
    {
      heading: 'Complaints',
      blocks: [p('If you are not satisfied with how a cancellation or refund was handled, write to our Grievance Officer:'), GRIEVANCE_LINES, COMPLAINT_TIMELINE],
    },
    {
      heading: 'Contact us',
      blocks: [CONTACT_LINES],
    },
  ],
};

export const SHIPPING_POLICY_TEMPLATE: InfoPageContent = {
  title: 'Shipping & Delivery Policy',
  effectiveDate: '',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('This policy explains where and how {{BUSINESS_TRADE_NAME}} ("Aadione") delivers orders, what delivery costs and what to expect at your door. It is part of our Terms & Conditions.'),
        OPERATOR_LINES,
      ],
    },
    {
      heading: 'Where we deliver',
      blocks: [
        list(
          'We deliver only to the villages, towns and PIN codes shown as served in the app and on our website. The app checks your address before you order.',
          'Each seller has its own opening hours; while a seller is closed, its products can be viewed but not ordered. Ordering may also be paused at times, for example outside operating hours or during maintenance.',
        ),
      ],
    },
    {
      heading: 'Who delivers',
      blocks: [
        p('Orders are collected from the seller and delivered to you by delivery agents arranged by Aadione. One order is delivered in one trip, even when it has items from more than one seller.'),
      ],
    },
    {
      heading: 'Delivery charges',
      blocks: [
        list(
          'The delivery charge depends on the distance to your address and is shown in your cart before you pay.',
          'The minimum order value is currently {{MIN_ORDER_VALUE}}.',
          'Delivery is free on orders of {{FREE_DELIVERY_THRESHOLD}} or more.',
          'A platform fee of {{PLATFORM_FEE}} applies per order.',
          'Charges can change from time to time; the ones shown when you order apply to that order.',
        ),
      ],
    },
    {
      heading: 'Delivery time',
      blocks: [
        p('The delivery time shown in the app is an estimate, not a guarantee. Weather, traffic, the seller\'s preparation time and other circumstances can cause delays. You can follow your order in the app until it reaches you.'),
      ],
    },
    {
      heading: 'At your door',
      blocks: [
        list(
          'Please give a complete and correct address and be available, and reachable on your mobile number, when your order arrives.',
          'For cash-on-delivery orders, please pay the amount shown. You may be asked for a delivery code, which confirms that the order reached you.',
          'You may check your order in front of the delivery agent before accepting it (see our Refund & Cancellation Policy). «TO CONFIRM: the same door-check practice as the Terms.»',
          '«TO CONFIRM: what happens if you cannot be reached or are not at the address — how long the delivery agent waits, whether a second attempt is made, and whether any amount is refunded for an undelivered prepaid order. Keep the same answer as the Terms.»',
        ),
      ],
    },
    {
      heading: 'Contact us',
      blocks: [p('For any question about a delivery:'), CONTACT_LINES],
    },
  ],
};

export const COOKIE_POLICY_TEMPLATE: InfoPageContent = {
  title: 'Cookie Policy',
  effectiveDate: '',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('This policy explains what our websites store in your browser: the Aadione website ({{BUSINESS_WEBSITE}}) and the Aadione Admin and Seller Panels. It applies together with our Privacy Policy.'),
        OPERATOR_LINES,
      ],
    },
    {
      heading: 'Cookies',
      blocks: [
        p('Aadione does not set cookies of its own, and we do not use advertising, analytics or tracking cookies or similar tools.'),
        p('No cookies are set when the website is visited normally. If Cloudflare, which delivers the website, has to check a visit for abuse, it may set its own short-lived security cookie; it is not used to track you.'),
      ],
    },
    {
      heading: 'Other information kept in your browser',
      blocks: [
        list(
          'Aadione website: the addresses of the current Aadione logo and icon, so they show without waiting when you come back. Nothing about you.',
          'Admin and Seller Panels (kept until you sign out or clear it): your sign-in session, so you stay signed in; which new-order alerts you have already seen; a collapsed menu; the onboarding step you were on; and the current Aadione logo addresses.',
          'Admin and Seller Panels (this browser tab only, gone when it is closed): where you were on a list, so Back returns there, and that you chose "Not now" on an updated policy.',
        ),
        p('You can clear this at any time from your browser settings; you will then need to sign in again to the panels.'),
      ],
    },
    {
      heading: 'Third-party services',
      blocks: [
        p('Our website loads its fonts from Google Fonts, which receives your IP address to deliver them. Links to app stores, social networks or maps take you to those services, whose own policies apply.'),
      ],
    },
    {
      heading: 'The Aadione app',
      blocks: [p('The Aadione mobile app does not use cookies. What the app stores on your phone is described in our Privacy Policy.')],
    },
    {
      heading: 'Changes and contact',
      blocks: [p('We publish every change to this policy as a new version with its "Last updated" date. For any question:'), CONTACT_LINES],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Sellers (Seller Panel)                                                      */
/* -------------------------------------------------------------------------- */
//
// Written from the Seller Panel as built (audit of 2026-11-12):
//   - sign-up with business details, email and password; Aadione reviews the
//     application (Gate 1), then the onboarding — business profile, PAN,
//     Aadhaar, GST, FSSAI (food), bank account and PDF documents — (Gate 2)
//     before the store goes live; either can be rejected with a reason and
//     resubmitted;
//   - documents are private files (never public links); document numbers are
//     masked everywhere except an audited Aadione admin view;
//   - sellers create their own categories and products; every new product is
//     approved by Aadione before customers see it; Aadione can disable a
//     product, with a reason the seller sees;
//   - sellers set price, MRP, stock, availability, opening hours, closures
//     and (per Aadione's rules) cash on delivery; delivery is by Aadione;
//   - commission per seller / category / product, snapshotted on each order;
//     settlements per settlement cycle, only for delivered and paid orders;
//     payouts are made by Aadione OUTSIDE the app (bank transfer / UPI) and
//     recorded with a reference and proof; a refund after delivery is
//     deducted from a later payout (commission reversed);
//   - coupons are funded by Aadione (they never reduce the seller's payout);
//     delivery and platform fees belong to Aadione;
//   - sellers see each customer's name, mobile and items ordered from them;
//   - a seller's optional customer-care phone/email, business name, store
//     address and (food) FSSAI number are shown to customers.

export const SELLER_TERMS_TEMPLATE: InfoPageContent = {
  title: 'Seller Terms & Conditions',
  effectiveDate: '',
  sections: [
    {
      heading: 'About these terms',
      blocks: [
        p('These Seller Terms & Conditions ("Seller Terms") apply between {{BUSINESS_LEGAL_NAME}}, which operates the {{BUSINESS_TRADE_NAME}} ("Aadione") marketplace, and every business ("you", the "Seller") that sells to customers through Aadione using the Aadione Seller Panel.'),
        OPERATOR_LINES,
        p('By applying to sell, and again when an important change is published, you are asked to read and accept these Seller Terms and the Seller Privacy Policy in the Seller Panel. «TO CONFIRM: whether a separate signed seller agreement is also used; if so, say which document prevails.»'),
      ],
    },
    {
      heading: 'Joining Aadione',
      blocks: [
        list(
          'You apply with your business details and an email address and password for the Seller Panel. Aadione reviews the application.',
          'Once the application is approved, you complete onboarding: business profile, PAN, GST (where registered), FSSAI licence (for food), bank account and the supporting documents (an Aadhaar number and card are optional). Aadione verifies them before your store goes live.',
          'Aadione may reject an application or onboarding with a reason; you can correct it and submit again.',
          'You must give true, complete and current information and keep it up to date — including your licences, which must remain valid while you sell.',
          'You are responsible for everything done from your Seller Panel accounts, including your staff\'s accounts. Keep passwords secret.',
        ),
      ],
    },
    {
      heading: 'Your products and listings',
      blocks: [
        list(
          'You create and manage your own categories and products, with accurate names, descriptions, images, sizes or variants, prices, MRP and any information the law requires (for example country of origin, net quantity, best-before date, veg/non-veg marking for food).',
          'Every new product is reviewed by Aadione before customers can see it. Aadione may reject a product, or later disable it, with a reason you can see — for example if it is unsafe, unlawful, misdescribed or infringes someone\'s rights.',
          'You may sell only products you are legally allowed to sell. Prohibited and restricted items must not be listed. «TO CONFIRM: list of prohibited / restricted categories.»',
          'You keep your stock and availability accurate. Prices are inclusive of applicable taxes.',
        ),
      ],
    },
    {
      heading: 'Orders',
      blocks: [
        list(
          'You accept or decline each new order promptly in the Seller Panel, and prepare accepted orders on time. «TO CONFIRM: the time within which a seller must accept or decline a new order, and prepare it.»',
          'A declined or cancelled order is refunded to the customer automatically if it was paid.',
          'Aadione arranges delivery: a delivery agent collects the order from your store. Please have it packed and ready.',
          'You keep your opening hours and closures up to date in the Seller Panel. While your store is closed, customers cannot order from it.',
          'Customer details you see (name, mobile number and the items ordered) may be used ONLY to prepare and hand over that order — never for marketing, and never shared with anyone else.',
        ),
      ],
    },
    {
      heading: 'Quality, safety and the law',
      blocks: [
        p('You are responsible for the products you sell — their quality, safety, freshness, labelling, legal compliance and, for food, hygiene and food-safety licensing. You comply with every law that applies to your business, including consumer protection, legal metrology, food safety, tax and GST laws.'),
        p('Your business name, store address and, for food sellers, FSSAI licence number are shown to customers; your customer-care phone number and email are shown only if you choose to provide them.'),
      ],
    },
    {
      heading: 'Customer complaints, returns and refunds',
      blocks: [
        list(
          'Aadione handles customer support and complaints, and you cooperate in resolving them — for example by checking an order, replacing an item or confirming what was supplied.',
          'Aadione decides refunds to customers in line with its customer Terms and the law.',
          'If a customer is refunded after delivery for an item you supplied (for example a wrong, damaged or defective item), the amount you earned on it — the price less the commission, which is reversed — is deducted from your next payout. You see each deduction in the Seller Panel.',
          '«TO CONFIRM: whether a deduction can be disputed, how, and within what time.»',
        ),
      ],
    },
    {
      heading: 'Commission and fees',
      blocks: [
        list(
          'Aadione charges a commission on each delivered sale. The rate is agreed with you and may differ by category or product: «TO CONFIRM: the standard commission rate(s), and how a change of rate is notified.»',
          'The commission that applies is fixed when the order is placed; a later change of rate never changes an earlier order.',
          'Discounts from Aadione coupons are paid by Aadione and do not reduce what you earn.',
          'Delivery and platform fees paid by customers belong to Aadione.',
          '«TO CONFIRM: GST on commission — whether Aadione charges GST on its commission and issues invoices, and any TCS / TDS deducted under GST or income-tax law.»',
        ),
      ],
    },
    {
      heading: 'Settlements and payouts',
      blocks: [
        list(
          'Your earnings are settled per settlement cycle. An order counts only when it has been delivered and paid, and only for the items not cancelled or refunded.',
          'Each settlement shows its orders, the commission and any deductions, and can be downloaded as a statement.',
          'Payouts are made by Aadione by bank transfer or UPI to the bank account in your Seller Panel, outside the Seller Panel; the payment reference (UTR) and proof are recorded on the settlement. «TO CONFIRM: whether Aadione pays only after verifying that bank account — the Seller Panel records verification, but payouts are made by hand and the system does not enforce it.»',
          '«TO CONFIRM: the settlement cycle (for example weekly) and the number of days after a settlement within which it is paid.»',
          'Please check each statement and tell Aadione about any error within «TO CONFIRM: 15 days».',
        ),
      ],
    },
    {
      heading: 'Suspension and closing your store',
      blocks: [
        list(
          'Aadione may stop new orders to your store, disable products, or suspend or close your seller account — with a reason — for example for a breach of these Seller Terms, unlawful or unsafe products, repeated complaints, misuse of customer data or fraud.',
          'You may stop selling at any time by contacting Aadione. Orders already accepted must still be fulfilled, and earnings already due are still settled.',
          '«TO CONFIRM: notice periods for suspension or termination, and how pending settlements and deductions are handled after closure.»',
        ),
      ],
    },
    {
      heading: 'Intellectual property',
      blocks: [
        p('You keep the rights in your own names, logos, product images and descriptions, and you allow Aadione to show them in the app, on the website and in its promotion of the marketplace while you sell on Aadione. You confirm that you have the right to use everything you upload. The Aadione name, logo, apps and website belong to the operator of Aadione.'),
      ],
    },
    {
      heading: 'Liability',
      blocks: [
        p('Each party is responsible for its own acts and omissions. You indemnify Aadione against claims arising from the products you sell or from your breach of these Seller Terms or the law. «TO CONFIRM: limitation of liability and indemnity wording — legal adviser to draft.»'),
      ],
    },
    {
      heading: 'Grievances and disputes',
      blocks: [
        p('For any question or complaint, contact Aadione seller support first (details below). You can also write to our Grievance Officer:'),
        GRIEVANCE_LINES,
        p('These Seller Terms are governed by the laws of India. Disputes are subject to the courts at «TO CONFIRM: city / district, for example Rajsamand, Rajasthan». «TO CONFIRM: whether disputes go to arbitration first.»'),
      ],
    },
    {
      heading: 'Changes to these terms',
      blocks: [
        p('We may update these Seller Terms. Each update is published as a new version with its "Last updated" date; for an important change we ask you to accept the new version in the Seller Panel. An order is governed by the Seller Terms in force when it was placed.'),
      ],
    },
    {
      heading: 'Contact us',
      blocks: [CONTACT_LINES],
    },
  ],
};

export const SELLER_PRIVACY_TEMPLATE: InfoPageContent = {
  title: 'Seller Privacy Policy',
  effectiveDate: '',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('This policy explains what information {{BUSINESS_TRADE_NAME}} ("Aadione", "we") collects from sellers and their staff when they apply, onboard and sell through the Aadione Seller Panel, why, who can see it and how long it is kept. How customers\' information is handled is described in our customer Privacy Policy.'),
        OPERATOR_LINES,
        p('We handle personal information under the laws of India, currently including the Information Technology Act, 2000 and the SPDI Rules, 2011; the Digital Personal Data Protection Act, 2023 and its Rules apply in phases, most obligations from May 2027.'),
      ],
    },
    {
      heading: 'Information we collect',
      blocks: [
        p('Your account and team:'),
        list(
          'The name, email address and mobile number of the owner and of each staff member you add, and a password (stored only in a form that cannot be read back).',
          'For each sign-in: the time, IP address and browser type, kept until a week after the sign-in expires; password-reset requests; and the changes made from each account (for example to products, prices or stock), so that actions can be traced.',
        ),
        p('Your business:'),
        list(
          'Business name and type, the owner\'s name, store address, map location, opening hours and closures.',
          'PAN, GST and (for food) FSSAI numbers, and the PDF documents you upload to prove them (for example GST certificate, FSSAI licence, PAN card, business licence, bank proof).',
          'An Aadhaar number and Aadhaar card, only if you choose to give them (they are optional). «TO CONFIRM — LEGAL REVIEW: when given, the full 12-digit number is stored (shown masked, last 4 digits) on the business profile and on the document, and the card PDF is kept in private storage — earlier uploads are kept too. The Aadhaar Act, 2016 and its regulations restrict how private businesses may collect and keep Aadhaar numbers: confirm the legal basis, or change to a masked copy only (see docs/proposals/seller-aadhaar-minimisation.md).»',
          'Your bank account holder name, account number, IFSC and bank name, to pay you.',
          'An optional customer-care phone number and email that you choose to show to customers.',
        ),
        p('Your store activity: your products, prices and stock, orders, settlements, payouts, deductions and statements.'),
        p('Technical information: your IP address and request logs, used for security and to fix problems. The Seller Panel keeps your sign-in session in your browser (see our Cookie Policy).'),
      ],
    },
    {
      heading: 'How we use it',
      blocks: [
        list(
          'To review your application and verify your business and documents before your store goes live.',
          'To run your store on the marketplace: show your products, pass orders to you, arrange delivery and handle customer support.',
          'To calculate your earnings, commission and deductions, and to pay you.',
          'To keep the records required by tax, accounting and other laws.',
          'To secure the Seller Panel, prevent fraud and misuse, and fix errors.',
          'To contact you about your account, orders, settlements and changes to our terms.',
        ),
        p('We do not sell sellers\' information or use it for advertising by others.'),
      ],
    },
    {
      heading: 'Who can see it',
      blocks: [
        list(
          'Customers: your business name, store address, products and prices; for food sellers your FSSAI licence number; and your customer-care phone and email only if you provide them. Your owner\'s mobile number is never shown to customers.',
          'Delivery agents: your store\'s name, address and location, to collect orders.',
          'Aadione team: our verification, support, operations and finance staff, according to their role. Documents are private files, never public links; document numbers are shown masked, and viewing a full number is recorded in an audit log.',
          'Our hosting, database and file storage providers (including Railway and Supabase), which store data for us.',
          'Banks and payment providers involved in paying you.',
          'Government, tax or regulatory authorities, or a court, when the law requires it.',
        ),
      ],
    },
    {
      heading: 'How long we keep it',
      blocks: [
        list(
          'Account, business and bank details: while you sell on Aadione, then «TO CONFIRM: retention period after the store is closed».',
          'Verification documents: «TO CONFIRM: retention period, and what happens to rejected or replaced documents».',
          'Orders, settlements, payouts and statements: «TO CONFIRM: the period required by GST and income-tax law, with the CA».',
          'Records of the Seller Terms and Seller Privacy Policy versions you accepted: as long as the records above, as evidence of what was agreed.',
        ),
      ],
    },
    {
      heading: 'How we protect it',
      blocks: [
        list(
          'All communication with the Seller Panel is encrypted in transit (HTTPS).',
          'Passwords are stored only in a form that cannot be read back.',
          'Documents are kept in private storage and are never published.',
          'Access is limited by role, and sensitive actions are recorded in audit logs.',
        ),
      ],
    },
    {
      heading: 'Your choices and rights',
      blocks: [
        list(
          'You can see and update your store details, customer-care contact and staff in the Seller Panel.',
          'You can ask the Grievance Officer for a copy of the personal information we hold about you, to correct it, or to delete what we are not required to keep, and you can complain about how it is handled.',
        ),
      ],
    },
    {
      heading: 'Grievance Officer',
      blocks: [GRIEVANCE_LINES, COMPLAINT_TIMELINE],
    },
    {
      heading: 'Changes to this policy',
      blocks: [p('Each update is published as a new version with its "Last updated" date; for an important change we ask you to accept the new version in the Seller Panel.')],
    },
    {
      heading: 'Contact us',
      blocks: [CONTACT_LINES],
    },
  ],
};

export const INFO_PAGE_TEMPLATES: Readonly<Record<InfoPageSlug, InfoPageContent>> = {
  privacy: PRIVACY_TEMPLATE,
  terms: TERMS_TEMPLATE,
  'refund-policy': REFUND_POLICY_TEMPLATE,
  'shipping-policy': SHIPPING_POLICY_TEMPLATE,
  'cookie-policy': COOKIE_POLICY_TEMPLATE,
  'seller-terms': SELLER_TERMS_TEMPLATE,
  'seller-privacy': SELLER_PRIVACY_TEMPLATE,
  about: ABOUT_TEMPLATE,
};
