/**
 * The shared control set.
 *
 * Small on purpose. UX_UI_SPEC describes a dozen screens and they all need
 * the same four things -- a field, a button, a card, a message -- so these
 * exist to stop the fifth screen inventing a fifth shade of border.
 *
 * Server components by default: none of these hold state. A form that needs
 * interactivity marks itself 'use client' and uses them from there.
 */

import type { InputHTMLAttributes, ReactNode } from 'react'

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `card ${className}` : 'card'}>{children}</div>
}

export function Stack({ children }: { children: ReactNode }) {
  return <div className="stack">{children}</div>
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
  error?: string | undefined
}

/**
 * A labelled input.
 *
 * The label wraps the input rather than pointing at it with `htmlFor`, so
 * there is no id to forget and no way for the two to drift apart. An error
 * is announced rather than merely coloured -- a message only red-ness
 * conveys is a message a screen reader user does not get.
 */
export function Field({ label, hint, error, ...input }: FieldProps) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {hint ? <span className="field__hint">{hint}</span> : null}
      <input
        {...input}
        className="field__input"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${input.name}-error` : undefined}
      />
      {error ? (
        <span className="field__error" id={`${input.name}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'success'
  children: ReactNode
}) {
  return (
    <div
      className={`alert alert--${kind}`}
      // Errors interrupt; confirmations wait their turn.
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  )
}

/**
 * The page frame.
 *
 * `narrow` is for anything a person fills in one column -- sign in, sign
 * up, checkout. A 960px-wide password field is not a form, it is a runway.
 */
export function Shell({
  children,
  nav,
  narrow,
}: {
  children: ReactNode
  nav?: ReactNode
  narrow?: boolean
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__inner">
          <a className="topbar__brand" href="/">
            Count On Local
          </a>
          {nav}
        </div>
      </header>
      <main className={narrow ? 'shell__body shell__narrow' : 'shell__body'}>{children}</main>
    </div>
  )
}
