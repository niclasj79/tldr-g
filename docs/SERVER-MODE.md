# Running TLDR-G Desktop as a server

TLDR-G Desktop normally talks to one browser window on the machine it is
installed on. This page is for extending that reach: your **own** phone,
tablet, or laptop reading the same graph from anywhere, or a short-lived
public link for a demo. It stays inside the free Desktop licence — one
person's own devices, or a demo you are showing someone — not serving other
people's day-to-day use as an organization. If that is what you need, that is
TLDR-G Server, in development; write to us.

Everything here happens on your own machine. Nothing is installed or run by
us; you are the operator.

---

## Before you start

- **Never set `TPVRG_API_HOST=0.0.0.0` on a network you don't fully trust.**
  It publishes the engine — unauthenticated by default on your LAN — to every
  other device on that network, with no warning shown to anyone else on it.
  Leave the app bound to `127.0.0.1` (its default) and use one of the tools
  below to reach it from elsewhere. They terminate the connection safely
  without ever widening the app's own bind address.
- Reaching the app remotely still goes through the auth layer described
  below (device tokens). A tool that exposes the *port* does not, by itself,
  expose the *data* — the token is what does that, deliberately.

---

## 1. Keep the machine awake

A laptop that sleeps stops answering. On the machine you're serving from,
while it's plugged in:

```
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

The display timeout doesn't affect anything running in the background, but
sleep and hibernate do. On a laptop, also check **Control Panel → Power
Options → Choose what closing the lid does** and set the plugged-in action to
**Do nothing** — closing the lid otherwise sleeps the machine regardless of
the settings above.

## 2. Run the engine at logon

TLDR-G Desktop ships as a windowed app (`TLDR-G.exe`) with a system tray icon
— there is no separate headless/console build today. In practice, "headless"
means: launch it at logon and leave the window minimized rather than closed
(closing the window quits the app; minimizing does not). The tray icon is
your confirmation that it's still running.

Set any server-mode environment variables once, so every future logon
inherits them without you re-typing anything:

```
setx TPVRG_SERVER_MODE 1
```

Then register the launch itself with Task Scheduler:

```
schtasks /create /tn "TLDR-G Server" /tr "\"C:\Program Files\TLDR-G\TLDR-G.exe\"" /sc onlogon /rl highest /f
```

Log off and back on to confirm it starts on its own before you rely on it.

## 3. Reach your own devices — Tailscale Serve

[Tailscale](https://tailscale.com) puts your devices on one private network
(a *tailnet*) over WireGuard, and its `serve` command turns a local port into
an HTTPS address only devices signed into that tailnet can reach.

> **What is reachable without a token, by design:** two pages and one probe —
> `GET /` (the Cockpit, which is the page that asks for your token),
> `GET /review.html` (the offline verifier) and `GET /health` (liveness and
> security posture, so an operator can read whether auth is on before holding
> a token; it carries no graph data). Every other route answers `401` until a
> valid bearer token is presented; failed attempts share one throttle and turn
> into `429` with a `Retry-After` header past the limit (30 per minute across
> all callers by default), while requests carrying a valid token keep passing.

1. Install Tailscale on the desktop and on each device you want to read from,
   and sign them all into the same tailnet.
2. Leave `TPVRG_API_HOST` unset (or `127.0.0.1`) — Tailscale reaches the app
   from outside without the app itself needing to bind anywhere wider.
3. On the desktop:
   ```
   tailscale serve 8321
   ```
   (8321 is the engine's default port — `DEFAULT_API_PORT` — adjust if you
   changed `TPVRG_API_PORT`.) Tailscale prints the HTTPS address it now
   answers on — something like `https://<your-machine-name>.<your-tailnet>.ts.net`.
4. Open that address from your phone or laptop, signed into the same
   tailnet. No port-forwarding on your router, and the address resolves to
   nothing outside the tailnet.

**Where TLS actually terminates.** The certificate is issued to your
tailnet's own name and the HTTPS connection ends **on your desktop** —
Tailscale's relay network (used only when two devices can't reach each other
directly) carries already-encrypted bytes and never decrypts them. This is
the property that makes Serve safe for `serve`-only use even before you add
the device-token layer below.

## 4. A public demo — Tailscale Funnel

`tailscale funnel` is the same idea extended past your tailnet, to anyone
with the link — no Tailscale account needed on the visitor's end.

```
tailscale funnel 8443
```

**Funnel only forwards a small set of ports: 443, 8443, and 10000.** Pick one
of those three for whichever instance you're putting on Funnel (see the
two-instance pattern below — it should not be the same port your real graph
lives on).

The same TLS story holds: your desktop terminates the connection; Tailscale's
global network carries the encrypted bytes to the internet but never reads
them. Funnel does need to be explicitly enabled once for your tailnet (from
the Tailscale admin console, if it isn't already) — the CLI tells you if it
isn't.

**Before you script this unattended, check the flag yourself:**

```
tailscale funnel --help
```

Tailscale's exact flag for running Funnel detached/in the background has
moved between versions — read what your installed version actually offers
rather than trusting a remembered flag from an older release.

## 5. The two-instance pattern — don't Funnel your own graph

Serve and Funnel each bind a specific port, and a given local port is behind
**one or the other, never both** on the same machine. That split is also
the right security boundary, so lean into it rather than working around it:

- **Instance A — your real graph.** Your own `TP_VRG_HOME`, your own
  ingested documents. Bind it behind `tailscale serve` only. Reachable from
  your own signed-in devices, never from the open internet.
- **Instance B — a demo world.** A separate `TP_VRG_HOME` pointed at sample
  or synthetic content, nothing of yours. Bind it behind `tailscale funnel`.
  Reachable by anyone with the link.

Two separate processes, two separate `TP_VRG_HOME` directories, two ports:

```
set TP_VRG_HOME=C:\Users\you\.tp_vrg
set TPVRG_API_PORT=8321
TLDR-G.exe

set TP_VRG_HOME=C:\tmp\tldr-g-demo-world
set TPVRG_API_PORT=8443
TLDR-G.exe
```

Then `tailscale serve 8321` on the first, `tailscale funnel 8443` on the
second. Never point Funnel at the port your real graph answers on.

## 6. Minting and revoking device tokens

Every non-admin visitor — a device of your own on Serve, or anyone on
Funnel — reads through a **device token**, not the admin token you set up
the app with. Mint and manage these from the Cockpit itself: open **Inspect
→ Server**, where you can see the bind address, whether server mode and the
served UI are active, and the list of tokens issued so far.

- **Mint** a token with a label (so you remember what it's for — "my phone",
  "the demo") and an expiry in hours. The token's value is shown **once**;
  copy it into the device or share it with your demo visitor immediately —
  it cannot be retrieved again after you navigate away.
- **Revoke** a token instantly from the same list. A revoked token stops
  working on its next request; it needs no restart of the engine and no
  server flag to take effect — revocation is reachable with the engine's
  default posture, on purpose, because it is the act you need when you have
  prepared nothing.
- A device token can read and ask questions, but cannot ingest new documents
  or activate a different graph — those stay admin-only. The admin token
  itself does not appear in this list and cannot be revoked from it.

Mint one token per device or per person, scoped to how long you actually
need it (a demo token for the length of the demo, not open-ended). Never
hand out the admin token for a demo — a device token is what exists so you
never have to.

## 7. Cloudflare Tunnel — the fallback

If Tailscale isn't an option for a visitor (you don't want to ask a stranger
to install anything, or your own network policy blocks it), [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared`) gives you a public URL without opening a port on your router:

```
cloudflared tunnel --url http://127.0.0.1:8443
```

A quick tunnel like this needs no Cloudflare account and prints a temporary
`https://<random>.trycloudflare.com` address; a persistent named tunnel needs
a Cloudflare account and a one-time `cloudflared tunnel login` plus config.

**The plaintext caveat.** This is the one place this document's TLS story
changes. With Cloudflare Tunnel, the public HTTPS connection terminates at
**Cloudflare's edge**, not on your desktop — Cloudflare's infrastructure sees
the request in plaintext before it re-encrypts (or doesn't) the last hop to
`cloudflared` on your machine. That is a different trust boundary than
Tailscale Funnel, where nothing between your desktop and the visitor's
browser can read the bytes. Use Cloudflare Tunnel only for the demo-world
instance, never for your real graph, and treat it as a fallback for when
Tailscale genuinely isn't available rather than a first choice.

## 8. The remote smoke checklist

Before you rely on any of this, or before showing it to someone else, work
through this list end to end:

1. From your own phone, on cellular data (not your home Wi-Fi), open the
   Serve URL and confirm the token screen appears.
2. Sign in with a device token minted from Inspect → Server (not the admin
   token).
3. Ingest a small document, ask a question, confirm the streamed answer and
   its receipt both arrive.
4. Open the Board tab and confirm it renders on a phone-sized screen.
5. From a device that is **not** on your tailnet, open the Funnel URL and
   confirm it loads the demo-world instance, not your real graph.
6. Confirm that device's token is refused (not silently ignored) on
   `/ingest` and on `/graphs/{slug}/activate` — a device token reads, it does
   not write.
7. Revoke that token from Inspect → Server and confirm the same device gets
   a 401 on its next request, with no restart needed.
8. Deliberately fail a bearer check repeatedly (a wrong or expired token) and
   confirm you eventually get a `429` with a `Retry-After` header rather than
   an unthrottled retry loop.

If every step above holds, the remote setup is doing what this page claims.

---

## Related

- `OFFLINE-INSTALL.md` — the `/OFFLINEMODELS` installer parameter, for a server instance with no internet access to Hugging Face
- The Releases page of this repository — the installer and the offline model pack

_This copy ships with the public repository; it is the operator guide for reaching TLDR-G Desktop remotely._
