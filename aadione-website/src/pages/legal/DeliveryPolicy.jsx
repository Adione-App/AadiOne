import { Navigate } from 'react-router-dom'

// Delivery area, charges and timing are part of the published Terms &
// Conditions (one source, shared with the app). This address is kept and
// leads there.
export default function DeliveryPolicy() {
  return <Navigate to="/terms-and-conditions#delivery-area-charges-and-timing" replace />
}
