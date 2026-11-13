import PolicyPage from './PolicyPage'

// The Seller Privacy Policy published in Admin → Legal & Policies.
export default function SellerPrivacy() {
  return (
    <PolicyPage
      slug="seller-privacy"
      title="Seller Privacy Policy"
      description="What information Aadione collects from sellers, why, who can see it and how long it is kept."
      path="/seller-privacy"
    />
  )
}
