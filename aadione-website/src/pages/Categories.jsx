import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import DownloadSection from '../components/DownloadSection'
import { LiveCategories, LiveRestaurants, MarketplaceKinds } from '../components/LiveCatalogue'
import useSEO from '../lib/useSEO'

export default function Categories() {
  useSEO({
    title: 'Shopping Categories',
    description:
      'Shop groceries, fresh fruits and vegetables and food from local restaurants on Aadione. See every category in the app today, read live from the Aadione catalogue.',
    path: '/categories',
  })

  return (
    <>
      <PageHero
        eyebrow="Categories"
        title="What you can order on Aadione."
        description="The categories below come straight from the Aadione app’s catalogue, so this page always matches what you can order today."
      />

      <section className="bg-white py-16 sm:py-24">
        <Container>
          <SectionHeading eyebrow="In the app now" title="Shop everyday essentials." />
          <div className="mt-10">
            <LiveCategories />
          </div>
        </Container>
      </section>

      <section className="bg-leaf-50/60 py-16 sm:py-24">
        <Container>
          <SectionHeading
            eyebrow="Food"
            title="Restaurants and cafés."
            description="Order meals from local restaurants and cafés in the Food section of the app."
          />
          <div className="mt-10">
            <LiveRestaurants cards />
          </div>
        </Container>
      </section>

      <section className="bg-white py-16 sm:py-24">
        <Container>
          <SectionHeading
            eyebrow="Every kind of local shop"
            title="Categories on the Aadione marketplace."
            description="Aadione is built for local sellers of every kind. “In the app now” means you can order from that category today; the others open as local sellers join."
          />
          <div className="mt-10">
            <MarketplaceKinds columns={4} />
          </div>
        </Container>
      </section>

      <DownloadSection />
    </>
  )
}
