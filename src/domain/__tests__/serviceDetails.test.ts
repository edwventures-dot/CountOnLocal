import { describe, expect, it } from 'vitest'
import {
  checkServiceDetails,
  describeDog,
  dogWarning,
  requiresDogDetails,
} from '../serviceDetails'

const good = {
  dog: { name: 'Biscuit', size: 'medium', restraint: 'harness', biteHistory: 'none' },
}

describe('which services need it', () => {
  it('asks for a dog on dog services', () => {
    expect(requiresDogDetails('dog_walking')).toBe(true)
    expect(requiresDogDetails('dog_waste_pickup')).toBe(true)
  })

  it('does not ask on anything else', () => {
    expect(requiresDogDetails('bin_curb_service')).toBe(false)
    expect(requiresDogDetails(null)).toBe(false)
  })

  it('passes through with nothing to check on a non-dog service', () => {
    expect(checkServiceDetails({ catalogCode: 'bin_curb_service', input: undefined })).toEqual({
      ok: true,
      details: {},
    })
  })
})

describe('what it refuses', () => {
  it('refuses a dog service with nothing supplied', () => {
    expect(checkServiceDetails({ catalogCode: 'dog_walking', input: undefined }).ok).toBe(false)
  })

  it('refuses a missing bite history rather than defaulting it', () => {
    // A missing history recorded as "none" is worse than no record: it
    // tells the provider something reassuring nobody actually said.
    const { dog, ...rest } = good
    const withoutBite = { ...rest, dog: { ...dog, biteHistory: undefined } }
    const r = checkServiceDetails({ catalogCode: 'dog_walking', input: withoutBite })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe('dog.biteHistory')
  })

  it('refuses an invented bite value', () => {
    const r = checkServiceDetails({
      catalogCode: 'dog_walking',
      input: { dog: { ...good.dog, biteHistory: 'probably_fine' } },
    })
    expect(r.ok).toBe(false)
  })

  it('refuses a missing name, size or restraint', () => {
    for (const field of ['name', 'size', 'restraint'] as const) {
      const dog = { ...good.dog, [field]: '' }
      const r = checkServiceDetails({ catalogCode: 'dog_walking', input: { dog } })
      expect(r.ok, field).toBe(false)
    }
  })

  it('accepts a complete answer', () => {
    const r = checkServiceDetails({ catalogCode: 'dog_walking', input: good })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.details.dog?.name).toBe('Biscuit')
  })

  it('keeps notes but truncates them', () => {
    const r = checkServiceDetails({
      catalogCode: 'dog_walking',
      input: { dog: { ...good.dog, notes: 'x'.repeat(500) } },
    })
    if (r.ok) expect(r.details.dog?.notes).toHaveLength(300)
  })
})

describe('what the provider is told', () => {
  it('warns loudly when a dog has bitten', () => {
    const r = checkServiceDetails({
      catalogCode: 'dog_walking',
      input: { dog: { ...good.dog, biteHistory: 'yes' } },
    })
    if (r.ok) {
      const warning = dogWarning(r.details)
      expect(warning).toContain('bitten')
      // The provider can say no. Telling them without telling them that
      // would be worse than not telling them.
      expect(warning).toMatch(/refuse/i)
    }
  })

  it('treats an unknown history as a warning, not a neutral fact', () => {
    // A rescue dog's history is often genuinely unknown, and that is a
    // reason to be careful rather than a reason to say nothing.
    const r = checkServiceDetails({
      catalogCode: 'dog_walking',
      input: { dog: { ...good.dog, biteHistory: 'unsure' } },
    })
    if (r.ok) expect(dogWarning(r.details)).toMatch(/not known|unpredictable/i)
  })

  it('says nothing when there is nothing to warn about', () => {
    const r = checkServiceDetails({ catalogCode: 'dog_walking', input: good })
    if (r.ok) expect(dogWarning(r.details)).toBeNull()
  })

  it('describes the dog for the route screen', () => {
    const r = checkServiceDetails({ catalogCode: 'dog_walking', input: good })
    if (r.ok) expect(describeDog(r.details)).toBe('Biscuit, medium, walked on harness')
  })

  it('says nothing for a service with no dog', () => {
    expect(dogWarning({})).toBeNull()
    expect(describeDog(null)).toBeNull()
  })
})
