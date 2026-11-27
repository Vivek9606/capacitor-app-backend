// Creates a single-use, fixed-amount discount code in the betterhood Shopify store (Slouch Catcher rewards).
// Needs SHOPIFY_STORE_DOMAIN (e.g. betterhood.myshopify.com) and SHOPIFY_ADMIN_TOKEN (Admin API, write_discounts).
import { env } from '../env.js'

export const shopifyConfigured = () => !!(env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_ADMIN_TOKEN)

const MUTATION = `mutation create($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}`

export async function createDiscountCode(code: string, valueInr: number, minOrderInr: number) {
  const input = {
    title: `Slouch Catcher reward ${code}`,
    code,
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: { value: { discountAmount: { amount: String(valueInr), appliesOnEachItem: false } }, items: { all: true } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    ...(minOrderInr > 0 ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(minOrderInr) } } } : {}),
  }
  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN! },
    body: JSON.stringify({ query: MUTATION, variables: { input } }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json().catch(() => ({}))) as any
  const errs = [...(data.errors || []), ...(data.data?.discountCodeBasicCreate?.userErrors || [])]
  if (!res.ok || errs.length || !data.data?.discountCodeBasicCreate?.codeDiscountNode) {
    throw new Error(`Shopify ${res.status}: ${errs.map((e: { message: string }) => e.message).join('; ') || 'no discount created'}`)
  }
}
