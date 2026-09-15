import Container from '../components/Container'
import PageHero from '../components/PageHero'
import CategoryCard from '../components/CategoryCard'
import AppStoreButtons from '../components/AppStoreButtons'
import useSEO from '../lib/useSEO'
import { categories, site } from '../config/site'

export default function Categories() {
  useSEO({
    title: 'Categories',
    description:
      'Explore a growing range of everyday products on Aadione — groceries, fresh produce, household essentials, clothing, electronics and more.',
    path: '/categories',
  })

  const mainCategories = categories.filter((c) => c.id !== 'more')

  return (
    <>
      <PageHero
        eyebrow="Categories"
        title="Shop by category."
        description={`${site.name} brings together everyday products across multiple categories in one app. Explore a growing range of everyday products.`}
      />

      <section className="bg-white py-20 sm:py-28">
        <Container>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {mainCategories.map((cat) => (
              <CategoryCard key={cat.id} id={cat.id} name={cat.name} description={cat.description} />
            ))}
          </div>
          <p className="mt-8 max-w-2xl text-sm leading-relaxed text-ink-light/70">
            Category availability may vary depending on your location and current product
            availability. New categories and products are added to {site.name} over time.
          </p>
        </Container>
      </section>

      <section className="bg-leaf-900 py-16 sm:py-20">
        <Container className="flex flex-col items-center gap-6 text-center">
          <h2 className="max-w-lg text-balance font-display text-2xl font-semibold text-white sm:text-3xl">
            See everything Aadione has to offer.
          </h2>
          <AppStoreButtons />
        </Container>
      </section>
    </>
  )
}
