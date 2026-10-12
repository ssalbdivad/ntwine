# Remote access

Frizz binds `127.0.0.1` and has no login of its own. To reach a board from a phone or another machine, something in front of it carries the traffic, and Frizz gates the first visit with a single-use sign-in link.

Press **R** in the terminal running Frizz. A walkthrough offers four ways to reach the board, checks what each needs, prints the commands, and remembers your choice — a plain `npx frizz` serves it from then on. **Off** in the same place goes back to loopback only.

```
  Reach this board from anywhere

  ❯ Private name        an unguessable name on frizz.sh — no account, nothing to install
    Cloudflare Tunnel   a domain you own on Cloudflare; cloudflared on this machine
    Tailscale           your tailnet; tailscale serve does the TLS
    Something else      any proxy or tunnel you run — tell Frizz its address
    Off                 loopback only  (current)
```

Whichever you pick, the board stays bound to loopback. The readout then shows a QR: scanning it trades a single-use code for a session cookie, so the link stops working the moment it is used. Press **L** for a fresh one at any time. A session lasts 30 days, after which the device needs a fresh link.

```sh
npx frizz --link          # a fresh link for a board that is already running — over SSH, for a headless box
npx frizz --sessions      # the devices holding a session
npx frizz --sign-out all  # revoke them
```

A device can sign itself out: **Sign out this device** in Settings ends that browser's session and nothing else. Signing out any other device is still `frizz --sign-out`, which runs only on the host (SSH counts), so a stolen phone cannot sign out the laptop.

## Try it without touching your board

A second Frizz that shares nothing with the one you run: a throwaway home and project, its own port, deleted when you press ctrl-c.

```sh
npx frizz --sandbox
```

Press **R** in it and walk through any setup. Credentials come along (`gh`, cloudflared's certificate and tunnel files, the agent CLIs, and on macOS the login keychain), so every screen sees what the real board sees; the saved setup, the registry and the session key are throwaway copies.

## A private name on frizz.sh

The default, and the shortest path there is: pick it and you are done. Frizz mints an unguessable name — 20 random characters, so nobody can find it by guessing — claims it with this machine's own key, and serves the board at it. No account, no sign-in, no domain, no port forwarding, no extra binary.

```
  Serving https://mk7w2qp9x4n3f6tbz5vh.frizz.sh (frizz.sh).

  Scan to sign in on a phone. Single use, expires in 5 minutes. Press L later for another.
```

The done screen shows that link as a QR code. The name is the address, not the lock: the first visit still needs the single-use sign-in link, so someone who somehow learns the name still meets a closed door.

## A custom name on frizz.sh

Paused. A name you choose, such as `ada.frizz.sh`, is tied to a GitHub account, and the GitHub sign-in it needs is not set up yet. Until it is, the **R** menu does not offer a custom name; use a private name, or a domain of your own below.

A board that already holds a custom name keeps it. Every launch renews the name with this machine's key alone, so no GitHub sign-in is involved, and the menu still lists the name as the current setup.

## How a frizz.sh name behaves

Every launch renews the lease. A name nobody has run for **30 days** is released.

Your board stays on loopback and **dials out** to `frizz.sh`, which is what removes the inbound port, the tunnel binary and the DNS record all at once — a laptop behind any NAT works with no configuration. The connection comes back by itself after a sleep or a network change, so a board is reachable again when the machine is.

### What you are agreeing to

- **One name per machine key.**
- **The name is a lease, not property.** It lapses after 30 days unused, and Frizz can reclaim any name at any time — that is the only enforcement there is, so it has to exist.
- **No warranty.** This is a free convenience on a domain someone else owns. Anything you cannot afford to lose access to belongs on a domain you control; every other section here shows how.
- **Your traffic passes through us.** A name on frizz.sh is served by a relay we run: every request and every keystroke goes through it. Frizz's own access gate still runs on your machine, so a visitor meets it whether or not the relay is honest — but if you would rather no third party carried the bytes, use a domain you control.

## Cloudflare Tunnel

Needs a domain you control on Cloudflare and `cloudflared` on this machine. Create the tunnel and its DNS record once, in another terminal:

```sh
cloudflared tunnel login                                  # pick your zone
cloudflared tunnel create my-board
cloudflared tunnel route dns my-board board.example.com
```

Point the tunnel at the board in `~/.cloudflared/frizz.yml`, which Frizz looks for by name. Keep it out of `config.yml`, whose catch-all shadows other tunnels:

```yaml
tunnel: my-board
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: board.example.com
    service: http://127.0.0.1:9393
  - service: http_status:404
```

Then pick **Cloudflare Tunnel** and name them:

```
  Hostname   board.example.com
  Tunnel     my-board
```

Frizz runs the tunnel beside the board, so the two share a lifetime: a tunnel that outlives its board serves Cloudflare error 1033, and a board that outlives its tunnel is unreachable with nothing to say why.

## Tailscale

Tailscale gives the machine a stable HTTPS name on your tailnet and terminates TLS itself, so only your devices can reach it. Run once, in another terminal:

```sh
tailscale serve --bg 9393     # Frizz's port
```

Then pick **Tailscale**. Frizz reads this machine's MagicDNS name from the daemon and offers it as the origin; enter accepts it.

## Something else

The rule is the same for Caddy, nginx, ngrok or anything else: terminate TLS wherever you like, proxy to `http://127.0.0.1:9393`, and give Frizz the exact origin a browser will show — scheme and host, no path. Frizz answers only to that `Host` and prints its sign-in link for it.

## Headless machines

A machine nobody watches still mints links on demand — sign in over SSH and ask the running board for one:

```sh
ssh you@box npx frizz --link
```

The link prints as a QR and a URL, is single-use, and expires in five minutes. The setup itself is made once from an interactive terminal; the saved choice (`cloud.json`, next to Frizz's registry — `~/Library/Application Support/Frizz` on macOS, `~/.frizz` on an install that already has one) is what a headless launch serves.

## SSH port forwarding

Needs no setup at all. The forwarded port is loopback on both ends, so Frizz treats it as local:

```sh
ssh -L 9393:127.0.0.1:9393 you@your-machine
# then open http://127.0.0.1:9393 on the client
```

Nothing is exposed and no sign-in link is involved. The cost is that the tunnel lives as long as the SSH session, which makes it awkward from a phone.
