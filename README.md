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
4. Optionally set a join code. Leaving it empty allows any device on the LAN to
   join; set one for a shared or untrusted network.
5. Press **Start service**.
6. Allow TCP `51821` and UDP `51820` through the server firewall.

The panel then shows the address to type on clients, for example
`192.168.1.10:51821`.

### Clients (Windows B, Linux C)

1. Open **WireGuard** and choose **Client**.
2. Enter the server's control address, for example `192.168.1.10:51821`.
3. Enter the join code if the server has one.
4. Press **Connect**.

The client receives an address such as `10.66.66.2`, writes a private
configuration, and starts the tunnel. It can then reach the server and the other
joined devices by their VPN addresses.

## Data and security

State lives under `$DSH_HOME/wireguard` (`C:\Users\<user>\.dsh\wireguard` on
Windows). It contains:

- `state.json` — peer registry, public keys, settings; private keys are **not**
  in this file.
- `server.key` / `client.key` — private keys, written with mode `0600` where the
  OS supports it.
- `server.conf` / `client.conf` — generated WireGuard configurations. On Windows
  the file is named after the tunnel (for example `dshwg0.conf`), because
  WireGuard uses the filename as the tunnel service name.

The LAN control panel exposes only health data and a join endpoint. It never
returns a private key. A join code is checked when configured; peer listing also
requires it. The control panel is unauthenticated when no join code is set, so
only enable that mode on a trusted LAN.

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
