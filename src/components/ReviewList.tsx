import { ReportReview } from '@/components/ReviewControls'

/**
 * Published reviews on a public storefront.
 *
 * A server component: the storefront is server-rendered and unauthenticated,
 * and the reviews are already in hand from the page's own query. Only the
 * report control is interactive, so only that part ships JavaScript.
 *
 * ## What is deliberately not here
 *
 * No reviewer name, no initial, no avatar, no "verified customer" badge.
 * The reviewer is a household on the same street as a named minor, and a
 * first name plus a service area is a smaller haystack than it looks.
 * SAFETY_TRUST_POLICY 3 keeps the customer side of this relationship
 * private, and a review is not an exception to that.
 *
 * No sort control and no filter. Newest first, which is the order the page
 * query already returns and the only order that cannot be gamed into
 * hiding a bad month.
 */

export type PublicReview = {
  id: string
  rating: number
  body: string | null
  responseBody: string | null
  createdAt: string
}

const MAX_SHOWN = 5

export function ReviewList({ reviews }: { reviews: PublicReview[] }) {
  if (reviews.length === 0) return null

  const shown = reviews.slice(0, MAX_SHOWN)

  return (
    <section className="reviews">
      <h3 className="reviews__heading">What neighbours said</h3>

      <ul className="reviews__list">
        {shown.map((r) => (
          <li key={r.id} className="reviews__item">
            <p className="reviews__stars" aria-label={`${r.rating} out of 5`}>
              <span aria-hidden="true">{'★'.repeat(r.rating)}</span>
              <span aria-hidden="true" className="reviews__stars--off">
                {'★'.repeat(5 - r.rating)}
              </span>
            </p>
            <p className="reviews__body">{r.body}</p>

            {r.responseBody ? (
              <div className="reviews__response">
                <p className="reviews__response-label">Reply from the provider</p>
                <p className="reviews__body">{r.responseBody}</p>
              </div>
            ) : null}

            <ReportReview reviewId={r.id} />
          </li>
        ))}
      </ul>

      {reviews.length > MAX_SHOWN ? (
        <p className="small muted">
          Showing the {MAX_SHOWN} most recent of {reviews.length}.
        </p>
      ) : null}
    </section>
  )
}
