import { Routes, Route, Navigate } from 'react-router-dom'
import ScrollToTop from './components/ScrollToTop'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import StructuredData from './components/StructuredData'

import Home from './pages/Home'
import About from './pages/About'
import HowItWorks from './pages/HowItWorks'
import Categories from './pages/Categories'
import Features from './pages/Features'
import FAQ from './pages/FAQ'
import Contact from './pages/Contact'
import Support from './pages/Support'
import DeliveryAreasPage from './pages/DeliveryAreasPage'
import Download from './pages/Download'
import NotFound from './pages/NotFound'

import PrivacyPolicy from './pages/legal/PrivacyPolicy'
import Terms from './pages/legal/Terms'
import CancellationRefund from './pages/legal/CancellationRefund'
import DeliveryPolicy from './pages/legal/DeliveryPolicy'
import DeleteAccount from './pages/DeleteAccount'

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <ScrollToTop />
      <StructuredData />
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/features" element={<Features />} />
          <Route path="/faq" element={<FAQ />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/support" element={<Support />} />
          <Route path="/delivery-areas" element={<DeliveryAreasPage />} />
          <Route path="/download" element={<Download />} />

          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms-and-conditions" element={<Terms />} />
          <Route path="/cancellation-refund-policy" element={<CancellationRefund />} />
          <Route path="/delivery-policy" element={<DeliveryPolicy />} />

          <Route path="/delete-account" element={<DeleteAccount />} />

          {/* Short addresses people type or apps link to; the canonical pages keep their URLs. */}
          <Route path="/privacy" element={<Navigate to="/privacy-policy" replace />} />
          <Route path="/terms" element={<Navigate to="/terms-and-conditions" replace />} />
          <Route path="/refund-policy" element={<Navigate to="/terms-and-conditions#cancelling-an-order" replace />} />
          <Route path="/account-deletion" element={<Navigate to="/delete-account" replace />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
