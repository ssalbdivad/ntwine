---
name: gcloud-vm
description: >-
  Provision, start, reach and use Google Cloud VMs — for any real-OS work the macOS host and Docker
  cannot do. Above all: REAL WINDOWS, which is the only way to check that ntwine still runs there now
  that tmux is gone. Invoke whenever you think "I need a Windows box" or "I need a Linux box": you can
  START the standing `nub-linux`/`nub-win` instances or CREATE a fresh one on demand. Carries the
  gotchas that each cost a cycle — IPs change on every restart, the SSH user is `nub` with key
  `~/.ssh/nub-vm`, a RUNNING box can be a wedged box (read the serial console), and the whole
  Windows-SSH bring-up sequence, which is NOT the documented one. AUTH IS NOT A BLOCKER: prefix any
  command with CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE and never conclude the VMs are unavailable from
  a "Reauthentication failed" error until you have tried it.
metadata:
  internal: true
---

# Google Cloud VMs

You have `gcloud` and can create/start/stop VMs yourself. Any time a task needs a real OS the Mac host
and Docker cannot give you, spin one up. Project `pullfrog`, zone **`us-central1-a`** — gcloud's default
zone is `us-west1-a`, so **always pass `--zone us-central1-a` explicitly**.

**For ntwine specifically, the case that matters is Windows.** tmux is gone, so Windows is a supported
platform on paper; the only way to keep that true is to actually run there. See the Windows section
below — the bring-up is fiddly and the recipe here is the one that works.

## Auth: use the service-account key, not `gcloud auth login`

The user credential's refresh token gets revoked periodically by org session-control policy, so
interactive login is not durable. A service-account key is exempt and works non-interactively:

```sh
export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=~/.config/pullfrog/vertex-service-account.json
gcloud compute instances list --project=pullfrog
```

It has Owner on `pullfrog`, so `list`/`describe`/`start`/`stop`/`create`/`delete` all work. Only fall
back to `! gcloud auth login` if this errors `Reauthentication failed`.

## The standing instances, and when to make your own

| Name | OS | Purpose |
|---|---|---|
| `nub-linux` | Ubuntu 24.04, e2-standard-4 | Real Linux-kernel enforcement (Landlock/seccomp/netns) |
| `nub-win` | Windows Server 2022 | Real Windows |

They belong to the `nub` project and may be stopped, wedged, or configured for someone else's key —
**do not assume you can reach them.** (Measured 2026-08-03: `nub-win` timed out during banner exchange
and `nub-win2` refused the `nub-vm` key with "Too many authentication failures".) When that happens,
**create your own throwaway box** rather than fighting theirs, and delete it when done.

```sh
gcloud compute instances create ntwine-win-tmp \
  --zone us-central1-a --project pullfrog \
  --machine-type e2-standard-4 \
  --image-family windows-2022 --image-project windows-cloud \
  --boot-disk-size 50GB

gcloud compute instances delete ntwine-win-tmp --zone us-central1-a --quiet   # a created VM bills its disk even when STOPPED
```

## SSH — user `nub`, key `~/.ssh/nub-vm`, and the IP is DYNAMIC

**Re-read the IP on every reconnect, not once per session.** A box can be stopped out from under you
mid-run and come back on a different address, so a sudden timeout on a previously-working box usually
means "it moved", not "it wedged".

```sh
IP=$(gcloud compute instances describe "$NAME" --zone us-central1-a --project=pullfrog \
      --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
ssh -i ~/.ssh/nub-vm -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -o ConnectTimeout=15 nub@"$IP" 'echo ok'
```

`-o IdentitiesOnly=yes` matters: without it ssh offers every key in your agent and the server closes the
connection with "Too many authentication failures" before it ever tries the right one.

Always reachability-guard a dispatch (`ConnectTimeout`, `timeout`) and retry with backoff after a fresh
start — sshd is not up the instant STATUS flips RUNNING.

## Windows bring-up — the part that is NOT documented anywhere else

A fresh `windows-2022` image will NOT accept SSH, and the failure is silent. Four things must be true,
and the official `enable-windows-ssh=TRUE` metadata alone gets you none of them. Do all of it in ONE
create so you only pay for one reset:

1. **The image ships no OpenSSH Server.** The guest agent logs `Could not determine if openssh version
   is compatible: could not find version` and gives up. Install it from a startup script.
2. **The guest agent only creates the `nub` account when it sees `ssh-keys` metadata**, and after the
   first pass it says `No new keys found, skipping account setup` and never writes `authorized_keys`.
   So pass the metadata AND write the key yourself.
3. **`nub` is an Administrator, and Windows OpenSSH ignores `~/.ssh/authorized_keys` for admins.** The
   key must go in `C:\ProgramData\ssh\administrators_authorized_keys`, with inheritance stripped.
4. **A startup script only runs at boot**, so `add-metadata` must be followed by
   `gcloud compute instances reset`.

```powershell
# win-ssh-setup.ps1 — ASCII ONLY (see the codepage gotcha below)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd -ErrorAction SilentlyContinue
$key = '<contents of ~/.ssh/nub-vm.pub>'
New-Item -ItemType Directory -Force -Path "C:\Users\nub\.ssh" | Out-Null
Set-Content -Path "C:\Users\nub\.ssh\authorized_keys" -Value $key -Encoding ascii
$adm = "C:\ProgramData\ssh\administrators_authorized_keys"
Set-Content -Path $adm -Value $key -Encoding ascii
icacls.exe $adm /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
Restart-Service sshd -ErrorAction SilentlyContinue
```

```sh
gcloud compute instances create ntwine-win-tmp --zone us-central1-a --project pullfrog \
  --machine-type e2-standard-4 --image-family windows-2022 --image-project windows-cloud \
  --boot-disk-size 50GB \
  --metadata enable-windows-ssh=TRUE,ssh-keys="nub:$(cat ~/.ssh/nub-vm.pub)" \
  --metadata-from-file windows-startup-script-ps1=win-ssh-setup.ps1
gcloud compute instances reset ntwine-win-tmp --zone us-central1-a --project pullfrog
```

Then poll for `$env:PROCESSOR_ARCHITECTURE` to come back `AMD64`. Read the progression: `Operation
timed out` → the network path or sshd is not up; `Connection refused` → the path is open and sshd is
not listening; `Disconnected from … port 22` → sshd is up and your key is being rejected (go fix
`administrators_authorized_keys`).

### Windows gotchas that each cost a cycle

- **The home directory is `C:\Users\nub.<HOSTNAME>`, not `C:\Users\nub`.** Always use
  `$env:USERPROFILE`; a hardcoded `C:\Users\nub\…` silently misses.
- **`nub.exe` needs the MSVC runtime.** A bare Server 2022 has none, and the only symptom is exit code
  `-1073741515` (`0xC0000135`, DLL_NOT_FOUND) with no message. Install `vc_redist.x64.exe` first.
- **This repo needs pnpm, not npm.** `npm install` fails `EUNSUPPORTEDPROTOCOL Unsupported URL Type
  "workspace:"`. Install `pnpm@10` globally, then `pnpm install --no-frozen-lockfile`.
- **Write every remote PowerShell script as ASCII + CRLF.** PowerShell 5.1 reads a BOM-less script in
  the ANSI codepage, so one UTF-8 character anywhere — an em-dash in a *comment* is the usual culprit —
  fails with `The string is missing the terminator`, and the error points at the LAST line of the file
  rather than the offending one.
- **`-File` with a path containing the profile directory can fail to resolve; use
  `-Command "& \"$env:USERPROFILE\script.ps1\""`** so the guest expands the path.
- **PowerShell's `Tee-Object`/`Out-File` write UTF-16LE by default.** A log you `scp` back will look
  like it has NUL bytes between every character; `iconv -f UTF-16LE -t UTF-8`, or pass
  `-Encoding utf8`.
- **`IsOutputRedirected` is always True over SSH**, so any `is_terminal()` branch takes the non-TTY
  path and first-run console behavior cannot be exercised. That needs a ConPTY harness or RDP.
- **A long run will outlive a foreground command.** Redirect to a file on the GUEST, run the SSH
  command in the background, and poll the guest-side file — an SSH pipe left open for ten minutes gets
  `client_loop: send disconnect: Broken pipe`, and the harness reports the *pipeline's* exit code, so a
  dead run arrives labelled "exit 0".

## Other gotchas

- **A RUNNING instance can be a DEAD instance — read the serial console FIRST.**
  ```sh
  gcloud compute instances get-serial-port-output "$NAME" --zone us-central1-a | tail -40
  ```
  This diagnosed an 11-day SSH-dead box instantly (an OOM had wedged sshd). It beats guessing "network
  problem" every time, and on Windows it is the only way to see what the guest agent is doing.
- **Judge results by behavioral/differential evidence** — EPERM vs success, a before/after delta, a
  control that must still fail — not wall-clock, since a shared VM may be contended.
- **Delete your box.** `gcloud compute instances delete <name> --zone us-central1-a --quiet`. Verify
  with `instances list` that only the pre-existing ones remain.

## Worked example: what this caught

Driving a real `windows-2022` box on 2026-08-03 found two Windows bugs that every local gate had
passed: a Codex `cwd` validator gated on `startsWith("/")` (rejecting every `C:\` path — 41 tests), and
the broker resolving `claude` to npm's `#!/bin/sh` shim instead of the native `claude.exe`, which broke
every Claude dispatch on Windows. The second one also killed the *obvious* fix: preferring `.cmd` via
PATHEXT returns a path Node refuses to spawn without a shell (`EINVAL`, CVE-2024-27980). Only running
it on the real OS surfaced that — reasoning about it produced a confident wrong answer.
