import LegalLayout from '../../components/LegalLayout'
import useSEO from '../../lib/useSEO'
import { Link } from 'react-router-dom'
import { business, contact, site, serviceInfo, legalDates } from '../../config/site'

export default function DeliveryPolicy() {
  useSEO({
    title: 'Delivery Policy',
    description: `Delivery area, charges and related terms for ${site.name} orders.`,
    path: '/delivery-policy',
  })

  const b = site.name

  return (
    <LegalLayout
      title="Delivery Policy"
      updated={legalDates.deliveryLastUpdated}
      intro={`This Delivery Policy explains how orders placed on ${b} are delivered, including our service area, delivery charges, and delivery conditions.`}
    >
      <h2>1. Delivery area</h2>
      <p>
        {b} currently provides delivery within a service radius of up to{' '}
        {serviceInfo.deliveryRadiusKm} km from the store. You can check whether your address falls
        within the delivery area directly in the app before placing an order.
      </p>

      <h2>2. Free delivery</h2>
      <p>
        Orders of {serviceInfo.currency}{serviceInfo.freeDeliveryThreshold} or above qualify for
        free delivery. Any delivery charge applicable to orders below this amount is shown before
        you confirm your order.
      </p>

      <h2>3. Delivery availability</h2>
      <p>
        Delivery availability depends on your delivery location and the current service area, and
        may change over time as {b} grows.
      </p>

      <h2>4. Delivery conditions</h2>
      <p>{serviceInfo.deliveryTimingNote}</p>

      <h2>5. Incorrect address</h2>
      <p>
        Please ensure the delivery address you provide is accurate and complete. {b} is not
        responsible for delays or failed deliveries caused by an incorrect or incomplete address.
      </p>

      <h2>6. Customer unavailable</h2>
      <p>
        Please ensure someone is available to receive the order at the provided address. If a
        delivery partner is unable to reach you or deliver the order, the order may be treated as
        undelivered, and applicable charges may still apply.
      </p>

      <h2>7. Operational delays</h2>
      <p>
        Delivery timing may be affected by factors such as order volume, distance from the store,
        weather, traffic, or store readiness. {b} does not guarantee a fixed delivery time.
      </p>

      <h2>8. Order handover</h2>
      <p>
        Once you place an order, it is sent to the store for acceptance. After the store accepts
        and begins packing your order, cancellation may no longer be available, as noted in our
        Cancellation & Refund Policy. Deliveries are then carried out by delivery partners engaged
        by {b} or the fulfilling store, who are expected to handle your order carefully and
        deliver it to the address provided at checkout.
      </p>

      <h2>9. Customer support</h2>
      <p>
        If your order arrives damaged, incomplete, or significantly delayed, please contact us
        {contact.supportEmail ? ` at ${contact.supportEmail}` : ' through our Contact page'} with
        your order ID so we can investigate and assist you promptly.
      </p>

      <h2>10. Changes to this policy</h2>
      <p>
        We may revise this Delivery Policy from time to time as our service area, operations, or
        delivery partners change. The updated version will be posted here with a revised "Last
        Updated" date.
      </p>

      <h2>11. Contact us</h2>
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
