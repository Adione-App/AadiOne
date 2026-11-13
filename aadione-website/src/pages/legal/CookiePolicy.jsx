import PolicyPage from './PolicyPage'

// The Cookie Policy published in Admin → Legal & Policies (linked in the footer only once published).
export default function CookiePolicy() {
  return (
    <PolicyPage
      slug="cookie-policy"
      title="Cookie Policy"
      description="What the Aadione website and panels store in your browser."
      path="/cookie-policy"
    />
  )
}
