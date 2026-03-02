Live Internet Simulation

An interactive, real‑time simulation of how data travels across the internet. Watch packets move through routers, see protocol handshakes in action, and experiment with network failures – all from your browser.

## Features

- **Live packet animation** – Visualize DNS, TCP, TLS, and HTTP traffic as it flows from client to server and back.
- **Protocol state machine** – Follow the exact steps of a secure login: DNS resolution → TCP handshake → TLS encryption → HTTP POST.
- **Multiple failure scenarios** – Simulate real‑world issues: wrong password, DNS failure, packet loss, server down, no internet, slow network.
- **OSI / TCP‑IP stack** – See which layer is active at each step (Application, Transport, Network, etc.).
- **Packet inspector** – Examine packet details: source/destination IP, ports, sequence numbers, TTL, flags.
- **Encapsulation view** – Watch how data is wrapped inside Ethernet, IP, TCP, and HTTP headers.
- **Interactive canvas** – Pan, zoom, and click on nodes to see their IP and status.
- **Routing table overlay** – View simplified routing tables of core routers.
- **Responsive design** – Works on desktop, tablet, and mobile.

## How to Use

1. Open `index.html` in any modern browser.
2. Select a scenario from the left panel (e.g., “Normal Login”, “Packet Loss”).
3. Click the **CONNECT** button to start the simulation.
4. Watch packets travel across the network – the event log and packet inspector update in real time.
5. Use the **top bar** to switch views (Network, Encapsulation, Routing), toggle Slow Mo, or replay.
6. **Pan** the canvas by dragging, **zoom** with mouse wheel or the on‑screen buttons.
7. **Hover** over any node to see its IP and description; click to log its info.

## Scenarios Explained

| Scenario       | Behavior                                                                 |
|----------------|--------------------------------------------------------------------------|
| Normal Login   | Full successful flow: DNS → TCP → TLS → HTTP 200 OK.                     |
| Wrong Password | Server returns HTTP 401 Unauthorized.                                    |
| DNS Failure    | DNS server does not respond – connection cannot proceed.                 |
| Packet Loss    | A packet is dropped mid‑route; TCP retransmits.                          |
| Server Down    | App servers are offline; TCP handshake times out.                        |
| No Internet    | ISP router is down – packets dropped at the first hop.                   |
| Slow Network   | Packet speed is reduced; database lookup takes longer.                   |

## Technical Stack

- Pure HTML, CSS, and JavaScript (no external libraries).
- Canvas‑based rendering with custom camera (pan & zoom).
- Object‑oriented simulation engine with `NetNode` and `Packet` classes.
- Protocol logic implemented as state machines with callbacks.

## File Structure

- `index.html`
- `style.css`
- `script.js`
- `README.md` – This file.

