import DownloadSection from '../components/DownloadSection'
import useSEO from '../lib/useSEO'

// The page the header's "Download App" button opens on a computer: both store
// badges and their QR codes. On a phone that button goes straight to the store.
export default function Download() {
  useSEO({
    title: 'Download the App',
    description: 'Download the Aadione app on Google Play for Android or the App Store for iPhone.',
    path: '/download',
  })
  return (
    <div className="pt-4">
      <DownloadSection id="get-the-app" headingLevel="h1" />
    </div>
  )
}
