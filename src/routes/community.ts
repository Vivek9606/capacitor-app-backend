import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { checkPost } from '../communityCheck.js'
import { one, q, tx } from '../db.js'
import { badRequest, HttpError, newId, notFound } from '../util.js'

/**
 * Community: a Slack-style forum for physios inside the app.
 * Everyone talks in "General"; admins open more channels. Posts can have replies (one level, like Slack threads).
 * Every physio post passes the safety check (communityCheck.ts) before it is saved. Admins post as "Betterhood team".
 */

const PAGE = 40
const Id = z.string().min(3).max(40)
const Body = z.string().trim().min(2, 'Write a little more').max(4000, 'Keep it under 4,000 characters')

type Row = Record<string, any>

export interface Author {
  id: string
  name: string
  photo?: string
  qualification?: string
  verified?: boolean
  team?: boolean
}

const TEAM: Author = { id: 'team', name: 'Betterhood team', team: true }
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined)

function postOut(r: Row, opts: { admin?: boolean } = {}) {
  const removed = r.status === 'removed'
  return {
    id: r.id,
    channelId: r.channel_id,
    parentId: r.parent_id ?? undefined,
    authorId: r.author_physio_id ?? 'team',
    // Physios never see the text of a removed post; admins do (to review it).
    body: removed && !opts.admin ? '' : r.body,
    removed,
    removedReason: opts.admin ? (r.removed_reason ?? undefined) : undefined,
    createdAt: iso(r.created_at)!,
    editedAt: iso(r.edited_at),
    lastReplyAt: iso(r.last_reply_at),
    replyCount: r.reply_count ?? 0,
    helpful: r.n_helpful ?? 0,
    mine: r.mine ?? false,
    reacted: r.reacted ?? false,
    reports: opts.admin ? (r.n_reports ?? 0) : undefined,
  }
}

/** The people behind a list of posts, once each (photos are data URLs, so they aren't repeated per post). */
async function authorsFor(rows: Row[]): Promise<Record<string, Author>> {
  const ids = [...new Set(rows.map((r) => r.author_physio_id).filter(Boolean))]
  const out: Record<string, Author> = { team: TEAM }
  if (!ids.length) return out
  const ph = await q('select id, name, photo, qualification, verification from physios where id = any($1)', [ids])
  for (const p of ph) out[p.id] = { id: p.id, name: p.name, photo: p.photo ?? undefined, qualification: p.qualification ?? undefined, verified: p.verification === 'verified' }
  return out
}

/** Shared select for posts. $1 = viewer physio id (or null for admin). */
const POST_SELECT = `
  select p.*,
         (select count(*)::int from community_reactions r where r.post_id = p.id) as n_helpful,
         exists (select 1 from community_reactions r where r.post_id = p.id and r.physio_id = $1) as reacted,
         (p.author_physio_id is not null and p.author_physio_id = $1) as mine,
         (select count(*)::int from community_reports rp where rp.post_id = p.id and rp.resolved_at is null) as n_reports
    from community_posts p`

async function channelOr404(id: string, opts: { includeArchived?: boolean } = {}) {
  const c = await one('select * from community_channels where id = $1', [id])
  if (!c || (c.archived_at && !opts.includeArchived)) throw notFound('Channel not found')
  return c
}

async function feed(channelId: string, viewer: string | null, before: string | undefined, admin: boolean) {
  const rows = await q(
    `${POST_SELECT}
      where p.channel_id = $2 and p.parent_id is null
        and ($3::timestamptz is null or p.created_at < $3)
        and ($4 or p.status = 'visible' or p.reply_count > 0)
      order by p.created_at desc
      limit ${PAGE + 1}`,
    [viewer, channelId, before ?? null, admin],
  )
  const more = rows.length > PAGE
  const page = rows.slice(0, PAGE).reverse() // oldest first, newest at the bottom (chat order)
  return { posts: page.map((r) => postOut(r, { admin })), authors: await authorsFor(page), more }
}

async function thread(postId: string, viewer: string | null, admin: boolean) {
  const root = await one(`${POST_SELECT} where p.id = $2 and p.parent_id is null`, [viewer, postId])
  if (!root) throw notFound('Post not found')
  const replies = await q(`${POST_SELECT} where p.parent_id = $2 and ($3 or p.status = 'visible') order by p.created_at`, [viewer, postId, admin])
  const channel = await one('select id, name, archived_at from community_channels where id = $1', [root.channel_id])
  if (!channel || (channel.archived_at && !admin)) throw notFound('Post not found')
  return { channel: { id: channel.id, name: channel.name }, post: postOut(root, { admin }), replies: replies.map((r) => postOut(r, { admin })), authors: await authorsFor([root, ...replies]) }
}

/** Saves a post or reply and bumps the counters it affects. */
async function insertPost(channelId: string, parentId: string | undefined, body: string, author: { physio?: string; admin?: string }) {
  return tx(async (c) => {
    if (parentId) {
      const parent = (await c.query('select id, channel_id, parent_id, status from community_posts where id = $1 for update', [parentId])).rows[0]
      if (!parent || parent.channel_id !== channelId) throw notFound('Post not found')
      if (parent.parent_id) throw badRequest('Reply to the original post')
      if (parent.status === 'removed') throw badRequest('This post was removed')
    }
    const id = newId('cp')
    const r = (
      await c.query(
        `insert into community_posts (id, channel_id, parent_id, author_physio_id, author_admin, body)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [id, channelId, parentId ?? null, author.physio ?? null, author.admin ?? null, body],
      )
    ).rows[0]
    if (parentId) await c.query('update community_posts set reply_count = reply_count + 1, last_reply_at = now() where id = $1', [parentId])
    await c.query('update community_channels set last_post_at = now() where id = $1', [channelId])
    return r
  })
}

async function recountReplies(parentId: string | null | undefined) {
  if (!parentId) return
  await q(`update community_posts set reply_count = (select count(*)::int from community_posts r where r.parent_id = $1 and r.status = 'visible') where id = $1`, [parentId])
}

/** The safety check couldn't run: the post is live, and admins get it in their review list. */
async function fileUnchecked(postId: string) {
  await q(`insert into community_reports (id, post_id, physio_id, reason) values ($1, $2, null, $3)`, [newId('cr'), postId, 'Safety check was unavailable when this was posted. Please review.']).catch(() => {})
}

export async function communityRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------------------------------------
  // Physios

  /** Channels with unread counts (posts and replies by others since the physio last opened the channel). */
  app.get('/community/channels', async (req) => {
    const me = requireRole(req, 'physio')
    const rows = await q(
      `select c.*,
              (select count(*)::int from community_posts p where p.channel_id = c.id and p.status = 'visible') as n_posts,
              (select count(*)::int from community_posts p
                 where p.channel_id = c.id and p.status = 'visible'
                   and (p.author_physio_id is null or p.author_physio_id <> $1)
                   and p.created_at > coalesce(rd.last_read_at, '-infinity')) as n_unread
         from community_channels c
         left join community_reads rd on rd.channel_id = c.id and rd.physio_id = $1
        where c.archived_at is null
        order by c.is_default desc, c.pinned desc, coalesce(c.last_post_at, c.created_at) desc`,
      [me],
    )
    return {
      channels: rows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        isDefault: c.is_default,
        pinned: c.pinned,
        lastPostAt: iso(c.last_post_at),
        posts: c.n_posts,
        unread: c.n_unread,
      })),
    }
  })

  /** Latest posts in a channel (chat order). Opening the first page marks the channel as read. */
  app.get('/community/channels/:id/posts', async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query)
    const c = await channelOr404(id)
    const out = await feed(c.id, me, before, false)
    if (!before)
      await q(
        `insert into community_reads (channel_id, physio_id, last_read_at) values ($1, $2, now())
         on conflict (channel_id, physio_id) do update set last_read_at = now()`,
        [c.id, me],
      )
    return { channel: { id: c.id, name: c.name, description: c.description, isDefault: c.is_default }, ...out }
  })

  app.get('/community/posts/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    return thread(id, me, false)
  })

  app.post('/community/channels/:id/posts', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = z.object({ body: Body, parentId: Id.optional() }).parse(req.body)
    const c = await channelOr404(id)
    const check = await checkPost(b.body)
    if (!check.ok) {
      await q('insert into community_blocked (id, physio_id, channel_id, reason, engine) values ($1, $2, $3, $4, $5)', [newId('cb'), me, c.id, check.category, check.engine]).catch(() => {})
      throw new HttpError(422, check.message, 'post_blocked')
    }
    const r = await insertPost(c.id, b.parentId, b.body, { physio: me })
    if (check.unchecked) await fileUnchecked(r.id)
    return { post: postOut({ ...r, mine: true }), authors: await authorsFor([r]) }
  })

  app.patch('/community/posts/:id', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = z.object({ body: Body }).parse(req.body)
    const p = await one('select * from community_posts where id = $1', [id])
    if (!p || p.author_physio_id !== me || p.status !== 'visible') throw notFound('Post not found')
    const check = await checkPost(b.body)
    if (!check.ok) {
      await q('insert into community_blocked (id, physio_id, channel_id, reason, engine) values ($1, $2, $3, $4, $5)', [newId('cb'), me, p.channel_id, check.category, check.engine]).catch(() => {})
      throw new HttpError(422, check.message, 'post_blocked')
    }
    const r = await one('update community_posts set body = $2, edited_at = now() where id = $1 returning *', [id, b.body])
    if (check.unchecked) await fileUnchecked(id)
    return { post: postOut({ ...r, mine: true }) }
  })

  /** Authors can take their own post down. */
  app.delete('/community/posts/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const p = await one('select * from community_posts where id = $1', [id])
    if (!p || p.author_physio_id !== me) throw notFound('Post not found')
    await q(`update community_posts set status = 'removed', removed_reason = 'Deleted by the author', removed_at = now() where id = $1`, [id])
    await recountReplies(p.parent_id)
    return { ok: true }
  })

  /** "Helpful": toggles the viewer's reaction. */
  app.post('/community/posts/:id/helpful', async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const p = await one(`select id from community_posts where id = $1 and status = 'visible'`, [id])
    if (!p) throw notFound('Post not found')
    const del = await q('delete from community_reactions where post_id = $1 and physio_id = $2 returning post_id', [id, me])
    if (!del.length) await q('insert into community_reactions (post_id, physio_id) values ($1, $2) on conflict do nothing', [id, me])
    const n = await one<{ n: number }>('select count(*)::int as n from community_reactions where post_id = $1', [id])
    return { reacted: !del.length, helpful: n?.n ?? 0 }
  })

  app.post('/community/posts/:id/report', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const me = requireRole(req, 'physio')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = z.object({ reason: z.string().trim().max(500).default('') }).parse(req.body ?? {})
    const p = await one(`select id from community_posts where id = $1 and status = 'visible'`, [id])
    if (!p) throw notFound('Post not found')
    await q(
      `insert into community_reports (id, post_id, physio_id, reason) values ($1, $2, $3, $4)
       on conflict (post_id, physio_id) do update set reason = excluded.reason, resolved_at = null, resolution = null`,
      [newId('cr'), id, me, b.reason],
    )
    return { ok: true }
  })

  // ---------------------------------------------------------------------------------------------------------
  // Admin (web dashboard)

  app.get('/admin/community', async (req) => {
    requireRole(req, 'admin')
    const [channels, reports, blocked, stats] = await Promise.all([
      q(
        `select c.*,
                (select count(*)::int from community_posts p where p.channel_id = c.id and p.status = 'visible') as n_posts,
                (select count(distinct p.author_physio_id)::int from community_posts p where p.channel_id = c.id) as n_people
           from community_channels c
          order by c.archived_at is not null, c.is_default desc, c.pinned desc, coalesce(c.last_post_at, c.created_at) desc`,
      ),
      q(
        `select rp.id, rp.reason, rp.created_at, rp.post_id, ph.name as reporter,
                p.body, p.channel_id, p.parent_id, p.author_physio_id, p.status, p.created_at as post_created_at, a.name as author_name, c.name as channel_name
           from community_reports rp
           join community_posts p on p.id = rp.post_id
           join community_channels c on c.id = p.channel_id
           left join physios ph on ph.id = rp.physio_id
           left join physios a on a.id = p.author_physio_id
          where rp.resolved_at is null
          order by rp.created_at desc`,
      ),
      q(`select reason, count(*)::int as n from community_blocked where created_at > now() - interval '30 days' group by reason order by n desc`),
      one(
        `select (select count(*)::int from community_posts where created_at > now() - interval '7 days' and author_physio_id is not null) as posts_7d,
                (select count(distinct author_physio_id)::int from community_posts where created_at > now() - interval '7 days') as posters_7d,
                (select count(distinct physio_id)::int from community_reads where last_read_at > now() - interval '7 days') as readers_7d,
                (select count(*)::int from physios) as physios`,
      ),
    ])
    return {
      stats,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        isDefault: c.is_default,
        pinned: c.pinned,
        archived: Boolean(c.archived_at),
        createdAt: iso(c.created_at),
        lastPostAt: iso(c.last_post_at),
        posts: c.n_posts,
        people: c.n_people,
      })),
      reports: reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        reporter: r.reporter ?? 'Safety check',
        createdAt: iso(r.created_at),
        post: { id: r.post_id, body: r.body, channelId: r.channel_id, channelName: r.channel_name, parentId: r.parent_id ?? undefined, author: r.author_name ?? 'Betterhood team', removed: r.status === 'removed', createdAt: iso(r.post_created_at) },
      })),
      blocked30d: blocked,
    }
  })

  const ChannelBody = z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    pinned: z.boolean().default(false),
  })

  app.post('/admin/community/channels', async (req) => {
    const admin = requireRole(req, 'admin')
    const b = ChannelBody.parse(req.body)
    const dup = await one('select id from community_channels where lower(name) = lower($1) and archived_at is null', [b.name])
    if (dup) throw badRequest('A channel with this name already exists')
    const r = await one('insert into community_channels (id, name, description, pinned, created_by) values ($1, $2, $3, $4, $5) returning id', [newId('cc'), b.name, b.description, b.pinned, admin])
    return { id: r!.id }
  })

  app.patch('/admin/community/channels/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = ChannelBody.partial().extend({ archived: z.boolean().optional() }).parse(req.body)
    const c = await channelOr404(id, { includeArchived: true })
    if (b.archived && c.is_default) throw badRequest('General can’t be archived')
    await q(
      `update community_channels set
         name = coalesce($2, name), description = coalesce($3, description), pinned = coalesce($4, pinned),
         archived_at = case when $5::boolean is null then archived_at when $5 then coalesce(archived_at, now()) else null end
       where id = $1`,
      [id, b.name ?? null, b.description ?? null, b.pinned ?? null, b.archived ?? null],
    )
    return { ok: true }
  })

  app.get('/admin/community/channels/:id/posts', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query)
    const c = await channelOr404(id, { includeArchived: true })
    return { channel: { id: c.id, name: c.name, description: c.description, isDefault: c.is_default }, ...(await feed(c.id, null, before, true)) }
  })

  app.get('/admin/community/posts/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    return thread(id, null, true)
  })

  /** Admins post as "Betterhood team" (announcements, AMAs, prompts to get a discussion going). */
  app.post('/admin/community/channels/:id/posts', async (req) => {
    const admin = requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = z.object({ body: Body, parentId: Id.optional() }).parse(req.body)
    const c = await channelOr404(id)
    const r = await insertPost(c.id, b.parentId, b.body, { admin })
    return { post: postOut(r, { admin: true }) }
  })

  app.post('/admin/community/posts/:id/remove', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    const b = z.object({ reason: z.string().trim().max(300).default('Removed by the Betterhood team') }).parse(req.body ?? {})
    const p = await one('select * from community_posts where id = $1', [id])
    if (!p) throw notFound('Post not found')
    await q(`update community_posts set status = 'removed', removed_reason = $2, removed_at = now() where id = $1`, [id, b.reason])
    await q(`update community_reports set resolved_at = now(), resolution = 'removed' where post_id = $1 and resolved_at is null`, [id])
    await recountReplies(p.parent_id)
    return { ok: true }
  })

  app.post('/admin/community/posts/:id/restore', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    const p = await one('select * from community_posts where id = $1', [id])
    if (!p) throw notFound('Post not found')
    await q(`update community_posts set status = 'visible', removed_reason = null, removed_at = null where id = $1`, [id])
    await recountReplies(p.parent_id)
    return { ok: true }
  })

  /** Keep a reported post (all open reports on it are closed). Removing goes through /remove. */
  app.post('/admin/community/posts/:id/keep', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: Id }).parse(req.params)
    await q(`update community_reports set resolved_at = now(), resolution = 'kept' where post_id = $1 and resolved_at is null`, [id])
    return { ok: true }
  })
}
