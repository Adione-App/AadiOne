import LegalLayout from '../../components/LegalLayout'
import useSEO from '../../lib/useSEO'
import { Link } from 'react-router-dom'
import { business, contact, site, serviceInfo, legalDates } from '../../config/site'

export default function CancellationRefund() {
  useSEO({
    title: 'Cancellation & Refund Policy',
    description: `Understand how order cancellations and refunds work on ${site.name}.`,
    path: '/cancellation-refund-policy',
  })

  const b = site.name

  return (
    <LegalLayout
      title="Cancellation & Refund Policy"
      updated={legalDates.refundLastUpdated}
      intro={`This policy explains how order cancellations and refunds are handled on ${b}.`}
    >
      <h2>1. Cancellation before store acceptance</h2>
      <p>
        You may cancel your order from the app before the store accepts it, free of charge.
      </p>

      <h2>2. Cancellation after store acceptance</h2>
      <p>
        {serviceInfo.cancellationNote} If you wish to cancel an order that has already been
        accepted, please contact support immediately; cancellation at this stage cannot be
        guaranteed, as the store may already be preparing your order.
      </p>

      <h2>3. Wrong product</h2>
      <p>
        If you receive a product materially different from what you ordered, please report it
        along with your order details and, where possible, photos of the item received.
      </p>

      <h2>4. Damaged product</h2>
      <p>
        If an item arrives damaged, spoiled, or spilled, please report it as soon as possible
        after delivery, along with photos where applicable.
      </p>

      <h2>5. Missing product</h2>
      <p>
        If an item you were billed for is missing from your delivered order, please report it so
        we can investigate and process any applicable adjustment or refund.
      </p>

      <h2>6. Failed order</h2>
      <p>
        An order may be cancelled by the store or by {b} in situations such as an item being
        unexpectedly out of stock, the delivery address falling outside the supported service
        area, the store being temporarily unable to fulfil orders, or suspected fraudulent or
        abusive ordering activity. In such cases, you will be notified as soon as possible, and
        any amount already paid for the affected order will be refunded as per Section 7 below.
      </p>

      <h2>7. Refund eligibility</h2>
      <p>
        Refunds are considered for orders cancelled before store acceptance, orders cancelled by
        the store, unavailable items, and verified issues such as wrong, damaged or missing
        products. Delivery charges are refunded only where the cancellation or issue is not
        attributable to the customer — for example, a store-side cancellation or a confirmed
        delivery error.
      </p>

      <h2>8. Payment issues</h2>
      <p>
        If a payment fails but an amount is debited from your account, please contact support with
        your order or transaction details so we can investigate and process a refund where
        applicable.
      </p>

      <h2>9. Refund process</h2>
      <p>
        Approved refunds for cancelled orders, unavailable items, or verified delivery issues are
        initiated to your original payment method for online payments, or handled directly for
        Cash on Delivery orders, as applicable. {serviceInfo.codNote} Processing times depend on
        your bank or payment provider and are not guaranteed by {b}.
      </p>

      <h2>10. Customer support</h2>
      <p>
        To request a cancellation or refund, use the cancel option in the app where the order is
        still eligible, or contact us with your order ID and details of the issue{' '}
        {contact.supportEmail ? `at ${contact.supportEmail}` : 'through our Contact page'}. Our
        support team will review your request and respond with the outcome and next steps.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We may update this Cancellation & Refund Policy periodically. The updated version will be
        posted on this page with a revised "Last Updated" date.
      </p>

      <h2>12. Contact us</h2>
      <ul>
        <li><strong>{business.legalEntityName}</strong></li>
        {contact.supportEmail && <li>Email: {contact.supportEmail}</li>}
        {contact.phone && <li>Phone: {contact.phone}</li>}
        {!contact.supportEmail && !contact.phone && (
          <li>
            Use our <Link to="/contact">Contact page</Link> to reach us.
          </li>
        )}
      </ul>
    </LegalLayout>
  )
}
