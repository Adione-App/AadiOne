import LegalLayout from '../../components/LegalLayout'
import useSEO from '../../lib/useSEO'
import { Link } from 'react-router-dom'
import { business, contact, site, serviceInfo, legalDates } from '../../config/site'

export default function Terms() {
  useSEO({
    title: 'Terms & Conditions',
    description: `The terms and conditions governing your use of ${site.name}.`,
    path: '/terms-and-conditions',
  })

  const b = site.name

  return (
    <LegalLayout
      title="Terms & Conditions"
      updated={legalDates.termsLastUpdated}
      intro={`These Terms & Conditions ("Terms") govern your access to and use of the ${b} website and mobile application (together, the "Platform"), operated by ${business.legalEntityName}. By creating an account or placing an order, you agree to these Terms.`}
    >
      <h2>1. Eligibility</h2>
      <p>
        You must be at least 18 years old and capable of entering into a binding contract under
        applicable law to use the Platform.
      </p>

      <h2>2. Account registration</h2>
      <ul>
        <li>You are responsible for maintaining the confidentiality of your account and for all activity under your account.</li>
        <li>You agree to provide accurate, current and complete information, including your delivery address and contact number.</li>
      </ul>

      <h2>3. Mobile OTP authentication</h2>
      <p>
        Account access on {b} is secured using mobile OTP (one-time password) authentication. You
        are responsible for keeping your registered mobile number and any OTPs sent to it secure,
        and for promptly informing us if you suspect unauthorised access to your account.
      </p>

      <h2>4. Products</h2>
      <p>
        {b} enables users to browse and order groceries, fresh produce, daily essentials and other
        everyday products from participating stores, for delivery within a supported service area.
        {' '}{b} facilitates the ordering and delivery process; products are sourced and fulfilled
        by the relevant store.
      </p>

      <h2>5. Product availability</h2>
      <p>
        Product availability shown in the app reflects current stock information but is not
        guaranteed. Items may become unavailable after an order is placed; where this happens, the
        store may remove the item, contact you about a substitute, or issue a refund for that item
        as applicable.
      </p>

      <h2>6. Product pricing</h2>
      <p>
        Prices shown in the app are those in effect at the time of ordering and may change from
        time to time. Applicable taxes, if any, will be reflected in your order summary before
        checkout.
      </p>

      <h2>7. Orders</h2>
      <p>
        Placing an order constitutes an offer to purchase; the order is confirmed only once
        accepted by the store. Order status, delivery estimates and other details shown in the app
        are indicative and may change based on stock and operational conditions.
      </p>

      <h2>8. Minimum / free delivery rules</h2>
      <p>
        Orders of {serviceInfo.currency}{serviceInfo.freeDeliveryThreshold} or more qualify for
        free delivery. Delivery charges applicable to orders below this amount, if any, are shown
        at checkout before you confirm your order.
      </p>

      <h2>9. Delivery area</h2>
      <p>
        {b} currently delivers within a service radius of up to {serviceInfo.deliveryRadiusKm} km
        from the store. Availability depends on your delivery location and the current service
        area, and may change over time.
      </p>

      <h2>10. Delivery</h2>
      <p>
        {serviceInfo.deliveryTimingNote} Please ensure someone is available to receive the order
        at the provided address.
      </p>

      <h2>11. Cancellation</h2>
      <p>{serviceInfo.cancellationNote} See our Cancellation & Refund Policy for full details.</p>

      <h2>12. Payment</h2>
      <ul>
        <li>You may pay by UPI or by Cash on Delivery, where eligible. UPI payments are made directly from your own UPI or banking app; {b} does not collect or store your card details, UPI PIN, bank account number or banking passwords.</li>
        <li>Because a direct UPI transfer does not automatically confirm to us, we verify each online payment against our own bank records before your order is confirmed. This may take some time during store hours.</li>
        <li>In case of a failed transaction where an amount is debited, any applicable refund will be processed as per our Cancellation & Refund Policy.</li>
      </ul>

      <h2>13. COD eligibility</h2>
      <p>{serviceInfo.codNote} Eligible payment options are shown at checkout for each order.</p>

      <h2>14. Returns</h2>
      <p>
        Given the nature of groceries and daily essentials, including perishable and
        semi-perishable goods, returns are generally not accepted once an order has been
        delivered, except where an item is damaged, materially different from what was ordered, or
        missing from the delivered order despite being billed. See our Cancellation & Refund Policy
        for details.
      </p>

      <h2>15. Refunds</h2>
      <p>
        Eligible refunds for cancelled orders, unavailable items, or verified delivery issues are
        processed as described in our Cancellation & Refund Policy. Refund timelines depend on
        your bank or payment provider.
      </p>

      <h2>16. User responsibilities</h2>
      <p>You agree to:</p>
      <ul>
        <li>Provide accurate delivery address and contact information.</li>
        <li>Be available to receive your order at the address and time provided.</li>
        <li>Use the Platform in compliance with these Terms and applicable law.</li>
      </ul>

      <h2>17. Prohibited activities</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Platform for any unlawful purpose or in violation of these Terms.</li>
        <li>Provide false information, including delivery address or contact details.</li>
        <li>Interfere with the security or proper functioning of the Platform.</li>
        <li>Misuse promotional offers, discounts, or referral programs.</li>
      </ul>

      <h2>18. Intellectual property</h2>
      <p>
        All content on the Platform, including the {b} name, logo, text, graphics and software, is
        owned by or licensed to {business.legalEntityName} and is protected under applicable
        intellectual property laws. You may not copy, reproduce, or use this content without prior
        written permission.
      </p>

      <h2>19. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, {b} shall not be liable for any indirect,
        incidental, or consequential damages arising from your use of the Platform, delays in
        delivery, or issues with products supplied by a store, except as required under applicable
        consumer protection law.
      </p>

      <h2>20. Changes to Terms</h2>
      <p>
        We may update these Terms from time to time. Continued use of the Platform after changes
        are posted constitutes acceptance of the updated Terms.
      </p>

      <h2>21. Governing law</h2>
      <p>
        These Terms shall be governed by the laws of India. Any disputes arising out of or in
        connection with these Terms shall be subject to the exclusive jurisdiction of the courts
        at {business.jurisdiction}.
      </p>

      <h2>22. Contact</h2>
      <ul>
        <li><strong>{business.legalEntityName}</strong></li>
        {contact.supportEmail && <li>Email: {contact.supportEmail}</li>}
        {contact.phone && <li>Phone: {contact.phone}</li>}
        {contact.address && <li>Address: {contact.address}</li>}
        {!contact.supportEmail && !contact.phone && (
          <li>
            Use our <Link to="/contact">Contact page</Link> to reach us.
          </li>
        )}
      </ul>
    </LegalLayout>
  )
}
