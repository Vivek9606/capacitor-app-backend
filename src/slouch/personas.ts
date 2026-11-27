// The 20 posture animals ("Posture Tool" sheet, Animal Posture Archetypes v2), moved here from the old
// slouch-catcher service. The AI rates four zones from 1 (poor) to 9 (strong): N neck, S shoulder, B back, K knee.
// `when` is the sheet's routing condition as written. `zones` is the animal's reference profile.
// `products` are ids from products.ts, best first.

export type Zones = { N: number; S: number; B: number; K: number }
export interface Persona {
  id: string
  name: string
  emoji: string
  tier: 'good' | 'average' | 'bad'
  zones: Zones
  when: (z: Zones) => boolean
  pattern: string
  remark: string
  products: string[]
}

export const PERSONAS: Persona[] = [
  { id: "horse", name: "The Horse", emoji: "🐎", tier: "good", zones: {N: 9,S: 8,B: 9,K: 8},
    when: ({ N, S, B, K }: Zones) => N >= 9 && B >= 9 && S >= 8 && K >= 8,
    pattern: "Near-perfect posture",
    remark: "Majestic and arrow-straight. Your only crime? Shoulders that get tired of carrying everyone else's standards.",
    products: ["roll-on","knee-sleeve"] },
  { id: "cheetah", name: "The Cheetah", emoji: "🐆", tier: "good", zones: {N: 8,S: 9,B: 9,K: 7},
    when: ({ N, S, B, K }: Zones) => B == 9 && S == 9 && N == 8 && K == 7,
    pattern: "Strong spine, tired knees",
    remark: "Noble. Upright. Carrying the weight of the world on a back that was built for it. Just don't ask the knees for a second opinion.",
    products: ["knee-sleeve","arch-insoles"] },
  { id: "lion", name: "The Lion", emoji: "🦁", tier: "good", zones: {N: 8,S: 9,B: 8,K: 6},
    when: ({ N, S, B, K }: Zones) => S == 9 && N == 8 && B == 8 && K == 6,
    pattern: "Regal above, wobbly below",
    remark: "Walks into every room like royalty. Knees, however, have filed a formal complaint with HR.",
    products: ["knee-brace","arch-insoles"] },
  { id: "wolf", name: "The Wolf", emoji: "🐺", tier: "good", zones: {N: 7,S: 8,B: 9,K: 8},
    when: ({ N, S, B, K }: Zones) => B == 9 && K == 8 && S == 8 && N == 7,
    pattern: "Spine of steel, head tilts",
    remark: "Perfect posture, except for the neck creeping forward like it's reading a ransom note pinned to the forest floor.",
    products: ["roll-on","cervical-pillow"] },
  { id: "meerkat", name: "The Meerkat", emoji: "🐿️", tier: "average", zones: {N: 8,S: 6,B: 7,K: 6},
    when: ({ N, S, B, K }: Zones) => N == 8 && B == 7 && S == 6 && K == 6,
    pattern: "Head high, shoulders caved",
    remark: "Majestic neck, heroic spine, but the shoulders have the energy of a wet napkin. Classic 'looks great from behind' energy.",
    products: ["roll-on","knee-sleeve"] },
  { id: "kangaroo", name: "The Kangaroo", emoji: "🦘", tier: "average", zones: {N: 8,S: 6,B: 5,K: 8},
    when: ({ N, S, B, K }: Zones) => N == 8 && K == 8 && S == 6 && B == 5,
    pattern: "Balanced on confidence alone",
    remark: "Stands on one leg and still has better balance than you. The back though? Arched like it's perpetually trying to look cool at a party.",
    products: ["back-belt","chair-lumbar"] },
  { id: "giraffe", name: "The Giraffe", emoji: "🦒", tier: "average", zones: {N: 3,S: 7,B: 8,K: 7},
    when: ({ N, S, B, K }: Zones) => N <= 3 && B >= 8 && S >= 7 && K >= 7,
    pattern: "Perfect body, tragic neck",
    remark: "A giraffe at a desk, neck folded like a pretzel to read a book on the floor, because its posture forgot that the screen goes UP there.",
    products: ["roll-on","cervical-pillow"] },
  { id: "bulldog", name: "The Bulldog", emoji: "🐶", tier: "average", zones: {N: 8,S: 7,B: 8,K: 3},
    when: ({ N, S, B, K }: Zones) => N == 8 && B == 8 && S <= 5 && K <= 5,
    pattern: "Alert head, forgotten limbs",
    remark: "Hyper-vigilant neck and spine, but the limbs are just along for the ride, dangling like forgotten browser tabs.",
    products: ["knee-brace","arch-insoles"] },
  { id: "swan", name: "The Swan", emoji: "🦢", tier: "average", zones: {N: 9,S: 4,B: 7,K: 6},
    when: ({ N, S, B, K }: Zones) => N == 9 && S <= 4 && B >= 7 && K == 6,
    pattern: "Graceful neck, collapsed shoulders",
    remark: "The neck? Glorious. The shoulders? Collapsed inward like a soufflé no one checked on. Beautiful from the chin up, a quiet disaster below.",
    products: ["roll-on","magnesium-lotion"] },
  { id: "gorilla", name: "The Gorilla", emoji: "🦍", tier: "average", zones: {N: 5,S: 9,B: 5,K: 7},
    when: ({ N, S, B, K }: Zones) => S == 9 && K == 7 && N <= 5 && B <= 5,
    pattern: "Powerful shoulders, hunched elsewhere",
    remark: "Shoulder strength that could move mountains. Neck and back, however, are still knuckle-walking through the Pleistocene.",
    products: ["chair-lumbar","roll-on"] },
  { id: "camel", name: "The Camel", emoji: "🐫", tier: "average", zones: {N: 7,S: 6,B: 3,K: 8},
    when: ({ N, S, B, K }: Zones) => B <= 3 && K == 8 && N == 7 && S == 6,
    pattern: "Lower back completely sacrificed",
    remark: "The back has a hump. Not metaphorically. Structurally. Everything else is coping, but the lumbar region clocked out years ago.",
    products: ["back-belt","chair-lumbar"] },
  { id: "ostrich", name: "The Ostrich", emoji: "🪶", tier: "average", zones: {N: 4,S: 6,B: 6,K: 8},
    when: ({ N, S, B, K }: Zones) => N <= 4 && K == 8 && S == 6 && B == 6,
    pattern: "Curled neck, solid base",
    remark: "Rolled its neck into a defensive ball and forgot to unroll it. The knees are thriving. The neck is still in crisis mode from 2019.",
    products: ["roll-on","contour-pillow"] },
  { id: "vulture", name: "The Vulture", emoji: "🦅", tier: "bad", zones: {N: 2,S: 7,B: 4,K: 5},
    when: ({ N, S, B, K }: Zones) => N <= 2 && S >= 7 && B <= 4 && K >= 5,
    pattern: "Neck in freefall, shoulders surviving",
    remark: "Perched. Waiting. Neck dangling forward like it's watching something die slowly. Which, anatomically, it is. The shoulders are horrified observers.",
    products: ["roll-on","chair-lumbar"] },
  { id: "hyena", name: "The Hyena", emoji: "🐾", tier: "bad", zones: {N: 3,S: 5,B: 2,K: 6},
    when: ({ N, S, B, K }: Zones) => B <= 2 && N <= 3 && S >= 5 && K >= 6,
    pattern: "Spine in crisis, everything tilted",
    remark: "Laughing its way to a physio clinic. The spine leans at an angle that suggests it gave up on vertical a long time ago.",
    products: ["chair-coccyx","back-belt"] },
  { id: "penguin", name: "The Penguin", emoji: "🐧", tier: "bad", zones: {N: 4,S: 3,B: 6,K: 1},
    when: ({ N, S, B, K }: Zones) => K <= 1 && B >= 6 && N <= 4 && S <= 3,
    pattern: "Waddling on broken knees",
    remark: "Upright torso, respectable back, but the knees are waddling through life like it's permanently icy. One strong gust from a full collapse.",
    products: ["knee-brace","arch-insoles"] },
  { id: "turtle", name: "The Turtle", emoji: "🐢", tier: "bad", zones: {N: 1,S: 6,B: 4,K: 4},
    when: ({ N, S, B, K }: Zones) => N <= 1 && S >= 6 && B <= 4 && K <= 4,
    pattern: "Head fully withdrawn into shell",
    remark: "A turtle at a standing desk, head pulled so far back into the shell it's technically working from home. From inside its own body.",
    products: ["roll-on","cervical-pillow"] },
  { id: "bear", name: "The Bear", emoji: "🐻", tier: "bad", zones: {N: 4,S: 4,B: 3,K: 5},
    when: ({ N, S, B, K }: Zones) => B <= 3 && N <= 4 && S <= 4 && K == 5,
    pattern: "Rounded in every dimension",
    remark: "Hibernated through every physio appointment. Everything's rounded: neck, back, ambitions. Comfortable, warm, and anatomically concerning.",
    products: ["chair-combo","magnesium-lotion"] },
  { id: "sloth", name: "The Sloth", emoji: "🦥", tier: "bad", zones: {N: 3,S: 4,B: 2,K: 4},
    when: ({ N, S, B, K }: Zones) => B <= 2 && N <= 3 && S <= 4 && K <= 4,
    pattern: "Hanging by a thread (literally)",
    remark: "Inverted. Suspended. Defying gravity and spinal health simultaneously. If posture were a schedule, the sloth would ask for an extension.",
    products: ["chair-combo","back-belt"] },
  { id: "raccoon", name: "The Raccoon", emoji: "🦝", tier: "bad", zones: {N: 3,S: 3,B: 3,K: 4},
    when: ({ N, S, B, K }: Zones) => K == 4 && N <= 3 && S <= 3 && B <= 3,
    pattern: "Uniformly collapsed, consistently committed",
    remark: "Dug through every trash can for good posture and found nothing. Hunched over the bin of life with quiet, relentless dedication.",
    products: ["roll-on","chair-combo"] },
  { id: "shrimp", name: "The Shrimp", emoji: "🦐", tier: "bad", zones: {N: 1,S: 2,B: 1,K: 2},
    when: ({ N, S, B, K }: Zones) => N <= 1 && B <= 1 && S <= 2 && K <= 2,
    pattern: "Peak slouch. Iconic. Terminal.",
    remark: "Curved into a perfect C. Not a posture. A lifestyle choice. The shrimp doesn't sit at a desk; the shrimp IS the desk.",
    products: ["chair-combo","roll-on"] },
]

export const ZONES: [keyof Zones, string][] = [['N', 'Neck'], ['S', 'Shoulder'], ['B', 'Back'], ['K', 'Knee']]
const clampZone = (v: unknown) => Math.max(1, Math.min(9, Math.round(Number(v)) || 1)) // the sheet has no 10s
const distance = (a: Zones, b: Zones) => ZONES.reduce((sum, [k]) => sum + (a[k] - b[k]) ** 2, 0)
const nearest = (z: Zones, list: Persona[]) => list.reduce((best, p) => (distance(z, p.zones) < distance(z, best.zones) ? p : best))

/** The sheet's conditions leave gaps and a few overlap, so: the closest matching animal, else the closest of all. */
export function routePersona(zones: Partial<Record<keyof Zones, unknown>>) {
  const z = Object.fromEntries(ZONES.map(([k]) => [k, clampZone(zones[k])])) as Zones
  const matches = PERSONAS.filter((p) => p.when(z))
  return { persona: nearest(z, matches.length ? matches : PERSONAS), zones: z }
}

/** Overall score out of 10, one decimal: the four zones added up, out of 36. */
export const zoneScore = (z: Zones) => Math.round((ZONES.reduce((s, [k]) => s + z[k], 0) / 36) * 100) / 10
export const personaById = Object.fromEntries(PERSONAS.map((p) => [p.id, p])) as Record<string, Persona>
