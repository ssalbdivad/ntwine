import assert from "node:assert/strict"
import test from "node:test"
import { createCloudflareApi } from "./cloudflare.ts"

/**
 * What these tests can and cannot prove.
 *
 * They pin the LOGIC: that a Cloudflare "success: false" carried on an HTTP 200 is treated as the
 * failure it is, that an upsert picks create-or-update correctly, that a delete of something absent is
 * not an error, and that the two settings without which a tunnel silently does not work are always
 * sent. All of that is real, and all of it would otherwise be discovered in production.
 *
 * They CANNOT prove the request shapes are what Cloudflare actually accepts. The fake answers whatever
 * this file asks it to, so a test asserting a URL only asserts a belief back to itself. A live run
 * against the real zone is what proves those, and one was done on 2026-08-24 — re-run it after
 * changing any URL or body here.
 */

const CONFIG = { token: "zone-token", accountId: "acct-1", zoneId: "zone-1" }

interface Recorded {
  url: string
  method: string
  body: unknown
  authorization: string | undefined
}

/** Swap in a fetch that answers from a script and records what it was asked. */
function withFetch(script: Array<{ status?: number; body: unknown }>) {
  const calls: Recorded[] = []
  const original = globalThis.fetch
  let index = 0
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const step = script[index++] ?? { status: 200, body: { success: true, result: null } }
    const headers = new Headers(init.headers)
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization") ?? undefined,
    })
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

const success = (result: unknown) => ({ body: { success: true, result } })

test("a Cloudflare failure carried on an HTTP 200 is still a failure", async () => {
  // The quirk that makes `response.ok` alone useless here: Cloudflare answers 200 with success:false
  // for some errors. Trusting the status would have this reporting a tunnel it never created.
  const fetcher = withFetch([
    { status: 200, body: { success: false, errors: [{ code: 1004, message: "DNS validation error" }], result: null } },
  ])
  try {
    const api = createCloudflareApi(CONFIG)
    await assert.rejects(api.createTunnel("u-colin"), /1004 DNS validation error/)
  } finally {
    fetcher.restore()
  }
})

test("a non-2xx names the endpoint that failed", async () => {
  const fetcher = withFetch([{ status: 403, body: { success: false, errors: [{ code: 10000, message: "denied" }] } }])
  try {
    const api = createCloudflareApi(CONFIG)
    await assert.rejects(api.createTunnel("u-colin"), /cfd_tunnel failed.*10000 denied/)
  } finally {
    fetcher.restore()
  }
})

test("the zone token authenticates every call and appears nowhere else", async () => {
  const fetcher = withFetch([success({ id: "t1", token: "run-token" })])
  try {
    await createCloudflareApi(CONFIG).createTunnel("u-colin")
    assert.equal(fetcher.calls[0]!.authorization, "Bearer zone-token")
    assert.equal(JSON.stringify(fetcher.calls[0]!.body).includes("zone-token"), false, "never in a body")
  } finally {
    fetcher.restore()
  }
})

test("a tunnel is created remotely-managed, so the user's machine needs no cert", async () => {
  // `config_src: "cloudflare"` is what lets the tunnel run from a token alone. Without it the user
  // would need a cert.pem, which is the whole thing this design exists to avoid.
  const fetcher = withFetch([success({ id: "t1", token: "run-token" })])
  try {
    const created = await createCloudflareApi(CONFIG).createTunnel("u-colin")
    assert.deepEqual(created, { id: "t1", token: "run-token" })
    assert.deepEqual(fetcher.calls[0]!.body, { name: "u-colin", config_src: "cloudflare" })
    assert.equal(fetcher.calls[0]!.method, "POST")
  } finally {
    fetcher.restore()
  }
})

test("ingress always ends with the catch-all, which Cloudflare requires", async () => {
  // An ingress list whose last rule carries a hostname is rejected outright, because it could fall
  // through to nothing. Easy to forget and impossible to miss once it happens.
  const fetcher = withFetch([success(null)])
  try {
    await createCloudflareApi(CONFIG).setTunnelIngress("t1", "colin.frizz.sh", "http://localhost:9393")
    const body = fetcher.calls[0]!.body as { config: { ingress: Array<Record<string, string>> } }
    assert.deepEqual(body.config.ingress, [
      { hostname: "colin.frizz.sh", service: "http://localhost:9393" },
      { service: "http_status:404" },
    ])
    assert.equal(fetcher.calls[0]!.method, "PUT")
  } finally {
    fetcher.restore()
  }
})

test("a new hostname is CREATED, an existing one is UPDATED", async () => {
  // Getting this backwards produces a duplicate-record error on every renewal, or a second record
  // that quietly shadows the first.
  const created = withFetch([success([]), success({ id: "rec-1" })])
  try {
    await createCloudflareApi(CONFIG).upsertDnsRecord("colin.frizz.sh", "t1.cfargotunnel.com")
    assert.match(created.calls[0]!.url, /dns_records\?name=colin\.frizz\.sh/)
    assert.equal(created.calls[1]!.method, "POST")
    assert.match(created.calls[1]!.url, /\/zones\/zone-1\/dns_records$/)
  } finally {
    created.restore()
  }

  const updated = withFetch([success([{ id: "rec-9", name: "colin.frizz.sh" }]), success({ id: "rec-9" })])
  try {
    await createCloudflareApi(CONFIG).upsertDnsRecord("colin.frizz.sh", "t2.cfargotunnel.com")
    assert.equal(updated.calls[1]!.method, "PUT")
    assert.match(updated.calls[1]!.url, /dns_records\/rec-9$/)
  } finally {
    updated.restore()
  }
})

test("the record is always proxied, or the name does not resolve at all", async () => {
  // An UNPROXIED CNAME to cfargotunnel.com resolves to nothing, and it would also publish the tunnel
  // id to anyone running a DNS query.
  const fetcher = withFetch([success([]), success({ id: "rec-1" })])
  try {
    await createCloudflareApi(CONFIG).upsertDnsRecord("colin.frizz.sh", "t1.cfargotunnel.com")
    assert.deepEqual(fetcher.calls[1]!.body, {
      type: "CNAME",
      name: "colin.frizz.sh",
      content: "t1.cfargotunnel.com",
      proxied: true,
    })
  } finally {
    fetcher.restore()
  }
})

test("deleting a record that is already gone is not an error", async () => {
  // Cleanup runs on paths that are already handling a failure. Throwing there would replace the real
  // error with a misleading one, and strand the resources cleanup was called to remove.
  const fetcher = withFetch([success([])])
  try {
    await createCloudflareApi(CONFIG).deleteDnsRecord("colin.frizz.sh")
    assert.equal(fetcher.calls.length, 1, "it looked, found nothing, and stopped")
  } finally {
    fetcher.restore()
  }
})

test("deleting an existing record targets it by id", async () => {
  const fetcher = withFetch([success([{ id: "rec-9", name: "colin.frizz.sh" }]), success(null)])
  try {
    await createCloudflareApi(CONFIG).deleteDnsRecord("colin.frizz.sh")
    assert.equal(fetcher.calls[1]!.method, "DELETE")
    assert.match(fetcher.calls[1]!.url, /dns_records\/rec-9$/)
  } finally {
    fetcher.restore()
  }
})

test("a response that is not JSON at all fails cleanly", async () => {
  // A Cloudflare 5xx can be an HTML error page. Parsing it must not throw something unrelated.
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response("<html>502</html>", { status: 502 })) as typeof fetch
  try {
    await assert.rejects(createCloudflareApi(CONFIG).tunnelToken("t1"), /failed/)
  } finally {
    globalThis.fetch = original
  }
})


test("a tunnel is deleted with cascade, or Cloudflare refuses one that still has connections", async () => {
  // The tunnel a takeover or a sweep needs to remove is exactly the one most likely to still have a
  // live connection, so without cascade the delete fails precisely when it matters.
  const fetcher = withFetch([success(null)])
  try {
    await createCloudflareApi(CONFIG).deleteTunnel("t1")
    assert.match(fetcher.calls[0]!.url, /cfd_tunnel\/t1\?cascade=true$/)
    assert.equal(fetcher.calls[0]!.method, "DELETE")
  } finally {
    fetcher.restore()
  }
})

test("findTunnel asks by name and reports absence as null", async () => {
  const found = withFetch([success([{ id: "t9" }])])
  try {
    assert.deepEqual(await createCloudflareApi(CONFIG).findTunnel("u-colin"), { id: "t9" })
    assert.match(found.calls[0]!.url, /cfd_tunnel\?is_deleted=false&name=u-colin$/)
  } finally {
    found.restore()
  }

  const missing = withFetch([success([])])
  try {
    assert.equal(await createCloudflareApi(CONFIG).findTunnel("u-nobody"), null)
  } finally {
    missing.restore()
  }
})
