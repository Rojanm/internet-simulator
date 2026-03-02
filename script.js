// ============================================================
//  NETLAB — RESPONSIVE INTERNET SIMULATION ENGINE
// ============================================================

const W = () => document.getElementById('canvas-area').clientWidth;
const H = () => document.getElementById('canvas-area').clientHeight;

// ===== CAMERA =====
const Camera = {
  x:0, y:0, scale:1,
  pan(dx,dy){ this.x+=dx; this.y+=dy; },
  zoom(f, cx, cy){
    const prev = this.scale;
    this.scale = Math.max(0.3, Math.min(3, this.scale*f));
    if(cx!==undefined){
      const sc = this.scale/prev;
      this.x = cx - (cx - W()/2 - this.x)*sc - W()/2;
      this.y = cy - (cy - H()/2 - this.y)*sc - H()/2;
    }
  },
  reset(){ this.x=0; this.y=0; this.scale=1; },
  toWorld(sx,sy){ return { x:(sx-W()/2-this.x)/this.scale, y:(sy-H()/2-this.y)/this.scale }; },
  transform(ctx){ ctx.translate(W()/2+this.x, H()/2+this.y); ctx.scale(this.scale,this.scale); }
};

// ===== MOUSE + TOUCH PAN/ZOOM =====
(function(){
  const ca = document.getElementById('canvas-area');
  let drag=false, lx, ly, lastDist=0;

  ca.addEventListener('mousedown', e=>{ if(e.target.closest('#event-log-overlay')) return; drag=true; lx=e.clientX; ly=e.clientY; });
  window.addEventListener('mousemove', e=>{ if(!drag) return; Camera.pan(e.clientX-lx, e.clientY-ly); lx=e.clientX; ly=e.clientY; });
  window.addEventListener('mouseup', ()=>{ drag=false; });
  ca.addEventListener('wheel', e=>{ e.preventDefault(); const r=ca.getBoundingClientRect(); Camera.zoom(e.deltaY<0?1.1:0.9, e.clientX-r.left, e.clientY-r.top); },{passive:false});

  ca.addEventListener('touchstart', e=>{
    if(e.target.closest('#event-log-overlay')) return;
    e.preventDefault();
    if(e.touches.length===1){ drag=true; lx=e.touches[0].clientX; ly=e.touches[0].clientY; }
    else if(e.touches.length===2){ drag=false; lastDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); }
  },{passive:false});

  ca.addEventListener('touchmove', e=>{
    if(e.target.closest('#event-log-overlay')) return;
    e.preventDefault();
    if(e.touches.length===1 && drag){ Camera.pan(e.touches[0].clientX-lx, e.touches[0].clientY-ly); lx=e.touches[0].clientX; ly=e.touches[0].clientY; }
    else if(e.touches.length===2){
      const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      if(lastDist>0){
        const r=ca.getBoundingClientRect();
        Camera.zoom(d/lastDist, (e.touches[0].clientX+e.touches[1].clientX)/2-r.left, (e.touches[0].clientY+e.touches[1].clientY)/2-r.top);
      }
      lastDist=d;
    }
  },{passive:false});

  ca.addEventListener('touchend', e=>{ if(e.touches.length<2) lastDist=0; if(e.touches.length===0) drag=false; });
})();

// ===== NODE MODEL =====
class NetNode {
  constructor(id,label,type,x,y,info){
    this.id=id; this.label=label; this.type=type;
    this.x=x; this.y=y; this.info=info||{};
    this.status='online'; this.highlight=0;
    this.connections=[]; this.routingTable=[];
    this.ip=info.ip||'0.0.0.0'; this.mac=info.mac||'AA:BB:CC:DD:EE:FF';
  }
}
const NODE_SIZES  = {client:26,router:20,dns:22,server:28,lb:24,db:20,isp:18,core:16};
const NODE_COLORS = {client:'#00d4ff',router:'#7c3aed',dns:'#10b981',server:'#f59e0b',lb:'#00d4ff',db:'#ef4444',isp:'#475569',core:'#94a3b8'};

// ===== PACKET =====
let pid=0;
class Packet{
  constructor(o){
    this.id=++pid;
    this.srcIp=o.srcIp||'192.168.1.10'; this.dstIp=o.dstIp||'93.184.216.34';
    this.srcPort=o.srcPort||Math.floor(Math.random()*30000+10000);
    this.dstPort=o.dstPort||443; this.protocol=o.protocol||'TCP';
    this.ttl=o.ttl||64; this.seq=o.seq||Math.floor(Math.random()*100000);
    this.ack=o.ack||0; this.flags=o.flags||'DATA'; this.payload=o.payload||0;
    this.color=o.color||'#00d4ff'; this.size=o.size||8; this.label=o.label||'';
    this.path=o.path||[]; this.pathIndex=0;
    this.x=0; this.y=0; this.targetX=0; this.targetY=0; this.progress=0;
    this.speed=o.speed||0.012; this.done=false; this.dropped=false;
    this.dropAt=o.dropAt||-1;
    this.onArrive=o.onArrive||null; this.onComplete=o.onComplete||null;
    this.trailPoints=[]; this.encapLayers=o.encapLayers||5;
  }
}

// ===== SIM ENGINE =====
const Sim = {
  nodes:{}, packets:[], connections:[],
  scenario:'normal', slowMo:false,
  currentConnection:null, timeline:[],
  view:'network', running:false, dropEffects:[],

  init(){
    this.buildTopology(); this.running=true; this.renderLoop();
    EventLog.log('Select a scenario and click CONNECT.','info');
  },

  buildTopology(){
    const hw=450;
    this.nodes = {
      client:     new NetNode('client',    'Client',       'client', -hw+60,  0,    {ip:'192.168.1.10',  mac:'A4:C3:F0:11:22:33', desc:'Browser sending login request'}),
      homerouter: new NetNode('homerouter','Home Router',  'router', -hw+180, 0,    {ip:'192.168.1.1',   mac:'D8:3A:DD:AA:BB:CC', desc:'NAT gateway — translates private→public IP'}),
      isp1:       new NetNode('isp1',      'ISP Edge',     'isp',    -hw+320, 0,    {ip:'203.0.113.1',   desc:'ISP ingress router — BGP peering point'}),
      core1:      new NetNode('core1',     'Core Router',  'core',   -hw+440, -80,  {ip:'10.0.0.1',      desc:'Internet backbone router — high-speed forwarding'}),
      core2:      new NetNode('core2',     'Core Router',  'core',   -hw+440, 80,   {ip:'10.0.0.2',      desc:'Redundant backbone path'}),
      dns:        new NetNode('dns',       'DNS Server',   'dns',    -hw+440, -200, {ip:'8.8.8.8',       desc:'Resolves domain names to IP addresses'}),
      isp2:       new NetNode('isp2',      'ISP Edge',     'isp',    -hw+560, 0,    {ip:'198.51.100.1',  desc:'Server-side ISP router'}),
      lb:         new NetNode('lb',        'Load Balancer','lb',     -hw+700, 0,    {ip:'93.184.216.34', desc:'Distributes requests across app servers'}),
      appserver1: new NetNode('appserver1','App Server 1', 'server', -hw+820, -80,  {ip:'10.1.0.10',     desc:'Handles login auth — JWT generation'}),
      appserver2: new NetNode('appserver2','App Server 2', 'server', -hw+820, 80,   {ip:'10.1.0.11',     desc:'Standby app server'}),
      database:   new NetNode('database',  'Database',     'db',     -hw+820, 0,    {ip:'10.1.0.50',     desc:'User credentials & session store'}),
    };
    this.nodes.homerouter.routingTable = [{dest:'0.0.0.0/0',nexthop:'203.0.113.1',iface:'eth0'},{dest:'192.168.1.0/24',nexthop:'local',iface:'eth1'}];
    this.nodes.core1.routingTable = [{dest:'93.184.216.0/24',nexthop:'198.51.100.1',iface:'ge0'},{dest:'8.8.8.0/24',nexthop:'direct',iface:'ge1'}];
    this.nodes.core2.routingTable = [{dest:'93.184.216.0/24',nexthop:'198.51.100.1',iface:'ge0'},{dest:'0.0.0.0/0',nexthop:'10.0.0.1',iface:'ge1'}];
    this.connections = [
      ['client','homerouter'],['homerouter','isp1'],['isp1','core1'],['isp1','core2'],
      ['core1','core2'],['core1','dns'],['core1','isp2'],['core2','isp2'],
      ['isp2','lb'],['lb','appserver1'],['lb','appserver2'],
      ['appserver1','database'],['appserver2','database'],
    ];
    this.connections.forEach(([a,b])=>{ this.nodes[a].connections.push(b); this.nodes[b].connections.push(a); });
  },

  setScenario(s){
    this.scenario=s;
    Object.values(this.nodes).forEach(n=>n.status='online');
    document.querySelectorAll('.scenario-item').forEach(el=>el.classList.remove('selected'));
    document.querySelector(`[data-s="${s}"]`).classList.add('selected');
    if(s==='server-down'){this.nodes.appserver1.status='offline';this.nodes.appserver2.status='offline';}
    if(s==='no-internet'){this.nodes.isp1.status='offline';}
    if(s==='dns-fail'){this.nodes.dns.status='error';}
    EventLog.log(`Scenario: ${s.replace(/-/g,' ').toUpperCase()}`,'warn');
    UI.setStatus(`Scenario: ${s.replace(/-/g,' ').toUpperCase()} — Click CONNECT`);
  },

  triggerLogin(){
    if(!this.running) return;
    this.packets=[]; this.timeline=[];
    this.currentConnection={seqClient:1000+Math.floor(Math.random()*1000), seqServer:5000+Math.floor(Math.random()*1000)};
    UI.clearConnections(); UI.updateEncap(0); UI.clearTimeline(); OSIStack.clear();
    EventLog.log('━━━ LOGIN INITIATED ━━━','info');
    this.setScenario(this.scenario);
    this.runFlow();
  },

  runFlow(){
    const s=this.scenario;
    const speed=this.slowMo?0.004:0.018;
    const delay=this.slowMo?1800:400;
    const pf  =['client','homerouter','isp1','core1','isp2','lb','appserver1'];
    const pdns=['client','homerouter','isp1','core1','dns'];
    const pb  =['appserver1','lb','isp2','core1','isp1','homerouter','client'];
    const pb2 =['appserver1','lb','isp2','core2','isp1','homerouter','client'];

    if(s==='dns-fail'){
      this.doDNS(pdns,true,()=>{ EventLog.log('DNS failed — cannot resolve server','error'); UI.setStatus('DNS FAILED'); OSIStack.setLayer(3,'error'); this.addTimeline('DNS FAIL','#ef4444'); UI.updateConnection('DNS','error'); });
      return;
    }
    if(s==='no-internet'){
      EventLog.log('No route to ISP — Layer 3 failure','error');
      this.nodes.isp1.status='error';
      OSIStack.setLayer(3,'error'); UI.setStatus('NO INTERNET — ISP unreachable'); this.addTimeline('NO ROUTE','#ef4444');
      this.spawnPacket({path:['client','homerouter'],srcIp:'192.168.1.10',dstIp:'203.0.113.1',color:'#ef4444',label:'DROP',flags:'DATA',speed,dropAt:1,onComplete:()=>EventLog.log('Packet dropped — no route to host','error')});
      return;
    }
    this.doDNS(pdns,false,()=>this.doTCP(pf,pb,speed,delay,()=>this.doTLS(pf,pb,speed,delay,()=>this.doHTTP(pf,pb,pb2,speed,delay))));
  },

  doDNS(path,fail,cb){
    const speed=this.slowMo?0.004:0.018;
    EventLog.log('Phase 1: DNS — resolving company.com → IP','info');
    OSIStack.setLayer(7,'active'); OSIStack.setLayer(3,'active');
    UI.setStatus('DNS QUERY → Resolving domain…'); this.addTimeline('DNS','#10b981'); UI.updateConnection('DNS','syn');
    this.spawnPacket({path,srcIp:'192.168.1.10',dstIp:'8.8.8.8',protocol:'UDP',dstPort:53,flags:'QUERY',color:'#10b981',label:'DNS?',size:7,speed,
      onArrive:(id,p)=>{ if(id==='dns'&&fail){p.color='#ef4444';p.label='ERR';} },
      onComplete:()=>{
        if(fail){cb();return;}
        this.spawnPacket({path:[...path].reverse(),srcIp:'8.8.8.8',dstIp:'192.168.1.10',protocol:'UDP',dstPort:53,flags:'RESP',color:'#10b981',label:'93.184…',size:7,speed,
          onComplete:()=>{ EventLog.log('DNS resolved: company.com → 93.184.216.34','success'); OSIStack.setLayer(3,'idle'); UI.updateConnection('DNS','established'); cb(); }
        });
      }
    });
  },

  doTCP(pf,pb,speed,delay,cb){
    EventLog.log('Phase 2: TCP 3-Way Handshake','info');
    OSIStack.setLayer(4,'active'); UI.setStatus('TCP SYN → Establishing connection…'); this.addTimeline('SYN','#f59e0b');
    const seq=this.currentConnection.seqClient;
    this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'TCP',dstPort:443,flags:'SYN',seq,ttl:64,color:'#f59e0b',label:'SYN',size:7,speed,
      onArrive:(id,p)=>{ p.ttl=Math.max(1,p.ttl-1); },
      onComplete:()=>{
        if(this.scenario==='server-down'){ EventLog.log('SYN timeout — server not responding','error'); UI.setStatus('SERVER DOWN — SYN timeout'); setTimeout(()=>{ EventLog.log('TCP retransmit SYN…','warn'); this.addTimeline('SYN RETRY','#ef4444'); },delay); return; }
        EventLog.log(`SYN sent (seq=${seq}) — awaiting SYN-ACK`,'info');
        setTimeout(()=>{
          this.addTimeline('SYN-ACK','#f59e0b');
          this.spawnPacket({path:pb,srcIp:'93.184.216.34',dstIp:'192.168.1.10',protocol:'TCP',dstPort:seq+1,flags:'SYN-ACK',seq:this.currentConnection.seqServer,ack:seq+1,color:'#f59e0b',label:'SYN-ACK',size:7,speed,
            onComplete:()=>{ EventLog.log('SYN-ACK received — sending ACK','info');
              setTimeout(()=>{
                this.addTimeline('ACK','#f59e0b');
                this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'TCP',dstPort:443,flags:'ACK',seq:seq+1,ack:this.currentConnection.seqServer+1,color:'#f59e0b',label:'ACK',size:6,speed,
                  onComplete:()=>{ EventLog.log('TCP ESTABLISHED','success'); OSIStack.setLayer(4,'idle'); OSIStack.setLayer(5,'active'); UI.updateConnection('TCP:443','established'); cb(); }
                });
              },delay*0.3);
            }
          });
        },delay*0.5);
      }
    });
  },

  doTLS(pf,pb,speed,delay,cb){
    EventLog.log('Phase 3: TLS Handshake (ClientHello → Cert → Keys)','info');
    OSIStack.setLayer(6,'active'); UI.setStatus('TLS HANDSHAKE → Encrypting channel…'); this.addTimeline('TLS Hello','#7c3aed');
    this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'TLS',dstPort:443,flags:'CLIENT_HELLO',color:'#7c3aed',label:'TLS Hi',size:8,speed,
      onComplete:()=>{ EventLog.log('ClientHello — TLS 1.3 cipher suites offered','info');
        setTimeout(()=>{
          this.spawnPacket({path:pb,srcIp:'93.184.216.34',dstIp:'192.168.1.10',protocol:'TLS',dstPort:443,flags:'SERVER_HELLO',color:'#7c3aed',label:'Cert',size:12,speed:speed*0.7,
            onComplete:()=>{ EventLog.log('Certificate received — verifying chain','info');
              setTimeout(()=>{
                this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'TLS',dstPort:443,flags:'FINISHED',color:'#7c3aed',label:'Keys✓',size:7,speed,
                  onComplete:()=>{ EventLog.log('TLS session established — traffic encrypted','success'); OSIStack.setLayer(6,'idle'); cb(); }
                });
              },delay*0.4);
            }
          });
        },delay*0.4);
      }
    });
  },

  doHTTP(pf,pb,pb2,speed,delay){
    EventLog.log('Phase 4: HTTPS POST /login (TLS encrypted)','info');
    OSIStack.setLayer(7,'active'); UI.setStatus('HTTPS POST → Sending credentials…'); this.addTimeline('HTTP POST','#00d4ff'); UI.updateEncap(5);
    const wp=this.scenario==='wrong-pass', pl=this.scenario==='packet-loss', sl=this.scenario==='slow-network';
    const hs=sl?speed*0.25:speed;
    this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'HTTPS',dstPort:443,flags:'POST',payload:248,seq:this.currentConnection.seqClient+2,color:'#00d4ff',label:'POST',size:9,speed:hs,dropAt:pl?3:-1,
      onComplete:()=>{
        if(pl){ EventLog.log('Packet lost! TCP retransmit triggered','error'); this.addTimeline('LOST','#ef4444'); UI.setStatus('PACKET LOST — Retransmitting…');
          setTimeout(()=>{ EventLog.log('TCP retransmission','warn'); this.addTimeline('RETX','#f59e0b');
            this.spawnPacket({path:pf,srcIp:'192.168.1.10',dstIp:'93.184.216.34',protocol:'HTTPS',dstPort:443,flags:'POST-RETX',payload:248,color:'#f59e0b',label:'RETX',size:9,speed,
              onComplete:()=>this.httpResp(pb,pb2,speed,delay,wp) });
          },delay*2); return;
        }
        EventLog.log('Request at load balancer → App Server 1','info');
        this.nodes.database.status='busy';
        setTimeout(()=>{ this.nodes.database.status='online'; this.httpResp(pb,pb2,speed,delay,wp); },sl?delay*3:delay);
      }
    });
  },

  httpResp(pb,pb2,speed,delay,wp){
    const code=wp?'401':'200', color=wp?'#ef4444':'#10b981';
    EventLog.log(`HTTP ${code} ${wp?'Unauthorized':'OK'}`,wp?'error':'success');
    this.addTimeline(`HTTP ${code}`,color); UI.setStatus(wp?'AUTH FAILED — 401':'LOGIN SUCCESS — 200 OK'); OSIStack.setLayer(7,'idle');
    this.spawnPacket({path:Math.random()>0.5?pb:pb2,srcIp:'93.184.216.34',dstIp:'192.168.1.10',protocol:'HTTPS',dstPort:443,flags:`RESP-${code}`,payload:wp?89:1420,color,label:code,size:10,speed,
      onComplete:()=>{ EventLog.log('Response received by browser','success'); this.addTimeline(wp?'AUTH ERR':'DONE ✓',color);
        if(!wp) UI.setStatus('✓ Login Successful — Session established');
        setTimeout(()=>this.tcpFin(pb,speed),500);
      }
    });
  },

  tcpFin(pb,speed){
    OSIStack.setLayer(4,'active'); EventLog.log('TCP FIN — closing gracefully','info');
    this.spawnPacket({path:pb,srcIp:'93.184.216.34',dstIp:'192.168.1.10',protocol:'TCP',dstPort:443,flags:'FIN',color:'#475569',label:'FIN',size:6,speed,
      onComplete:()=>{ OSIStack.setLayer(4,'idle'); UI.updateConnection('TCP:443','closed'); EventLog.log('Connection closed — all layers idle','info'); OSIStack.clear(); }
    });
  },

  spawnPacket(o){
    const p=new Packet(o);
    const s=this.nodes[p.path[0]]; if(s){p.x=s.x;p.y=s.y;}
    this.setPT(p); this.packets.push(p); UI.setPI(p);
  },

  setPT(p){
    if(p.pathIndex+1<p.path.length){ const t=this.nodes[p.path[p.pathIndex+1]]; if(t){p.targetX=t.x;p.targetY=t.y;} }
    p.progress=0;
  },

  addTimeline(label,color){ this.timeline.push({label,color}); UI.renderTimeline(); },

  toggleSlowMo(){
    this.slowMo=!this.slowMo;
    document.getElementById('btn-slowmo').classList.toggle('active',this.slowMo);
    document.getElementById('speed-display').textContent=this.slowMo?'0.25x':'1x';
  },

  replay(){ this.packets=[]; this.timeline=[]; UI.clearTimeline(); UI.clearConnections(); UI.updateEncap(0); OSIStack.clear(); setTimeout(()=>this.triggerLogin(),100); },

  ease(t){ return t<0.5?2*t*t:-1+(4-2*t)*t; },

  update(){
    const bs=this.slowMo?0.3:1.0;
    this.packets.forEach(p=>{
      if(p.done||p.dropped) return;
      p.progress+=p.speed*bs;
      if(p.progress>=1){
        p.progress=1; p.x=p.targetX; p.y=p.targetY; p.pathIndex++;
        if(p.dropAt>=0&&p.pathIndex>p.dropAt){ p.dropped=true; p.done=true; this.dropEffects.push({x:p.x,y:p.y,r:0,opacity:1}); if(p.onComplete)p.onComplete(); return; }
        const nid=p.path[p.pathIndex];
        if(nid){ const n=this.nodes[nid]; if(n){ n.highlight=1; if(['router','core','isp'].includes(n.type))p.ttl=Math.max(1,p.ttl-1); } if(p.onArrive)p.onArrive(nid,p); UI.setPI(p); }
        if(p.pathIndex>=p.path.length-1){ p.done=true; if(p.onComplete)p.onComplete(); } else { this.setPT(p); }
      } else {
        const c=this.nodes[p.path[p.pathIndex]]; if(c){ const e=this.ease(p.progress); p.x=c.x+(p.targetX-c.x)*e; p.y=c.y+(p.targetY-c.y)*e; }
      }
      p.trailPoints.push({x:p.x,y:p.y}); if(p.trailPoints.length>18)p.trailPoints.shift();
    });
    Object.values(this.nodes).forEach(n=>{ if(n.highlight>0)n.highlight=Math.max(0,n.highlight-0.022); });
    this.packets=this.packets.filter(p=>!p.done||p.trailPoints.length>0);
    this.packets.forEach(p=>{ if(p.done&&p.trailPoints.length>0)p.trailPoints.shift(); });
    this.dropEffects=this.dropEffects.filter(d=>d.opacity>0.02);
    this.dropEffects.forEach(d=>{ d.r+=1.5; d.opacity*=0.92; });
  },

  renderLoop(){
    const canvas=document.getElementById('sim-canvas');
    const ctx=canvas.getContext('2d');
    const loop=()=>{
      canvas.width=canvas.parentElement.clientWidth;
      canvas.height=canvas.parentElement.clientHeight;
      this.update(); this.draw(ctx,canvas.width,canvas.height);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  draw(ctx,cw,ch){
    ctx.clearRect(0,0,cw,ch); ctx.save();
    this.drawGrid(ctx,cw,ch);
    Camera.transform(ctx);
    this.drawEdges(ctx); this.drawTrails(ctx); this.drawDropFX(ctx);
    this.drawNodes(ctx); this.drawPackets(ctx);
    if(this.view==='routing') this.drawRouting(ctx);
    ctx.restore();
  },

  drawGrid(ctx,cw,ch){
    ctx.save(); ctx.strokeStyle='rgba(26,37,68,0.35)'; ctx.lineWidth=0.5;
    const gs=40,ox=(cw/2+Camera.x)%gs,oy=(ch/2+Camera.y)%gs;
    for(let x=ox;x<cw;x+=gs){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,ch);ctx.stroke();}
    for(let y=oy;y<ch;y+=gs){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(cw,y);ctx.stroke();}
    ctx.restore();
  },

  drawEdges(ctx){
    this.connections.forEach(([a,b])=>{
      const na=this.nodes[a],nb=this.nodes[b]; if(!na||!nb) return;
      const down=na.status==='offline'||nb.status==='offline';
      ctx.beginPath(); ctx.moveTo(na.x,na.y); ctx.lineTo(nb.x,nb.y);
      ctx.strokeStyle=down?'rgba(239,68,68,0.2)':'rgba(26,37,68,0.9)';
      ctx.setLineDash(down?[6,4]:[]); ctx.lineWidth=2; ctx.stroke(); ctx.setLineDash([]);
      if(!down){
        const ht=this.packets.some(p=>{ const pi=p.pathIndex; return(p.path[pi]===a&&p.path[pi+1]===b)||(p.path[pi]===b&&p.path[pi+1]===a); });
        if(ht){ const mx=(na.x+nb.x)/2,my=(na.y+nb.y)/2; ctx.beginPath(); ctx.arc(mx,my,3,0,Math.PI*2); ctx.fillStyle='rgba(0,212,255,0.4)'; ctx.fill(); }
      }
    });
  },

  drawNodes(ctx){ Object.values(this.nodes).forEach(n=>this.drawNode(ctx,n)); },

  drawNode(ctx,n){
    const sz=NODE_SIZES[n.type]||22, c=NODE_COLORS[n.type]||'#00d4ff';
    const err=n.status==='error'||n.status==='offline', busy=n.status==='busy';
    if(n.highlight>0||busy){
      const gc=err?'#ef4444':c;
      const g=ctx.createRadialGradient(n.x,n.y,0,n.x,n.y,sz*2.5);
      g.addColorStop(0,gc+Math.round(n.highlight*60).toString(16).padStart(2,'0')); g.addColorStop(1,'transparent');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(n.x,n.y,sz*2.5,0,Math.PI*2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(n.x,n.y,sz+4,0,Math.PI*2);
    ctx.strokeStyle=err?'#ef4444':(n.highlight>0.3?c:'rgba(26,37,68,0.8)'); ctx.lineWidth=2; ctx.stroke();
    const gr=ctx.createRadialGradient(n.x-sz*0.3,n.y-sz*0.3,0,n.x,n.y,sz);
    gr.addColorStop(0,(err?'#ef4444':c)+'33'); gr.addColorStop(1,'#050810');
    ctx.beginPath(); ctx.arc(n.x,n.y,sz,0,Math.PI*2); ctx.fillStyle=gr; ctx.fill();
    if(err){ ctx.strokeStyle='#ef4444'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(n.x-7,n.y-7); ctx.lineTo(n.x+7,n.y+7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(n.x+7,n.y-7); ctx.lineTo(n.x-7,n.y+7); ctx.stroke(); }
    ctx.fillStyle=err?'#ef4444':c; ctx.font=`bold 9px 'Courier New'`; ctx.textAlign='center';
    ctx.fillText(n.label.toUpperCase(),n.x,n.y+sz+13);
    ctx.fillStyle='rgba(148,163,184,0.5)'; ctx.font='7px Courier New'; ctx.fillText(n.ip,n.x,n.y+sz+22);
    if(busy||n.highlight>0.5){ const t=(Date.now()%1000)/1000; ctx.beginPath(); ctx.arc(n.x,n.y,sz+6+t*12,0,Math.PI*2); ctx.strokeStyle=(busy?'#f59e0b':c)+Math.round((1-t)*80).toString(16).padStart(2,'0'); ctx.lineWidth=1; ctx.stroke(); }
  },

  drawPackets(ctx){
    this.packets.forEach(p=>{
      if(p.done) return;
      const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*3);
      g.addColorStop(0,p.color+'80'); g.addColorStop(1,'transparent');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,p.size*3,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,Math.PI*2); ctx.fillStyle=p.color; ctx.fill();
      if(p.label){ ctx.fillStyle='#fff'; ctx.font=`bold 8px 'Courier New'`; ctx.textAlign='center'; ctx.fillText(p.label,p.x,p.y-p.size-3); }
      if(p.encapLayers>1&&!p.dropped){ const cols=['#ef4444','#f59e0b','#10b981','#00d4ff']; for(let i=1;i<p.encapLayers;i++){ ctx.beginPath(); ctx.arc(p.x,p.y,p.size+i*3,0,Math.PI*2); ctx.strokeStyle=(cols[i-1]||'#fff')+'40'; ctx.lineWidth=1; ctx.stroke(); } }
    });
  },

  drawTrails(ctx){
    this.packets.forEach(p=>{
      if(p.trailPoints.length<2) return;
      ctx.beginPath(); ctx.moveTo(p.trailPoints[0].x,p.trailPoints[0].y);
      p.trailPoints.slice(1).forEach(pt=>ctx.lineTo(pt.x,pt.y));
      ctx.strokeStyle=p.dropped?'#ef4444':p.color; ctx.lineWidth=2; ctx.globalAlpha=0.28; ctx.stroke(); ctx.globalAlpha=1;
    });
  },

  drawDropFX(ctx){
    this.dropEffects.forEach(d=>{
      ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,Math.PI*2); ctx.strokeStyle=`rgba(239,68,68,${d.opacity})`; ctx.lineWidth=2; ctx.stroke();
      ctx.strokeStyle=`rgba(239,68,68,${d.opacity})`; ctx.beginPath(); ctx.moveTo(d.x-8,d.y-8); ctx.lineTo(d.x+8,d.y+8); ctx.stroke(); ctx.beginPath(); ctx.moveTo(d.x+8,d.y-8); ctx.lineTo(d.x-8,d.y+8); ctx.stroke();
    });
  },

  drawRouting(ctx){
    ['homerouter','core1','core2'].forEach(id=>{
      const n=this.nodes[id]; if(!n||!n.routingTable.length) return;
      const bx=n.x+30,by=n.y-40,rh=n.routingTable.length*14+22;
      ctx.fillStyle='rgba(10,15,30,0.93)'; ctx.fillRect(bx,by,180,rh);
      ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1; ctx.strokeRect(bx,by,180,rh);
      ctx.fillStyle='#f59e0b'; ctx.font='bold 9px Courier New'; ctx.textAlign='left'; ctx.fillText('ROUTING TABLE',bx+6,by+13);
      ctx.fillStyle='#94a3b8'; ctx.font='8px Courier New';
      n.routingTable.forEach((r,i)=>ctx.fillText(`${r.dest} → ${r.nexthop}`,bx+6,by+13+(i+1)*13));
    });
  }
};

// ===== OSI STACK =====
const OSIStack = {
  m:{7:'layer-7',6:'layer-6',5:'layer-5',4:'layer-4',3:'layer-3',2:'layer-2',1:'layer-1'},
  setLayer(n,s){ const el=document.getElementById(this.m[n]); if(!el) return; el.className='osi-layer'; if(s==='active')el.classList.add('active'); if(s==='error')el.classList.add('error'); },
  clear(){ Object.values(this.m).forEach(id=>{ const el=document.getElementById(id); if(el)el.className='osi-layer'; }); }
};

// ===== EVENT LOG =====
let logCount=0;
const EventLog = {
  log(msg,type='info'){
    const el=document.getElementById('event-log');
    const e=document.createElement('div'); e.className=`log-entry ${type}`;
    const ts=new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    e.innerHTML=`<span class="log-ts">${ts}</span>${msg}`;
    el.appendChild(e);
    el.scrollTop=el.scrollHeight;
    while(el.children.length>120) el.removeChild(el.firstChild);
    logCount++;
    const c=document.getElementById('log-count'); if(c) c.textContent=`${logCount} event${logCount!==1?'s':''}`;
  }
};

// ===== UI =====
const UI = {
  setStatus(m){ document.getElementById('status-bar').textContent=m; },

  setView(v){
    Sim.view=v;
    [['normal','network'],['encap','encap'],['routing','routing']].forEach(([k,vv])=>{
      const tb=document.getElementById(`btn-view-${k}`), mb=document.getElementById(`m-btn-view-${k}`);
      const a=v===vv; if(tb)tb.classList.toggle('active',a); if(mb)mb.classList.toggle('active',a);
    });
    const ev=document.getElementById('encap-view'); if(ev) ev.style.boxShadow=v==='encap'?'0 0 0 1px var(--accent)':'';
  },

  setPI(p){
    const s=(id,v)=>{ const el=document.getElementById(id); if(el)el.textContent=v; };
    s('pi-status',p.dropped?'DROPPED':(p.done?'DELIVERED':'IN TRANSIT'));
    s('pi-src',p.srcIp); s('pi-dst',p.dstIp); s('pi-port',p.dstPort);
    s('pi-proto',p.protocol); s('pi-ttl',p.ttl); s('pi-seq',p.seq);
    s('pi-payload',p.payload?`${p.payload}B`:'N/A'); s('pi-phase',p.flags);
  },

  updateEncap(layers){
    ['enc-data','enc-http','enc-tcp','enc-ip','enc-eth'].forEach((id,i)=>{
      const el=document.getElementById(id); if(!el) return;
      if(i<layers){ el.classList.add('visible'); el.classList.remove('hidden'); if(!el.dataset.added){el.classList.add('adding');el.dataset.added='1';setTimeout(()=>el.classList.remove('adding'),500);} }
      else { el.classList.add('hidden'); el.classList.remove('visible'); delete el.dataset.added; }
    });
  },

  updateConnection(name,state){
    const el=document.getElementById('conn-rows');
    let row=document.getElementById('conn-'+name);
    if(!row){ row=document.createElement('div'); row.id='conn-'+name; row.className='conn-row'; el.appendChild(row); }
    row.innerHTML=`<span style="color:var(--text2)">${name}</span><span class="conn-state ${state}">${state.toUpperCase()}</span>`;
  },

  clearConnections(){ document.getElementById('conn-rows').innerHTML=''; },

  renderTimeline(){
    const el=document.getElementById('timeline-events'); el.innerHTML='';
    Sim.timeline.forEach((ev,i)=>{
      if(i>0){ const l=document.createElement('div'); l.className='timeline-line'; el.appendChild(l); }
      const d=document.createElement('div'); d.className='timeline-event';
      d.innerHTML=`<div class="timeline-dot" style="background:${ev.color}"></div><div class="timeline-label">${ev.label}</div>`;
      el.appendChild(d);
    });
    const bar=document.getElementById('timeline-bar'); if(bar) bar.scrollLeft=bar.scrollWidth;
  },

  clearTimeline(){ document.getElementById('timeline-events').innerHTML=''; },

  togglePanel(side){
    const panel=document.getElementById(`${side}-panel`);
    const bd=document.getElementById('backdrop');
    const tog=document.getElementById(`dtog-${side}`);
    const isOpen=panel.classList.contains('open');
    document.getElementById('left-panel').classList.remove('open');
    document.getElementById('right-panel').classList.remove('open');
    document.getElementById('dtog-left').classList.remove('active');
    document.getElementById('dtog-right').classList.remove('active');
    if(!isOpen){ panel.classList.add('open'); tog.classList.add('active'); bd.classList.add('show'); }
    else { bd.classList.remove('show'); }
  },

  closeAll(){
    document.getElementById('left-panel').classList.remove('open');
    document.getElementById('right-panel').classList.remove('open');
    document.getElementById('dtog-left').classList.remove('active');
    document.getElementById('dtog-right').classList.remove('active');
    document.getElementById('backdrop').classList.remove('show');
  }
};

// ===== CANVAS HOVER =====
(function(){
  const canvas=document.getElementById('sim-canvas');
  const tip=document.getElementById('tooltip');
  let hn=null;

  canvas.addEventListener('mousemove',e=>{
    if(e.target.closest&&e.target.closest('#event-log-overlay')) return;
    const r=canvas.getBoundingClientRect();
    const w=Camera.toWorld(e.clientX-r.left,e.clientY-r.top);
    hn=null;
    for(const n of Object.values(Sim.nodes)){
      const sz=NODE_SIZES[n.type]||22;
      if(Math.hypot(w.x-n.x,w.y-n.y)<sz+8){hn=n;break;}
    }
    if(hn){
      tip.style.display='block'; tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY-10)+'px';
      tip.innerHTML=`<strong style="color:var(--accent)">${hn.label}</strong><br><span style="color:var(--text3)">IP:</span> ${hn.ip}<br><span style="color:var(--text3)">Status:</span> <span style="color:${hn.status==='online'?'var(--accent3)':'var(--err)'}">${hn.status}</span><br><span style="color:var(--text3)">Type:</span> ${hn.type}<br><span style="font-size:10px;color:var(--text2)">${hn.info.desc||''}</span>`;
      canvas.style.cursor='pointer';
    } else { tip.style.display='none'; canvas.style.cursor='grab'; }
  });

  canvas.addEventListener('mouseleave',()=>{ tip.style.display='none'; });

  canvas.addEventListener('click',e=>{
    if(!hn) return;
    EventLog.log(`Node: ${hn.label} [${hn.ip}] — ${hn.info.desc||''}`,'info');
    if(hn.routingTable?.length){ OSIStack.setLayer(3,'active'); setTimeout(()=>OSIStack.setLayer(3,'idle'),800); }
  });
})();

const overlay = document.getElementById('event-log-overlay');
const logContainer = document.getElementById('event-log');

overlay.addEventListener('wheel', (e) => {
  // Prevent the canvas zoom and any page scroll
  e.preventDefault();
  e.stopPropagation();

  // Scroll the log container by the same amount as the wheel delta
  logContainer.scrollTop += e.deltaY;
}, { passive: false });  // passive: false allows preventDefault()

Sim.init();