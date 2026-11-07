import { Navigate } from 'react-router-dom'

// Cancellations, refunds and returns are part of the published Terms &
// Conditions (one source, shared with the app). This address is kept — it may
// be registered with payment and app-store partners — and leads there.
export default function CancellationRefund() {
  return <Navigate to="/terms-and-conditions#cancelling-an-order" replace />
}
