/**
 * Coming-soon landing page.
 *
 * Structure follows UX_UI_SPEC section 7, with the pre-launch constraint
 * that section names explicitly: "Use real platform metrics only after
 * launch. Prelaunch uses category statements, not fake counts." So there is
 * no counter anywhere on this page, and the one storefront mockup is
 * labelled as an example rather than presented as a live business.
 *
 * That is the same rule as CLAUDE.md 10 -- trust copy must be earned. Before
 * launch we have earned none of it, so we claim none of it.
 *
 * Copy comes from marketing/COPY_DECK.md and the section 7 spec rather than
 * being written fresh, so the site and the flyers say the same thing.
 */

import type { Metadata } from 'next'
import { AuthFragmentNotice } from '@/components/AuthFragmentNotice'
import { WaitlistForm } from './WaitlistForm'
import {
  BORDER,
  CREAM,
  FONT_BODY,
  FONT_HEADING,
  INK,
  LIME,
  MUTED,
  RADIUS_CARD,
  SHADOW,
  WHITE,
} from '@/lib/brand'

export const metadata: Metadata = {
  title: 'Count On Local -- Start a business where you live',
  description:
    'Count On Local is a neighborhood microbusiness platform. Publish a real service page, get recurring customers nearby, and run the route, payments and schedule from one dashboard. Launching soon.',
}

const PROVIDER_STEPS = [
  ['Pick what you do', 'Choose from an approved list of neighborhood services.'],
  ['Publish your page', 'A real service page with your name, your price, your schedule.'],
  ['Get neighbors subscribed', 'Share a link or print a QR flyer for your street.'],
  ['Run your route and get paid', 'One list, one day, money in your account.'],
] as const

const CUSTOMER_SERVICES = [
  ['Trash cans', 'Out on collection day, back at the house after.'],
  ['Dog walking', 'A regular walk on the days you cannot get to it.'],
  ['Yard help', 'Raking, hand weeding, sticks and debris.'],
  ['Plant watering', 'Keeps the pots alive while you are away.'],
] as const

export default function Home() {
  return (
    <main style={S.page}>
      {/* Reads an auth outcome Supabase left in the URL fragment. A
          fragment never reaches the server, so nothing else can. */}
      <AuthFragmentNotice />
      <div style={S.wrap}>
        <header style={S.header}>
          <div style={S.brand}>
            <span style={S.mark} aria-hidden>
              C
            </span>
            <span>Count On Local</span>
          </div>
          <span style={S.pill}>Launching soon</span>
        </header>

        <section style={S.hero}>
          <div>
            <p style={S.eyebrow}>Neighborhood businesses start small.</p>
            <h1 style={S.h1}>Start a business where you live.</h1>
            <p style={S.lede}>
              Create a real service page, get recurring customers nearby, and run the whole thing
              from one simple dashboard.
            </p>
            <WaitlistForm />
          </div>

          <aside style={S.mock} aria-label="Example service page">
            <p style={S.mockTag}>Example service page</p>
            <div style={S.mockHead}>
              <span style={S.mockAvatar} aria-hidden>
                JB
              </span>
              <div>
                <strong style={{ display: 'block', fontSize: 17 }}>Jake&apos;s Bin Service</strong>
                <span style={{ color: MUTED, fontSize: 14 }}>Every Tuesday</span>
              </div>
            </div>
            <div style={S.mockCard}>
              <p style={S.mockMini}>CURB-TO-HOUSE RETURN</p>
              <p style={{ margin: '4px 0 10px', color: MUTED, fontSize: 14, lineHeight: 1.5 }}>
                Your cans are back at the house before the day gets away from you.
              </p>
              <span style={S.price}>
                $3<span style={{ fontSize: 14, fontWeight: 600 }}>/week</span>
              </span>
            </div>
            <p style={S.mockFoot}>
              Billed every 4 weeks. Pause or cancel yourself, any time, without calling anyone.
            </p>
          </aside>
        </section>

        <section style={S.section}>
          <h2 style={S.h2}>How it works</h2>
          <ol style={S.steps}>
            {PROVIDER_STEPS.map(([title, body], i) => (
              <li key={title} style={S.step}>
                <span style={S.stepNum} aria-hidden>
                  {i + 1}
                </span>
                <div>
                  <strong style={{ display: 'block', marginBottom: 4 }}>{title}</strong>
                  <span style={{ color: MUTED, lineHeight: 1.55 }}>{body}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section style={S.section}>
          <h2 style={S.h2}>Good help is closer than you think.</h2>
          <p style={S.body}>
            Small, regular jobs that are easy to put off and too small for a company to bother with.
            Subscribe once and stop thinking about it.
          </p>
          <div style={S.grid}>
            {CUSTOMER_SERVICES.map(([title, body]) => (
              <div key={title} style={S.card}>
                <strong style={{ display: 'block', marginBottom: 6 }}>{title}</strong>
                <span style={{ color: MUTED, fontSize: 15, lineHeight: 1.55 }}>{body}</span>
              </div>
            ))}
          </div>
        </section>

        <section style={{ ...S.section, ...S.guardian }}>
          <h2 style={{ ...S.h2, marginTop: 0 }}>They run the business. You stay connected.</h2>
          <p style={S.body}>
            A provider aged 13 to 17 needs a parent or guardian connected before they can take a
            paying customer. Guardians approve which services are allowed, see the service area and
            the scheduled work, get alerted to new customers and incidents, and can pause the
            business immediately.
          </p>
          <p style={{ ...S.body, marginBottom: 0 }}>
            A provider&apos;s home address, school, exact age and private schedule are never public,
            and a customer&apos;s address is only ever shown to the provider doing the work.
          </p>
        </section>

        <footer style={S.footer}>
          <p style={{ margin: 0 }}>
            Count On Local is a product of EDW Ventures. Terms, Privacy and the Safety Center will be
            published before launch.
          </p>
        </footer>
      </div>
    </main>
  )
}

const S: Record<string, React.CSSProperties> = {
  page: {
    background: CREAM,
    color: INK,
    minHeight: '100vh',
    fontFamily: FONT_BODY,
    padding: '28px 20px 64px',
  },
  wrap: { maxWidth: 1060, margin: '0 auto' },

  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: 44,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, fontWeight: 900, fontSize: 21 },
  mark: {
    width: 38,
    height: 38,
    borderRadius: 11,
    background: INK,
    color: LIME,
    display: 'grid',
    placeItems: 'center',
    fontWeight: 900,
    fontSize: 22,
    flex: 'none',
  },
  pill: {
    borderRadius: 999,
    padding: '7px 13px',
    background: LIME,
    fontWeight: 800,
    fontSize: 13,
  },

  hero: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, .85fr)',
    gap: 48,
    alignItems: 'start',
  },
  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: '.12em',
    fontSize: 12,
    fontWeight: 900,
    margin: 0,
  },
  h1: {
    fontFamily: FONT_HEADING,
    fontSize: 'clamp(38px, 6vw, 60px)',
    lineHeight: 1.02,
    letterSpacing: '-.045em',
    margin: '14px 0 18px',
  },
  lede: { fontSize: 19, lineHeight: 1.55, color: MUTED, margin: 0, maxWidth: 520 },

  mock: {
    background: WHITE,
    border: '1px solid ' + BORDER,
    borderRadius: 26,
    padding: 20,
    boxShadow: SHADOW,
  },
  mockTag: {
    textTransform: 'uppercase',
    letterSpacing: '.12em',
    fontSize: 11,
    fontWeight: 900,
    color: MUTED,
    margin: '0 0 14px',
  },
  mockHead: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
  mockAvatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    background: INK,
    color: LIME,
    display: 'grid',
    placeItems: 'center',
    fontWeight: 900,
    flex: 'none',
  },
  mockCard: { border: '1px solid ' + BORDER, borderRadius: RADIUS_CARD, padding: 16 },
  mockMini: { fontSize: 11, fontWeight: 900, letterSpacing: '.1em', color: MUTED, margin: 0 },
  price: { fontSize: 30, fontWeight: 900, letterSpacing: '-.04em' },
  mockFoot: { color: MUTED, fontSize: 13, lineHeight: 1.55, margin: '14px 0 0' },

  section: { paddingTop: 64 },
  h2: {
    fontFamily: FONT_HEADING,
    fontSize: 'clamp(26px, 3.4vw, 34px)',
    letterSpacing: '-.035em',
    margin: '0 0 14px',
  },
  body: { color: MUTED, fontSize: 16.5, lineHeight: 1.6, margin: '0 0 18px', maxWidth: 720 },

  steps: { listStyle: 'none', display: 'grid', gap: 14, padding: 0, margin: 0 },
  step: { display: 'flex', gap: 14, alignItems: 'flex-start' },
  stepNum: {
    width: 34,
    height: 34,
    borderRadius: 11,
    background: LIME,
    display: 'grid',
    placeItems: 'center',
    fontWeight: 900,
    flex: 'none',
  },

  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
    gap: 16,
  },
  card: {
    background: WHITE,
    border: '1px solid ' + BORDER,
    borderRadius: RADIUS_CARD,
    padding: 18,
  },

  guardian: {
    background: WHITE,
    border: '1px solid ' + BORDER,
    borderRadius: 24,
    padding: 30,
    marginTop: 64,
  },

  footer: {
    marginTop: 64,
    paddingTop: 24,
    borderTop: '1px solid ' + BORDER,
    color: MUTED,
    fontSize: 14,
  },
}
