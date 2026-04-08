const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  const fp = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp);
    const ct = { '.html':'text/html','.js':'text/javascript','.css':'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct }); res.end(data);
  });
});
const wss = new WebSocketServer({ server });

const ARENA = { w: 1200, h: 800 };
const R = 18, BASE_SPEED = 4, BOMB_BOOST = 1.35;
const BOMB_MIN = 10000, BOMB_MAX = 20000, TAG_CD = 500;
const OBSTACLES = [
  {x:200,y:150,w:80,h:80},{x:500,y:100,w:120,h:60},{x:900,y:150,w:80,h:100},
  {x:150,y:400,w:60,h:120},{x:550,y:350,w:100,h:100},{x:950,y:380,w:80,h:80},
  {x:300,y:600,w:100,h:60},{x:600,y:620,w:80,h:80},{x:850,y:580,w:120,h:80},
];
const SPAWNS = [{x:100,y:100},{x:1100,y:100},{x:100,y:700},{x:1100,y:700},{x:600,y:100},{x:600,y:700}];

let players = new Map(), nextId = 1, state = 'lobby';
let bombHolder = null, bombTimer = null, bombStart = 0, bombDur = 0, roundNum = 0, scores = {};

function send(ws, m) { if (ws.readyState===1) ws.send(JSON.stringify(m)); }
function broadcast(m) { const d=JSON.stringify(m); for(const p of players.values()) if(p.ws.readyState===1) p.ws.send(d); }
function alive() { return [...players.values()].filter(p=>p.alive); }
function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function scoreboard() { return [...players.values()].map(p=>({id:p.id,name:p.name,score:scores[p.id]||0})); }
function serPlayers() { return [...players.values()].map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,alive:p.alive,ready:p.ready})); }

function resolveObs(p) {
  for (const o of OBSTACLES) {
    const cx=clamp(p.x,o.x,o.x+o.w), cy=clamp(p.y,o.y,o.y+o.h);
    const dx=p.x-cx, dy=p.y-cy, d2=dx*dx+dy*dy;
    if (d2<R*R) { const d=Math.sqrt(d2)||1; p.x=cx+dx/d*R; p.y=cy+dy/d*R; }
  }
}

function startRound() {
  const a = alive();
  if (a.length<2) return endMatch();
  roundNum++;
  const sh=[...SPAWNS].sort(()=>Math.random()-.5);
  a.forEach((p,i)=>{ p.x=sh[i%sh.length].x; p.y=sh[i%sh.length].y; });
  const h = a[Math.floor(Math.random()*a.length)];
  bombHolder=h.id; h.tagCd=Date.now()+TAG_CD;
  bombDur=BOMB_MIN+Math.random()*(BOMB_MAX-BOMB_MIN); bombStart=Date.now();
  state='playing';
  broadcast({type:'roundStart',round:roundNum,bombHolder,bombDuration:bombDur,players:serPlayers()});
  bombTimer=setTimeout(explode, bombDur);
}

function explode() {
  const h=players.get(bombHolder);
  if(!h) return;
  h.alive=false; state='roundEnd';
  broadcast({type:'explosion',playerId:bombHolder,x:h.x,y:h.y});
  bombHolder=null;
  setTimeout(()=>{ alive().length<2 ? endMatch() : startRound(); }, 3000);
}

function endMatch() {
  const a=alive(), w=a.length===1?a[0]:null;
  if(w) scores[w.id]=(scores[w.id]||0)+1;
  state='lobby';
  for(const p of players.values()){ p.alive=true; p.ready=false; }
  broadcast({type:'matchEnd',winner:w?{id:w.id,name:w.name}:null,scores:scoreboard()});
}

// 60fps game loop
setInterval(()=>{
  if(state!=='playing') return;
  for(const p of players.values()){
    if(!p.alive) continue;
    const spd = p.id===bombHolder ? BASE_SPEED*BOMB_BOOST : BASE_SPEED;
    let mx=0,my=0;
    if(p.inp.up) my-=1; if(p.inp.down) my+=1; if(p.inp.left) mx-=1; if(p.inp.right) mx+=1;
    if(p.inp.jx!=null){ mx+=p.inp.jx; my+=p.inp.jy; }
    const mag=Math.sqrt(mx*mx+my*my);
    if(mag>0){ p.x+=(mx/mag)*spd; p.y+=(my/mag)*spd; }
    p.x=clamp(p.x,R,ARENA.w-R); p.y=clamp(p.y,R,ARENA.h-R);
    resolveObs(p);
  }
  if(bombHolder){
    const h=players.get(bombHolder);
    if(h&&h.alive&&(!h.tagCd||Date.now()>h.tagCd)){
      for(const p of players.values()){
        if(p.id===bombHolder||!p.alive) continue;
        const dx=h.x-p.x,dy=h.y-p.y;
        if(dx*dx+dy*dy<(R*2)*(R*2)){
          const old=bombHolder; bombHolder=p.id; p.tagCd=Date.now()+TAG_CD;
          broadcast({type:'tagged',from:old,to:p.id}); break;
        }
      }
    }
  }
  broadcast({type:'state',players:[...players.values()].filter(p=>p.alive).map(p=>({id:p.id,x:p.x,y:p.y})),
    bombHolder,bombElapsed:Date.now()-bombStart,bombDuration:bombDur});
}, 1000/60);

wss.on('connection', ws=>{
  if(players.size>=6){ send(ws,{type:'full'}); ws.close(); return; }
  const id=nextId++, p={id,ws,name:'Player'+id,x:600,y:400,alive:true,ready:false,inp:{up:false,down:false,left:false,right:false}};
  players.set(id,p); scores[id]=scores[id]||0;
  send(ws,{type:'welcome',id,obstacles:OBSTACLES,arena:ARENA,players:serPlayers(),gameState:state,scores:scoreboard()});
  broadcast({type:'playerJoined',player:{id,name:p.name}});

  ws.on('message',raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==='setName'){ p.name=(m.name||'Anon').slice(0,16); broadcast({type:'nameChange',id,name:p.name}); }
    else if(m.type==='ready'){ p.ready=true; broadcast({type:'playerReady',id});
      if(state==='lobby'&&players.size>=2&&[...players.values()].every(q=>q.ready)){ for(const q of players.values()) q.alive=true; startRound(); }
    } else if(m.type==='input'){ p.inp=m.input; }
  });

  ws.on('close',()=>{
    players.delete(id); broadcast({type:'playerLeft',id});
    if(state==='playing'){
      if(bombHolder===id){ clearTimeout(bombTimer); const a=alive(); if(a.length<2) endMatch();
        else{ const nh=a[Math.floor(Math.random()*a.length)]; bombHolder=nh.id; broadcast({type:'tagged',from:id,to:nh.id}); }
      } else if(alive().length<2){ clearTimeout(bombTimer); endMatch(); }
    }
  });
});

server.listen(PORT, ()=>console.log(`Bomb Tag on http://localhost:${PORT}`));
