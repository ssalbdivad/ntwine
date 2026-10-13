# Hosted Ntwine: `<name>.frizz.sh` as a paid service

Status: **BUILDING.** Owner effort: ntwine worker thread (remote-access). The design to build is [Stage 2, revised](#stage-2-revised-leased-names-keypair-ownership-no-accounts) at the bottom of this file, not the original Stage 2 sketch above it.

A "NOT BUILDING" verdict sat here on 2026-08-24 and was reversed the same day. It is worth recording why, because three of its four reasons were wrong on facts that were never checked:

| The objection | What is actually true |
| --- | --- |
| No control over abuse | We hold the zone token, so any name dies in ONE API call. We lose visibility into traffic, which is the privacy property we want — not control over the name. |
| It contradicts "local only, no cloud, no account" | Loopback stays the default and the feature is opt-in. The revised design also has no accounts at all — ownership is a keypair, not a login. |
| §2.2.1(j) blocks it | (j) is the residual risk, not the operative clause. The operative one is §2.2.1(a) — selling access to the Services, or signing up a third party. Neither happens: users never get a Cloudflare account, dashboard, or API. |
| The value is thin | It is the difference between "reachable from your phone" and "read a guide, buy a domain, run four commands". |

The one thing that stands: this must ship as a FEATURE OF NTWINE, never as a standalone tunnel or proxy product. That is the exact line Cloudflare draws in its SSL-for-SaaS terms — provisioning for end customers inside an integrated application is fine; reselling, standalone service, or handing over dashboard/API access is not.

## There is no alternative mechanism inside Cloudflare — this is forced

Both intuitive alternatives are closed, so the tunnels MUST live in our account. Verified 2026-08-24:

- **A user's own tunnel, in their own Cloudflare account, under our name.** Impossible. The `<id>.cfargotunnel.com` target only resolves for DNS records in the SAME account; a cross-account CNAME returns [error 1014](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014).
- **Delegating `alice.frizz.sh` to the user as its own zone (NS delegation).** [Subdomain setup is Enterprise-only.](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/)

So the choice is not between mechanisms. It is: tunnels in our account (below), our own relay (§ Building the tunnel ourselves), or the user brings their own domain (docs/remote-access.md). Only the first delivers `<name>.frizz.sh` with no setup.

## The ceiling, which decides the plan more than anything else

| Limit | Value | Source |
| --- | --- | --- |
| DNS records per zone, free | **200** for a zone created after 2024-09-01 — which `frizz.sh` is | [DNS features and plans](https://developers.cloudflare.com/dns/reference/all-features/) |
| DNS records per zone, Pro/Business | 3,500 | same |
| Tunnels per account | **1,000**, Enterprise to raise | [Account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) |

One user costs one DNS record and one tunnel. So the runway is **200 names free → 1,000 on Pro (~$25/mo, capped by tunnels, not records) → an Enterprise conversation**. That cap is a feature of the plan: the Cloudflare conversation about terms happens naturally at the point where you are also asking for a limit increase, rather than as a cold legal question up front.

## Why

Ntwine runs on your machine and binds loopback. Reaching it from anywhere means a tunnel, and today
that means the user brings their own Cloudflare or Tailscale account and their own domain. The product
idea is to sell the part that is annoying: identity, a stable name, and auth in front of a board that
otherwise has none. `npx ntwine --cloud` and you are at `colin.frizz.sh` from your phone.

What you are selling is **reachability and identity, not compute**. The agents still run on the user's
machine with the user's credentials. That is the whole reason the margin can be good — and it is also
what makes the security bar unusually high, because every customer is handing your namespace a
direct line to a shell on their laptop.

## Verified premises (ground truth, measured 2026-08-03/04)

These are the facts the design rests on. Each was checked, not recalled.

| Premise | Evidence |
| --- | --- |
| Cloudflare API tokens scope to a **zone**, never to a record | [Cloudflare permissions docs](https://developers.cloudflare.com/fundamentals/api/reference/permissions/); record-level is an open feature request |
| ⇒ a zone-writing token can never ship in the client | any user could then take/delete any subdomain, or repoint the apex |
| A **per-tunnel run token** is narrow — runs that tunnel, nothing else | this is what makes the vending-machine design safe |
| A **remotely-managed** tunnel (`config_src: "cloudflare"`) needs no `cert.pem` | created + configured via API, run via `cloudflared tunnel run --token` |
| Universal SSL covers `*.frizz.sh` **one level only** | deeper (`a.b.frizz.sh`) needs Advanced Certificate Manager, paid, wildcard-per-level, 50 SANs/cert |
| ⇒ the namespace must be flat: `colin.frizz.sh` | fine now that Ntwine is one server per machine |
| GitHub device flow needs only a **public `client_id`**, no secret | [octokit/auth-oauth-device](https://github.com/octokit/auth-oauth-device.js/) — the CLI can do the whole login itself |
| Cloudflare Access free tier is **50 seats, then $7/user/mo** | [Access pricing](https://www.cloudflare.com/sase/products/access/) |
| The Zero Trust reselling clause covers **Access, Gateway, RBI, email security, CASB, DLP** — **NOT Tunnel** | [Zero Trust service-specific terms](https://www.cloudflare.com/service-specific-terms-zero-trust-services/), product list read verbatim |
| The **general** agreement is the real constraint, and it is broader | [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) §2.2.1(a) "rent, lease, loan, export, or sell access to the Services to any third party, or sign up for the Services on behalf of a third party"; §2.2.1(j) "use the Services to provide a virtual private network or other similar proxy services" |
| The zone is capped at **200 DNS records** — it was created after 2024-09-01, and the account move re-created it | [DNS features and plans](https://developers.cloudflare.com/dns/reference/all-features/); 3,500 on Pro/Business |
| Non-Enterprise accounts cap at **1,000 tunnels** | [Cloudflare One account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) — also 100 edge connections per tunnel |
| **Cloudflare for SaaS** is the sanctioned "extend Cloudflare to your end customers" product | [docs](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/); Shopify, Webflow, Kinsta, Render ship on it |
| DO **WebSocket hibernation applies to INCOMING connections** (`ctx.acceptWebSocket()`) | [Durable Objects WebSocket docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — the agent dials in, so this is the right direction |
| `frizz.sh` moved to its own account on 2026-08-15 | zone `94acd4da90ceb813886c897e7f82a961`, account `dde3ec1f6b1f0a397ea82a9ed322f5ce`. The pre-move zone `2dc5dbf9…` in personal account `3eef35e2…` is DEAD — a token scoped to it authorizes nothing. |
| Ntwine has **no authentication of any kind** today | reaching the port is the authorization; `EXPOSED_WARNING` says so |
| cloudflared's origin-facing contract | port-less `Host`, `x-forwarded-for`, `x-forwarded-proto: https`, `cf-*`; app reads carry no Origin + `sec-fetch-site: same-origin` |

## The decision that shapes everything: do NOT use Cloudflare Access

My earlier advice — "prototype with Access, it is zero code" — is right for a free toy and **wrong the
moment money is involved**, for two independent reasons:

1. **It sets a $7/user/month COGS floor.** Every paying customer consumes an Access seat past the first
   50. If you charge $15, you have given away half your margin before hosting anything.
2. **It is the one place the Zero Trust reselling clause genuinely does bite.** That clause enumerates
   Access, Gateway, RBI, email security, CASB and DLP — so it says nothing about Tunnel, but a paid
   product whose access control *is* Cloudflare Access is squarely what it describes.

So: **Ntwine grows its own auth layer.** That is a day or two of work, it removes the per-user cost
entirely, it is portable across tunnels (works for self-hosters on Tailscale or ssh too), and it is
defense in depth regardless — today a misconfigured edge means total compromise.

This is the single highest-leverage item in this plan and it blocks everything after it.

## Architecture

**Data plane: Cloudflare's edge. You never proxy a byte.** Each user's traffic goes browser → Cloudflare
→ their own tunnel → their laptop. You carry no bandwidth cost, you are not on the hot path, and you
cannot read their traffic. If your control plane is down, every existing board keeps working and only
new signups break. Getting this right is worth more than any other architectural choice here.

**Control plane: one Worker + D1.** It is a credential vending machine, ~a few hundred lines:

```
POST /device/start      → GitHub device flow (public client_id, CLI shows the code)
POST /device/poll       → exchange for a GitHub token; verify; read numeric user id
POST /claim             → create tunnel via CF API, create CNAME, return the per-tunnel token
GET  /jwks              → public keys, so Ntwine verifies sessions offline
GET  /login?return=…    → browser GitHub OAuth → mint a short-lived JWT → redirect back
POST /stripe/webhook    → subscription lifecycle → enable/disable
```

**Identity: GitHub, keyed on the numeric user id — never the login string.** Handles get renamed and
released; keying on the string means the next holder of `colinhacks` inherits the subdomain. This is
the same shape as the documented tunnel-subdomain recycling hijacks. **Never release a claimed
subdomain**, for the same reason.

**Board auth: a signed session Ntwine verifies itself.**

1. Browser hits `colin.frizz.sh`, Ntwine sees no session cookie.
2. Redirect to `auth.frizz.sh/login?return=…`; GitHub OAuth; Worker mints a short-lived JWT naming the
   subdomain and the user.
3. Redirect back; Ntwine validates the JWT against cached JWKS — **offline, no call to your Worker** —
   and sets an `HttpOnly; Secure; SameSite=Lax` cookie.

Ntwine's existing origin gate already refuses cross-site mutations, so CSRF is covered by machinery that
exists. The new surface is the cookie and the JWT.

## What Ntwine itself has to gain (the code work)

1. **Session layer** — JWT verify, JWKS cache, cookie, login redirect, logout. Gate every route the
   `--public-origin` path serves. *This is the prerequisite for everything.*
2. **`ntwine login` / `--cloud`** — device flow, store the per-tunnel token in `~/.ntwine/`, supervise
   `cloudflared` as a child process (restart, backoff, health).
3. **A `cloudflared` binary** — bundle per platform (~30 MB each, ugly in an npm package) or download
   on first `--cloud` use with a pinned checksum. Prefer download-on-demand; the package stays small
   and self-hosters never pay for it.
4. **Revocation** — the Worker says the subscription lapsed, Ntwine stops serving the public origin and
   says why. Must fail closed.
5. **Local escape hatch** — `--public-origin` and loopback keep working with no account, forever. The
   free/self-host tier is what makes the paid tier feel like convenience rather than a toll booth.

## What changes because it is *paid*

The free prototype needs almost no state. Billing changes that.

- **Stripe Checkout + Customer Portal.** Do not build billing UI. Portal handles card updates,
  cancellation, invoices.
- **Subscription state is now load-bearing**: `subscription.deleted`, `payment_failed`, and
  `customer.subscription.updated` webhooks must disable the tunnel. Grace period on failed payment
  (people's cards expire; do not nuke their board same-day).
- **Reconciliation cron.** D1, Cloudflare, and Stripe *will* drift — a webhook is missed, a tunnel is
  deleted by hand. A nightly job that reconciles all three and reports drift is not optional at the
  point people are paying.
- **Recovery and support.** Lost laptop, new machine, "my subdomain is stuck". Needs a re-issue path
  that proves identity (GitHub re-auth) and rotates the tunnel token.
- **Abuse.** Someone will put a phishing page behind `*.frizz.sh`. You are the party of record. Needs a
  ToS, an abuse contact, and a per-user + global kill switch you have actually tested.
- **Tax.** Stripe Tax; it is a checkbox and it is not optional for a real business.

## Cost model

Marginal cost per user is approximately **zero** if you avoid Access — that is the entire point of the
design above. Fixed: Workers paid plan $5/mo, D1 negligible at this scale, tunnels free, bandwidth is
Cloudflare's. Variable: Stripe at 2.9% + 30¢. Domain ~$30/yr for `.sh`.

The thing that would wreck this model is anything that puts you on the data plane, or Access seats.

## Security: the part that deserves the most paranoia

**A Ntwine board runs shell commands as its owner. An auth bug here is remote code execution on your
customers' laptops, not a data leak.** That reframes several ordinary choices:

- **Vanity subdomains advertise the target list.** `colin.frizz.sh` lets anyone enumerate your customers
  from GitHub handles. For a paid product vanity is part of the value, so buy it back with genuinely
  strong auth rather than obscurity — but know the trade you are making. (Microsoft's dev tunnels chose
  opaque ids for exactly this reason, and require the *same account on both ends*.)
- **The per-tunnel token on the user's disk is a bearer credential.** Stolen, it does not reach their
  machine — but it lets the thief serve traffic *as* `colin.frizz.sh`, which is a good phishing primitive.
  Make rotation a first-class operation, not a support ticket.
- **Secrets never touch the client.** The Cloudflare zone token lives only as a Worker secret
  (`wrangler secret put`), never in `wrangler.toml`, never in the repo, never in the npm package. Add a
  pre-publish grep for token-shaped strings over `npm pack` output, and turn on GitHub push protection.
- Short JWT lifetime, refresh via redirect, no token left in the URL after exchange, rate limit the
  Worker's claim endpoint.

## Staged build

**Stage 0 — done.** `--public-origin` + docs. Self-host tier: bring your own Cloudflare/Tailscale.
Costs you nothing and is a real product on its own.

**Stage 1 — Ntwine auth layer.** JWT sessions. Needed by every later stage, valuable standalone (it
closes the "misconfigured edge = total compromise" hole for self-hosters today).

**Stage 2 — free tier with subdomains.** Worker + D1 + GitHub device flow + tunnel vending. No billing.
Validates demand and the whole mechanism.

**Stage 3 — paid.** Stripe, revocation, reconciliation, ToS, support.

Do not skip Stage 1 to get to Stage 2 faster; Stage 2 without it is a public directory of unauthenticated
shells.

## The terms question, correctly stated

An earlier draft of this plan said the blocker was the Zero Trust reselling clause. **That was the wrong
clause.** Cloudflare Tunnel is not one of the enumerated Zero Trust Services, so it does not apply.

The real constraint is the general [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/),
which applies to everything:

- **§2.2.1(a)** — no "rent, lease, loan, export, or sell access to the Services to any third party, or
  sign up for the Services on behalf of a third party."
- **§2.2.1(j)** — no "use the Services to provide a virtual private network or other similar proxy
  services."

(j) is the sharp one, and it is aimed squarely at this product's shape. Two consequences worth being
precise about:

1. **This is not a "Cloudflare Tunnel is disallowed" finding — it is a self-serve-terms finding.** The
   clause ends where a written agreement begins, and Cloudflare sells exactly that: **Cloudflare for
   SaaS** exists to extend Cloudflare to a provider's end customers, and Shopify, Webflow, Kinsta and
   Render are shipping on it. So the path exists; it runs through a sales conversation and an Enterprise
   agreement, not through self-serve signup. The 1,000-tunnel account cap forces that same conversation
   at scale anyway, so the two arrive together.
2. **Building your own tunnel on Workers + Durable Objects does NOT dodge this.** It is still Cloudflare's
   network, and "providing proxy services" arguably describes a hand-rolled proxy more plainly than it
   describes using their supported product. Escaping §2.2.1(j) means moving the *data plane* off
   Cloudflare — which is a much bigger decision than which tunnel library to use.

**What to do about it: do not let it block Stages 0–2.** Self-hosting, the Ntwine auth layer, and even a
free tier where users authenticate with their own GitHub are not "selling access to the Services." Ask
Cloudflare before Stage 3, when there is a real product to describe and the question is concrete.

Also: move `frizz.sh` out of the personal Cloudflare account before it carries a business. Moving a zone
between accounts later means removing and re-adding it, with a DNS gap.

## Building the tunnel ourselves

Worth costing, both as leverage in that conversation and as insurance if the answer is no.

**Cloudflare Workers + Durable Objects — no servers, ~1–2 weeks for a credible v1.** One DO per subdomain
holds a WebSocket the user's agent dials *in* on; the Worker routes `<name>.frizz.sh` to that DO, which
forwards over the socket. Hibernation applies to incoming sockets, so idle tunnels cost approximately
nothing and connections survive. No regions, no autoscaling, no machines.

**The hard part is not routing — it is multiplexing.** The board is itself WebSocket-heavy (the board
socket plus every terminal pane), so you are tunnelling WebSockets *inside* a WebSocket, alongside
concurrent HTTP. That means your own framing, stream ids, backpressure, and reconnect/resume semantics.
cloudflared gets this from QUIC streams for free. This is the piece that turns "a weekend" into "a
fortnight, then a long tail of edge cases," and it is where a DIY tunnel earns its bugs.

**Off Cloudflare, if §2.2.1(j) forces it:**

- **Fly.io** — the best fit for "no infrastructure management" outside Cloudflare. Anycast plus Machines,
  deploy a container running a small tunnel server (`frp`, `rathole`, or your own). Hosting arbitrary
  network services *is* their business, so the terms fit naturally. You pay egress, which Cloudflare
  does not charge you for — that is the real cost of leaving.
- **ngrok** — they sell embedding into other products, which is the "just buy it" answer and the fastest
  legitimate path. Public list pricing includes data transfer at $0.10/GB, so it becomes a genuine
  per-user COGS line; OEM terms need a sales conversation of their own.
- **A VPS running `frp`/`rathole`** — cheapest and most controllable, and explicitly ruled out: it is
  infrastructure management.

**The engineering conclusion, which is cheap and worth doing regardless: make the transport pluggable in
Ntwine.** Do not hard-code `cloudflared`. If the tunnel is a strategy behind a small interface, then the
answer to the terms question — and any later cost or reliability surprise — becomes a swap rather than a
rewrite. That is a day of design discipline now against a fortnight of migration later.

## Rejected

- **Cloudflare Access as the product's auth** — $7/user COGS floor and probable ToS conflict. See above.
- **A proxy Worker in front of `*.frizz.sh`** — removes per-user DNS writes, but puts you on the data
  plane: their bandwidth on your bill, your uptime in front of every board, and you can see everything.
- **Nested `<repo>.<user>.frizz.sh`** — needs paid ACM with a wildcard per user, 50 SANs per cert. Moot
  now that Ntwine is one server per machine.
- **Shipping a Cloudflare token in the client** — impossible to scope safely; see verified premises.
- **Vercel as the front** — no tunnel product, and `vercel.json` rewrites do not proxy WebSocket
  upgrades to an external destination. Ntwine's board and terminals are all WebSockets.

## Stage 1, concretely: single-use codes instead of one standing secret

What shipped in `ec6ecb1` is a **floor**: one long-lived bearer secret, printed at launch, traded for a
year-long cookie. It works, and its weaknesses are structural rather than fixable by tuning:

- The secret lands in terminal scrollback, shell history, and (as of 2026-08-16) an email. Every copy is
  permanently valid.
- It only rotates when the board restarts, which is exactly when it is most disruptive to rotate.
- There is one secret for the whole machine, so "let someone see this board" is indistinguishable from
  "hand over every project on my laptop".

### The mechanism

Separate **codes** from **sessions** — the single most important move, and the reason this generalises.

- A **code** is single-use and short-lived (~5 minutes). It authorizes exactly one exchange.
- A **session** is what the code mints: a long-lived signed cookie, independently revocable.
- `GET /?ntwine_code=<code>` → atomic compare-and-set on the code (used exactly once, no TOCTOU) → mint
  session → redirect to a clean URL, as the current exchange already does.

Once that split exists, everything else is a policy on top: expiry, per-device naming, "sign out all
devices", and eventually a real IdP minting the session instead of a code. The hosted product's JWT is
the same shape with GitHub in front, which is why this is not throwaway work.

### QR is the right affordance, not a gimmick

The actual problem is moving a credential from a terminal to a phone, and a 32-character token is
miserable to type. Render the code as a QR in the terminal (half-block glyphs; a minimal encoder is
small enough not to warrant a dependency). Repainting it the moment it is consumed — the server already
knows, because consumption goes through one endpoint — makes the staleness visible instead of implicit.

### Show it in an EPHEMERAL pane, not the standing readout

Tempting to print the QR in the launch readout. Don't:

- The readout is scrollback. A QR sitting in scrollback is the same leak as the token today, just harder
  to grep for.
- Ntwine deliberately degrades to plain parseable records when stdout is not a TTY (`if (!readout)`), and
  a permanent live region fights `--debug`, piping, and CI.

So: keep the standing readout exactly as it is, and add a keypress (TTY only) that opens a temporary
full-screen pane showing a freshly minted code as a QR, which restores the normal readout on dismiss or
expiry. That is the maintainer's second sketch and it is the safer of the two.

### Keep the standing secret for headless

`NTWINE_PUBLIC_TOKEN` stays, for boxes with no TTY where nobody can press a key — a server, a container, a
CI runner. Interactive launches default to single-use codes; headless ones keep the pinned secret. Say so
in the readout, because the two postures have genuinely different risk.

### Cautions worth encoding in the tests

- Single-use must be **atomic**. Two browsers racing one code is the bug that makes "single-use" a lie.
- Short expiry: a QR photographed over a shoulder, or caught in a screen recording, is a real vector.
- Rate-limit redemption, and never write a code to a log file or the terminal title.
- Sessions need revocation, or "I shared my board once" becomes permanent.

## Stage 2, concretely: who actually creates a new user's subdomain

The question this answers, because it is the one that keeps coming back: **does the user running
`cloudflared tunnel run` create their subdomain?** No. That command only CONNECTS a tunnel that already
exists. Both the tunnel and the DNS record are created by API calls against the zone, and the token that
authorises them can never be on a user's machine — Cloudflare scopes tokens to a zone, never to a
record, so anything strong enough to create `alice.frizz.sh` is also strong enough to delete
`bob.frizz.sh` and repoint the apex.

So a broker is required. One correction to how it is usually imagined: **it does not need to be
persistent.** Registration is request/response, so a Worker is exactly right and nothing stays running.

### The sequence

| Who | Does what |
| --- | --- |
| CLI | `POST /register` to the Worker with the desired name and the local port |
| Worker | Authenticates the user (Stage 3 concern; v1 can be first-come-first-served) |
| Worker → CF | `POST /accounts/{id}/cfd_tunnel` `{name, config_src:"cloudflare"}` → tunnel id **and its run token** |
| Worker → CF | `PUT /accounts/{id}/cfd_tunnel/{id}/configurations` → ingress to `http://localhost:<port>` |
| Worker → CF | `POST /zones/{id}/dns_records` → CNAME `<name>.frizz.sh` → `<tunnelid>.cfargotunnel.com`, proxied |
| Worker | Returns **only the per-tunnel run token** |
| CLI | Stores it under `~/.ntwine/`, runs `cloudflared tunnel run --token …` as a supervised child |

### Why this split is the safe one

**The Worker creates; the user's machine only connects.** A per-tunnel run token runs exactly one tunnel
and nothing else — it cannot enumerate the zone, cannot create records, cannot reach another user's
tunnel. That asymmetry is the entire security argument, and it is why the zone token never leaves the
Worker and the run token is safe to hand out.

### Three consequences worth knowing before writing any of it

- **No relational database.** The registry is Workers KV, one small JSON row per name — see the
  storage decision above. Uniqueness, ownership and the lease all read from that row; the built code
  never queries Cloudflare to ask whether a name is taken. D1 earns its place at Stage 3 for
  subscription state and audit, not for any of this.
- **The Worker is off the data plane.** It runs during signup and never again. If it is down, every
  existing board keeps working and only new registrations fail. Protecting that property is worth more
  than any other choice in this document.
- **Users need the `cloudflared` binary.** Bundle per platform (~30 MB each, ugly in an npm package) or
  download on first `--cloud` use against a pinned checksum. Prefer the download: the package stays
  small and self-hosters never pay for it.

### The port detail that decides the shape

Remotely-managed ingress lives in Cloudflare, so the Worker must know which local port to point at. Have
the CLI send its port at registration and the Worker set ingress accordingly — one extra API call, and it
handles people not on the default port. The alternative (fixing the port by convention) is simpler and
breaks the first time someone runs two boards or has 9494 occupied.

### Do not start this before the terms question

Stage 2 is where you begin creating tunnels *on behalf of other people*, which is precisely the activity
§2.2.1(j) describes. Building it first and asking afterwards risks discovering the data plane has to move
after the code assumes it never will. Ask, then build.

## "Just give them a subdomain pointing at their own IP" — can we stay off the data path entirely?

The instinct: provision `<name>.frizz.sh`, point it at the user's own public IP, and let their machine
serve the traffic. Ntwine-the-company does DNS and nothing else. Worth taking seriously, because it is
the cheapest possible business and it fails for a reason that is easy to miss.

### First: the current design already keeps us off the data path

Worth saying plainly, because it may dissolve the whole concern. With Cloudflare Tunnel, traffic goes
browser → **Cloudflare's** edge → the user's own tunnel → their laptop. It does not touch anything we
run. We pay no bandwidth, host no proxy, and cannot see the traffic. The only thing we would operate is
the registration Worker, which runs once at signup and never again.

So "I don't want traffic routed through our own thing" is already satisfied. The thing traffic routes
through is Cloudflare, and that is also true of the DNS-only design, just at a different layer.

### The DNS-only version, and why it cannot serve a laptop

An A record pointing at the user's IP needs all of:

- **A reachable public IP.** Home connections are behind NAT, and a growing share are behind CARRIER-GRADE
  NAT, where the user has no unique public address at all and no amount of configuration produces one.
- **Inbound port forwarding**, configured on their router. This is the step that ends most self-hosting
  stories, and it is not something a CLI can do for them.
- **A STABLE address.** This is the one that kills it outright for Ntwine. The product runs on a laptop
  that moves between home, an office, a café, a hotel. Its public IP changes with every network — so the
  A record is stale minutes after it is written. Dynamic DNS (the machine reports its own IP and we
  update the record) fixes staleness but nothing else, and it cannot fix NAT.

For a desktop with a static IP, or a VPS, DNS-only works fine. For the machine Ntwine actually runs on,
it does not, and no amount of engineering on our side changes that.

### The certificate problem, which IS solvable

Even where the IP works, an A record alone gets you `http://`. Ntwine over plain HTTP is not acceptable:
no secure context (so no clipboard), and the session cookie crosses the internet in the clear. A
certificate for `<name>.frizz.sh` needs a private key on the USER's machine, so we cannot issue it
centrally without shipping keys around.

The clean answer is [ACME DNS-01 with CNAME delegation](https://cert-manager.io/docs/configuration/acme/dns01/):
we host a `_acme-challenge.<name>.frizz.sh` record (or delegate it to a minimal challenge-only service,
which is what [acmedns.org](https://acmedns.org/) does), the user's machine runs the ACME client, and
Let's Encrypt issues the certificate directly to them. The private key never leaves their disk and we
never hold it. That is a genuinely nice property and it is the piece worth remembering if the DNS-only
route is ever revisited — but it solves the cert, not the reachability.

### Where that leaves it

- **Tunnel (current).** The only option that works on a laptop behind NAT on someone else's wifi. Already
  keeps us off the data path. Cost to us is zero bandwidth.
- **DNS-only + ACME delegation.** Purest form of "we only do DNS". Viable for static-IP desktops and VPSes
  — a real audience, just not the primary one. Worth offering as a second tier, never as the default.
- **Dynamic DNS.** Solves a changing IP, not NAT. Only worth building on top of the DNS-only tier.

The conclusion that matters: the tunnel is not a compromise forced by laziness. For a laptop it is the
only mechanism that works at all, and it already has the property that motivated the question.

---

## Stage 2, revised: leased names, keypair ownership, no accounts

This supersedes the "Stage 2, concretely" sketch above. The Cloudflare API calls are unchanged — they are forced, per the section at the top. What changes is everything around them: who owns a name, how long they own it, and what we have to store.

### Ownership is a keypair, not an account

The CLI generates an Ed25519 keypair on first use and writes it to `~/.ntwine/identity.key` (0600). That key IS the account. No email, no password, no OAuth, no user table.

```
POST /claim                       →  { name, port, pubkey, sig }
```

The Worker verifies the signature over the request body, then issues. Re-registering from a second machine means copying the key file — the same mental model as an SSH key, and the same failure mode: lose the key, lose the name. A recovery address is an opt-in Stage 3 field, not a signup step.

This is what lets the feature keep Ntwine's "no account" promise while still having an owner for every name.

### Names are leases, not property

A claim is good for 30 days. Every launch renews it with a signed heartbeat; a name nobody has run in 30 days has its tunnel and DNS record deleted and returns to the pool.

Three problems solved by one rule:

- **Squatting.** A name costs continuous use, not a one-time claim.
- **The 200/1,000 ceiling.** The registry self-trims, so the cap counts ACTIVE users rather than everyone who ever tried it.
- **Abandoned liability.** A name pointing at a laptop that no longer exists stops being ours to answer for.

### What the Worker actually does

Unchanged from the original sketch, and it needs no database:

| Step | Call |
| --- | --- |
| Is the name taken? | `GET /accounts/{id}/cfd_tunnel?name=u-<name>` — Cloudflare's own list IS the registry |
| Create | `POST /accounts/{id}/cfd_tunnel` `{name, config_src:"cloudflare"}` → id + run token |
| Point it at the board | `PUT /accounts/{id}/cfd_tunnel/{id}/configurations` → ingress `http://localhost:<port>` |
| Publish the name | `POST /zones/{id}/dns_records` → proxied CNAME `<name>.frizz.sh` → `<id>.cfargotunnel.com` |
| Return | the per-tunnel run token, and nothing else |

The pubkey has to live somewhere to verify renewals, and so does the lease timestamp. **Workers KV**, one small JSON row per name — decided 2026-08-24 while building it, over two alternatives:

- *Tunnel metadata.* Unverified: the create API's support for arbitrary metadata could not be confirmed from the docs, and a design cannot rest on a field nobody has seen accepted.
- *A DNS TXT record per owner.* Doubles the record count against a **200-record cap**. That is the one resource this design cannot spend twice.

KV is not the D1 that "no database" was written to avoid — it is a binding, free at this scale, and the lease needs a timestamp Cloudflare's tunnel object does not carry.

### Why the token split is the whole security argument

The zone token never leaves the Worker. What reaches a user's machine is a per-tunnel run token, which can run exactly one tunnel and cannot enumerate the zone, create records, or reach another user's tunnel. That asymmetry is why handing it out is safe.

### Revocation

We hold the zone token, so any name is one `DELETE` away — record and tunnel both. Traffic stays invisible to us by design; the name does not. A short AUP has to say the name is ours and can be reclaimed, because that is the only enforcement we have and the only one we need.

### What is genuinely NOT solved

- **The board behind the name is still shell access**, gated by Ntwine's single-use links. A leaked link is a leaked shell. This is the same exposure as the self-hosted path, but now under a name we handed out.
- **The 1,000-tunnel cap** arrives before any Enterprise conversation is scheduled. Plan the conversation for ~700.
- **Port at claim time** assumes the board keeps that port. Re-claiming on a port change is one more signed call; the CLI should just do it rather than making it a user-visible step.
