import Container from '../components/Container'
import PageHero from '../components/PageHero'
import FAQItem from '../components/FAQItem'
import useSEO from '../lib/useSEO'
import { serviceInfo, site } from '../config/site'

const contactLine = 'you can reach us through the Contact page.'

const categories = [
  {
    title: 'About Aadione',
    items: [
      {
        q: `What is ${site.name}?`,
        a: `${site.name} is a local multi-category shopping and delivery application for groceries, fresh produce, daily essentials and more.`,
      },
      {
        q: 'What can I buy on Aadione?',
        a: 'Today: groceries, fruits and vegetables, and food from local restaurants and cafés. More kinds of shop — such as clothing or electronics — appear as local sellers join. The Categories page always shows what is in the app now.',
      },
      {
        q: 'How does login work?',
        a: `${site.name} uses mobile OTP authentication.`,
      },
    ],
  },
  {
    title: 'Ordering',
    items: [
      {
        q: 'How do I order?',
        a: `Download the ${site.name} app, sign in, browse products, add them to your cart and place your order.`,
      },
      {
        q: 'Can I cancel my order?',
        a: serviceInfo.cancellationNote,
      },
      {
        q: 'Is Cash on Delivery available?',
        a: serviceInfo.codNote,
      },
    ],
  },
  {
    title: 'Delivery & pricing',
    items: [
      {
        q: 'Where does Aadione deliver?',
        a: serviceInfo.areaNote,
      },
      {
        q: 'Is delivery free?',
        a: serviceInfo.deliveryChargeNote,
      },
      {
        q: 'How long does delivery take?',
        a: serviceInfo.deliveryTimingNote,
      },
    ],
  },
  {
    title: 'Account & support',
    items: [
      {
        q: 'How can I delete my account?',
        a: `In the app, or on the ${site.name} Delete Account page: verify your mobile number with a one-time code and confirm. The page explains what is deleted and which records are kept.`,
      },
      {
        q: 'How can I contact Aadione?',
        a: `Use the Contact or Support page — ${contactLine}`,
      },
      {
        q: 'Is my personal information safe?',
        a: 'Our Privacy Policy explains what we collect, why, who it is shared with and how long it is kept.',
      },
    ],
  },
]

export default function FAQ() {
  useSEO({
    title: 'FAQ',
    description: 'Answers to common questions about ordering, delivery, payments and your Aadione account.',
    path: '/faq',
  })

  return (
    <>
      <PageHero
        eyebrow="FAQ"
        title="Frequently asked questions."
        description="Can't find what you're looking for? Reach out on our Contact or Support page and we'll help directly."
      />

      <section className="bg-white py-20 sm:py-28">
        <Container className="grid grid-cols-1 gap-16 lg:grid-cols-2 lg:gap-x-16">
          {categories.map((cat) => (
            <div key={cat.title}>
              <h2 className="font-display text-2xl font-semibold text-ink">{cat.title}</h2>
              <div className="mt-2">
                {cat.items.map((item) => (
                  <FAQItem key={item.q} question={item.q} answer={item.a} />
                ))}
              </div>
            </div>
          ))}
        </Container>
      </section>
    </>
  )
}
