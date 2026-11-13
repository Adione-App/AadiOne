import { Navigate } from 'react-router-dom'
import LegalDocument from '../../components/InfoPageDocument'
import { useInfoPage } from '../../lib/publicApi'
import useSEO from '../../lib/useSEO'

// A policy published in Admin Panel → Legal & Policies, from the same API as
// the app (one source). `fallbackTo`: where this address leads while the
// policy is not published — e.g. the matching section of the Terms, which
// covered it before it had a page of its own.
export default function PolicyPage({ slug, title, description, path, fallbackTo = null }) {
  useSEO({ title, description, path })
  const { status, data } = useInfoPage(slug)
  if (fallbackTo && status === 'ready' && !data) return <Navigate to={fallbackTo} replace />
  return <LegalDocument slug={slug} fallbackTitle={title} />
}
