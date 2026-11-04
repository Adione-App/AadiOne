/**
 * The Aadione starting wording for the three information pages.
 *
 * NEVER shown to customers by itself. An admin loads a template into the
 * draft (Admin Panel → Information Pages), reviews it, replaces every
 * «TO CONFIRM: …» marker with the owner's decision, and publishes; a page
 * still containing a marker cannot be published (info-page.service.ts).
 *
 * Written from what the system actually does (2026-11-03 audit): MSG91 OTP
 * sign-in, Cashfree checkout (no card / UPI credentials ever reach
 * Aadione), Firebase push only (no email, no SMS marketing, no analytics or
 * advertising SDKs), sellers see the customer's name and mobile, Aadione
 * delivery agents see the delivery details, account deletion as implemented
 * in auth.service deleteAccount, refunds handled through support (in-app
 * refund requests are switched off; there is no automated doorstep-return or
 * replacement-order feature).
 *
 * Every business / contact detail is a {{TOKEN}} filled from Admin
 * Configuration when the page is read — a line whose setting is empty is left
 * out. Not legal advice: the owner's lawyer reviews before publishing.
 */

import type { InfoPageContent, InfoPageSlug } from '../../shared';

const p = (text: string) => ({ type: 'paragraph' as const, text });
const list = (...items: string[]) => ({ type: 'bullets' as const, items });

const CONTACT_LINES = list(
  'Email: {{SUPPORT_EMAIL}}',
  'Phone: {{SUPPORT_PHONE}}',
  'WhatsApp: {{SUPPORT_WHATSAPP}}',
  'Support hours: {{SUPPORT_HOURS}}',
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
  'Business structure: {{BUSINESS_TYPE}}',
  'Principal place of business: {{BUSINESS_ADDRESS}}',
  'GSTIN: {{GSTIN}}',
);

export const PRIVACY_TEMPLATE: InfoPageContent = {
  title: 'Privacy Policy',
  version: '2.0',
  effectiveDate: '2026-11-03',
  sections: [
    {
      heading: 'About this policy',
      blocks: [
        p('{{BUSINESS_TRADE_NAME}} ("Aadione", "we", "us") is a hyperlocal online marketplace that connects customers with local sellers and delivers orders through its own delivery agents.'),
        OPERATOR_LINES,
        p('This Privacy Policy explains what personal information we collect when you use the Aadione mobile app, why we collect it, who we share it with, how long we keep it and the choices you have. It applies to customers of the Aadione app.'),
      ],
    },
    {
      heading: 'Information we collect',
      blocks: [
        p('Account information:'),
        list(
          'Your mobile number. It is required to create an account and to sign in with a one-time password (OTP).',
          'Your name, and your email address if you choose to add one.',
          'Your referral code and referral rewards, if you use the Refer & Earn feature.',
        ),
        p('Delivery addresses and location:'),
        list(
          'Saved addresses: recipient name and mobile number, house / street details, landmark, village or town, district, state, PIN code, an optional label (such as Home), and the map location (GPS coordinates) of the address.',
          'Your device location, only while you use the app and only if you allow it. It is used to check whether we deliver to you, to help you find your address, and to estimate delivery charges and time. When you choose to deliver to your current location, that location and its accuracy are saved with the order.',
          'We do not collect your location in the background.',
        ),
        p('Order information:'),
        list(
          'The items you order, the sellers, prices, discounts, coupons, delivery and platform fees, and order totals.',
          'The delivery details of each order: recipient name, mobile number, address, landmark and delivery location.',
          'Order notes you add, the order status history, cancellations and refunds.',
          'Information you share with our support team, such as complaint details and photos of a damaged or wrong item.',
        ),
        p('Payment information:'),
        list(
          'Online payments are processed by Cashfree Payments. To open the payment page we share the order amount and reference, and your name, mobile number and email address (if you have added one) with Cashfree.',
          'From Cashfree we receive the payment status, amount, payment method type (for example UPI or card), Cashfree payment and order references, and the reason if a payment fails.',
          'We never receive or store your card number, CVV, UPI PIN, net banking password or other payment credentials.',
          'For a refund of a cash-on-delivery order, we may ask for your UPI ID or bank account details. They are used only to send that refund.',
        ),
        p('Device and technical information:'),
        list(
          'A push notification token, if you allow notifications.',
          'App version, device type and operating system, and error reports (such as an error message and the screen it happened on), used to keep the app working.',
          'Your IP address and server request logs, used for security and to prevent misuse.',
        ),
        p('Kept only on your phone: your wishlist and recent searches are stored on your device and are not sent to us.'),
        p('We do not use advertising identifiers, advertising networks or third-party analytics tools, and we do not access your contacts, photos or files except a photo you choose to send to us.'),
      ],
    },
    {
      heading: 'How we use your information',
      blocks: [
        list(
          'To create and secure your account and sign you in with an OTP.',
          'To show products and sellers available at your location and to check that we deliver to your address.',
          'To place, prepare, deliver and track your orders, and to let the seller and our delivery agent contact you about your order.',
          'To process payments, cash on delivery, cancellations and refunds.',
          'To send you notifications about your orders, payments and refunds, and back-in-stock alerts you have asked for.',
          'To handle your questions, complaints and grievances.',
          'To detect and prevent fraud, misuse and security threats.',
          'To keep the records required by tax, accounting and other applicable laws.',
          'To find and fix errors and keep the app reliable.',
        ),
        p('We do not sell your personal information and we do not use it for third-party advertising.'),
      ],
    },
    {
      heading: 'Who we share your information with',
      blocks: [
        p('We share only what each party needs:'),
        list(
          'Sellers: the seller preparing your order sees your name, mobile number and the items you ordered from them.',
          'Aadione delivery agents: the agent delivering your order sees your name, mobile number, delivery address and location, the order details and any cash-on-delivery amount.',
          'MSG91: receives your mobile number to send the OTP message.',
          'Cashfree Payments: processes online payments and refunds, as described above.',
          'Google Firebase Cloud Messaging: delivers push notifications to your device using its notification token.',
          'Hosting, database, storage and caching providers (including Railway and Supabase), which run our servers and store our data on our behalf.',
          'Government, regulatory or law enforcement authorities, or a court, when the law requires it, and where needed to protect the rights, property or safety of our customers, sellers, delivery agents or Aadione.',
        ),
        p('Our service providers may use your information only to provide their service to us.'),
      ],
    },
    {
      heading: 'Where your information is stored',
      blocks: [
        p('Your information is stored and processed on servers operated by our service providers. «TO CONFIRM: hosting locations — application servers (Railway) in Singapore and database / file storage (Supabase) in Mumbai, India. Confirm the regions and whether to disclose them by name before publishing.»'),
      ],
    },
    {
      heading: 'How we protect your information',
      blocks: [
        list(
          'All communication between the app and our servers is encrypted in transit.',
          'One-time passwords are short-lived and stored only in a form that cannot be read back.',
          'Access to customer information is limited by role to the people who need it to run the service.',
          'Payment credentials are handled by Cashfree and never reach our systems.',
        ),
        p('No system is completely secure. If a security incident affects your personal information, we will act promptly and inform you and the authorities where the law requires it.'),
      ],
    },
    {
      heading: 'How long we keep your information',
      blocks: [
        list(
          'Account details and saved addresses: while your account is open, and deleted when you delete your account.',
          'One-time passwords: a few minutes.',
          'Order, payment and refund records (including the delivery details recorded with each order): for as long as required by tax, accounting and other applicable laws and to resolve disputes. «TO CONFIRM: retention period, to be confirmed with the CA (for example the GST record-keeping period).»',
          'Notifications: until you delete your account.',
          'Server logs and error reports: only as long as needed for security and troubleshooting.',
        ),
      ],
    },
    {
      heading: 'Deleting your account',
      blocks: [
        p('You can delete your account in the app from Account → Personal Information → Delete Account. An account cannot be deleted while an order is still in progress.'),
        p('When you delete your account:'),
        list(
          'Your name, email address, saved addresses, notifications, device registrations and active cart are deleted.',
          'Your mobile number is removed from the account, you are signed out on all devices, and the account can no longer be used.',
          'Records of past orders, payments and refunds — including the delivery details recorded with those orders — are kept for the period the law requires, as described above. They are not used to contact you or for marketing.',
          'Your wishlist and recent searches are stored only on your phone; uninstalling the app or clearing its data removes them.',
        ),
        p('If you cannot use the app, you can ask the Grievance Officer to delete your account. We may need to confirm that the request comes from the account holder.'),
      ],
    },
    {
      heading: 'Your choices and rights',
      blocks: [
        list(
          'You can view and update your name, email and saved addresses in the app.',
          'You can turn off location access in your phone settings and enter your address manually instead.',
          'You can turn off push notifications in your phone settings.',
          'You can ask for access to, correction of or deletion of your personal information, and raise a complaint, by writing to the Grievance Officer.',
        ),
        p('You may exercise any other rights available to you under applicable Indian law.'),
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
        p('We acknowledge complaints within 48 hours and aim to resolve them within one month of receiving them.'),
      ],
    },
    {
      heading: 'Changes to this policy',
      blocks: [
        p('We may update this Privacy Policy when our services or the law change. The updated policy will show a new version number and effective date, and we will tell you in the app about significant changes. Where the law requires your consent to a change, we will ask for it.'),
      ],
    },
    {
      heading: 'Contact us',
      blocks: [p('For any questions about this Privacy Policy:'), CONTACT_LINES],
    },
  ],
};

export const TERMS_TEMPLATE: InfoPageContent = {
  title: 'Terms & Conditions',
  version: '2.0',
  effectiveDate: '2026-11-03',
  sections: [
    {
      heading: 'About these terms',
      blocks: [
        p('These Terms & Conditions ("Terms") apply when you use the {{BUSINESS_TRADE_NAME}} ("Aadione", "we", "us") mobile app to browse, buy or have orders delivered.'),
        OPERATOR_LINES,
        p('By creating an account or placing an order you agree to these Terms and to our Privacy Policy. Please read them carefully. Nothing in these Terms limits the rights you have under the Consumer Protection Act, 2019 or any other applicable law.'),
      ],
    },
    {
      heading: 'Using Aadione',
      blocks: [
        list(
          'You can browse products, sellers and restaurants as a guest. You need an account to add items to the cart and place orders.',
          'Accounts are for people aged 18 and above. «TO CONFIRM: minimum age 18.»',
          'You sign in with your mobile number and a one-time password (OTP). Never share your OTP with anyone — Aadione will never ask you for it. You are responsible for activity on your account.',
          'Please give accurate details and a mobile number on which you can be reached, so that we can deliver your order.',
          'You can delete your account at any time, as described in our Privacy Policy.',
        ),
      ],
    },
    {
      heading: 'The Aadione marketplace',
      blocks: [
        p('Aadione is an online marketplace. Products are sold by independent local sellers — such as grocery stores, restaurants and cafes, fashion and electronics stores — whose name is shown with their products and in your order. Aadione provides the app, online payment collection through Cashfree, customer support and delivery by Aadione delivery agents.'),
        p('Each seller is responsible for the products it sells: their quality, accurate description, labelling, pricing information and compliance with applicable laws, including food safety licensing for food sellers. Aadione is responsible for the services it provides, including delivery by its agents and handling your complaints.'),
      ],
    },
    {
      heading: 'Products, prices and availability',
      blocks: [
        list(
          'All prices are in Indian Rupees and include applicable taxes. The price that applies is the one shown when you place your order.',
          'Product images are for identification; packaging may differ.',
          'Stock is limited and can change. If an item becomes unavailable before you pay, the app tells you. If a seller cannot fulfil an order you have already paid for, you are refunded.',
          'Each seller has its own opening hours. When a seller is closed, its products can be browsed but not ordered.',
          'While you are paying online, the items in your order are held for you for a limited time. If the payment is not completed in that time, the hold ends and the items stay in your cart.',
        ),
      ],
    },
    {
      heading: 'Delivery area and charges',
      blocks: [
        list(
          'We deliver only to the localities shown as served in the app. The app checks your address before you order.',
          'Delivery charges depend on distance and are shown in your cart before you pay.',
          'The minimum order value is currently {{MIN_ORDER_VALUE}}.',
          'Delivery is free on orders of {{FREE_DELIVERY_THRESHOLD}} or more.',
          'A platform fee of {{PLATFORM_FEE}} applies per order.',
          'Every charge is shown in the cart and at checkout before you pay. Charges may change from time to time; the ones shown when you order apply to that order.',
          'Delivery times shown in the app are estimates, not guarantees.',
        ),
      ],
    },
    {
      heading: 'Placing an order',
      blocks: [
        list(
          'Please review your cart, address and charges before you confirm.',
          'An online order is confirmed only after your payment has been verified with Cashfree by our servers. A success message on the payment screen alone does not confirm an order.',
          'A cash-on-delivery order is confirmed when you place it.',
          'We or the seller may decline or cancel an order — for example if an item is unavailable, the seller is closed, the address cannot be served, or we suspect misuse. We will tell you why, and any amount you paid is refunded in full.',
        ),
      ],
    },
    {
      heading: 'Payments',
      blocks: [
        list(
          'Online payments are processed securely by Cashfree Payments using the methods Cashfree offers at checkout (such as UPI, cards and net banking). Aadione does not see or store your card or UPI credentials. Cashfree\'s own terms also apply to your payment.',
          'If a payment is still pending, please wait for it to be confirmed before paying again.',
          'If money is deducted but your order is not confirmed, or a payment arrives late or twice, the amount is refunded to your original payment method. For a failed UPI payment, your bank is also required to reverse it within the timelines set by the Reserve Bank of India.',
          'Cash on delivery is available only when it is shown as an option at checkout. It may be limited by order value, seller or product. Please pay the exact amount shown. You may be asked for a delivery code at the door.',
        ),
      ],
    },
    {
      heading: 'Cancelling an order',
      blocks: [
        list(
          'Before your online payment is confirmed, you can stop at any time; nothing is charged and your items stay in your cart.',
          'After your order is confirmed, you can cancel it from the order screen until the seller starts preparing it. If you paid online, the full amount — including delivery and platform fees — is refunded to your original payment method.',
          'Once preparation has started, the order can no longer be cancelled in the app. Please contact support and we will help if the order can still be stopped.',
          'If Aadione or a seller cancels your order, we tell you why and refund the full amount you paid.',
          'Aadione does not charge any cancellation fee.',
        ),
      ],
    },
    {
      heading: 'Delivery and checking your order at the door',
      blocks: [
        p('Orders are delivered by Aadione delivery agents. When your order arrives, you may check it in front of the agent before accepting it:'),
        list(
          'Check that the items and quantities match your order in the app, that seals and packaging are intact, and that nothing is visibly damaged, leaking or spoiled.',
          'Factory-sealed electronic products are checked from the outside only; the seal is not opened at the door.',
          'The agent waits a reasonable time while you check. «TO CONFIRM: waiting time, e.g. about 5 minutes.»',
          'If an item is wrong, damaged or visibly spoiled, hand that item back to the agent and accept the rest of the order.',
          'The agent informs Aadione customer support, which records the returned item against your order and the seller and arranges your refund or replacement under the "Refunds" and "Replacements" sections below.',
          'For a cash-on-delivery order, please pay the amount shown at the door; the amount for a returned item is refunded to you afterwards.',
          'If an item is missing, tell the agent or contact support right away.',
        ),
        p('Checking at the door is offered for your convenience. If you do not check, or a problem could not reasonably be seen at the door, you can still report it as described in the next section.'),
      ],
    },
    {
      heading: 'Wrong, damaged, missing or defective items',
      blocks: [
        p('Please contact customer support (details at the end of these Terms) and quote your order number. Report the problem as soon as you can, ideally within:'),
        list(
          'Missing or wrong items: «TO CONFIRM: 24 hours» of delivery.',
          'Damaged, spoiled or expired perishables (vegetables, fruit, dairy, bakery and similar): «TO CONFIRM: 24 hours» of delivery.',
          'Restaurant and food orders: «TO CONFIRM: 2 hours» of delivery.',
          'Damaged or expired packaged groceries and household items: «TO CONFIRM: 48 hours» of delivery.',
          'Electronics, clothing and other goods that are defective, not as described, or not the size or model you ordered: «TO CONFIRM: 7 days» of delivery, unused and with original tags and packaging.',
        ),
        p('We may ask for photos or a video, and we may ask you to hand the item back to an Aadione delivery agent. Our support team reviews each report with the seller and tells you the outcome. If a report is not accepted, we explain why, and you can escalate it to the Grievance Officer.'),
        p('Reporting after these times does not take away any right you have by law — please still contact us and we will look into it. Defective, deficient, spurious or not-as-described goods are always eligible for a remedy as required by law.'),
      ],
    },
    {
      heading: 'Returns',
      blocks: [
        list(
          'Perishable items, food orders and opened hygiene or consumable products cannot be returned because you changed your mind. Wrong, damaged or defective items are always covered under the section above.',
          '«TO CONFIRM: change-of-mind returns for other goods — recommended: not offered at launch, and clearly stated here.»',
        ),
      ],
    },
    {
      heading: 'Refunds',
      blocks: [
        list(
          'Refunds are handled by our customer support team.',
          'A refund is the amount you actually paid for the affected items, after any discount or coupon.',
          'Delivery and platform fees are refunded when the whole order is cancelled, not delivered or fully refunded. «TO CONFIRM: whether fees are also refunded on a partial refund — recommended: no.»',
          'Online payments are refunded through Cashfree to your original payment method. We start the refund within «TO CONFIRM: 2 working days» of approving it; the time it takes to reach your account depends on your bank or payment provider.',
          'Cash-on-delivery orders are refunded by UPI or bank transfer to the details you give our support team, within «TO CONFIRM: 5 working days» of approval.',
          'You can see the refund on your order in the app, and we notify you when it is processed.',
        ),
      ],
    },
    {
      heading: 'Replacements',
      blocks: [
        p('Where the same item is available from the seller and our support team can arrange it, we may offer a replacement instead of a refund. A replacement is never forced on you: for a wrong, damaged, defective or missing item you can always choose a refund. «TO CONFIRM: replacements offered "where available", or refunds only.»'),
      ],
    },
    {
      heading: 'Food orders',
      blocks: [
        list(
          'Food is prepared by the restaurant or cafe you order from. The restaurant is responsible for its preparation, hygiene, ingredients and food safety licensing.',
          'If you have an allergy or dietary requirement, please check the item description and contact the restaurant or our support before ordering. We cannot guarantee that any item is free of a particular ingredient.',
          'Veg and non-veg marks are provided by the restaurant.',
        ),
      ],
    },
    {
      heading: 'Coupons, offers and referrals',
      blocks: [
        list(
          'Coupons and offers are subject to the conditions shown with them, such as validity dates, minimum order value and usage limits.',
          'Coupons have no cash value and cannot be exchanged for money.',
          'If an order that used a coupon is cancelled, the coupon may become usable again within its validity, according to its conditions.',
          'Referral rewards are given according to the Refer & Earn conditions shown in the app.',
          'We may withdraw a coupon, offer or reward that is misused.',
        ),
      ],
    },
    {
      heading: 'Your responsibilities',
      blocks: [
        list(
          'Give a correct delivery address and be reachable on your mobile number when your order is on its way.',
          'Do not place false orders, repeatedly refuse cash-on-delivery orders, or misuse coupons, referrals or refunds.',
          'Treat sellers, delivery agents and support staff with respect.',
          'Do not try to interfere with, copy, overload or gain unauthorised access to the app or our systems.',
        ),
        p('We may restrict cash on delivery for, suspend or close an account that is misused, after telling you why where possible.'),
      ],
    },
    {
      heading: 'Sellers\' responsibilities',
      blocks: [
        p('Sellers on Aadione agree to list accurate product information and prices, supply products of the quality described, comply with applicable laws, prepare accepted orders on time, and cooperate with Aadione in resolving customer complaints and refunds.'),
      ],
    },
    {
      heading: 'Intellectual property',
      blocks: [
        p('The Aadione name, logo, app and content created by Aadione belong to the operator of Aadione. Product names, images and descriptions belong to the sellers or their owners. You may not copy or use them except to use the app as intended.'),
      ],
    },
    {
      heading: 'Availability of the service',
      blocks: [
        p('We work to keep Aadione available, but ordering may be paused or limited — for example outside working hours, during maintenance, or when a seller is closed — and the app may occasionally be unavailable for reasons beyond our control.'),
      ],
    },
    {
      heading: 'Our responsibility',
      blocks: [
        p('We are responsible for the services we provide. To the extent permitted by law, we are not responsible for losses that were not reasonably foreseeable or that are caused by events beyond our reasonable control. Nothing in these Terms limits any liability that cannot be limited by law or any right you have under the Consumer Protection Act, 2019.'),
      ],
    },
    {
      heading: 'Complaints and grievance redressal',
      blocks: [
        p('For any problem, please contact customer support first (details below). If you are not satisfied with the response, or for any complaint, you can write to our Grievance Officer:'),
        GRIEVANCE_LINES,
        p('We acknowledge complaints within 48 hours and aim to resolve them within one month of receiving them.'),
        p('You can also approach the National Consumer Helpline or the appropriate Consumer Commission under the Consumer Protection Act, 2019. «TO CONFIRM: National Consumer Helpline number and website, verified from the official government source.»'),
      ],
    },
    {
      heading: 'Governing law',
      blocks: [
        p('These Terms are governed by the laws of India. Subject to your right to approach a Consumer Commission, disputes are subject to the courts at «TO CONFIRM: city / district».'),
      ],
    },
    {
      heading: 'Changes to these terms',
      blocks: [
        p('We may update these Terms. The updated Terms will show a new version number and effective date, and we will tell you in the app about significant changes. An order is governed by the Terms in effect when it was placed.'),
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
  version: '1.0',
  effectiveDate: '2026-11-03',
  sections: [
    {
      heading: 'What is Aadione?',
      blocks: [
        p('{{BUSINESS_TRADE_NAME}} is a hyperlocal online marketplace for your town. It brings the shops and restaurants around you into one app — you browse, order and pay in one place, and Aadione\'s own delivery team brings your order to your door.'),
      ],
    },
    {
      heading: 'What you can order',
      blocks: [
        list(
          'Groceries and daily needs, including fresh vegetables and fruits.',
          'Food from local restaurants and cafes.',
          'Fashion, electronics and other products from local stores.',
        ),
        p('What is available depends on the sellers serving your area and their opening hours.'),
      ],
    },
    {
      heading: 'How Aadione works',
      blocks: [
        list(
          'Set your delivery location — the app shows the sellers and products available to you.',
          'Add items from one or more sellers to a single cart.',
          'See every charge — prices, delivery charge and any fees — before you pay.',
          'Pay online securely through Cashfree, or choose cash on delivery where it is offered.',
          'Track your order in the app until it is delivered.',
        ),
      ],
    },
    {
      heading: 'Local sellers',
      blocks: [
        p('Aadione is built for local businesses. Grocery stores, restaurants, cafes and shops in your area list their own products, set their own prices and opening hours, and prepare your orders — Aadione helps them reach customers online.'),
      ],
    },
    {
      heading: 'Our delivery',
      blocks: [
        p('Orders are delivered by Aadione delivery agents. You can check your order at the door, and our support team is there if anything is not right.'),
      ],
    },
    {
      heading: 'Our approach',
      blocks: [
        list(
          'Clear prices: every charge is shown before you pay.',
          'Safe payments: online payments go through Cashfree; Aadione never sees your card or UPI details.',
          'Real support: questions and complaints are handled by our support team and Grievance Officer.',
        ),
      ],
    },
    {
      heading: 'Our mission',
      blocks: [p('To make local shopping simple and convenient — bringing the trusted shops and restaurants of your town to your phone.')],
    },
    {
      heading: 'Our vision',
      blocks: [p('A thriving local economy where every neighbourhood seller can serve customers online, and every customer can rely on them.')],
    },
    {
      heading: 'Contact us',
      blocks: [CONTACT_LINES, list('Business: {{BUSINESS_LEGAL_NAME}}', 'Address: {{BUSINESS_ADDRESS}}', 'GSTIN: {{GSTIN}}')],
    },
  ],
};

export const INFO_PAGE_TEMPLATES: Readonly<Record<InfoPageSlug, InfoPageContent>> = {
  privacy: PRIVACY_TEMPLATE,
  terms: TERMS_TEMPLATE,
  about: ABOUT_TEMPLATE,
};
