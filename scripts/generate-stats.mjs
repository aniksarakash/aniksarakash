#!/usr/bin/env node
/**
 * Generates assets/github.svg — a branded, self-hosted GitHub stats card.
 *
 * Why self-hosted: the public github-readme-stats instance is paused
 * (503 DEPLOYMENT_PAUSED) and github-profile-trophy returns 402
 * DEPLOYMENT_DISABLED. This commits a static SVG, so the README depends on
 * nobody else's uptime or rate limit.
 *
 * ── Private contributions ──────────────────────────────────────────────────
 * Nearly all of this profile's activity is in private enterprise repos:
 * totalCommitContributions is 0 and restrictedContributionsCount carries the
 * whole year. Those restricted counts are visible to third parties (including
 * the Actions GITHUB_TOKEN) ONLY while the account has
 *   Settings → Profile → "Include private contributions on my profile"
 * switched on. Flip it off and the headline number silently becomes 0.
 *
 * So we don't just read the number, we verify it:
 *   1. Cross-check contributionCalendar.totalContributions against
 *      public + restricted. The calendar is the same figure github.com shows.
 *   2. Persist assets/stats.json as a provenance record.
 *   3. If visibility disappears (restricted was >0 recently, now 0), keep the
 *      last good value, mark it stale, and shout — rather than quietly
 *      publishing a wrong 0. STRICT=1 turns that into a build failure.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/generate-stats.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'

const LOGIN = process.env.GH_LOGIN || 'aniksarakash'
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const STRICT = process.env.STRICT === '1'
const CACHE = 'assets/stats.json'
/** A cache older than this is too stale to defend a degraded live read against. */
const CACHE_TRUST_DAYS = 45

if (!TOKEN) {
  console.error('Set GITHUB_TOKEN (read:user is enough; a PAT also works).')
  process.exit(1)
}

/** Clones/mirrors of third-party projects — not forks per GitHub's flag, but not authored here. */
const EXCLUDE = new Set(['cjdns', 'NewPipe', 'DPITunnel', 'BlackHole', 'Rapidleech'])

// ── Design tokens, lifted from aniksarkerakash.com ──────────────────────────
const INK = '#030014'
const INK_SOFT = '#12121a'
const BONE = '#f3eee4'
const TEXT_2 = '#a9a3bd'
const TEXT_3 = '#6f6a85'
const BORDER = '#2a2a3a'
const A = { blue: '#4f69e8', purple: '#7c3aed', cyan: '#06b6d4', amber: '#f59e0b', pink: '#ec4899', mint: '#10b981' }

const QUERY = `
query($login:String!, $after:String) {
  viewer { login }
  user(login:$login) {
    createdAt
    followers { totalCount }
    pullRequests(states:[OPEN,CLOSED,MERGED]) { totalCount }
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions }
    }
    repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { name stargazerCount primaryLanguage { name color } }
    }
  }
}`

async function gql(after) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'readme-stats' },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN, after } }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`)
  const json = await res.json()
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}

async function collect() {
  let after = null
  let data = null
  let stars = 0
  const langs = new Map()

  do {
    const page = await gql(after)
    data ??= page
    for (const repo of page.user.repositories.nodes) {
      if (EXCLUDE.has(repo.name)) continue
      stars += repo.stargazerCount
      const lang = repo.primaryLanguage
      if (!lang) continue
      const cur = langs.get(lang.name) ?? { count: 0, color: lang.color }
      cur.count += 1
      langs.set(lang.name, cur)
    }
    const info = page.user.repositories.pageInfo
    after = info.hasNextPage ? info.endCursor : null
  } while (after)

  const u = data.user
  const c = u.contributionsCollection
  const since = new Date(u.createdAt)

  return {
    viewer: data.viewer.login,
    isOwner: data.viewer.login.toLowerCase() === LOGIN.toLowerCase(),
    publicContribs: c.totalCommitContributions,
    restricted: c.restrictedContributionsCount,
    // The canonical "N contributions in the last year" github.com renders.
    contributions: c.contributionCalendar.totalContributions,
    stars,
    repos: u.repositories.totalCount,
    followers: u.followers.totalCount,
    prs: u.pullRequests.totalCount,
    years: Math.max(1, Math.floor((Date.now() - since.getTime()) / (365.25 * 864e5))),
    since: since.getUTCFullYear(),
    langs: [...langs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
  }
}

/**
 * Decide whether this run's private-contribution visibility is trustworthy,
 * falling back to the last good reading rather than publishing a wrong zero.
 */
async function reconcile(live) {
  let cache = null
  try {
    cache = JSON.parse(await readFile(CACHE, 'utf8'))
  } catch {
    /* first run */
  }

  const ageDays = cache?.generatedAt
    ? (Date.now() - new Date(cache.generatedAt).getTime()) / 864e5
    : Infinity
  const cacheTrusted = cache && ageDays <= CACHE_TRUST_DAYS

  const lostVisibility = Boolean(cacheTrusted && cache.restricted > 0 && live.restricted === 0)

  const notes = []
  if (!live.isOwner) {
    notes.push(`viewer is @${live.viewer}, not @${LOGIN} — relying on public profile visibility`)
  }
  if (lostVisibility) {
    notes.push(
      `private contributions went ${cache.restricted} → 0 in ${ageDays.toFixed(0)}d; ` +
        `"Include private contributions on my profile" is probably OFF — reusing last good reading`
    )
  }

  const resolved = lostVisibility
    ? { ...live, contributions: cache.contributions, restricted: cache.restricted, publicContribs: cache.publicContribs }
    : live

  return { resolved, degraded: lostVisibility, notes, asOf: lostVisibility ? cache.generatedAt : new Date().toISOString() }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n))

function render(d, { degraded, asOf }) {
  const W = 1000, H = 310
  const privatePct = d.contributions > 0 ? Math.round((d.restricted / d.contributions) * 100) : 0

  const tiles = [
    { v: fmt(d.contributions), label: 'contributions, 12 mo', color: A.blue },
    { v: fmt(d.repos), label: 'public repositories', color: A.cyan },
    { v: fmt(d.prs), label: 'pull requests opened', color: A.purple },
    { v: fmt(d.stars), label: 'stars earned', color: A.amber },
    { v: fmt(d.followers), label: 'followers', color: A.pink },
    { v: `${d.years}y`, label: `building since ${d.since}`, color: A.mint },
  ]

  const TW = 148, TH = 78, GX = 12, GY = 14, TX = 34, TY = 96
  const tileSvg = tiles.map((t, i) => {
    const x = TX + (i % 3) * (TW + GX)
    const y = TY + Math.floor(i / 3) * (TH + GY)
    return `  <g class="rise" style="animation-delay:${(0.08 + i * 0.07).toFixed(2)}s">
    <rect x="${x}" y="${y}" width="${TW}" height="${TH}" rx="10" fill="${BONE}" fill-opacity="0.04" stroke="${BORDER}"/>
    <rect x="${x}" y="${y + 14}" width="3" height="${TH - 28}" rx="1.5" fill="${t.color}"/>
    <text class="fs" x="${x + 18}" y="${y + 38}" font-size="25" font-weight="700" fill="${BONE}">${esc(t.v)}</text>
    <text class="fm" x="${x + 18}" y="${y + 60}" font-size="10" fill="${TEXT_3}">${esc(t.label)}</text>
  </g>`
  }).join('\n')

  // ── Public / private split of the last 12 months ──────────────────────────
  const SX = 548, SY = 96, SW = 418, SH = 12
  const privW = Math.round((privatePct / 100) * SW)
  const pubW = Math.max(0, SW - privW - (privW > 0 && privW < SW ? 2 : 0))
  // Every animated bar carries its FINAL width as the attribute and animates
  // up from 0. Authoring width="0" and relying on fill="freeze" to fill it in
  // means the chart is empty wherever SMIL is unsupported or disabled.
  const splitBar = `  <rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" rx="4" fill="${BONE}" fill-opacity="0.05"/>
  <rect x="${SX}" y="${SY}" width="${privW}" height="${SH}" rx="4" fill="${A.purple}">
    <animate attributeName="width" from="0" to="${privW}" dur="0.9s" begin="0.25s" calcMode="spline" keySplines="0.22 0.61 0.36 1" fill="freeze"/>
  </rect>${pubW > 0 ? `
  <rect x="${SX + privW + 2}" y="${SY}" width="${pubW}" height="${SH}" rx="4" fill="${A.mint}">
    <animate attributeName="width" from="0" to="${pubW}" dur="0.9s" begin="0.32s" calcMode="spline" keySplines="0.22 0.61 0.36 1" fill="freeze"/>
  </rect>` : ''}
  <g class="rise" style="animation-delay:.45s">
    <circle cx="${SX + 5}" cy="${SY + 30}" r="5" fill="${A.purple}"/>
    <text class="fm" x="${SX + 18}" y="${SY + 34}" font-size="11.5" fill="${TEXT_2}">private repos</text>
    <text class="fm" x="${SX + 150}" y="${SY + 34}" font-size="11.5" font-weight="700" fill="${BONE}" text-anchor="end">${privatePct}%</text>
    <circle cx="${SX + 224}" cy="${SY + 30}" r="5" fill="${A.mint}"/>
    <text class="fm" x="${SX + 237}" y="${SY + 34}" font-size="11.5" fill="${TEXT_2}">public repos</text>
    <text class="fm" x="${SX + SW}" y="${SY + 34}" font-size="11.5" font-weight="700" fill="${BONE}" text-anchor="end">${100 - privatePct}%</text>
  </g>`

  // ── Languages: top 6, stacked, 2px surface gaps ───────────────────────────
  const top = d.langs.slice(0, 6)
  const totalRepos = d.langs.reduce((s, l) => s + l.count, 0) || 1
  const topTotal = top.reduce((s, l) => s + l.count, 0) || 1
  const BX = 548, BY = 190, BW = 418, BH = 14, GAP = 2
  const usable = BW - GAP * Math.max(0, top.length - 1)

  let cursor = BX
  const segs = top.map((l, i) => {
    const w = Math.max(6, (l.count / topTotal) * usable)
    const seg = `  <rect x="${cursor.toFixed(1)}" y="${BY}" width="${w.toFixed(1)}" height="${BH}" rx="4" fill="${l.color || A.blue}">
    <animate attributeName="width" from="0" to="${w.toFixed(1)}" dur="0.9s" begin="${(0.4 + i * 0.06).toFixed(2)}s" calcMode="spline" keySplines="0.22 0.61 0.36 1" fill="freeze"/>
  </rect>`
    cursor += w + GAP
    return seg
  }).join('\n')

  const legend = top.map((l, i) => {
    const x = BX + (i % 2) * 212
    const y = BY + 36 + Math.floor(i / 2) * 22
    const pct = ((l.count / totalRepos) * 100).toFixed(0)
    return `  <g class="rise" style="animation-delay:${(0.55 + i * 0.05).toFixed(2)}s">
    <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color || A.blue}"/>
    <text class="fm" x="${x + 18}" y="${y}" font-size="11" fill="${TEXT_2}">${esc(l.name)}</text>
    <text class="fm" x="${x + 196}" y="${y}" font-size="11" font-weight="700" fill="${BONE}" text-anchor="end">${pct}%</text>
  </g>`
  }).join('\n')

  const stamp = asOf.slice(0, 10)
  const langList = top.map((l) => `${l.name} ${((l.count / totalRepos) * 100).toFixed(0)} percent`).join(', ')
  const foot = degraded
    ? `Private-contribution visibility is off — showing last verified reading from ${stamp}`
    : `${privatePct}% of the last 12 months is private enterprise work · primary language per repo across ${totalRepos} repositories`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="GitHub activity for ${esc(LOGIN)}: ${d.contributions} contributions in the last 12 months, of which ${privatePct} percent are in private repositories; ${d.repos} public repositories, ${d.prs} pull requests, ${d.stars} stars, ${d.followers} followers, building since ${d.since}. Languages by repository: ${esc(langList)}.">
  <title>GitHub activity for ${esc(LOGIN)}</title>
  <defs>
    <linearGradient id="surface" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${INK}"/>
      <stop offset="100%" stop-color="${INK_SOFT}"/>
    </linearGradient>
    <linearGradient id="rule" gradientUnits="userSpaceOnUse" x1="34" y1="0" x2="${W - 34}" y2="0">
      <stop offset="0%" stop-color="${A.blue}"/>
      <stop offset="50%" stop-color="${A.purple}"/>
      <stop offset="100%" stop-color="${A.cyan}"/>
    </linearGradient>
    <style>
      .fs { font-family: 'Space Grotesk', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
      .fm { font-family: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace; }
      /* Resting state is VISIBLE and the animation plays from hidden via
         'backwards' (which applies the from-state during animation-delay).
         The naive form — opacity:0 in the base rule, animated up to 1 —
         renders a completely blank card anywhere the CSS is stripped or
         animations are disabled. Degrading to "no animation" beats
         degrading to "no content". */
      .rise { animation: rise .7s cubic-bezier(.22,.61,.36,1) backwards; }
      @keyframes rise { from { opacity:0; transform: translateY(9px) } to { opacity:1; transform: translateY(0) } }
      @media (prefers-reduced-motion: reduce) { .rise { animation: none } }
    </style>
  </defs>

  <rect width="${W}" height="${H}" rx="16" fill="url(#surface)"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="none" stroke="${BONE}" stroke-opacity="0.10"/>

  <text class="fs" x="34" y="44" font-size="19" font-weight="700" fill="${BONE}">Activity overview</text>
  <text class="fm" x="${W - 34}" y="44" font-size="11" fill="${TEXT_3}" text-anchor="end">updated ${stamp} · @${esc(LOGIN)}</text>
  <path d="M34 62 H ${W - 34}" stroke="url(#rule)" stroke-width="1.5" stroke-opacity="0.6"/>

${tileSvg}

  <text class="fs" x="${SX}" y="${SY - 14}" font-size="15" font-weight="600" fill="${BONE}">Where the work happens</text>
${splitBar}

  <text class="fs" x="${BX}" y="${BY - 14}" font-size="15" font-weight="600" fill="${BONE}">Languages by repository</text>
  <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="4" fill="${BONE}" fill-opacity="0.05"/>
${segs}
${legend}

  <text class="fm" x="34" y="${H - 16}" font-size="10" fill="${TEXT_3}" opacity="0.8">${esc(foot)}</text>
</svg>
`
}

// ── main ────────────────────────────────────────────────────────────────────
const live = await collect()
const { resolved, degraded, notes, asOf } = await reconcile(live)

await mkdir('assets', { recursive: true })
await writeFile('assets/github.svg', render(resolved, { degraded, asOf }), 'utf8')

// Provenance record — this is what the next run reconciles against.
if (!degraded) {
  await writeFile(
    CACHE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        viewer: live.viewer,
        isOwner: live.isOwner,
        contributions: live.contributions,
        publicContribs: live.publicContribs,
        restricted: live.restricted,
        stars: live.stars,
        repos: live.repos,
        prs: live.prs,
        followers: live.followers,
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

const privatePct = resolved.contributions > 0 ? Math.round((resolved.restricted / resolved.contributions) * 100) : 0
console.log(`assets/github.svg written`)
console.log(`  viewer            @${live.viewer}${live.isOwner ? ' (owner)' : ' (third party)'}`)
console.log(`  contributions     ${resolved.contributions}  (public ${resolved.publicContribs} + private ${resolved.restricted} = ${privatePct}% private)`)
console.log(`  repos/stars/prs   ${resolved.repos} / ${resolved.stars} / ${resolved.prs}`)
console.log(`  languages         ${resolved.langs.slice(0, 6).map((l) => `${l.name}:${l.count}`).join(', ')}`)

// Cross-check: the calendar total should equal public + restricted.
const sum = resolved.publicContribs + resolved.restricted
if (!degraded && sum !== resolved.contributions) {
  notes.push(`calendar total ${resolved.contributions} != public+private ${sum} (calendar counts issues/PRs/reviews too)`)
}

for (const n of notes) {
  console.warn(`  WARNING: ${n}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> [!WARNING]\n> ${n}\n\n`)
  }
}

if (degraded) {
  console.error('\nRefusing to publish a degraded contribution count.')
  console.error('Fix: GitHub → Settings → Profile → check "Include private contributions on my profile".')
  if (STRICT) process.exit(1)
}
