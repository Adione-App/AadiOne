import { Routes, Route } from 'react-router-dom'
import ScrollToTop from './components/ScrollToTop'
import Navbar from './components/Navbar'
import Footer from './components/Footer'

import Home from './pages/Home'
import About from './pages/About'
import HowItWorks from './pages/HowItWorks'
import Categories from './pages/Categories'
import Features from './pages/Features'
import FAQ from './pages/FAQ'
import Contact from './pages/Contact'
import Support from './pages/Support'
import NotFound from './pages/NotFound'

import PrivacyPolicy from './pages/legal/PrivacyPolicy'
import Terms from './pages/legal/Terms'
import CancellationRefund from './pages/legal/CancellationRefund'
import DeliveryPolicy from './pages/legal/DeliveryPolicy'
import DeleteAccount from './pages/DeleteAccount'

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-cream">
      <ScrollToTop />
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

          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms-and-conditions" element={<Terms />} />
          <Route path="/cancellation-refund-policy" element={<CancellationRefund />} />
          <Route path="/delivery-policy" element={<DeliveryPolicy />} />

          <Route path="/delete-account" element={<DeleteAccount />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
