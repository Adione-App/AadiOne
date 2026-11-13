import PolicyPage from './PolicyPage'

// The Shipping & Delivery Policy once it is published (Admin → Legal &
// Policies). Until then this address leads to the delivery section of the
// published Terms (/terms-and-conditions#delivery-area-charges-and-timing).
export default function DeliveryPolicy() {
  return (
    <PolicyPage
      slug="shipping-policy"
      title="Shipping & Delivery Policy"
      description="Where and how Aadione delivers, delivery charges, delivery times and what to expect at your door."
      path="/delivery-policy"
      fallbackTo="/terms-and-conditions#delivery-area-charges-and-timing"
    />
  )
}
