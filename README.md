# dsh-wireguard

A DeepSeek Harness plugin that turns a Windows or Linux machine into a WireGuard
server, or joins it to one, from a dedicated panel in the Harness Web UI.

The panel has two tabs, matching the workflow:

1. **Service** — start the WireGuard interface and a LAN-facing control panel.
2. **Client** — enter the server's control-panel address, receive a VPN address,
   and bring up the local tunnel.

Once joined, every device can reach the others through its private `10.66.66.x`
address. Traffic stays inside the WireGuard subnet; the default internet route
is not changed.

## Requirements

| Platform | Required software | Privilege |
| --- | --- | --- |
| Linux server/client | `wireguard-tools` (`wg`) and `iproute2` (`ip`) | root, or passwordless `sudo` for `wg`/`ip` |
| Windows server/client | Official WireGuard for Windows (`wireguard.exe` + `wg.exe`) | Harness must run as administrator |

The panel detects missing tools and offers a **Install WireGuard** action:

- **Windows** — downloads the official installer and starts it with UAC approval
  when Harness is not elevated.
- **Linux** — uses `apt`, `dnf`, `yum`, `pacman`, `zypper`, or `apk`, trying
  passwordless sudo first and `pkexec` as a desktop fallback. If neither is
  available, the panel shows the exact `sudo …` command to run once.

Manual installation still works:

```bash
sudo apt install wireguard iproute2
# or
sudo dnf install wireguard-tools iproute
```

Windows: install from <https://www.wireguard.com/install/>, then press
**Recheck** (or restart Harness).

## Use

### Server (Linux A)

1. Open **WireGuard** in the Harness sidebar.
2. Stay on **Service**.
3. Review the control-panel port (`51821`), WireGuard port (`51820`), VPN subnet
   (`10.66.66.0/24`), and advertised LAN address. Leave the address empty to
   auto-detect it.
4. Review the join code. The plugin generates a random one when none exists.
   The same value is the control-panel password: clients enter it to join, and
   browsers ask for it when opening the control-panel URL (any username works).
   Editing it changes both uses.
5. Press **Start service**.
6. Allow TCP `51821` and UDP `51820` through the server firewall.

The panel then shows the address to type on clients, for example
`192.168.1.10:51821`.

### Clients (Windows B, Linux C)

1. Open **WireGuard** and choose **Client**.
2. Enter the server's control address, for example `192.168.1.10:51821`.
3. Enter the join code shown on the server's Service tab.
4. Press **Connect**.

The client receives an address such as `10.66.66.2`, writes a private
configuration, and starts the tunnel. It can then reach the server and the other
joined devices by their VPN addresses.

### One-click Linux client deployment (unknown distribution)

While the service is running, the Service tab also shows a **Linux client
deployment** card with separate **IPv4** and **IPv6** targets and two single-line
commands for each: a simple curl-only version and a full version with downloader
fallbacks. Both commands detect whether they are already root and prepend `sudo`
when needed. The control panel serves the parameterized bootstrap as a public
static resource at `/client.sh`; the copied command downloads it, makes it
executable, runs it with the control URL, join code, and address family as
arguments, and (in the full version) removes the temporary file. Paste one whole
line into the target machine's terminal and press Enter. The bootstrap prints
`[dsh-wg]` step-by-step logs so progress and failures are visible.

The bootstrap detects `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, or `apk`,
installs WireGuard, joins with the current join code, writes
`/etc/wireguard/dshwg0.conf`, starts the tunnel, and enables it at boot when
systemd is available. If it cannot identify the package manager, it prints the
packages to install manually.

The copied command contains the join code, which is also the control-panel
password. Send it only to a trusted device.

### IPv6-only clients (IPv4 VPN inside)

The VPN subnet stays IPv4 (`10.66.66.0/24`). IPv6 is supported as the outer
transport: the control panel listens dual-stack, WireGuard listens on both IPv4
and IPv6, and the deployment card has a separate **IPv6** target. The target uses
the advertised IPv6 address when one is configured, otherwise the server's
detected global IPv6 address.

For an IPv6-only client:

1. Allow **TCP 51821** and **UDP 51820** for IPv6 in the cloud security group
   and host firewall.
2. In the deployment card choose **IPv6**, then copy either command.
3. The client joins over IPv6, receives `10.66.66.x`, and routes that IPv4 VPN
   subnet inside the tunnel. The server's join reply advertises the IPv6
   WireGuard endpoint for this client.

No IPv6 VPN address pool is created. SSH and other VPN traffic to the client
still use its `10.66.66.x` address. If the server has no reachable IPv6 address,
the IPv6 target is disabled; use a dual-stack relay or NAT64 in front of the
server. If **Advertised address** is itself an IPv6 literal, only the IPv6 target
is available; use an IPv4 address or a dual-stack DNS name to keep IPv4 clients.

## Troubleshooting

### A joined peer stays offline

The panel marks a peer offline when the server has not seen a recent WireGuard
handshake. Joining uses TCP `51821`, but the tunnel itself uses UDP `51820`.
Allow **UDP `51820`** (not TCP) inbound in the cloud security group and the host
firewall, and make sure the client network allows outbound UDP. If the peer was
created but `lastHandshakeAt` is empty, the handshake packets are not reaching
the server.

To confirm, run on the server while restarting the tunnel on the client:

```bash
sudo tcpdump -ni eth0 udp port 51820
```

No captured packets point to a security-group, NAT, or client-egress problem.
Captured packets without a handshake point to a peer-key mismatch; compare
`sudo wg show dshwg0 public-key` on the client with the fingerprint shown in the
panel and re-join if they differ.

A machine in client mode does not normally need an inbound UDP rule: it
initiates the handshake, and stateful firewalls allow the reply. It does need
outbound UDP to the server (cloud egress and host firewall), plus TCP `51821`
for joining. Only a machine that also accepts WireGuard connections needs
inbound UDP on its own listen port. If the client's firewall drops all inbound
traffic without connection tracking, allow the established/related reply or UDP
from the server's address.

### SSH access to a client

In the **Connected devices** table, click **SSH** on a joined peer, enter the
Linux user the server should log in as, and copy the generated command. Run that
command on the client; it adds the server's public key to that user's
`authorized_keys`. The private key is generated on the server and stored under
`$DSH_HOME/wireguard/ssh/` with mode `0600`; it is never displayed in the panel
or included in the copied command.

After the client command succeeds, the server can connect over the VPN address:

```bash
ssh -i "$DSH_HOME/wireguard/ssh/<peer-key-file>" <user>@10.66.66.2
```

The client must accept SSH public-key authentication, and its own firewall must
allow SSH (usually TCP `22`) from the WireGuard subnet.

## Data and security

State lives under `$DSH_HOME/wireguard` (`C:\Users\<user>\.dsh\wireguard` on
Windows). It contains:

- `state.json` — peer registry, public keys, settings; WireGuard and SSH
  private keys are **not** in this file.
- `server.key` / `client.key` — WireGuard private keys, written with mode `0600`
  where the OS supports it.
- `ssh/<hash>.key` — per-peer SSH private keys for server-to-client access,
  written with mode `0600` where the OS supports it.
- `server.conf` / `client.conf` — generated WireGuard configurations. On Windows
  the file is named after the tunnel (for example `dshwg0.conf`), because
  WireGuard uses the filename as the tunnel service name.

The LAN control panel never returns a private key. A random join code is
generated when none exists, and that single value protects both joining and
browser access: the status page and peer list require an in-page login with the
join code as the password, backed by an HttpOnly session cookie. The
`/client.sh` bootstrap and `/health` endpoint stay public because they contain
no secrets; the join code is passed to `/client.sh` as an argument by the
one-click command.

Because the join code must be shown to clients and entered on the control-panel
prompt, `state.json` stores it as plain text, protected by mode `0600`. Treat
that file as a secret.

The control panel is plain HTTP. A password sent over HTTP is only as private as
the network path, so use it on a trusted LAN or put a TLS reverse proxy in front
of it before exposing it to the internet. The WireGuard UDP endpoint cannot go
through an ordinary HTTP reverse proxy and should be published directly.

## Architecture

- **Host plugin** (`src/index.ts`, bundled to `index.js`) — manages keys, peer
  addresses, interface lifecycle, installation, and the external control-panel
  HTTP service.
- **Panel API** — same-origin `/api/dsh-wireguard/*` routes on the Harness web
  server, used by the panel. Mutating calls require the
  `x-dsh-wireguard: 1` header.
- **Client panel** (`src/client/index.tsx`, bundled to `client.js`) — a
  React + Ant Design main-panel page plus a sidebar icon, registered through
  `ctx.slots`, localized through `ctx.locale`, and themed through
  `ConfigProvider` plus the Harness theme service.
- **Control panel** — a separate HTTP listener on `0.0.0.0:51821` so clients on
  other machines can join without exposing the Harness API.

The source is TypeScript throughout. Ant Design is bundled into `client.js`;
React and React DOM remain the host-provided browser modules.

The server adds each peer with `AllowedIPs = <peer>/32`. Clients route only the
VPN subnet through the server. The server enables IPv4 forwarding and adds a
best-effort peer-to-peer FORWARD rule. On Windows server mode, client-to-client
routing may still require additional Windows routing configuration; a Linux
server is recommended for a full mesh.

## Development

Install the build dependencies once, then type-check, test, and bundle:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` produces `index.js` (Host) and `client.js` (React + Ant Design).
The browser bundle externalizes `react`, `react-dom`, and `react/jsx-runtime`;
everything else needed by the panel, including Ant Design, is bundled.

The plugin is installed as a local DSH bundle:

```text
C:\Users\<user>\Documents\deepseek-harness\default-workspace\dsh-wireguard
```

## Limitations

- The WireGuard interface is managed through the system tools; it is not a
  bundled userspace implementation.
- Windows requires Harness to run elevated for both server and client modes.
- Starting the server requires the chosen ports to be free and allowed by the
  host firewall.
- The control panel is HTTP, intended for a trusted LAN. Do not expose
  `51821` directly to the public internet without an additional TLS/reverse
  proxy layer.
- The panel does not configure DNS search domains or internet-wide tunneling;
  it routes the WireGuard subnet only.
