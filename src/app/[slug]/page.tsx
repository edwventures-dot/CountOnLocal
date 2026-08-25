/**
 * The public storefront: countonlocal.com/{slug}
 *
 * PRD section 9. This is the page a neighbour lands on after scanning a
 * flyer, so it has to answer three questions fast: what is this, does it
 * cover my house, and what does it cost.
 *
 * Read through the ANON client even though this runs on the server. That is
 * deliberate: row level security, not this file, decides what is public. If
 * a future edit selects a column it should not, the database refuses rather
 * than the page leaking it. A minor's date of birth, home location and
 * private service-area geometry are all one careless join away otherwise.
 */

import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import type { Database } from '@/lib/supabase/types'

export const revalidate = 300

type Params = { params: Promise<{ slug: string }> }

function publicClient() {
  const env = publicEnv()
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function loadStorefront(slug: string) {
  const db = publicClient()

  const { data: business } = await db
    .from('businesses')
    .select('id, name, slug, tagline, about, public_area_label, published_at')
    .eq('slug', slug)
    .maybeSingle()

  if (!business) return null

  const { data: services } = await db
    .from('provider_services')
    .select('id, slug, public_name, description, price_cents, price_unit, billing_cycle_weeks, schedule_rule, capacity_rule')
    .eq('business_id', business.id)

  return { business, services: services ?? [] }
}

/** Integer cents to a display string. Formatting happens only here. */
function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function unitLabel(unit: string): string {
  return unit === 'week' ? '/week' : unit === 'month' ? '/month' : ' per visit'
}

/**
 * The billing cadence is shown separately from the price. PRD section 12:
 * a $3/week service billed every 4 weeks must say both, so nobody is
 * surprised by a $12 charge they thought was $3.
 */
function cadenceLine(priceCents: number, unit: string, cycleWeeks: number): string | null {
  if (unit !== 'week') return null
  const perCycle = priceCents * cycleWeeks
  return `Billed ${formatMoney(perCycle)} every ${cycleWeeks} weeks, plus platform fee`
}

function scheduleLine(rule: Record<string, unknown>): string | null {
  const day = typeof rule['weekday'] === 'string' ? rule['weekday'] : null
  const window = typeof rule['window'] === 'string' ? rule['window'] : null
  if (!day && !window) return null
  const dayText = day ? day.charAt(0).toUpperCase() + day.slice(1) + 's' : null
  return [dayText, window].filter(Boolean).join(' · ')
}

export async function generateMetadata({ params }: Params) {
  const { slug } = await params
  const data = await loadStorefront(slug)
  if (!data) return { title: 'Not found' }
  return {
    title: `${data.business.name} · Count On Local`,
    description: data.business.tagline ?? 'A neighbourhood service business on Count On Local.',
  }
}

export default async function Storefront({ params }: Params) {
  const { slug } = await params
  const data = await loadStorefront(slug)

  // A draft, paused or suspended business is filtered out by row level
  // security, so it reaches here as "not found" -- which is also the right
  // answer publicly. A paused page should not announce that it is paused.
  if (!data) notFound()

  const { business, services } = data

  return (
    <main style={S.page}>
      <div style={S.wrap}>
        <header style={S.head}>
          <div style={S.avatar} aria-hidden>
            {business.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p style={S.eyebrow}>Neighbourhood service business</p>
            <h1 style={S.title}>{business.name}</h1>
            {business.tagline ? <p style={S.tagline}>{business.tagline}</p> : null}
            <div style={S.badges}>
              {/*
                Publishing requires a cleared guardian, and revocation pauses
                the business -- so a page being visible at all is itself the
                evidence for this badge. SAFETY_TRUST_POLICY section 19
                allows only claims that are factually earned.
              */}
              <span style={S.badgeGreen}>Guardian connected</span>
              <span style={S.badge}>Payments handled securely</span>
              {business.public_area_label ? (
                <span style={S.badge}>Serving {business.public_area_label}</span>
              ) : null}
            </div>
          </div>
        </header>

        {services.length === 0 ? (
          <p style={S.muted}>This business has no services listed right now.</p>
        ) : (
          services.map((s) => {
            const cadence = cadenceLine(s.price_cents, s.price_unit, s.billing_cycle_weeks)
            const schedule = scheduleLine(s.schedule_rule ?? {})
            return (
              <section key={s.id} style={S.card}>
                <div style={S.cardTop}>
                  <div>
                    {schedule ? <p style={S.mini}>{schedule.toUpperCase()}</p> : null}
                    <h2 style={S.serviceName}>{s.public_name}</h2>
                    <p style={S.muted}>{s.description}</p>
                  </div>
                  <div style={S.priceBlock}>
                    <span style={S.price}>{formatMoney(s.price_cents)}</span>
                    <span style={S.priceUnit}>{unitLabel(s.price_unit)}</span>
                  </div>
                </div>

                {cadence ? <p style={S.cadence}>{cadence}</p> : null}

                <form action={`/${business.slug}/${s.slug}/check`} method="get" style={S.eligRow}>
                  <input
                    name="address"
                    placeholder="Enter your address"
                    aria-label="Service address"
                    style={S.input}
                  />
                  <button type="submit" style={S.cta}>
                    Check my address
                  </button>
                </form>
                <p style={S.fineprint}>
                  Recurring service. Pause or cancel any time from your account.
                </p>
              </section>
            )
          })
        )}

        {business.about ? (
          <section style={S.about}>
            <h2 style={S.aboutTitle}>About this service</h2>
            <p style={S.muted}>{business.about}</p>
          </section>
        ) : null}

        <footer style={S.footer}>
          <span style={S.wordmark}>Count On Local</span>
          <span style={S.muted}>Start a business where you live.</span>
        </footer>
      </div>
    </main>
  )
}

// Brand tokens from assets/brand-tokens.css, inlined so the page renders
// standalone. A shared stylesheet replaces this when the design system lands.
const INK = '#14263A'
const LIME = '#C7F34A'
const CREAM = '#F6F3EA'
const MUTED = '#607080'
const BORDER = '#DDE3E6'
const GREEN = '#16875B'

const S: Record<string, React.CSSProperties> = {
  page: {
    background: CREAM,
    color: INK,
    minHeight: '100vh',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    padding: '40px 20px 80px',
  },
  wrap: { maxWidth: 760, margin: '0 auto' },
  head: { display: 'flex', gap: 18, alignItems: 'flex-start', marginBottom: 28 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 20,
    background: INK,
    color: LIME,
    display: 'grid',
    placeItems: 'center',
    fontWeight: 900,
    fontSize: 24,
    flex: 'none',
  },
  eyebrow: { textTransform: 'uppercase', letterSpacing: '.12em', fontSize: 12, fontWeight: 900, margin: 0 },
  title: { fontSize: 40, letterSpacing: '-.03em', margin: '6px 0' },
  tagline: { fontSize: 18, color: MUTED, margin: '6px 0' },
  badges: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 },
  badge: { borderRadius: 999, padding: '6px 10px', background: '#eef2f3', fontSize: 12, fontWeight: 800 },
  badgeGreen: { borderRadius: 999, padding: '6px 10px', background: '#e7f6ef', color: GREEN, fontSize: 12, fontWeight: 800 },
  card: {
    background: '#fff',
    border: `1px solid ${BORDER}`,
    borderRadius: 18,
    padding: 22,
    marginBottom: 18,
    boxShadow: '0 12px 32px rgba(20,38,58,.08)',
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start' },
  mini: { fontSize: 12, color: MUTED, margin: 0, letterSpacing: '.08em', fontWeight: 800 },
  serviceName: { fontSize: 24, margin: '6px 0' },
  muted: { color: MUTED, lineHeight: 1.55, margin: '6px 0' },
  priceBlock: { textAlign: 'right', flex: 'none' },
  price: { fontSize: 32, fontWeight: 900, letterSpacing: '-.03em' },
  priceUnit: { fontSize: 14, color: MUTED },
  cadence: { fontSize: 13, color: MUTED, margin: '10px 0 0' },
  eligRow: { display: 'flex', gap: 10, marginTop: 18 },
  input: { flex: 1, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14, fontSize: 15 },
  cta: { border: 0, borderRadius: 12, padding: '14px 18px', fontWeight: 850, background: LIME, color: INK, cursor: 'pointer' },
  fineprint: { fontSize: 12, color: MUTED, margin: '12px 0 0' },
  about: { marginTop: 28 },
  aboutTitle: { fontSize: 22, letterSpacing: '-.02em', margin: '0 0 6px' },
  footer: { marginTop: 48, paddingTop: 20, borderTop: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 13 },
  wordmark: { fontWeight: 900 },
}
