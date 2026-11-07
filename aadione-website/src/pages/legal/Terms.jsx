import LegalDocument from '../../components/InfoPageDocument'
import useSEO from '../../lib/useSEO'

// The published Terms & Conditions from the Aadione API — the same text as the app.
export default function Terms() {
  useSEO({
    title: 'Terms & Conditions',
    description:
      'The terms for using Aadione: accounts, orders, payments, delivery, cancellations, refunds, returns and complaints.',
    path: '/terms-and-conditions',
  })
  return <LegalDocument slug="terms" fallbackTitle="Terms & Conditions" />
}
