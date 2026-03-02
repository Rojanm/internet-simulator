// ============================================================
// NETLAB — FULL INTERNET SIMULATION ENGINE (unchanged)
// ============================================================

// ===== CONSTANTS =====
const W = () => document.getElementById('canvas-area').clientWidth;
const H = () => document.getElementById('canvas-area').clientHeight;

// ===== CAMERA =====
const Camera = {
  x: 0, y: 0, scale: 1,
  pan(dx, dy) { this.x += dx; this.y += dy; },
  zoom(factor) {
    this.scale = Math.max(0.4, Math.min(2.5, this.scale * factor));
  },
  reset() { this.x = 0; this.y = 0; this.scale = 1; },
  toWorld(sx, sy) {
    return { x: (sx - W()/2 - this.x) / this.scale, y: (sy - H()/2 - this.y) / this.scale };
  },
  transform(ctx) {
    ctx.translate(W()/2 + this.x, H()/2 + this.y);
    ctx.scale(this.scale, this.scale);
  }
};

// Pan with mouse
(function initPan() {
  let dragging = false, lastX, lastY;
  const ca = document.getElementById('canvas-area');
  ca.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  ca.addEventListener('mousemove', e => {
    if (!dragging) return;
    Camera.pan(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
  });
  ca.addEventListener('mouseup', () => dragging = false);
  ca.addEventListener('mouseleave', () => dragging = false);
  ca.addEventListener('wheel', e => { e.preventDefault(); Camera.zoom(e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
})();

// ===== NODE MODEL =====
class NetNode {
  constructor(id, label, type, x, y, info) {
    this.id = id;
    this.label = label;
    this.type = type; // client, router, dns, server, lb, db, isp
    this.x = x; this.y = y;
    this.info = info || {};
    this.status = 'online'; // online, offline, error, busy
    this.highlight = 0; // 0-1 glow intensity
    this.pulse = 0;
    this.connections = []; // connected node ids
    this.routingTable = [];
    this.processingQueue = [];
    this.ip = info.ip || '0.0.0.0';
    this.mac = info.mac || 'AA:BB:CC:DD:EE:FF';
  }
}

// Node size by type
const NODE_SIZES = { client: 28, router: 22, dns: 24, server: 30, lb: 26, db: 22, isp: 20, core: 18 };
const NODE_COLORS = {
  client: '#00d4ff', router: '#7c3aed', dns: '#10b981',
  server: '#f59e0b', lb: '#00d4ff', db: '#ef4444', isp: '#475569', core: '#94a3b8'
};
const NODE_ICONS = {
  client: '💻', router: '⬡', dns: '🔍', server: '🖥', lb: '⚖', db: '🗄', isp: '📡', core: '●'
};

// ===== PACKET MODEL =====
let packetIdCounter = 0;
class Packet {
  constructor(opts) {
    this.id = ++packetIdCounter;
    this.srcIp = opts.srcIp || '192.168.1.10';
    this.dstIp = opts.dstIp || '93.184.216.34';
    this.srcPort = opts.srcPort || Math.floor(Math.random()*30000+10000);
    this.dstPort = opts.dstPort || 443;
    this.protocol = opts.protocol || 'TCP';
    this.ttl = opts.ttl || 64;
    this.seq = opts.seq || Math.floor(Math.random()*100000);
    this.ack = opts.ack || 0;
    this.flags = opts.flags || 'DATA';
    this.payload = opts.payload || 0;
    this.phase = opts.phase || 'request';
    this.color = opts.color || '#00d4ff';
    this.size = opts.size || 8;
    this.label = opts.label || '';
    this.opacity = 1;
    this.ghost = false; // lost packet

    // Path animation
    this.path = opts.path || []; // array of node ids
    this.pathIndex = 0;
    this.x = 0; this.y = 0;
    this.targetX = 0; this.targetY = 0;
    this.progress = 0; // 0-1 between path[i] and path[i+1]
    this.speed = opts.speed || 0.012;
    this.done = false;
    this.onArrive = opts.onArrive || null; // callback when reaches node
    this.onComplete = opts.onComplete || null;
    this.dropped = false;
    this.dropAt = opts.dropAt || -1; // path index to drop at
    this.trailPoints = [];
    this.encapLayers = opts.encapLayers || 5;
  }
}

// ===== PROTOCOL STATE MACHINE =====
const ProtocolState = {
  IDLE: 'IDLE',
  DNS_QUERY: 'DNS_QUERY',
  DNS_RESPONSE: 'DNS_RESPONSE',
  TCP_SYN: 'TCP_SYN',
  TCP_SYN_ACK: 'TCP_SYN_ACK',
  TCP_ACK: 'TCP_ACK',
  TLS_HELLO: 'TLS_HELLO',
  TLS_CERT: 'TLS_CERT',
  TLS_DONE: 'TLS_DONE',
  HTTP_REQUEST: 'HTTP_REQUEST',
  SERVER_PROCESS: 'SERVER_PROCESS',
  HTTP_RESPONSE: 'HTTP_RESPONSE',
  TCP_FIN: 'TCP_FIN',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
};

// ===== SIMULATION ENGINE =====
const Sim = {
  nodes: {},
  packets: [],
  connections: [],
  state: ProtocolState.IDLE,
  scenario: 'normal',
  slowMo: false,
  speedMultiplier: 1,
  currentConnection: null,
  timeline: [],
  activeLayer: null,
  view: 'network',
  seqCounter: 1000,
  running: false,

  init() {
    this.buildTopology();
    this.running = true;
    this.renderLoop();
    EventLog.log('NetLab initialized. Select scenario and click CONNECT.', 'info');
  },

  buildTopology() {
    // Build network nodes in world coordinates (centered at 0,0)
    // Layout:
    //   Client → HomeRouter → ISP1 → CoreRouter1 ↔ CoreRouter2 → ISP2 → LoadBalancer
    //                                                ↓
    //                                              DNS
    //                              AppServer ← LoadBalancer → AppServer2
    //                                ↓
    //                              Database

    const w = 900, h = 500;
    const hw = w/2, hh = h/2;

    this.nodes = {
      client:    new NetNode('client',    'Client',      'client', -hw+60,  0,     { ip:'192.168.1.10', mac:'A4:C3:F0:11:22:33', desc:'Browser sending login request' }),
      homerouter:new NetNode('homerouter','Home Router', 'router', -hw+180, 0,     { ip:'192.168.1.1',  mac:'D8:3A:DD:AA:BB:CC', desc:'NAT gateway. Translates private→public IP' }),
      isp1:      new NetNode('isp1',      'ISP Edge',    'isp',    -hw+320, 0,     { ip:'203.0.113.1',  desc:'ISP ingress router. BGP peering point' }),
      core1:     new NetNode('core1',     'Core Router', 'core',   -hw+440, -80,   { ip:'10.0.0.1',     desc:'Internet backbone router. High-speed forwarding' }),
      core2:     new NetNode('core2',     'Core Router', 'core',   -hw+440, 80,    { ip:'10.0.0.2',     desc:'Redundant backbone path' }),
      dns:       new NetNode('dns',       'DNS Server',  'dns',    -hw+440, -200,  { ip:'8.8.8.8',      desc:'Resolves domain names to IP addresses' }),
      isp2:      new NetNode('isp2',      'ISP Edge',    'isp',    -hw+560, 0,     { ip:'198.51.100.1', desc:'Server-side ISP router' }),
      lb:        new NetNode('lb',        'Load Balancer','lb',    -hw+700, 0,     { ip:'93.184.216.34',desc:'Distributes requests across app servers' }),
      appserver1:new NetNode('appserver1','App Server 1','server', -hw+820, -80,   { ip:'10.1.0.10',    desc:'Handles login auth logic. JWT generation' }),
      appserver2:new NetNode('appserver2','App Server 2','server', -hw+820, 80,    { ip:'10.1.0.11',    desc:'Standby app server' }),
      database:  new NetNode('database',  'Database',    'db',     -hw+820, 0,     { ip:'10.1.0.50',    desc:'User credentials & session store' }),
    };

    // Routing tables (simplified)
    this.nodes.homerouter.routingTable = [
      { dest: '0.0.0.0/0', nexthop: '203.0.113.1', iface: 'eth0' },
      { dest: '192.168.1.0/24', nexthop: 'local', iface: 'eth1' },
    ];
    this.nodes.core1.routingTable = [
      { dest: '93.184.216.0/24', nexthop: '198.51.100.1', iface: 'ge0' },
      { dest: '8.8.8.0/24', nexthop: 'direct', iface: 'ge1' },
    ];
    this.nodes.core2.routingTable = [
      { dest: '93.184.216.0/24', nexthop: '198.51.100.1', iface: 'ge0' },
      { dest: '0.0.0.0/0', nexthop: '10.0.0.1', iface: 'ge1' },
    ];

    // Connections (edges)
    this.connections = [
      ['client','homerouter'],
      ['homerouter','isp1'],
      ['isp1','core1'],
      ['isp1','core2'],
      ['core1','core2'],
      ['core1','dns'],
      ['core1','isp2'],
      ['core2','isp2'],
      ['isp2','lb'],
      ['lb','appserver1'],
      ['lb','appserver2'],
      ['appserver1','database'],
      ['appserver2','database'],
    ];

    // Set up neighbor lists
    this.connections.forEach(([a,b]) => {
      this.nodes[a].connections.push(b);
      this.nodes[b].connections.push(a);
    });
  },

  setScenario(s) {
    this.scenario = s;
    // Reset node statuses
    Object.values(this.nodes).forEach(n => n.status = 'online');
    document.querySelectorAll('.scenario-item').forEach(el => el.classList.remove('selected'));
    document.querySelector(`[data-s="${s}"]`).classList.add('selected');
    // Apply scenario effects
    if (s === 'server-down') { this.nodes.appserver1.status = 'offline'; this.nodes.appserver2.status = 'offline'; }
    if (s === 'no-internet') { this.nodes.isp1.status = 'offline'; }
    if (s === 'dns-fail')    { this.nodes.dns.status = 'error'; }
    EventLog.log(`Scenario set: ${s}`, 'warn');
    UI.setStatus(`Scenario: ${s.replace('-',' ').toUpperCase()} — Click CONNECT`);
  },

  setScenarioByLabel(s) { this.setScenario(s); },

  triggerLogin() {
    if (this.running === false) return;
    this.packets = [];
    this.timeline = [];
    this.currentConnection = { state: 'init', seqClient: 1000+Math.floor(Math.random()*1000), seqServer: 5000+Math.floor(Math.random()*1000) };
    UI.clearConnections();
    UI.updateEncap(0);
    UI.clearTimeline();
    OSIStack.clear();
    EventLog.log('━━━ LOGIN INITIATED ━━━', 'info');

    // Reset node statuses based on scenario
    this.setScenario(this.scenario);

    // Begin protocol flow
    this.runFlow();
  },

  runFlow() {
    const s = this.scenario;
    const speed = this.slowMo ? 0.004 : 0.018;
    const delay = this.slowMo ? 1800 : 400;

    const path_full = ['client','homerouter','isp1','core1','isp2','lb','appserver1'];
    const path_dns  = ['client','homerouter','isp1','core1','dns'];
    const path_back = ['appserver1','lb','isp2','core1','isp1','homerouter','client'];
    const path_backcore2 = ['appserver1','lb','isp2','core2','isp1','homerouter','client'];

    // PHASE 0: DNS
    if (s === 'dns-fail') {
      this.doDNSPhase(path_dns, true, () => {
        EventLog.log('DNS resolution failed — cannot reach server', 'error');
        UI.setStatus('DNS FAILED — No IP address resolved');
        OSIStack.setLayer(3, 'error');
        this.addTimeline('DNS FAIL', '#ef4444');
        UI.updateConnection('DNS', 'error');
      });
      return;
    }
    if (s === 'no-internet') {
      EventLog.log('No route to ISP — connection refused at layer 3', 'error');
      this.highlightNode('isp1', 'error');
      OSIStack.setLayer(3, 'error');
      UI.setStatus('NO INTERNET — ISP unreachable');
      this.addTimeline('NO ROUTE', '#ef4444');
      this.spawnPacket({
        path: ['client','homerouter'],
        srcIp: '192.168.1.10', dstIp: '203.0.113.1',
        color: '#ef4444', label: 'DROP', flags: 'DATA', speed,
        dropAt: 1,
        onComplete: () => {
          EventLog.log('Packet dropped — TTL exceeded / No route', 'error');
        }
      });
      return;
    }

    // Step 1: DNS Query
    this.doDNSPhase(path_dns, false, () => {
      // Step 2: TCP Handshake
      this.doTCPHandshake(path_full, path_back, speed, delay, () => {
        // Step 3: TLS
        this.doTLS(path_full, path_back, speed, delay, () => {
          // Step 4: HTTP Request
          this.doHTTP(path_full, path_back, path_backcore2, speed, delay);
        });
      });
    });
  },

  doDNSPhase(path, fail, cb) {
    const speed = this.slowMo ? 0.004 : 0.018;
    EventLog.log('Phase 1: DNS Resolution — resolving company.com → IP', 'info');
    OSIStack.setLayer(7, 'active');
    OSIStack.setLayer(3, 'active');
    UI.setStatus('DNS QUERY → Resolving domain name...');
    this.addTimeline('DNS', '#10b981');
    UI.updateConnection('DNS', 'syn');

    this.spawnPacket({
      path, srcIp: '192.168.1.10', dstIp: '8.8.8.8',
      protocol: 'UDP', dstPort: 53, flags: 'QUERY',
      color: '#10b981', label: 'DNS?', size: 7, speed,
      onArrive: (nodeId, p) => { if (nodeId === 'dns') { if (fail) { p.color = '#ef4444'; p.label = 'ERR'; } } },
      onComplete: () => {
        if (fail) { cb(); return; }
        // DNS response
        this.spawnPacket({
          path: [...path].reverse(), srcIp: '8.8.8.8', dstIp: '192.168.1.10',
          protocol: 'UDP', dstPort: 53, flags: 'RESP',
          color: '#10b981', label: '93.184…', size: 7, speed,
          onComplete: () => {
            EventLog.log('DNS resolved: company.com → 93.184.216.34', 'success');
            OSIStack.setLayer(3, 'idle');
            UI.updateConnection('DNS', 'established');
            cb();
          }
        });
      }
    });
  },

  doTCPHandshake(pathFwd, pathBack, speed, delay, cb) {
    EventLog.log('Phase 2: TCP 3-Way Handshake', 'info');
    OSIStack.setLayer(4, 'active');
    UI.setStatus('TCP SYN → Establishing connection...');
    this.addTimeline('SYN', '#f59e0b');
    const seq = this.currentConnection.seqClient;

    // SYN
    this.spawnPacket({
      path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
      protocol: 'TCP', dstPort: 443, flags: 'SYN', seq, ttl: 64,
      color: '#f59e0b', label: 'SYN', size: 7, speed,
      onArrive: (nid, p) => { p.ttl = Math.max(1, p.ttl - 1); },
      onComplete: () => {
        if (this.scenario === 'server-down') {
          EventLog.log('SYN sent — no SYN-ACK received (server down)', 'error');
          UI.setStatus('SERVER DOWN — SYN timeout');
          // Show retry
          setTimeout(() => {
            EventLog.log('TCP retransmit SYN (attempt 2)...', 'warn');
            this.addTimeline('SYN RETRY', '#ef4444');
          }, delay);
          return;
        }
        EventLog.log(`SYN sent (seq=${seq}) — waiting for SYN-ACK`, 'info');
        // SYN-ACK back
        setTimeout(() => {
          this.addTimeline('SYN-ACK', '#f59e0b');
          this.spawnPacket({
            path: pathBack, srcIp: '93.184.216.34', dstIp: '192.168.1.10',
            protocol: 'TCP', dstPort: seq+1, flags: 'SYN-ACK',
            seq: this.currentConnection.seqServer, ack: seq+1,
            color: '#f59e0b', label: 'SYN-ACK', size: 7, speed,
            onComplete: () => {
              EventLog.log(`SYN-ACK received — sending ACK`, 'info');
              setTimeout(() => {
                this.addTimeline('ACK', '#f59e0b');
                this.spawnPacket({
                  path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
                  protocol: 'TCP', dstPort: 443, flags: 'ACK',
                  seq: seq+1, ack: this.currentConnection.seqServer+1,
                  color: '#f59e0b', label: 'ACK', size: 6, speed,
                  onComplete: () => {
                    EventLog.log('TCP connection ESTABLISHED', 'success');
                    OSIStack.setLayer(4, 'idle');
                    OSIStack.setLayer(5, 'active');
                    UI.updateConnection('TCP:443', 'established');
                    cb();
                  }
                });
              }, delay * 0.3);
            }
          });
        }, delay * 0.5);
      }
    });
  },

  doTLS(pathFwd, pathBack, speed, delay, cb) {
    EventLog.log('Phase 3: TLS Handshake (ClientHello → ServerHello → Cert → Keys)', 'info');
    OSIStack.setLayer(6, 'active');
    UI.setStatus('TLS HANDSHAKE → Encrypting channel...');
    this.addTimeline('TLS Hello', '#7c3aed');

    // Client Hello
    this.spawnPacket({
      path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
      protocol: 'TLS', dstPort: 443, flags: 'CLIENT_HELLO',
      color: '#7c3aed', label: 'TLS Hi', size: 8, speed,
      onComplete: () => {
        EventLog.log('ClientHello sent — TLS 1.3, cipher suites offered', 'info');
        setTimeout(() => {
          // Server Hello + Cert
          this.spawnPacket({
            path: pathBack, srcIp: '93.184.216.34', dstIp: '192.168.1.10',
            protocol: 'TLS', dstPort: 443, flags: 'SERVER_HELLO',
            color: '#7c3aed', label: 'Cert', size: 12, speed: speed*0.7, // cert is big
            onComplete: () => {
              EventLog.log('ServerHello + Certificate received — verifying chain', 'info');
              setTimeout(() => {
                // Finished
                this.spawnPacket({
                  path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
                  protocol: 'TLS', dstPort: 443, flags: 'FINISHED',
                  color: '#7c3aed', label: 'Keys✓', size: 7, speed,
                  onComplete: () => {
                    EventLog.log('TLS session established — all traffic encrypted', 'success');
                    OSIStack.setLayer(6, 'idle');
                    cb();
                  }
                });
              }, delay * 0.4);
            }
          });
        }, delay * 0.4);
      }
    });
  },

  doHTTP(pathFwd, pathBack, pathBackAlt, speed, delay) {
    EventLog.log('Phase 4: HTTP POST /login (encrypted)', 'info');
    OSIStack.setLayer(7, 'active');
    UI.setStatus('HTTP POST → Sending credentials...');
    this.addTimeline('HTTP POST', '#00d4ff');
    UI.updateEncap(5);

    const wrongPass = this.scenario === 'wrong-pass';
    const packetLoss = this.scenario === 'packet-loss';
    const slowNet = this.scenario === 'slow-network';

    const httpSpeed = slowNet ? speed * 0.25 : speed;

    // HTTP Request packet
    this.spawnPacket({
      path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
      protocol: 'HTTPS', dstPort: 443, flags: 'POST',
      payload: 248, seq: this.currentConnection.seqClient + 2,
      color: '#00d4ff', label: 'POST', size: 9, speed: httpSpeed,
      dropAt: packetLoss ? 3 : -1,
      onComplete: () => {
        if (packetLoss) {
          EventLog.log('Packet lost in transit! TCP retransmit triggered', 'error');
          this.addTimeline('LOST', '#ef4444');
          UI.setStatus('PACKET LOST — TCP retransmitting...');
          // Retransmit after delay
          setTimeout(() => {
            EventLog.log('TCP retransmission (duplicate packet)', 'warn');
            this.addTimeline('RETX', '#f59e0b');
            this.spawnPacket({
              path: pathFwd, srcIp: '192.168.1.10', dstIp: '93.184.216.34',
              protocol: 'HTTPS', dstPort: 443, flags: 'POST-RETX',
              payload: 248, color: '#f59e0b', label: 'RETX', size: 9, speed,
              onComplete: () => { this.receiveHTTPResponse(pathBack, pathBackAlt, speed, delay, wrongPass); }
            });
          }, delay * 2);
          return;
        }
        EventLog.log('HTTP request received at load balancer → forwarding to App Server 1', 'info');
        // DB lookup indicator
        this.highlightNode('database', 'busy');
        setTimeout(() => {
          this.nodes.database.status = 'online';
          this.receiveHTTPResponse(pathBack, pathBackAlt, speed, delay, wrongPass);
        }, slowNet ? delay * 3 : delay);
      }
    });
  },

  receiveHTTPResponse(pathBack, pathBackAlt, speed, delay, wrongPass) {
    const httpCode = wrongPass ? '401' : '200';
    const label = wrongPass ? '401' : '200';
    const color = wrongPass ? '#ef4444' : '#10b981';
    EventLog.log(`Server processing complete → HTTP ${httpCode} ${wrongPass?'Unauthorized':'OK'}`, wrongPass?'error':'success');
    this.addTimeline(`HTTP ${httpCode}`, color);
    UI.setStatus(wrongPass ? 'AUTH FAILED — 401 Unauthorized' : 'LOGIN SUCCESS — 200 OK');
    OSIStack.setLayer(7, 'idle');

    // Response packet takes alternate path sometimes
    const rpath = Math.random() > 0.5 ? pathBack : pathBackAlt;

    this.spawnPacket({
      path: rpath, srcIp: '93.184.216.34', dstIp: '192.168.1.10',
      protocol: 'HTTPS', dstPort: 443, flags: `RESP-${httpCode}`,
      payload: wrongPass ? 89 : 1420, color, label, size: 10, speed,
      onComplete: () => {
        EventLog.log('Response received by browser — rendering result', 'success');
        if (!wrongPass) {
          this.addTimeline('DONE ✓', '#10b981');
          UI.setStatus('✓ Login Successful — Session established');
        } else {
          this.addTimeline('AUTH ERR', '#ef4444');
        }
        // TCP FIN
        setTimeout(() => { this.doTCPClose(pathBack, speed); }, 500);
      }
    });
  },

  doTCPClose(pathBack, speed) {
    OSIStack.setLayer(4, 'active');
    EventLog.log('TCP FIN — closing connection gracefully', 'info');
    this.spawnPacket({
      path: pathBack, srcIp: '93.184.216.34', dstIp: '192.168.1.10',
      protocol: 'TCP', dstPort: 443, flags: 'FIN',
      color: '#475569', label: 'FIN', size: 6, speed,
      onComplete: () => {
        OSIStack.setLayer(4, 'idle');
        UI.updateConnection('TCP:443', 'closed');
        EventLog.log('Connection closed. All layers idle.', 'info');
        OSIStack.clear();
      }
    });
  },

  highlightNode(id, status) {
    if (this.nodes[id]) this.nodes[id].status = status;
  },

  spawnPacket(opts) {
    const p = new Packet(opts);
    // Set initial position from first node
    const startNode = this.nodes[p.path[0]];
    if (startNode) { p.x = startNode.x; p.y = startNode.y; }
    p.pathIndex = 0;
    this.setPacketTarget(p);
    this.packets.push(p);
    this.updateInspector(p);
  },

  setPacketTarget(p) {
    if (p.pathIndex + 1 < p.path.length) {
      const target = this.nodes[p.path[p.pathIndex + 1]];
      if (target) { p.targetX = target.x; p.targetY = target.y; }
    }
    p.progress = 0;
  },

  addTimeline(label, color) {
    this.timeline.push({ label, color, t: Date.now() });
    UI.renderTimeline();
  },

  toggleSlowMo() {
    this.slowMo = !this.slowMo;
    this.speedMultiplier = this.slowMo ? 0.25 : 1;
    document.getElementById('btn-slowmo').classList.toggle('active', this.slowMo);
    document.getElementById('speed-display').textContent = this.slowMo ? '0.25x' : '1x';
  },

  replay() {
    this.packets = [];
    this.timeline = [];
    UI.clearTimeline();
    UI.clearConnections();
    UI.updateEncap(0);
    OSIStack.clear();
    setTimeout(() => this.triggerLogin(), 100);
  },

  update(dt) {
    const baseSpeed = this.slowMo ? 0.3 : 1.0;
    this.packets.forEach(p => {
      if (p.done || p.dropped) return;
      p.progress += p.speed * baseSpeed;
      if (p.progress >= 1) {
        p.progress = 1;
        p.x = p.targetX; p.y = p.targetY;
        p.pathIndex++;

        // Check drop
        if (p.dropAt >= 0 && p.pathIndex > p.dropAt) {
          p.dropped = true;
          p.done = true;
          // Spawn ghost effect
          this.spawnDropEffect(p.x, p.y);
          if (p.onComplete) p.onComplete();
          return;
        }

        // Arrive at node
        const nodeId = p.path[p.pathIndex];
        if (nodeId) {
          const node = this.nodes[nodeId];
          if (node) {
            node.highlight = 1;
            // Decrement TTL on routers
            if (node.type === 'router' || node.type === 'core' || node.type === 'isp') {
              p.ttl = Math.max(1, p.ttl - 1);
            }
          }
          if (p.onArrive) p.onArrive(nodeId, p);
          this.updateInspector(p);
        }

        if (p.pathIndex >= p.path.length - 1) {
          p.done = true;
          if (p.onComplete) p.onComplete();
        } else {
          this.setPacketTarget(p);
        }
      } else {
        // Interpolate position
        const curNode = this.nodes[p.path[p.pathIndex]];
        if (curNode) {
          const ease = this.easeInOut(p.progress);
          p.x = curNode.x + (p.targetX - curNode.x) * ease;
          p.y = curNode.y + (p.targetY - curNode.y) * ease;
        }
      }

      // Trail
      p.trailPoints.push({ x: p.x, y: p.y, t: Date.now() });
      if (p.trailPoints.length > 20) p.trailPoints.shift();
    });

    // Fade node highlights
    Object.values(this.nodes).forEach(n => {
      if (n.highlight > 0) n.highlight = Math.max(0, n.highlight - 0.02);
    });

    // Clean done packets
    this.packets = this.packets.filter(p => !p.done || p.trailPoints.length > 0);
    this.packets.forEach(p => {
      if (p.done && p.trailPoints.length > 0) p.trailPoints.shift();
    });
  },

  dropEffects: [],
  spawnDropEffect(x, y) {
    this.dropEffects.push({ x, y, r: 0, opacity: 1 });
  },

  easeInOut(t) {
    return t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
  },

  updateInspector(p) {
    UI.setPacketInspector(p);
  },

  renderLoop() {
    const canvas = document.getElementById('sim-canvas');
    const ctx = canvas.getContext('2d');
    let last = performance.now();

    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;

      // Resize
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;

      this.update(dt);
      this.draw(ctx, canvas.width, canvas.height);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  draw(ctx, cw, ch) {
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();

    // Grid background
    this.drawGrid(ctx, cw, ch);

    Camera.transform(ctx);

    // Draw connections
    this.drawEdges(ctx);

    // Draw packets (trails first)
    this.drawPacketTrails(ctx);

    // Draw drop effects
    this.drawDropEffects(ctx);

    // Draw nodes
    this.drawNodes(ctx);

    // Draw packets
    this.drawPackets(ctx);

    // Routing view overlay
    if (this.view === 'routing') {
      this.drawRoutingOverlay(ctx);
    }

    ctx.restore();
  },

  drawGrid(ctx, cw, ch) {
    ctx.save();
    ctx.strokeStyle = 'rgba(26,37,68,0.4)';
    ctx.lineWidth = 0.5;
    const gs = 40;
    const ox = (cw/2 + Camera.x) % gs;
    const oy = (ch/2 + Camera.y) % gs;
    for (let x = ox; x < cw; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
    }
    for (let y = oy; y < ch; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
    }
    ctx.restore();
  },

  drawEdges(ctx) {
    this.connections.forEach(([a, b]) => {
      const na = this.nodes[a], nb = this.nodes[b];
      if (!na || !nb) return;

      const isDown = na.status === 'offline' || nb.status === 'offline';
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.lineTo(nb.x, nb.y);

      if (isDown) {
        ctx.strokeStyle = 'rgba(239,68,68,0.2)';
        ctx.setLineDash([6, 4]);
      } else {
        ctx.strokeStyle = 'rgba(26,37,68,0.9)';
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      // Bandwidth indicator dots on edge
      if (!isDown) {
        const hasTraffic = this.packets.some(p => {
          const pi = p.pathIndex;
          return p.path[pi] === a && p.path[pi+1] === b ||
                 p.path[pi] === b && p.path[pi+1] === a;
        });
        if (hasTraffic) {
          const mx = (na.x + nb.x)/2, my = (na.y + nb.y)/2;
          ctx.beginPath();
          ctx.arc(mx, my, 3, 0, Math.PI*2);
          ctx.fillStyle = 'rgba(0,212,255,0.4)';
          ctx.fill();
        }
      }
    });
  },

  drawNodes(ctx) {
    Object.values(this.nodes).forEach(n => this.drawNode(ctx, n));
  },

  drawNode(ctx, n) {
    const size = NODE_SIZES[n.type] || 24;
    const color = NODE_COLORS[n.type] || '#00d4ff';
    const isError = n.status === 'error' || n.status === 'offline';
    const isBusy = n.status === 'busy';

    // Glow
    if (n.highlight > 0 || n.status === 'busy') {
      const glowColor = isError ? '#ef4444' : color;
      const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, size*2.5);
      glow.addColorStop(0, `${glowColor}${Math.round(n.highlight * 60).toString(16).padStart(2,'0')}`);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(n.x, n.y, size*2.5, 0, Math.PI*2); ctx.fill();
    }

    // Outer ring
    ctx.beginPath();
    ctx.arc(n.x, n.y, size+4, 0, Math.PI*2);
    ctx.strokeStyle = isError ? '#ef4444' : (n.highlight > 0.3 ? color : 'rgba(26,37,68,0.8)');
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner fill
    const grad = ctx.createRadialGradient(n.x-size*0.3, n.y-size*0.3, 0, n.x, n.y, size);
    const c = isError ? '#ef4444' : color;
    grad.addColorStop(0, c + '33');
    grad.addColorStop(1, '#050810');
    ctx.beginPath();
    ctx.arc(n.x, n.y, size, 0, Math.PI*2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Error X overlay
    if (isError) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(n.x-8, n.y-8); ctx.lineTo(n.x+8, n.y+8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(n.x+8, n.y-8); ctx.lineTo(n.x-8, n.y+8); ctx.stroke();
    }

    // Label
    ctx.fillStyle = isError ? '#ef4444' : color;
    ctx.font = `bold 10px 'Courier New'`;
    ctx.textAlign = 'center';
    ctx.fillText(n.label.toUpperCase(), n.x, n.y + size + 14);

    // IP label
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    ctx.font = '8px Courier New';
    ctx.fillText(n.ip, n.x, n.y + size + 24);

    // Pulsing ring for busy/error
    if (isBusy || n.highlight > 0.5) {
      const t = (Date.now() % 1000) / 1000;
      const pr = size + 6 + t * 12;
      const pa = 1 - t;
      ctx.beginPath();
      ctx.arc(n.x, n.y, pr, 0, Math.PI*2);
      ctx.strokeStyle = `${isBusy ? '#f59e0b' : color}${Math.round(pa * 80).toString(16).padStart(2,'0')}`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  },

  drawPackets(ctx) {
    this.packets.forEach(p => {
      if (p.done && p.trailPoints.length === 0) return;
      if (p.done) return;

      // Outer glow
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
      glow.addColorStop(0, p.color + '80');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size*3, 0, Math.PI*2); ctx.fill();

      // Core
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      ctx.fillStyle = p.color;
      ctx.fill();

      // Label
      if (p.label) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 8px 'Courier New'`;
        ctx.textAlign = 'center';
        ctx.fillText(p.label, p.x, p.y - p.size - 3);
      }

      // Encap rings (show layers)
      if (p.encapLayers > 1 && !p.dropped) {
        for (let i = 1; i < p.encapLayers; i++) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size + i*3, 0, Math.PI*2);
          const cols = ['#ef4444','#f59e0b','#10b981','#00d4ff'];
          ctx.strokeStyle = (cols[i-1] || '#fff') + '40';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    });
  },

  drawPacketTrails(ctx) {
    this.packets.forEach(p => {
      if (p.trailPoints.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(p.trailPoints[0].x, p.trailPoints[0].y);
      for (let i = 1; i < p.trailPoints.length; i++) {
        ctx.lineTo(p.trailPoints[i].x, p.trailPoints[i].y);
      }
      ctx.strokeStyle = p.dropped ? '#ef4444' : p.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  },

  drawDropEffects(ctx) {
    this.dropEffects = this.dropEffects.filter(d => d.opacity > 0.01);
    this.dropEffects.forEach(d => {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(239,68,68,${d.opacity})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      // X mark
      ctx.strokeStyle = `rgba(239,68,68,${d.opacity})`;
      ctx.beginPath(); ctx.moveTo(d.x-8, d.y-8); ctx.lineTo(d.x+8, d.y+8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(d.x+8, d.y-8); ctx.lineTo(d.x-8, d.y+8); ctx.stroke();
      d.r += 1.5; d.opacity *= 0.92;
    });
  },

  drawRoutingOverlay(ctx) {
    const routers = ['homerouter','core1','core2'];
    routers.forEach(id => {
      const n = this.nodes[id];
      if (!n || !n.routingTable.length) return;
      const bx = n.x + 30, by = n.y - 40;
      ctx.fillStyle = 'rgba(10,15,30,0.92)';
      const rh = n.routingTable.length * 14 + 22;
      ctx.fillRect(bx, by, 180, rh);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, 180, rh);
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 9px Courier New';
      ctx.textAlign = 'left';
      ctx.fillText('ROUTING TABLE', bx+6, by+13);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px Courier New';
      n.routingTable.forEach((r, i) => {
        ctx.fillText(`${r.dest} → ${r.nexthop}`, bx+6, by+13+(i+1)*13);
      });
    });
  },
};

// ===== OSI STACK UI =====
const OSIStack = {
  layers: { 7:'layer-7', 6:'layer-6', 5:'layer-5', 4:'layer-4', 3:'layer-3', 2:'layer-2', 1:'layer-1' },
  setLayer(num, state) {
    const el = document.getElementById(this.layers[num]);
    if (!el) return;
    el.className = 'osi-layer';
    if (state === 'active') el.classList.add('active');
    if (state === 'error')  el.classList.add('error');
    if (state === 'idle')   {} // just normal
  },
  clear() {
    Object.values(this.layers).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.className = 'osi-layer';
    });
  }
};

// ===== EVENT LOG =====
const EventLog = {
  log(msg, type = 'info') {
    const el = document.getElementById('event-log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const ts = new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    entry.innerHTML = `<span class="log-ts">${ts}</span>${msg}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
    // Trim
    while (el.children.length > 100) el.removeChild(el.firstChild);
  }
};

// ===== UI HELPERS =====
const UI = {
  setStatus(msg) {
    document.getElementById('status-bar').textContent = msg;
  },
  setView(v) {
    Sim.view = v;
    document.querySelectorAll('#topbar .btn').forEach(b => {
      b.classList.toggle('active',
        (v === 'network' && b.id === 'btn-view-normal') ||
        (v === 'encap'   && b.id === 'btn-view-encap')  ||
        (v === 'routing' && b.id === 'btn-view-routing')
      );
    });
    if (v === 'encap') { document.getElementById('encap-view').style.border = '1px solid var(--accent)'; }
    else { document.getElementById('encap-view').style.border = ''; }
  },
  setPacketInspector(p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pi-status', p.dropped ? 'DROPPED' : (p.done ? 'DELIVERED' : 'IN_TRANSIT'));
    set('pi-src', p.srcIp);
    set('pi-dst', p.dstIp);
    set('pi-port', p.dstPort);
    set('pi-proto', p.protocol);
    set('pi-ttl', p.ttl);
    set('pi-seq', p.seq);
    set('pi-payload', p.payload ? `${p.payload}B` : 'N/A');
    set('pi-phase', p.flags);
  },
  updateEncap(layers) {
    const ids = ['enc-data','enc-http','enc-tcp','enc-ip','enc-eth'];
    ids.forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (i < layers) {
        el.classList.add('visible');
        el.classList.remove('hidden');
        if (!el.dataset.added) { el.classList.add('adding'); el.dataset.added = '1'; setTimeout(() => el.classList.remove('adding'), 500); }
      } else {
        el.classList.add('hidden');
        el.classList.remove('visible');
        delete el.dataset.added;
      }
    });
  },
  updateConnection(name, state) {
    const el = document.getElementById('conn-rows');
    let row = document.getElementById('conn-'+name);
    if (!row) {
      row = document.createElement('div');
      row.id = 'conn-'+name;
      row.className = 'conn-row';
      el.appendChild(row);
    }
    row.innerHTML = `<span style="color:var(--text2)">${name}</span><span class="conn-state ${state}">${state.toUpperCase()}</span>`;
  },
  clearConnections() {
    document.getElementById('conn-rows').innerHTML = '';
  },
  renderTimeline() {
    const el = document.getElementById('timeline-events');
    el.innerHTML = '';
    Sim.timeline.forEach((ev, i) => {
      if (i > 0) {
        const line = document.createElement('div');
        line.className = 'timeline-line';
        el.appendChild(line);
      }
      const div = document.createElement('div');
      div.className = 'timeline-event';
      div.innerHTML = `<div class="timeline-dot" style="background:${ev.color}"></div><div class="timeline-label">${ev.label}</div>`;
      el.appendChild(div);
    });
  },
  clearTimeline() {
    document.getElementById('timeline-events').innerHTML = '';
  }
};

// ===== CANVAS CLICK — Node hover/tooltip =====
(function initCanvasInteraction() {
  const canvas = document.getElementById('sim-canvas');
  const tooltip = document.getElementById('tooltip');
  let hoveredNode = null;

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = Camera.toWorld(mx, my);

    hoveredNode = null;
    for (const n of Object.values(Sim.nodes)) {
      const sz = NODE_SIZES[n.type] || 24;
      const dx = world.x - n.x, dy = world.y - n.y;
      if (Math.sqrt(dx*dx+dy*dy) < sz + 8) {
        hoveredNode = n;
        break;
      }
    }

    if (hoveredNode) {
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 10) + 'px';
      tooltip.innerHTML = `
        <strong style="color:var(--accent)">${hoveredNode.label}</strong><br>
        <span style="color:var(--text3)">IP:</span> ${hoveredNode.ip}<br>
        <span style="color:var(--text3)">Status:</span> <span style="color:${hoveredNode.status==='online'?'var(--accent3)':'var(--err)'}">${hoveredNode.status}</span><br>
        <span style="color:var(--text3)">Type:</span> ${hoveredNode.type}<br>
        <span style="font-size:10px;color:var(--text2)">${hoveredNode.info.desc||''}</span>
      `;
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  canvas.addEventListener('click', e => {
    if (!hoveredNode) return;
    EventLog.log(`Node clicked: ${hoveredNode.label} [${hoveredNode.ip}] — ${hoveredNode.info.desc||''}`, 'info');
    if (hoveredNode.routingTable && hoveredNode.routingTable.length) {
      OSIStack.setLayer(3, 'active');
      setTimeout(() => OSIStack.setLayer(3, 'idle'), 800);
    }
  });
})();

// ===== INIT =====
Sim.init();