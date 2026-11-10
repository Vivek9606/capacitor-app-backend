import { q } from './db.js'

/**
 * Suggest a physio for a patient from their assessment result.
 * Same rules as the app's demo mode (capacitor-app-physio/src/lib/match.ts):
 *   - specialty: nerve problems → Neuro, everything else → Orthopaedic / Sports
 *   - city: the patient's city appears in the physio's clinic / service area / locations
 *   - ties go to the physio with fewer patients
 * Returns undefined when no physio fits at all (the admin picks one by hand).
 */
export function wantedFocus(cat?: string): string[] {
  return cat === 'nerve' ? ['Neuro', 'Orthopaedic'] : ['Orthopaedic', 'Sports']
}

export async function suggestPhysio(cat: string | undefined, city: string | undefined): Promise<string | undefined> {
  const rows = await q<{ id: string; focus_areas: string[]; clinic: { address?: string; area?: string } | null; practice: { serviceArea?: string; locations?: { address: string }[] } | null; n: number }>(
    `select ph.id, ph.focus_areas, ph.clinic, ph.practice, (select count(*)::int from patients p where p.physio_id = ph.id) as n from physios ph`,
  )
  const want = wantedFocus(cat)
  const c = city?.trim().toLowerCase()
  let best: { id: string; score: number; n: number } | undefined
  for (const r of rows) {
    const focusHit = want.findIndex((w) => r.focus_areas.includes(w))
    const where = [r.clinic?.address, r.clinic?.area, r.practice?.serviceArea, ...(r.practice?.locations ?? []).map((l) => l.address)].join(' ').toLowerCase()
    const cityHit = !!c && where.includes(c)
    const score = (cityHit ? 3 : 0) + (focusHit === 0 ? 2 : focusHit > 0 ? 1 : 0)
    if (score === 0) continue
    if (!best || score > best.score || (score === best.score && r.n < best.n)) best = { id: r.id, score, n: r.n }
  }
  return best?.id
}
