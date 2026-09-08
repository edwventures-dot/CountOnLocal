import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every class a component names must exist in the stylesheet.
 *
 * This is here because of a real bug that nothing else could have caught.
 * The Subscribe form's attestation used `className="check"`, a class that
 * has never existed -- so six points somebody is meant to read one at a
 * time rendered as a single running paragraph with checkboxes scattered
 * through it. Typecheck passed, every test passed, the build was clean, and
 * it surfaced only because a person loaded the page and said the words were
 * on top of each other.
 *
 * A className is a string. Nothing in TypeScript checks it against
 * anything, which makes it one of the few places in this codebase where a
 * typo is completely silent -- and the damage landed on exactly the screen
 * where somebody is agreeing to things.
 *
 * The check is deliberately crude: substring, not a parser. A false pass is
 * possible (a class that happens to be a substring of another); a false
 * failure is not, which is the direction that matters for a test other
 * people will have to trust.
 */

const CSS = readFileSync('src/app/globals.css', 'utf8')

/** Utility names that are composed rather than declared whole. */
const IGNORED = new Set(['sr-only'])

function componentFiles(): string[] {
  const dir = 'src/components'
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f))
}

describe('class names resolve to real styles', () => {
  for (const file of componentFiles()) {
    const name = file.split(/[\/]/).pop()
    it(`${name} names no class that does not exist`, () => {
      const source = readFileSync(file, 'utf8')

      // Only literal className="..." attributes. Template literals and
      // conditionals are skipped rather than half-parsed.
      const classes = [...source.matchAll(/className="([a-zA-Z0-9_ -]+)"/g)]
        .flatMap((m) => (m[1] ?? '').split(/\s+/))
        .filter((c) => c.length > 0 && !IGNORED.has(c))

      const missing = [...new Set(classes)].filter((c) => !CSS.includes(`.${c}`))
      expect(missing, `${file}: not in globals.css`).toEqual([])
    })
  }

  it('catches an invented class, which is the whole point', () => {
    // A positive control. Without it, a regex that matched nothing would
    // look exactly like a codebase with no mistakes in it.
    const invented = [...'<div className="definitely-not-a-real-class" />'.matchAll(
      /className="([a-zA-Z0-9_ -]+)"/g,
    )].flatMap((m) => (m[1] ?? '').split(/\s+/))
    expect(invented).toContain('definitely-not-a-real-class')
    expect(CSS.includes('.definitely-not-a-real-class')).toBe(false)
  })
})
