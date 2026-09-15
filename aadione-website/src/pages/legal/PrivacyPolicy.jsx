import LegalLayout from '../../components/LegalLayout'
import useSEO from '../../lib/useSEO'
import { business, contact, site, legalDates } from '../../config/site'
import { Link } from 'react-router-dom'

export default function PrivacyPolicy() {
  useSEO({
    title: 'Privacy Policy',
    description: `How ${site.name} collects, uses and protects your personal information.`,
    path: '/privacy-policy',
  })

  const b = site.name

  return (
    <LegalLayout
      title="Privacy Policy"
      updated={legalDates.privacyLastUpdated}
      intro={`This Privacy Policy explains how ${b} ("${b}", "we", "us" or "our") collects, uses, shares and protects information when you use the ${b} mobile application and website (together, the "Services"). By using our Services, you agree to the practices described in this Privacy Policy.`}
    >
      <h2>1. Introduction</h2>
      <p>
        This Privacy Policy applies to all users of the {b} mobile application and website. It
        describes what information we collect, why we collect it, how it is used and shared, and
        the choices available to you.
      </p>

      <h2>2. Information we collect</h2>
      <p>
        We collect information you provide directly, information generated through your use of
        the Services, and information collected automatically from your device.
      </p>

      <h2>3. Mobile number &amp; OTP authentication</h2>
      <p>
        {b} uses your mobile number to create and access your account through a one-time
        password (OTP). We collect and store your mobile number to authenticate you and to
        communicate important account and order information.
      </p>

      <h2>4. Account information</h2>
      <p>
        When you create an account, we may collect information such as your name, mobile number
        and other details you choose to provide in your profile.
      </p>

      <h2>5. Delivery address information</h2>
      <p>
        To deliver your orders, we collect the delivery address you provide, including details
        necessary to locate and reach your delivery location.
      </p>

      <h2>6. Order information</h2>
      <p>
        We collect information about the orders you place, including products ordered, order
        value, order status and order history, to process and fulfil your orders and to provide
        customer support.
      </p>

      <h2>7. Payment information</h2>
      <p>
        {b} supports payment by UPI and Cash on Delivery, where eligible. For UPI payments, the
        transaction is completed directly within your own UPI or banking app — we do not collect
        or store your card details, UPI PIN, bank account number or banking passwords. We record
        that a payment was made for an order, the amount, and a transaction reference where
        available, so we can confirm and reconcile it against our own bank records.
      </p>

      <h2>8. Location information</h2>
      <p>
        We may collect approximate or precise location information from your device, with your
        permission, to confirm delivery availability within our service area and to support
        accurate delivery.
      </p>

      <h2>9. Device &amp; technical information</h2>
      <p>
        We collect certain technical information automatically, such as device type, operating
        system, app version, IP address and general usage patterns within the app, to help us
        operate and improve the Services.
      </p>

      <h2>10. How we use information</h2>
      <p>We use the information we collect to:</p>
      <ul>
        <li>Create and manage your account, and process and deliver your orders.</li>
        <li>Confirm delivery availability within our service area.</li>
        <li>Communicate order updates and important service notices.</li>
        <li>Provide customer support and resolve complaints, cancellations, or refund requests.</li>
        <li>Improve the Services' performance, reliability and user experience.</li>
        <li>Detect, prevent and address fraud, abuse or security issues.</li>
        <li>Comply with applicable laws, regulations and lawful requests from authorities.</li>
      </ul>

      <h2>11. Data sharing</h2>
      <p>We do not sell your personal information. We may share information with:</p>
      <ul>
        <li>The store fulfilling your order, to prepare and pack it.</li>
        <li>Delivery partners, to complete delivery of your order.</li>
        <li>Our SMS/communications provider, to send OTPs and order updates to your mobile number.</li>
        <li>Law enforcement or regulatory authorities, where required by law or to protect our rights, users, or the public.</li>
      </ul>

      <h2>12. Service providers</h2>
      <p>
        We work with service providers who support our operations, such as hosting, analytics and
        customer support tools. These providers process information on our behalf and under
        appropriate confidentiality and data-protection obligations.
      </p>

      <h2>13. Data security</h2>
      <p>
        We take reasonable technical and organisational measures to protect your information
        against unauthorised access, alteration, disclosure or destruction. However, no method of
        transmission or storage is completely secure, and we cannot guarantee absolute security.
      </p>

      <h2>14. Data retention</h2>
      <p>
        We retain personal information for as long as necessary to provide our Services, comply
        with legal obligations, resolve disputes and enforce our agreements. Order and
        transaction records may be retained for a longer period as required for legal, security,
        fraud-prevention or accounting purposes.
      </p>

      <h2>15. Account &amp; data deletion</h2>
      <p>
        You may request deletion of your account and associated personal data at any time through
        our{' '}
        <Link to="/delete-account">Delete Account page</Link>, which does not require you to sign in.
        Some information may be retained after deletion where required for legal, security,
        fraud-prevention, accounting or other legitimate purposes, as described on that page.
      </p>

      <h2>16. Children's privacy</h2>
      <p>
        The Services are not intended for individuals under the age of 18. We do not knowingly
        collect personal information from children. If you believe a child has provided us
        information, please contact us so we can take appropriate action.
      </p>

      <h2>17. User rights</h2>
      <p>Subject to applicable law, you may:</p>
      <ul>
        <li>Access, update, or correct your account information within the app.</li>
        <li>Request deletion of your account and associated personal information, subject to any legal retention requirements.</li>
        <li>Opt out of non-essential communications, such as promotional messages.</li>
        {contact.supportEmail && (
          <li>Contact us with any privacy-related questions or requests at {contact.supportEmail}.</li>
        )}
      </ul>

      <h2>18. Third-party services</h2>
      <p>
        The Services may rely on third-party providers, such as your UPI or banking app and
        mapping or location services, whose own privacy practices govern the information you
        share directly with them. We encourage you to review their respective privacy policies.
      </p>

      <h2>19. Changes to this Privacy Policy</h2>
      <p>
        We may update this Privacy Policy from time to time to reflect changes in our practices or
        for legal, operational or regulatory reasons. The updated version will be posted on this
        page with a revised "Last Updated" date.
      </p>

      <h2>20. Contact us</h2>
      <p>
        For any questions or concerns regarding this Privacy Policy or our data practices, please
        contact:
      </p>
      <ul>
        <li><strong>{business.legalEntityName}</strong></li>
        {contact.supportEmail && <li>Email: {contact.supportEmail}</li>}
        {contact.phone && <li>Phone: {contact.phone}</li>}
        {contact.address && <li>Address: {contact.address}</li>}
        {!contact.supportEmail && !contact.phone && (
          <li>
            Use our <Link to="/contact">Contact page</Link> to reach us.
          </li>
        )}
        <li>
          Grievance Officer: {business.grievanceOfficer.name}
          {business.grievanceOfficer.email && <> — {business.grievanceOfficer.email}</>}
        </li>
      </ul>
    </LegalLayout>
  )
}
