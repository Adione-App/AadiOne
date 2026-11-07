import LegalDocument from '../../components/InfoPageDocument'
import useSEO from '../../lib/useSEO'

// The published Privacy Policy from the Aadione API — the same text as the app.
export default function PrivacyPolicy() {
  useSEO({
    title: 'Privacy Policy',
    description:
      'What personal information Aadione collects, why, who it is shared with, how long it is kept and how to exercise your rights.',
    path: '/privacy-policy',
  })
  return <LegalDocument slug="privacy" fallbackTitle="Privacy Policy" />
}
