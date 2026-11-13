import PolicyPage from './PolicyPage'

// The Refund & Cancellation Policy once it is published (Admin → Legal &
// Policies). Until then this address — which may be registered with payment
// and app-store partners — leads to the cancellation and refund sections of
// the published Terms (/terms-and-conditions#cancelling-an-order).
export default function CancellationRefund() {
  return (
    <PolicyPage
      slug="refund-policy"
      title="Refund & Cancellation Policy"
      description="How to cancel an Aadione order, when you are refunded and how refunds reach you."
      path="/cancellation-refund-policy"
      fallbackTo="/terms-and-conditions#cancelling-an-order"
    />
  )
}
