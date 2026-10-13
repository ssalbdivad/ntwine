import type { CloudflareApi } from "./claim-handler.ts"

/**
 * The real Cloudflare REST calls, and the ONLY place the zone token is used.
 *
 * EXERCISED AGAINST THE LIVE API on 2026-08-24: create, ingress, DNS create and update, token re-read,
 * and both deletes all ran against the real zone (the old domain; the registrar has moved to `ntwine.app` since). The tests below cover this file's logic
 * against a fake, which cannot prove a request SHAPE — a fake answers whatever it is asked. Only the
 * live run does that, so re-run one after changing any URL or body here.
 */

const API = "https://api.cloudflare.com/client/v4"

export interface CloudflareConfig {
  token: string
  accountId: string
  zoneId: string
}

interface CloudflareEnvelope<T> {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result: T
}

async function call<T>(config: CloudflareConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  })
  // Cloudflare answers 200 with `success: false` for some failures and a 4xx for others, so neither
  // signal alone is enough to tell whether the call did anything.
  const envelope = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null
  if (!response.ok || !envelope?.success) {
    const detail = envelope?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? response.statusText
    throw new Error(`cloudflare ${init.method ?? "GET"} ${path} failed: ${detail}`)
  }
  return envelope.result
}

interface DnsRecord {
  id: string
  name: string
}

export function createCloudflareApi(config: CloudflareConfig): CloudflareApi {
  const findDnsRecord = async (hostname: string): Promise<DnsRecord | undefined> => {
    const records = await call<DnsRecord[]>(
      config,
      `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`
    )
    return records[0]
  }

  return {
    async createTunnel(name) {
      // `config_src: "cloudflare"` makes this a REMOTELY-MANAGED tunnel: its ingress lives in
      // Cloudflare and it runs from a token alone, so the user's machine never needs a cert.pem and
      // never sees anything that could reach the zone.
      const tunnel = await call<{ id: string; token: string }>(config, `/accounts/${config.accountId}/cfd_tunnel`, {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" }),
      })
      return { id: tunnel.id, token: tunnel.token }
    },

    async findTunnel(name) {
      const tunnels = await call<Array<{ id: string }>>(
        config,
        `/accounts/${config.accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`
      )
      return tunnels[0] ?? null
    },

    async tunnelToken(id) {
      return call<string>(config, `/accounts/${config.accountId}/cfd_tunnel/${id}/token`)
    },

    async setTunnelIngress(id, hostname, service) {
      await call(config, `/accounts/${config.accountId}/cfd_tunnel/${id}/configurations`, {
        method: "PUT",
        // The trailing catch-all is REQUIRED — Cloudflare rejects an ingress list whose last rule
        // carries a hostname, because such a list could fall through to nothing.
        body: JSON.stringify({
          config: { ingress: [{ hostname, service }, { service: "http_status:404" }] },
        }),
      })
    },

    async upsertDnsRecord(hostname, target) {
      const existing = await findDnsRecord(hostname)
      const body = JSON.stringify({ type: "CNAME", name: hostname, content: target, proxied: true })
      // Proxied is not optional: an unproxied CNAME to cfargotunnel.com does not resolve, and it would
      // also publish the tunnel id to anyone running a DNS query.
      if (existing) {
        await call(config, `/zones/${config.zoneId}/dns_records/${existing.id}`, { method: "PUT", body })
        return
      }
      await call(config, `/zones/${config.zoneId}/dns_records`, { method: "POST", body })
    },

    async deleteTunnel(id) {
      // `cascade` drops the tunnel's connections too. Without it Cloudflare refuses to delete a tunnel
      // that still has one, which is exactly the tunnel a takeover or a sweep needs to remove.
      await call(config, `/accounts/${config.accountId}/cfd_tunnel/${id}?cascade=true`, { method: "DELETE" })
    },

    async deleteDnsRecord(hostname) {
      const existing = await findDnsRecord(hostname)
      if (!existing) return
      await call(config, `/zones/${config.zoneId}/dns_records/${existing.id}`, { method: "DELETE" })
    },
  }
}
