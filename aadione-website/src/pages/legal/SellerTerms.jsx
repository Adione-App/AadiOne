import PolicyPage from './PolicyPage'

// The Seller Terms & Conditions published in Admin → Legal & Policies (the same text sellers accept in the Seller Panel).
export default function SellerTerms() {
  return (
    <PolicyPage
      slug="seller-terms"
      title="Seller Terms & Conditions"
      description="The terms for selling on Aadione: onboarding, products, orders, commission, settlements and payouts."
      path="/seller-terms"
    />
  )
}
