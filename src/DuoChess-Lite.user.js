// ==UserScript==
// @name         Duolingo Chess Solver
// @namespace    duochess-lite
// @version      1.1
// @icon         https://i.ibb.co/gZpNbsPP/cosmic.jpg
// @description  Automaticly solve your Duolingo chess lessons and play chess with Oscar for you.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        none
// @connect https://i.ibb.co/gZpNbsPP/cosmic.jpg
// @connect https://stockfish.online
// @connect https://esm.sh/chess.js@1.3.0
// @license MIT
// @copyright DuoHacker
// ==/UserScript==
 
/*
Just a small script for Duolingo Chess. My team and I probably won't update it much, so it might be a little broken lol.
*/
 
(() => {
"use strict";
 
const BOT_CFG = {
    engine:          "stockfish",
    jceLevel:        3,
    stockfishDepth:  12,
    clickDelay:      260,
    moveDelay:       700,
    thinkDelay:      350,
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    postMoves:       true,
};
 
const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      180,
    moveDelay:       600,
    enemyDelay:      800,
    continueDelay:   600,
    autoContinue:    true,
    flipped:         false,
    turbo:           true,   // skip verify-waits when the move sequence is already known-correct
    turboPressMs:    60,     // pointerdown→pointerup gap — below ~50ms Duolingo's board often drops the click
    turboClickGap:   60,     // gap between "from" click and "to" click — needs time to register piece selection
    turboSettleMs:   90,     // settle after a confirmed player move before next click
};
 
const STORE_KEY = "duochess.v1.settings";
 
function loadSettings(){
    try{
        const saved=JSON.parse(localStorage.getItem(STORE_KEY)||"{}");
        if(saved.bot){
            // Drop legacy cosmic/minimax keys
            delete saved.bot.minimaxDepth;
            delete saved.bot.cosmicDepth;
            if(saved.bot.engine==="minimax"||saved.bot.engine==="cosmic"||saved.bot.engine==="auto") saved.bot.engine="stockfish";
            Object.assign(BOT_CFG,saved.bot);
        }
        if(saved.solver) Object.assign(SOL_CFG,saved.solver);
    }catch(_){}
}
function saveSettings(){
    try{ localStorage.setItem(STORE_KEY,JSON.stringify({bot:BOT_CFG,solver:SOL_CFG})); }catch(_){}
}
loadSettings();
 
// ══════════════════════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════════════════════
 
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const UCI_RE   = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
const toUCI    = s => String(s).trim().split(/\s+/).filter(validUCI);
const esc      = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
 
async function boardStabilize(timeout = 3000, stableMs = 120, sampleInterval = 80) {
    const canvas = findCanvas();
    if (!canvas) { await sleep(stableMs); return; }
    const ctx = canvas.getContext("2d");
    if (!ctx) { await sleep(stableMs); return; }
    const w = Math.min(canvas.width, 64), h = Math.min(canvas.height, 64);
    const getHash = () => {
        try {
            const d = ctx.getImageData(0, 0, w, h).data;
            let s = 0;
            for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i] + d[i+1] + d[i+2]) | 0;
            return s;
        } catch(_) { return Math.random(); }
    };
    const t0 = Date.now();
    let prev = getHash(), stableSince = Date.now();
    while (Date.now() - t0 < timeout) {
        await sleep(sampleInterval);
        const cur = getHash();
        if (cur !== prev) { stableSince = Date.now(); prev = cur; }
        else if (Date.now() - stableSince >= stableMs) return;
    }
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════════
 
const BOT_S = {
    matchId: null, playerColor: null,
    currentFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moveHistory: [], status: "idle", authToken: null,
    jce: null, jceReady: false,
    stockfish: null, stockfishReady: false,
    engineName: "none", lastMove: null,
};
 
const SOL_STATE = {
    raw: null, challenges: [], currentIdx: 0, solving: false, log: [],
};
 
// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS & CLICK
// ══════════════════════════════════════════════════════════════════════════════
 
let _canvasCache = { el: null, t: 0 };
 
function findCanvas() {
    // Short-lived cache: avoids re-scanning the whole DOM on every snap/click
    // call when several happen back-to-back within the same animation frame.
    const now = Date.now();
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < 150) {
        return _canvasCache.el;
    }
    const candidates = [...document.querySelectorAll("canvas")]
        .filter(c => {
            if (!c.isConnected) return false;
            const r = c.getBoundingClientRect();
            if (!(r.width > 200 && r.height > 200 && Math.abs(r.width/r.height - 1) < 0.2)) return false;
            // Decorative overlay canvases (confetti/particles/celebration effects)
            // are typically non-interactive — skip them so we don't grab the
            // wrong layer when several square canvases are stacked.
            const cs = getComputedStyle(c);
            if (cs.pointerEvents === "none") return false;
            return true;
        })
        .sort((a,b) => {
            const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
            return (rb.width*rb.height)-(ra.width*ra.height);
        });
    const picked = candidates[0] ?? null;
    _canvasCache = { el: picked, t: now };
    return picked;
}
 
async function waitCanvas(timeout=10000) {
    const t0=Date.now();
    while(Date.now()-t0<timeout){ const c=findCanvas(); if(c) return c; await sleep(50); }
    throw new Error("Canvas not found");
}
 
function firePointer(el,type,x,y,buttons) {
    if(typeof PointerEvent==="function")
        el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,pointerId:1,pointerType:"mouse",isPrimary:true,view:window}));
}
function fireMouse(el,type,x,y,buttons) {
    el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,view:window}));
}
 
async function clickSquare(sq,insetRatio,flipped,pressMs=70) {
    const canvas=await waitCanvas();
    function coords(r) {
        const iw=r.width*insetRatio,ih=r.height*insetRatio;
        const bw=r.width-iw*2,bh=r.height-ih*2;
        const file=sq.charCodeAt(0)-97,rank=Number(sq[1]);
        const col=flipped?7-file:file,row=flipped?rank-1:8-rank;
        return {x:r.left+iw+(col+0.5)*bw/8,y:r.top+ih+(row+0.5)*bh/8};
    }
    const d=coords(canvas.getBoundingClientRect());
    firePointer(canvas,"pointerdown",d.x,d.y,1); fireMouse(canvas,"mousedown",d.x,d.y,1);
    await sleep(pressMs);
    const u=coords(canvas.getBoundingClientRect());
    firePointer(canvas,"pointerup",u.x,u.y,0); fireMouse(canvas,"mouseup",u.x,u.y,0); fireMouse(canvas,"click",u.x,u.y,0);
}
let _Chess = null;
 
async function loadChessJS(){
    try{
        const mod=await import("https://esm.sh/chess.js@1.3.0");
        _Chess=mod.Chess??mod.default?.Chess??mod.default;
        addLog("sys","chess.js loaded");
        reparseChallenges();
        renderPanel();
    }catch(e){addLog("sys","chess.js failed");}
}
 
async function loadJCE(){
    try{
        addLog("sys","Loading js-chess-engine...");
        const mod=await import("https://esm.sh/js-chess-engine@2.3.2");
        BOT_S.jce=mod.Game??mod.default?.Game;
        if(!BOT_S.jce) throw new Error("JCE Game class not found");
        BOT_S.jceReady=true;
        addLog("sys","js-chess-engine ready");
        renderPanel();
    } catch(e){
        addLog("sys","js-chess-engine failed: "+e.message);
        renderPanel();
    }
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  ENGINE — Stockfish (stockfish.online REST API)
//  API: GET https://stockfish.online/api/s/v2.php?fen=<FEN>&depth=<N>&mode=bestmove
//  Returns JSON: { success: true, bestmove: "e2e4 ponder d7d5", ... }
//  Logo: https://stockfishchess.org/images/logo/icon_512x512@2x.webp
// ══════════════════════════════════════════════════════════════════════════════
 
async function loadStockfish(){
    addLog("sys","Checking stockfish.online API...");
    try{
        const testFen = encodeURIComponent("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        const r = await _origFetch(
            `https://stockfish.online/api/s/v2.php?fen=${testFen}&depth=5&mode=bestmove`,
            {method:"GET"}
        );
        if(!r.ok) throw new Error("HTTP "+r.status);
        const data = await r.json();
        if(!data.success) throw new Error("API returned success:false");
        BOT_S.stockfishReady = true;
        BOT_S.stockfish = { api: true };
        addLog("sys","stockfish.online ready — bestmove: "+data.bestmove);
        renderPanel();
        return true;
    } catch(e){
        addLog("sys","stockfish.online unreachable: "+e.message);
        renderPanel();
        return false;
    }
}
 
async function stockfishBestMove(fen, depth){
    if(!BOT_S.stockfishReady) return null;
    try{
        const encodedFen = encodeURIComponent(fen);
        const clampedDepth = Math.min(depth, 15);
        const r = await _origFetch(
            `https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=${clampedDepth}&mode=bestmove`,
            {method:"GET"}
        );
        if(!r.ok) throw new Error("HTTP "+r.status);
        const data = await r.json();
        if(!data.success || !data.bestmove) throw new Error("No bestmove in response");
        const mv = data.bestmove.replace(/^bestmove\s*/,"").split(/\s+/)[0];
        return validUCI(mv) ? mv : null;
    } catch(e){
        addLog("sys","SF API err: "+e.message);
        return null;
    }
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  ENGINE — DISPATCH
// ══════════════════════════════════════════════════════════════════════════════
 
function activeEngineName(){
    const e=BOT_CFG.engine;
    if(e==="stockfish"&&BOT_S.stockfishReady) return "Stockfish";
    if(e==="jce"&&BOT_S.jceReady)             return "js-chess-engine";
    // fallback if chosen engine not ready
    if(BOT_S.stockfishReady) return "Stockfish";
    if(BOT_S.jceReady)       return "js-chess-engine";
    return "none";
}
 
async function getBestMove(fen){
    const e=BOT_CFG.engine;
 
    // Stockfish (primary or fallback)
    if(BOT_S.stockfishReady&&(e==="stockfish"||e!=="jce")){
        try{
            const mv=await stockfishBestMove(fen,BOT_CFG.stockfishDepth);
            if(mv){ BOT_S.engineName="Stockfish"; return mv; }
        }catch(_){}
    }
 
    // JCE (primary or fallback)
    if(BOT_S.jceReady&&BOT_S.jce&&(e==="jce"||e!=="stockfish")){
        try{
            const game=new BOT_S.jce(fen),obj=game.aiMove(BOT_CFG.jceLevel);
            const[from,to]=Object.entries(obj)[0];
            let uci=from.toLowerCase()+to.toLowerCase();
            if((parseInt(from[1])===7&&parseInt(to[1])===8)||(parseInt(from[1])===2&&parseInt(to[1])===1)) uci+="q";
            BOT_S.engineName="js-chess-engine";
            return uci;
        }catch(_){}
    }
 
    // Last resort: random via chess.js
    if(_Chess){
        try{
            const chess=new _Chess(fen),moves=chess.moves({verbose:true});
            if(moves.length){
                const m=moves[Math.floor(Math.random()*moves.length)];
                BOT_S.engineName="random";
                return m.from+m.to+(m.promotion??"");
            }
        }catch(_){}
    }
 
    return null;
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  BOT LOGIC
// ══════════════════════════════════════════════════════════════════════════════
 
const MATCHES_RE=/\/chess\/\d+\/\d+\/matches(?:\/([^/?#]+))?/;
const MOVES_RE=/\/chess\/\d+\/\d+\/matches\/[^/?#]+\/moves/;
const isMatchURL=url=>MATCHES_RE.test(url)&&!MOVES_RE.test(url);
const isSessionURL=url=>typeof url==="string"&&/\/sessions(?:[/?#]|$)/i.test(url);
const fenSide=fen=>fen?.split(" ")?.[1]??"w";
function isOurTurn(fen){if(!BOT_S.playerColor||!BOT_S.matchId)return false;const s=fenSide(fen);return(s==="w"&&BOT_S.playerColor==="white")||(s==="b"&&BOT_S.playerColor==="black");}
 
function onMatchData(data){
    if(!data) return;
    const match=data.match??(data.boardFen?data:null);
    if(!match) return;
    if(match.id&&!BOT_S.matchId){BOT_S.matchId=match.id;BOT_S.playerColor=match.playerColor??"white";addLog("bot",`Match ${match.id.slice(0,8)} — ${BOT_S.playerColor}`);}
    if(match.boardFen) BOT_S.currentFen=match.boardFen;
    if(Array.isArray(match.moveHistory)) BOT_S.moveHistory=[...match.moveHistory];
    if(match.endCondition||match.status==="finished"){BOT_S.status="idle";renderPanel();return;}
    if(match.status==="active"&&isOurTurn(BOT_S.currentFen)){
        if(BOT_S.status!=="thinking"&&BOT_S.status!=="playing"){
            BOT_S.status="our_turn";
            if(BOT_CFG.autoPlay) setTimeout(takeTurn,BOT_CFG.thinkDelay);
        }
    } else BOT_S.status="waiting";
    renderPanel();
}
 
async function waitCanvasChange(baseline, timeout=1200, interval=40){
    const canvas=findCanvas();
    if(!canvas||baseline===null) { await sleep(120); return; }
    const ctx=canvas.getContext("2d");
    if(!ctx) { await sleep(120); return; }
    const w=Math.min(canvas.width,64), h=Math.min(canvas.height,64);
    const t0=Date.now();
    while(Date.now()-t0<timeout){
        await sleep(interval);
        try{
            const d=ctx.getImageData(0,0,w,h).data;
            let s=0; for(let i=0;i<d.length;i+=16) s=(s*31+d[i]+d[i+1]+d[i+2])|0;
            if(s!==baseline) return;
        }catch(_){ return; }
    }
}
 
function canvasHash(){
    const canvas=findCanvas();
    if(!canvas) return null;
    try{
        const ctx=canvas.getContext("2d");
        if(!ctx) return null;
        const w=Math.min(canvas.width,64), h=Math.min(canvas.height,64);
        const d=ctx.getImageData(0,0,w,h).data;
        let s=0; for(let i=0;i<d.length;i+=16) s=(s*31+d[i]+d[i+1]+d[i+2])|0;
        return s;
    }catch(_){ return null; }
}
 
async function takeTurn(){
    if(BOT_S.status==="thinking"||BOT_S.status==="playing") return;
    BOT_S.status="thinking"; renderPanel();
 
    let move=null, fenUsed=null;
    let attempts=0;
    while(attempts++<2){
        fenUsed=BOT_S.currentFen;                 // snapshot the FEN we're thinking against
        move=await getBestMove(fenUsed);
        if(!move){BOT_S.status="idle";renderPanel();return;}
        // If the board changed while we were waiting on the engine (poll loop /
        // websocket pushed a new boardFen), the move we just computed may no
        // longer be legal — validate against the FEN we're about to act on.
        if(fenUsed===BOT_S.currentFen) break;       // board didn't move, safe to use
        if(_Chess){
            try{
                const c=new _Chess(BOT_S.currentFen);
                const ok=c.moves({verbose:true}).some(m=>m.from+m.to+(m.promotion??"")===move);
                if(ok) break;                       // still legal on the latest board, use it
            }catch(_){}
        }
        // not safe — loop once more and recompute against the latest FEN
        addLog("bot","board changed mid-think, recomputing");
        move=null;
    }
    if(!move){BOT_S.status="idle";renderPanel();return;}
 
    BOT_S.status="playing"; BOT_S.lastMove=move; renderPanel();
    try{
        const flip=BOT_CFG.flipped||BOT_S.playerColor==="black";
        const hashBefore=canvasHash();
        await clickSquare(move.slice(0,2),BOT_CFG.boardInsetRatio,flip);
        await waitCanvasChange(hashBefore, 1000, 30);
        await sleep(Math.max(BOT_CFG.clickDelay, 120));
        await clickSquare(move.slice(2,4),BOT_CFG.boardInsetRatio,flip);
        if(move[4]){
            await sleep(350);
            const name={q:"queen",r:"rook",b:"bishop",n:"knight"}[move[4]]??"queen";
            for(const sel of[`[data-piece="${name}"]`,`[aria-label*="${name}" i]`]){const el=document.querySelector(sel);if(el){el.click();break;}}
        }
        await sleep(BOT_CFG.moveDelay);
        if(BOT_CFG.postMoves&&BOT_S.matchId) await postMove(move);
        addLog("bot",`${move} [${BOT_S.engineName}]`);
        BOT_S.status="waiting";
    } catch(e){addLog("bot","err: "+e.message);BOT_S.status="idle";}
    renderPanel();
}
 
async function postMove(uci){
    const uid=location.pathname.match(/\/(\d+)\//)?.[1]??"0";
    const hdrs={"Content-Type":"application/json"};
    if(BOT_S.authToken) hdrs["Authorization"]=BOT_S.authToken;
    try{
        const res=await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}/moves`,{method:"POST",headers:hdrs,body:JSON.stringify({move:uci})});
        const data=await res.json(),m=data.match??data;
        if(m?.boardFen) BOT_S.currentFen=m.boardFen;
        if(m?.boardFen&&isOurTurn(m.boardFen)&&BOT_CFG.autoPlay) setTimeout(takeTurn,BOT_CFG.thinkDelay+BOT_CFG.moveDelay);
    } catch(_){}
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  SOLVER
// ══════════════════════════════════════════════════════════════════════════════
 
function _sanitizeDuoFen(fen){
    const parts=fen.split(" ");
    const rows=parts[0].split("/");
    rows[0]=rows[0].replace(/[pP]/g,ch=>ch==="p"?"q":"Q");
    rows[7]=rows[7].replace(/[pP]/g,ch=>ch==="p"?"q":"Q");
    parts[0]=rows.join("/");
    const board=parts[0];
    const hasWK=/K/.test(board), hasBK=/k/.test(board);
    if(!hasWK||!hasBK){
        const r2=parts[0].split("/");
        const expand=row=>{const c=[];for(const ch of row){if(/\d/.test(ch))for(let i=0;i<+ch;i++)c.push(".");else c.push(ch);}return c;};
        const compress=c=>{let s="",e=0;for(const x of c){if(x==="."){e++;}else{if(e)s+=e;s+=x;e=0;}}if(e)s+=e;return s;};
        const grid=r2.map(expand);
        const place=(g,p,rs)=>{for(const r of rs)for(let f=7;f>=0;f--)if(g[r][f]==="."){g[r][f]=p;return;}};
        if(!hasWK) place(grid,"K",[7,6,5,4]);
        if(!hasBK) place(grid,"k",[0,1,2,3]);
        parts[0]=grid.map(compress).join("/");
        if(parts.length>=3) parts[2]="-";
    }
    return parts.join(" ");
}
 
function _forceWhite(fen){
    const p=fen.split(" ");
    p[1]="w"; p[2]="-"; p[3]="-";
    return p.join(" ");
}
 
function starCaptureAdapter(fen, seedMoves, maxMoves){
    if(!_Chess) return null;
    try{
        let workFen=_sanitizeDuoFen(fen);
        const steps=[];
        const limit=maxMoves??16;
        const pieceVal={p:1,n:3,b:3,r:5,q:9,k:0};
        for(const uci of seedMoves){
            if(!validUCI(uci)) continue;
            workFen=_forceWhite(workFen);
            const c=new _Chess(workFen);
            const res=c.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]??undefined});
            if(!res) break;
            steps.push({kind:"player",move:uci});
            workFen=_forceWhite(c.fen());
        }
        let iters=0;
        while(steps.length<limit&&iters++<32){
            workFen=_forceWhite(workFen);
            const c=new _Chess(workFen);
            const moves=c.moves({verbose:true});
            const caps=moves.filter(m=>m.captured&&m.captured!=="k");
            if(!caps.length) break;
            caps.sort((a,b)=>(pieceVal[b.captured??""]??0)-(pieceVal[a.captured??""]??0));
            const best=caps[0];
            c.move(best);
            workFen=c.fen();
            steps.push({kind:"player",move:best.from+best.to+(best.promotion??"")});
        }
        return steps.length>0 ? steps : null;
    }catch(_){ return null; }
}
 
function countBlackPieces(fen){
    const board=fen.split(" ")[0];
    return(board.match(/p/g)??[]).length;
}
 
function buildSequence(info, fen){
    const correct=(info.correctMoves??[]).flatMap(toUCI);
    const enemy=(info.enemyMoves??[]).flatMap(toUCI);
    const validPth=(info.validPaths??[]).map(v=>toUCI(String(v)));
    const hiMoves=(info.highlight??[]).flatMap(v=>String(v).match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/g)??[]);
    const maxMoves=info.maxMoves??undefined;
    const hasEnemy=enemy.length>0;
    const starCount=fen?countBlackPieces(fen):0;
 
    if(correct.length>0){
        const steps=correct.map(m=>({kind:"player",move:m}));
        if(hasEnemy){
            const mixed=[];
            correct.forEach((m,i)=>{mixed.push({kind:"player",move:m});if(i<enemy.length)mixed.push({kind:"enemy",move:enemy[i]});});
            return{source:"correctMoves",steps:mixed,allPaths:validPth};
        }
        return{source:"correctMoves",steps,allPaths:validPth};
    }
    if(validPth.length>0&&validPth[0].length>0){
        const seed=validPth[0];
        return{source:"validPaths",steps:seed.map(m=>({kind:"player",move:m})),allPaths:validPth};
    }
    if(hiMoves.length>0){
        if(_Chess&&fen){
            const adapted=starCaptureAdapter(fen,hiMoves,maxMoves);
            if(adapted&&adapted.length>0) return{source:"adapter(highlight)",steps:adapted,allPaths:[]};
        }
        return{source:"highlight",steps:hiMoves.map(m=>({kind:"player",move:m})),allPaths:[]};
    }
    if(_Chess&&fen&&starCount>0){
        const adapted=starCaptureAdapter(fen,[],maxMoves);
        if(adapted&&adapted.length>0) return{source:"adapter(fen)",steps:adapted,allPaths:[]};
    }
    const evalMap=info.moveEvaluationsForPositions??{},evalSteps=[];
    for(const k of Object.keys(evalMap)){
        const best=evalMap[k].filter(e=>e.moveCorrectness==="correct").sort((a,b)=>b.wdl-a.wdl)[0];
        if(best&&validUCI(best.move)){evalSteps.push({kind:"player",move:best.move});if(best.enemyResponse&&validUCI(best.enemyResponse))evalSteps.push({kind:"enemy",move:best.enemyResponse});}
    }
    if(evalSteps.length>0) return{source:"evalFallback",steps:evalSteps,allPaths:[]};
    return{source:"none",steps:[],allPaths:[]};
}
 
function parseChallenge(raw,idx){
    const p=buildSequence(raw?.chessPuzzleInfo??{}, raw?.fen??"");
    return{idx,id:raw.id??`ch_${idx}`,fen:raw.fen??"",source:p.source,steps:p.steps,allPaths:p.allPaths,raw};
}
 
function reparseChallenges(){
    if(!SOL_STATE.raw||!SOL_STATE.challenges.length) return;
    const prevIdx=SOL_STATE.currentIdx;
    SOL_STATE.challenges=[...(SOL_STATE.raw.challenges??[]),...(SOL_STATE.raw.adaptiveChallenges??[])].map(parseChallenge);
    SOL_STATE.currentIdx=prevIdx;
    addLog("solver","Re-parsed with StarAdapter: "+SOL_STATE.challenges.length+" challenges");
    renderPanel();
}
 
function processSession(session){
    if(!Array.isArray(session?.challenges)) return;
    SOL_STATE.raw=session; SOL_STATE.currentIdx=0;
    SOL_STATE.challenges=[...(session.challenges??[]),...(session.adaptiveChallenges??[])].map(parseChallenge);
    addLog("solver",`Session loaded: ${SOL_STATE.challenges.length} challenges`);
    renderPanel();
}
 
async function clickContinue(){
    const t0=Date.now();
    while(Date.now()-t0<6000){
        const b=document.querySelector('button[data-test="player-next"]:not([aria-disabled="true"])')
            ??[...document.querySelectorAll("button")].find(x=>{const t=x.textContent.trim().toLowerCase();return(t==="tiep tuc"||t==="continue"||t==="tiếp tục")&&x.getAttribute("aria-disabled")!=="true"&&x.isConnected;});
        if(b){b.click();return true;}
        await sleep(100);
    }
    return false;
}
 
// Fast canvas-change detector: returns as soon as hash differs from baseline, or timeout
async function _waitBoardChange(baseline, timeout=1500, interval=20){
    const canvas=findCanvas();
    if(!canvas||baseline===null){await sleep(60);return;}
    const ctx=canvas.getContext("2d");
    if(!ctx){await sleep(60);return;}
    const w=Math.min(canvas.width,32),h=Math.min(canvas.height,32);
    const t0=Date.now();
    while(Date.now()-t0<timeout){
        await sleep(interval);
        try{
            const d=ctx.getImageData(0,0,w,h).data;
            let s=0;for(let i=0;i<d.length;i+=8)s=(s*31+d[i]+d[i+1]+d[i+2])|0;
            if(s!==baseline){ _canvasCache.t=0; return; }
        }catch(_){return;}
    }
}
 
// Fast canvas hash snapshot
function _canvasSnap(){
    const canvas=findCanvas();
    if(!canvas)return null;
    try{
        const ctx=canvas.getContext("2d");
        if(!ctx)return null;
        const w=Math.min(canvas.width,32),h=Math.min(canvas.height,32);
        const d=ctx.getImageData(0,0,w,h).data;
        let s=0;for(let i=0;i<d.length;i+=8)s=(s*31+d[i]+d[i+1]+d[i+2])|0;
        return s;
    }catch(_){return null;}
}
 
async function solveChallenge(ch){
    if(!ch.steps.length){addLog("solver",`#${ch.idx} no steps (${ch.source})`);return;}
    addLog("solver",`Solving #${ch.idx} [${ch.source}]${SOL_CFG.turbo?" ⚡turbo":""}`);
    for(const step of ch.steps){
        renderPanel();
        if(step.kind==="player"){
            if(!validUCI(step.move)) throw new Error("Invalid UCI: "+step.move);
            addLog("solver",`Move: ${step.move}`);
 
            if(SOL_CFG.turbo){
                // Known-correct move from puzzle data — no need to wait for canvas
                // confirmation, just give Duolingo's click handler enough time to
                // register each press before firing the next one.
                await clickSquare(step.move.slice(0,2),SOL_CFG.boardInsetRatio,SOL_CFG.flipped,SOL_CFG.turboPressMs);
                await sleep(SOL_CFG.turboClickGap);
                await clickSquare(step.move.slice(2,4),SOL_CFG.boardInsetRatio,SOL_CFG.flipped,SOL_CFG.turboPressMs);
                await sleep(SOL_CFG.turboSettleMs);
            } else {
                const h0=_canvasSnap();
                await clickSquare(step.move.slice(0,2),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
                await sleep(SOL_CFG.clickDelay);   // gap between from→to click
                await clickSquare(step.move.slice(2,4),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
 
                // Wait for board to actually change (our piece moved), then a short settle
                await _waitBoardChange(h0, 1500, 20);
                await sleep(SOL_CFG.moveDelay);    // let animation finish
            }
 
        } else {
            // Enemy move: outcome isn't known in advance (server/engine decides),
            // so always poll for an actual board change — turbo just polls faster.
            addLog("solver",`Waiting enemy: ${step.move}`);
            const h1=_canvasSnap();
            const interval=SOL_CFG.turbo?10:20;
            const timeout=SOL_CFG.turbo?SOL_CFG.enemyDelay:(SOL_CFG.enemyDelay+800);
            await _waitBoardChange(h1, timeout, interval);
            await sleep(SOL_CFG.turbo?30:80); // tiny settle after enemy animation
        }
    }
    addLog("solver",`#${ch.idx} complete`);
    if(SOL_CFG.autoContinue){await sleep(SOL_CFG.turbo?Math.min(150,SOL_CFG.continueDelay):SOL_CFG.continueDelay);await clickContinue();}
}
 
async function solve(idx=SOL_STATE.currentIdx){
    if(SOL_STATE.solving) throw new Error("Already solving");
    const ch=SOL_STATE.challenges[idx];if(!ch) throw new Error("No challenge at "+idx);
    SOL_STATE.solving=true;try{await solveChallenge(ch);}finally{SOL_STATE.solving=false;renderPanel();}
}
 
async function solveNext(){
    if(!SOL_STATE.challenges.length) throw new Error("No session loaded");
    if(SOL_STATE.currentIdx>=SOL_STATE.challenges.length){addLog("solver","All done");return;}
    await solve(SOL_STATE.currentIdx);SOL_STATE.currentIdx++;renderPanel();
}
 
async function solveAll(){
    if(SOL_STATE.solving) throw new Error("Already solving");
    while(SOL_STATE.currentIdx<SOL_STATE.challenges.length){await solveNext();await sleep(200);}
    addLog("solver","All challenges complete");renderPanel();
}
 
// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK HOOKS
// ══════════════════════════════════════════════════════════════════════════════
 
let _lastSessionUrl = null;
const _origFetch=window.fetch;
window.fetch=async function(...args){
    const res=await _origFetch.apply(this,args);
    const url=typeof args[0]==="string"?args[0]:(args[0]?.url??res.url??"");
    if(args[1]?.headers){const h=args[1].headers;const tok=typeof h.get==="function"?h.get("authorization"):h["authorization"];if(tok)BOT_S.authToken=tok;}
    if(isMatchURL(url))   res.clone().json().then(onMatchData).catch(()=>{});
    if(isSessionURL(url)) { _lastSessionUrl = url; res.clone().json().then(processSession).catch(()=>{}); }
    return res;
};
const _xOpen=XMLHttpRequest.prototype.open,_xSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,url,...r){this.__dcUrl=String(url??"");return _xOpen.call(this,m,url,...r);};
XMLHttpRequest.prototype.send=function(...args){
    const url=this.__dcUrl;
    if(isMatchURL(url)||isSessionURL(url)){
        this.addEventListener("load",()=>{
            try{const d=this.responseType==="json"?this.response:JSON.parse(this.responseText);if(isMatchURL(url))onMatchData(d);if(isSessionURL(url)){_lastSessionUrl=url;processSession(d);}}catch(_){}
        });
    }
    return _xSend.apply(this,args);
};
 
// ══════════════════════════════════════════════════════════════════════════════
//  LOG
// ══════════════════════════════════════════════════════════════════════════════
 
function addLog(source,msg){
    SOL_STATE.log.push({source,msg,time:new Date().toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit",second:"2-digit"})});
    if(SOL_STATE.log.length>120) SOL_STATE.log.shift();
    renderPanel();
}
 
// ══════════════════════════════════════════════════════════════════════════════
 
 
 
 
// ── Chủ động fetch /sessions từ URL hiện tại ──
async function _fetchSession() {
    let sessionUrl = null;
 
    // 1. Dùng URL đã cache từ hook (reliable nhất)
    if (_lastSessionUrl) sessionUrl = _lastSessionUrl;
 
    // 2. Scan performance entries (chỉ có sau khi page load xong)
    if (!sessionUrl) {
        try {
            const SESSION_RE = /\/sessions(?:[/?#&]|$)/i;
            const hit = performance.getEntriesByType("resource")
                .find(e => SESSION_RE.test(e.name));
            if (hit) sessionUrl = hit.name;
        } catch (_) {}
    }
 
    if (!sessionUrl) {
        const date = new Date().toISOString().slice(0, 10);
        const candidates = [
            `https://www.duolingo.com/${date}/sessions`,
            `/api/1/sessions`,
            `/${date}/sessions`,
        ];
        for (const url of candidates) {
            try {
                const hdrs = {};
                if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
                const r = await _origFetch(url, { method: "GET", headers: hdrs });
                if (r.ok) { sessionUrl = url; break; }
            } catch (_) {}
        }
    }
 
    if (!sessionUrl) {
        addLog("solver", "[fetch] /sessions URL not found — navigate to a chess lesson first");
        return false;
    }
 
    try {
        const hdrs = {};
        if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
        const r = await _origFetch(sessionUrl, { method: "GET", headers: hdrs });
        if (!r.ok) { addLog("solver", "[fetch] /sessions HTTP " + r.status); return false; }
        const data = await r.json();
        processSession(data);
        return true;
    } catch (e) {
        addLog("solver", "[fetch] /sessions err: " + e.message);
        return false;
    }
}
 
//  SVG ICONS
    // ══════════════════════════════════════════════════════════════════════════════
 
    const ICONS = {
        play: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 3l10 5-10 5V3z" fill="currentColor"/></svg>`,
        pause: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor"/><rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor"/></svg>`,
        next: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3l7 5-7 5V3z" fill="currentColor"/><rect x="11" y="3" width="2" height="10" rx="1" fill="currentColor"/></svg>`,
        skipall: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3l5 5-5 5V3z" fill="currentColor"/><path d="M8 3l5 5-5 5V3z" fill="currentColor"/></svg>`,
        flip: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 10H6m3-3l-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        close: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
        minus: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
        chess: `
<svg width="18" height="18" viewBox="0 0 1024 1024" fill="none"
     xmlns="http://www.w3.org/2000/svg">
    <path d="M326.008826 236.527964h364.960302c8.422161 0 16.844322 9.825854 18.949862 22.459096l89.836382 701.846734a19.651709 19.651709 0 0 1-21.055402 22.459095H239.681678a19.651709 19.651709 0 0 1-20.353556-22.459095l90.538229-701.846734c1.403693-12.633241 9.825854-22.459095 16.142475-22.459096z"
          fill="currentColor"/>
    <path d="M191.254253 939.076545l646.400842 0 0 84.221608-646.400842 0 0-84.221608Z"
          fill="currentColor"/>
    <path d="M310.568198 433.04505h400.052638q17.546168 0 18.949862-5.614774L838.356942 249.863052s-18.248015-14.036935-32.28495-14.036935H213.011502c-14.036935 0-23.160942 10.527701-21.055402 14.036935L286.705409 421.113655a21.757249 21.757249 0 0 0 11.931394 9.825855z"
          fill="currentColor"/>
    <path d="M726.763311 0.005615h65.973593a43.514498 43.514498 0 0 1 44.216344 44.216344V259.688906a43.514498 43.514498 0 0 1-43.514497 44.216345h-561.477387A44.216344 44.216344 0 0 1 185.639479 259.688906V44.221959A44.216344 44.216344 0 0 1 229.855823 0.005615h70.184674v118.612098A21.757249 21.757249 0 0 0 326.008826 140.374962h56.147739a21.757249 21.757249 0 0 0 21.757248-21.757249V0.005615h218.976182v118.612098a21.757249 21.757249 0 0 0 21.757248 21.757249h59.656973a21.757249 21.757249 0 0 0 21.757248-21.757249z"
          fill="currentColor"/>
</svg>`,
        bolt: `
<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
     xmlns="http://www.w3.org/2000/svg">
    <path d="M17.502 12.033l-4.241-2.458 2.138-5.131c.066-.134.103-.285.103-.444 0-.552-.445-1-.997-1-.249.004-.457.083-.622.214l-.07.06-7.5 7.1c-.229.217-.342.529-.306.842.036.313.219.591.491.75l4.242 2.46-2.163 5.19c-.183.436-.034.94.354 1.208.173.118.372.176.569.176.248 0 .496-.093.688-.274l7.5-7.102c.229-.217.342-.529.306-.842-.037-.313-.22-.591-.492-.749z"
          fill="currentColor"/>
</svg>`,
        log: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="1.5" rx="0.75" fill="currentColor"/><rect x="2" y="7" width="9" height="1.5" rx="0.75" fill="currentColor"/><rect x="2" y="11" width="11" height="1.5" rx="0.75" fill="currentColor"/></svg>`,
        settings: `
<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
     xmlns="http://www.w3.org/2000/svg">
    <path d="M12 4a1 1 0 0 0-1 1c0 1.692-2.046 2.54-3.243 1.343a1 1 0 1 0-1.414 1.414C7.54 8.954 6.693 11 5 11a1 1 0 1 0 0 2c1.692 0 2.54 2.046 1.343 3.243a1 1 0 0 0 1.414 1.414C8.954 16.46 11 17.307 11 19a1 1 0 1 0 2 0c0-1.692 2.046-2.54 3.243-1.343a1 1 0 1 0 1.414-1.414C16.46 15.046 17.307 13 19 13a1 1 0 1 0 0-2c-1.692 0-2.54-2.046-1.343-3.243a1 1 0 0 0-1.414-1.414C15.046 7.54 13 6.693 13 5a1 1 0 0 0-1-1zm-2.992.777a3 3 0 0 1 5.984 0 3 3 0 0 1 4.23 4.231 3 3 0 0 1 .001 5.984 3 3 0 0 1-4.231 4.23 3 3 0 0 1-5.984 0 3 3 0 0 1-4.231-4.23 3 3 0 0 1 0-5.984 3 3 0 0 1 4.231-4.231z"
          fill="currentColor"/>
    <path d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-2.828-.828a4 4 0 1 1 5.656 5.656 4 4 0 0 1-5.656-5.656z"
          fill="currentColor"/>
</svg>`,
        check: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        reload: `
<svg width="14" height="14" viewBox="0 0 20 20" fill="none"
     xmlns="http://www.w3.org/2000/svg">
    <path d="M13.9372 4.21148C14.3936 4.52244 14.5115 5.14453 14.2005 5.60095C13.8896 6.05738 13.2675 6.1753 12.8111 5.86434C11.9885 5.30394 11.0183 5 10 5C7.23858 5 5 7.23858 5 10C5 12.7614 7.23858 15 10 15C12.7614 15 15 12.7614 15 10C15 9.44772 15.4477 9 16 9C16.5523 9 17 9.44772 17 10C17 13.866 13.866 17 10 17C6.13401 17 3 13.866 3 10C3 6.13401 6.13401 3 10 3C11.4232 3 12.7852 3.42666 13.9372 4.21148Z"
          fill="currentColor"/>
    <path d="M13.5385 12.5062C13.0732 12.8038 12.4548 12.6679 12.1572 12.2026C11.8596 11.7373 11.9955 11.1189 12.4608 10.8214L15.9426 8.59426C16.4079 8.29667 17.0263 8.43258 17.3239 8.89784C17.6215 9.36309 17.4855 9.98149 17.0203 10.2791L13.5385 12.5062Z"
          fill="currentColor"/>
    <path d="M18.9034 12.4104C19.1284 12.9147 18.9019 13.506 18.3976 13.731C17.8932 13.956 17.3019 13.7295 17.0769 13.2252L15.5688 9.84436C15.3438 9.33999 15.5702 8.74871 16.0746 8.52371C16.579 8.29871 17.1703 8.52519 17.3953 9.02957L18.9034 12.4104Z"
          fill="currentColor"/>
</svg>`,
        cpu: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="5.5" y="5.5" width="5" height="5" rx="0.5" fill="currentColor"/><path d="M5 1v2M8 1v2M11 1v2M5 13v2M8 13v2M11 13v2M1 5h2M1 8h2M1 11h2M13 5h2M13 8h2M13 11h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
        dot: `<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor"/></svg>`,
    };
 
    // ══════════════════════════════════════════════════════════════════════════════
    //  STYLES  (Duolingo × Apple)
    // ══════════════════════════════════════════════════════════════════════════════
 
    const STYLE = `
@font-face {
    font-family: "SF Pro Rounded";
    src: url("https://font.duohacker.io.vn/SF-Pro-Rounded-Regular.otf") format("opentype");
    font-weight: 400; font-display: swap;
}
@font-face {
    font-family: "SF Pro Rounded";
    src: url("https://font.duohacker.io.vn/SF-Pro-Rounded-Semibold.otf") format("opentype");
    font-weight: 600; font-display: swap;
}
@font-face {
    font-family: "SF Pro Rounded";
    src: url("https://font.duohacker.io.vn/SF-Pro-Rounded-Bold.otf") format("opentype");
    font-weight: 700; font-display: swap;
}
@font-face {
    font-family: "SF Pro Rounded";
    src: url("https://font.duohacker.io.vn/SF-Pro-Rounded-Heavy.otf") format("opentype");
    font-weight: 800; font-display: swap;
}
@font-face {
    font-family: "SF Pro Rounded";
    src: url("https://font.duohacker.io.vn/SF-Pro-Rounded-Black.otf") format("opentype");
    font-weight: 900; font-display: swap;
}
 
#dc-panel,#dc-panel*{box-sizing:border-box;margin:0;padding:0;}
 
/* ── DESIGN TOKENS (DuoRain-style CSS vars) ── */
#dc-panel{
    --glass: blur(26px) saturate(140%);
    --shadow: 0 24px 64px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.03), inset 0 1px 0 rgba(255,255,255,0.06);
    --green: 88,204,2;
    --green-hex: #58cc02;
    --green-light: #78e000;
    /* dark defaults */
    --bg:       rgba(18,20,28,0.88);
    --sidebar:  rgba(12,14,20,0.82);
    --surface:  rgba(255,255,255,0.035);
    --hover:    rgba(255,255,255,0.07);
    --input-bg: rgba(255,255,255,0.055);
    --swan:     rgba(255,255,255,0.08);
    --swan2:    rgba(255,255,255,0.05);
    --eel:      #e2e4f0;
    --wolf:     rgba(255,255,255,0.35);
    --muted:    rgba(255,255,255,0.18);
    --dropdown: rgba(15,17,24,0.97);
}
#dc-panel.dc-light{
    --bg:       rgba(230,234,248,0.82);
    --sidebar:  rgba(210,216,240,0.88);
    --surface:  rgba(0,0,0,0.04);
    --hover:    rgba(0,0,0,0.06);
    --input-bg: rgba(0,0,0,0.05);
    --swan:     rgba(0,0,0,0.09);
    --swan2:    rgba(0,0,0,0.05);
    --eel:      #1a1c28;
    --wolf:     rgba(0,0,0,0.45);
    --muted:    rgba(0,0,0,0.22);
    --dropdown: rgba(230,234,248,0.98);
}
 
/* ── PANEL ── */
#dc-panel{
    position:fixed;bottom:24px;right:24px;
    width:500px;
    max-width:calc(100vw - 48px);
    max-height:calc(100vh - 48px);
    display:flex;flex-direction:column;
    border-radius:20px;
    background:var(--bg);
    backdrop-filter:var(--glass);
    -webkit-backdrop-filter:var(--glass);
    border:1px solid var(--swan);
    box-shadow:var(--shadow);
    font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;
    font-size:13px;color:var(--eel);
    user-select:none;z-index:2147483647;
    overflow:hidden;
    transition:opacity .28s cubic-bezier(.2,0,.2,1), transform .28s cubic-bezier(.2,0,.2,1), filter .28s;
}
#dc-panel * { font-family: 'SF Pro Rounded','Nunito', system-ui, sans-serif; }
#dc-panel.dc-hidden{opacity:0;pointer-events:none;transform:translateY(10px) scale(0.97);filter:blur(3px);}
 
 
 
/* ── TITLE BAR ── */
#dc-bar{
    display:flex;align-items:center;padding:0 14px;
    height:48px;flex-shrink:0;
    border-bottom:1px solid rgba(255,255,255,0.06);
    cursor:grab;gap:0;
}
#dc-bar:active{cursor:grabbing;}
#dc-wordmark{
    flex:1;display:flex;align-items:center;gap:9px;
    font-size:13px;font-weight:900;letter-spacing:0.04em;
    color:#e2e4f0;
}
#dc-wordmark .dc-avatar{
    width:26px;height:26px;border-radius:8px;
    border:1.5px solid rgba(88,204,2,0.4);
    object-fit:cover;flex-shrink:0;
}
#dc-wordmark .dc-title-text{
    background:linear-gradient(90deg,#78e000 0%,#b8ff40 60%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
    background-clip:text;letter-spacing:0.06em;
}
#dc-wordmark .dc-ver-badge{
    font-size:9px;font-weight:800;letter-spacing:0.1em;
    color:rgba(120,224,0,0.6);background:rgba(88,204,2,0.08);
    border:1px solid rgba(88,204,2,0.18);
    padding:2px 6px;border-radius:20px;
    -webkit-text-fill-color:initial;
}
.dc-winbtn{
    width:26px;height:26px;border-radius:7px;
    border:1px solid rgba(255,255,255,0.07);
    background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.3);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:all .12s;margin-left:5px;
}
.dc-winbtn:hover{background:rgba(255,255,255,0.1);color:#fff;border-color:rgba(255,255,255,0.18);}
.dc-winbtn:active{transform:scale(0.88);}
 
/* ── TAB BAR ── */
#dc-tabs{
    display:flex;flex-shrink:0;
    border-bottom:1px solid rgba(255,255,255,0.05);
    background:rgba(0,0,0,0.12);
    padding:6px 10px 0;gap:2px;
}
.dc-tab{
    display:flex;align-items:center;gap:5px;
    padding:0 10px;height:34px;
    border:none;background:transparent;
    color:rgba(255,255,255,0.3);font-family:'SF Pro Rounded','Nunito',sans-serif;
    font-size:11.5px;font-weight:800;
    cursor:pointer;letter-spacing:0.01em;
    border-radius:9px 9px 0 0;
    border-bottom:2px solid transparent;margin-bottom:-1px;
    transition:color .14s,background .14s,border-color .14s;
    white-space:nowrap;
}
.dc-tab svg{flex-shrink:0;}
.dc-tab:hover{color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.04);}
.dc-tab.on{color:#78e000;border-bottom-color:#78e000;background:rgba(88,204,2,0.05);}
 
/* ── PANE ── */
#dc-pane{
    overflow-y:auto;overflow-x:hidden;
    padding:12px;display:flex;flex-direction:column;gap:8px;
    flex:1 1 auto;min-height:120px;max-height:320px;
}
#dc-pane::-webkit-scrollbar{width:4px;}
#dc-pane::-webkit-scrollbar-track{background:rgba(255,255,255,0.03);border-radius:4px;margin:6px 0;}
#dc-pane::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(88,204,2,0.5) 0%,rgba(88,204,2,0.18) 100%);border-radius:4px;}
#dc-pane::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,rgba(120,224,0,0.8) 0%,rgba(88,204,2,0.45) 100%);}
#dc-pane::-webkit-scrollbar-thumb:active{background:rgba(120,224,0,0.9);}
#dc-pane{scrollbar-width:thin;scrollbar-color:rgba(88,204,2,0.35) rgba(255,255,255,0.03);}
 
.dc-section-label{
    font-size:10px;font-weight:800;letter-spacing:0.12em;
    text-transform:uppercase;color:rgba(255,255,255,0.2);padding:0 2px;
}
 
/* ── CARD ── */
.dc-card{
    background:rgba(255,255,255,0.035);
    border:1px solid rgba(255,255,255,0.07);
    border-radius:14px;
}
/* Children that need clipped corners (grids, progress, lists) get their own clip */
.dc-card>.dc-kv-grid,.dc-card>.dc-prog-wrap,.dc-card>.dc-ch-list{overflow:hidden;border-radius:13px;}
.dc-card>.dc-kv-grid{border-radius:13px;}
.dc-card>.dc-ch-list .dc-ch-item:first-child{border-radius:13px 13px 0 0;}
.dc-card>.dc-ch-list .dc-ch-item:last-child{border-radius:0 0 13px 13px;}
 
/* ── BUTTONS ── */
.dc-btn-row{display:flex;gap:7px;padding:10px;flex-wrap:wrap;}
.btn{
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    padding:0 14px;height:38px;border-radius:11px;border:1.5px solid;
    font-family:'SF Pro Rounded','Nunito',sans-serif;font-size:13px;font-weight:800;cursor:pointer;
    letter-spacing:0.01em;white-space:nowrap;flex-shrink:0;
    transition:all .15s cubic-bezier(.34,1.56,.64,1);
}
.btn:active{transform:scale(0.94)!important;}
#dc-panel .btn.primary{
    background:#58cc02 !important;
    border-color:#58cc02 !important;color:#fff !important;
    box-shadow:0 2px 8px rgba(88,204,2,0.25) !important;
}
#dc-panel .btn.primary:hover{background:#63db02 !important;transform:translateY(-1px);box-shadow:0 4px 14px rgba(88,204,2,0.35) !important;}
#dc-panel .btn.green{background:rgba(88,204,2,0.09) !important;border-color:rgba(88,204,2,0.28) !important;color:#78e000 !important;}
#dc-panel .btn.green:hover{background:rgba(88,204,2,0.16) !important;border-color:rgba(88,204,2,0.45) !important;transform:translateY(-1px);}
#dc-panel .btn.ghost{background:rgba(255,255,255,0.04) !important;border-color:rgba(255,255,255,0.09) !important;color:rgba(255,255,255,0.4) !important;}
#dc-panel .btn.ghost:hover{background:rgba(255,255,255,0.09) !important;border-color:rgba(255,255,255,0.18) !important;color:#e2e4f0 !important;}
#dc-panel .btn.ghost.on{border-color:rgba(120,224,0,0.35) !important;color:#78e000 !important;background:rgba(88,204,2,0.07) !important;}
#dc-panel .btn.fill{flex:1;}
 
/* ── STATUS BAR ── */
.dc-status-bar{
    display:flex;align-items:center;gap:8px;
    padding:7px 14px;border-top:1px solid rgba(255,255,255,0.05);
    background:rgba(0,0,0,0.15);
    font-size:11px;
    border-radius:0 0 20px 20px;
}
.dc-status-dot{
    width:6px;height:6px;border-radius:50%;flex-shrink:0;transition:background .3s;
}
.dc-status-dot.idle    {background:rgba(255,255,255,0.12);}
.dc-status-dot.our_turn{background:#ffd900;animation:dc-pulse 1s infinite;box-shadow:0 0 6px #ffd900;}
.dc-status-dot.thinking{background:#a855f7;animation:dc-pulse .7s infinite;box-shadow:0 0 6px #a855f7;}
.dc-status-dot.playing {background:#78e000;box-shadow:0 0 6px #78e000;}
.dc-status-dot.waiting {background:rgba(255,255,255,0.12);}
@keyframes dc-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
.dc-status-txt{flex:1;font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;font-size:10px;color:rgba(255,255,255,0.25);}
.dc-status-move{font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;font-weight:600;color:#78e000;font-size:11px;}
 
/* ── KV GRID ── */
.dc-kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,0.05);}
.dc-kv-cell{background:rgba(22,23,30,0.95);padding:10px 12px;display:flex;flex-direction:column;gap:3px;}
.dc-kv-label{font-size:9px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.22);}
.dc-kv-value{font-size:13px;font-weight:700;color:#d8dae8;font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;}
.dc-kv-value.accent{color:#78e000;}
.dc-kv-value.yellow{color:#ffd900;}
.dc-kv-value.dim   {color:rgba(255,255,255,0.18);}
 
/* ── FEN ── */
.dc-fen{
    font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;font-size:9px;
    color:rgba(255,255,255,0.15);word-break:break-all;line-height:1.8;
    padding:8px 12px;background:rgba(0,0,0,0.12);border-top:1px solid rgba(255,255,255,0.05);
}
 
/* ── CHALLENGES ── */
.dc-ch-list{display:flex;flex-direction:column;}
.dc-ch-item{
    display:flex;align-items:flex-start;gap:9px;
    padding:9px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
}
.dc-ch-item:last-child{border-bottom:none;}
.dc-ch-item.current{background:rgba(88,204,2,0.04);}
.dc-ch-item.done{opacity:.3;}
.dc-ch-num{
    width:24px;height:24px;border-radius:7px;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;
    font-size:10px;font-weight:800;font-family:'SF Pro Rounded','Nunito',sans-serif;margin-top:1px;
}
.dc-ch-num.current{background:rgba(88,204,2,0.14);color:#78e000;}
.dc-ch-num.done   {background:rgba(88,204,2,0.05);color:rgba(88,204,2,0.35);}
.dc-ch-num.pending{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.18);}
.dc-ch-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.dc-ch-src{
    font-size:9px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;
    padding:2px 5px;border-radius:5px;display:inline-block;
}
.dc-ch-moves{font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;font-size:10px;color:rgba(255,255,255,0.25);line-height:1.6;}
.dc-ch-moves .mv-player{color:#78e000;}
.dc-ch-moves .mv-enemy {color:#ff6060;}
 
/* ── SETTINGS ── */
.dc-setting-row{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:10px 13px;border-bottom:1px solid rgba(255,255,255,0.04);
}
.dc-setting-row:last-child{border-bottom:none;}
.dc-setting-label{font-size:12px;color:rgba(255,255,255,0.65);font-weight:700;}
.dc-setting-desc{font-size:10px;color:rgba(255,255,255,0.18);margin-top:1px;}
 
/* ── TOGGLE SWITCH ── */
.dc-sw{position:relative;width:38px;height:22px;cursor:pointer;flex-shrink:0;}
.dc-sw input{opacity:0;width:0;height:0;position:absolute;}
.dc-sw-t{position:absolute;inset:0;border-radius:11px;background:rgba(255,255,255,0.08);border:1.5px solid rgba(255,255,255,0.1);transition:all .16s;}
.dc-sw input:checked~.dc-sw-t{background:#58cc02;border-color:#78e000;box-shadow:0 0 8px rgba(88,204,2,0.35);}
.dc-sw-k{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,0.45);transition:transform .16s cubic-bezier(.34,1.56,.64,1),background .16s;box-shadow:0 1px 3px rgba(0,0,0,0.3);}
.dc-sw input:checked~.dc-sw-t~.dc-sw-k{transform:translateX(16px);background:#fff;}
 
/* ── STEPPER ── */
.dc-stepper{display:flex;align-items:center;gap:5px;}
.dc-stepper button{
    width:30px;height:30px;border-radius:9px;
    border:1.5px solid rgba(255,255,255,0.09);
    background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.45);font-size:15px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:all .12s;font-weight:300;line-height:1;
}
.dc-stepper button:hover{background:rgba(255,255,255,0.11);color:#fff;border-color:rgba(255,255,255,0.22);}
.dc-stepper button:active{transform:scale(0.9);}
.dc-stepper-val{min-width:34px;text-align:center;font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;font-size:13px;font-weight:600;color:#d8dae8;}
 
/* ── ENGINE SELECTOR ── */
.dc-eng-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:10px;}
.dc-eng-btn{
    display:flex;align-items:center;gap:10px;
    padding:10px 12px;border-radius:11px;
    border:1.5px solid rgba(255,255,255,0.07);
    background:rgba(255,255,255,0.03);
    cursor:pointer;text-align:left;
    transition:all .14s cubic-bezier(.34,1.56,.64,1);
}
.dc-eng-btn>*{pointer-events:none;}
.dc-eng-btn:hover{border-color:rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);transform:translateY(-1px);}
.dc-eng-btn.on{border-color:rgba(88,204,2,0.45);background:rgba(88,204,2,0.08);box-shadow:0 0 12px rgba(88,204,2,0.1);}
.dc-eng-icon{width:32px;height:32px;border-radius:8px;object-fit:contain;flex-shrink:0;background:rgba(0,0,0,0.2);}
.dc-eng-info{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dc-eng-name{font-size:11px;font-weight:800;font-family:'SF Pro Rounded','Nunito',sans-serif;color:rgba(255,255,255,0.4);letter-spacing:0.03em;white-space:nowrap;}
.dc-eng-btn.on .dc-eng-name{color:#78e000;}
.dc-eng-sub{font-size:9.5px;color:rgba(255,255,255,0.2);font-weight:600;font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;white-space:nowrap;}
.dc-eng-btn.on .dc-eng-sub{color:rgba(120,224,0,0.65);}
.dc-eng-badge{
    margin-left:auto;flex-shrink:0;
    width:7px;height:7px;border-radius:50%;
    background:rgba(255,255,255,0.1);
}
.dc-eng-badge.ready{background:#78e000;box-shadow:0 0 5px rgba(120,224,0,0.5);}
 
/* ── LOG ── */
.dc-log-entry{
    display:flex;gap:8px;align-items:baseline;
    padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03);
    font-size:11px;font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;
}
.dc-log-entry:last-child{border-bottom:none;}
.dc-log-time{color:rgba(255,255,255,0.12);flex-shrink:0;font-size:9.5px;}
.dc-log-src{flex-shrink:0;width:44px;font-weight:600;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;}
.dc-log-src.sys   {color:rgba(255,255,255,0.22);}
.dc-log-src.bot   {color:#78e000;}
.dc-log-src.solver{color:#a855f7;}
.dc-log-msg{color:rgba(255,255,255,0.3);flex:1;word-break:break-all;}
 
/* ── EMPTY ── */
.dc-empty{
    text-align:center;color:rgba(255,255,255,0.16);font-size:12px;
    padding:28px 16px;line-height:2;font-family:'SF Pro Rounded','Nunito',sans-serif;font-weight:700;
}
 
/* ── PROGRESS ── */
.dc-prog-wrap{height:3px;background:rgba(255,255,255,0.05);}
.dc-prog-bar{height:3px;background:linear-gradient(90deg,#58cc02,#78e000);transition:width .4s cubic-bezier(.4,0,.2,1);}
 
/* ── HUB HEADER ── */
.dc-hub-hd{
    padding:14px 14px 10px;
    border-bottom:1px solid rgba(255,255,255,0.05);
}
.dc-hub-label{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.2);}
.dc-hub-title{font-size:20px;font-weight:900;color:#e2e4f0;margin-top:2px;font-family:'SF Pro Rounded','Nunito',sans-serif;letter-spacing:-.02em;}
.dc-hub-title span{color:#78e000;}
 
/* ── DIV ── */
.dc-divider{height:1px;background:rgba(255,255,255,0.05);margin:0 12px;}
 
@media(max-width:520px){
    #dc-panel{left:8px;right:8px;bottom:8px;width:auto;border-radius:18px;}
}
`;
 
    // ══════════════════════════════════════════════════════════════════════════════
    //  PANEL BUILD
    // ══════════════════════════════════════════════════════════════════════════════
 
    let _panel = null,
        _toggle = null,
        _activeTab = "hub";
 
    const TABS = [{
            id: "hub",
            icon: ICONS.chess,
            label: "Hub"
        },
        {
            id: "bot",
            icon: ICONS.cpu,
            label: "Bot"
        },
        {
            id: "solver",
            icon: ICONS.bolt,
            label: "Solver"
        },
        {
            id: "log",
            icon: ICONS.log,
            label: "Log"
        },
        {
            id: "cfg",
            icon: ICONS.settings,
            label: "Settings"
        },
    ];
 
    const SRC_CLR = {
        correctMoves: {
            bg: "#0b1e0f",
            fg: "#4caf6e"
        },
        highlight: {
            bg: "#1e1808",
            fg: "#e8a020"
        },
        validPaths: {
            bg: "#0b0f1e",
            fg: "#5a6aff"
        },
        evalFallback: {
            bg: "#180b1e",
            fg: "#a855f7"
        },
        none: {
            bg: "#1e0b0b",
            fg: "#c44444"
        },
    };
 
    // Engine metadata
    const ENGINE_META = {
        stockfish: {
            name: "Stockfish",
            sub: "stockfish.online",
            iconUrl: "https://stockfishchess.org/images/logo/icon_512x512@2x.webp",
        },
        jce: {
            name: "js-chess-engine",
            sub: "esm.sh/js-chess-engine",
            iconUrl: null,
            iconSVG: `
    <svg width="22" height="22" viewBox="0 0 50.8 50.8"
         xmlns="http://www.w3.org/2000/svg" xml:space="preserve">
        <g style="stroke-width:1.00012;stroke-dasharray:none">
            <path d="m29.084 17.202 4.752 3.087c.037 1.357-.699 2.623-.699 2.623H29.09c-.883 6.963 6.255 11.358 6.255 11.358 3.9 3.11 3.385 8.283 3.385 8.283s-.055.867-3.476 1.66c0 0-2.98.96-12.944.69"
                  style="fill:none;stroke:#FFFFFF;stroke-width:3.175;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:none"/>
            <path d="m21.82 17.256-4.72 3.033c-.036 1.357.7 2.623.7 2.623h4.047c.883 6.963-6.255 11.358-6.255 11.358-3.9 3.11-3.385 8.283-3.385 8.283s.055.867 3.476 1.66c0 0 2.979.96 12.944.69"
                  style="fill:none;stroke:#FFFFFF;stroke-width:3.175;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:none"/>
            <path d="M11.13-25.59a6.26 6.352 0 0 1-6.122 4.238A6.26 6.352 0 0 1-.81-26.011a6.26 6.352 0 0 1 2.64-7.027 6.26 6.352 0 0 1 7.397.453"
                  style="fill:none;stroke:#FFFFFF;stroke-width:3.17506;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:none"
                  transform="matrix(-.26297 .9648 -.96701 -.25472 0 0)"/>
        </g>
    </svg>`,
        },
    };
 
    // ── TAB: HUB ──────────────────────────────────────────────────────────────────
    function tabHub() {
        const st = BOT_S.status;
        const done = Math.min(SOL_STATE.currentIdx, SOL_STATE.challenges.length);
        const total = SOL_STATE.challenges.length;
        const pct = total ? Math.round(done / total * 100) : 0;
        const eng = activeEngineName();
        const stColor = st === "playing" ? "#78e000" : st === "thinking" ? "#a855f7" : st === "our_turn" ? "#ffd900" : "rgba(255,255,255,0.25)";
        return `
    <div class="dc-card">
        <div class="dc-hub-hd">
            <div class="dc-hub-label">Active Engine</div>
            <div class="dc-hub-title">${esc(eng==="none"?"No engine":eng)} <span>↗</span></div>
        </div>
        <div class="dc-prog-wrap"><div class="dc-prog-bar" style="width:${pct}%"></div></div>
        <div class="dc-btn-row">
            <button class="btn primary fill" id="dc-h-play">${ICONS.play} Play Best Move</button>
            <button class="btn ghost ${BOT_CFG.autoPlay?"on":""}" id="dc-h-auto">${BOT_CFG.autoPlay?ICONS.pause:ICONS.play} Auto</button>
        </div>
    </div>
    <div class="dc-card">
        <div class="dc-btn-row">
            <button class="btn green fill" id="dc-h-solve">${ICONS.bolt} Solve Next</button>
            <button class="btn ghost ${SOL_CFG.autoContinue?"on":""}" id="dc-h-cont">${ICONS.reload} Auto Continue</button>
        </div>
    </div>
    <div class="dc-card">
        <div class="dc-kv-grid">
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Engine</div>
                <div class="dc-kv-value accent">${esc(eng)}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Status</div>
                <div class="dc-kv-value" style="color:${stColor}">${esc(st.replace("_"," "))}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Playing As</div>
                <div class="dc-kv-value">${esc(BOT_S.playerColor??"—")}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Puzzles</div>
                <div class="dc-kv-value">${done} / ${total||"—"}</div>
            </div>
        </div>
    </div>`;
    }
 
    // ── TAB: BOT ─────────────────────────────────────────────────────────────────
    function tabBot() {
        const st = BOT_S.status;
        const side = fenSide(BOT_S.currentFen) === "w" ? "White" : "Black";
        const stColor = st === "playing" ? "#78e000" : st === "thinking" ? "#a855f7" : st === "our_turn" ? "#ffd900" : "rgba(255,255,255,0.25)";
        return `
    <div class="dc-card">
        <div class="dc-kv-grid">
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Active Engine</div>
                <div class="dc-kv-value accent">${esc(activeEngineName())}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Status</div>
                <div class="dc-kv-value" style="color:${stColor}">${esc(st.replace("_"," "))}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Playing As</div>
                <div class="dc-kv-value">${esc(BOT_S.playerColor??"—")}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">To Move</div>
                <div class="dc-kv-value">${side}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Moves Made</div>
                <div class="dc-kv-value">${BOT_S.moveHistory.length}</div>
            </div>
            <div class="dc-kv-cell">
                <div class="dc-kv-label">Last Move</div>
                <div class="dc-kv-value">${esc(BOT_S.lastMove??"—")}</div>
            </div>
        </div>
    </div>
    <div class="dc-card">
        <div class="dc-btn-row">
            <button class="btn primary fill" id="dc-bot-play">${ICONS.play} Play Now</button>
            <button class="btn ghost ${BOT_CFG.autoPlay?"on":""}" id="dc-bot-auto">${BOT_CFG.autoPlay?"Auto ON":"Auto OFF"}</button>
            <button class="btn ghost ${BOT_CFG.flipped?"on":""}" id="dc-bot-flip">${ICONS.flip} Flip</button>
        </div>
    </div>
    <div class="dc-card">
        <div class="dc-fen">${esc(BOT_S.currentFen)}</div>
    </div>`;
    }
 
    // ── TAB: SOLVER ───────────────────────────────────────────────────────────────
    function tabSolver() {
        const ch = SOL_STATE.challenges;
        const done = SOL_STATE.currentIdx;
        const total = ch.length;
        const pct = total ? Math.round(done / total * 100) : 0;
        return `
    <div class="dc-card">
        <div class="dc-prog-wrap"><div class="dc-prog-bar" style="width:${pct}%"></div></div>
        <div class="dc-btn-row">
            <button class="btn primary fill" id="dc-sol-next" ${SOL_STATE.solving?"disabled":""}>${ICONS.next} Solve Next</button>
            <button class="btn green fill" id="dc-sol-all" ${SOL_STATE.solving?"disabled":""}>${ICONS.skipall} Solve All</button>
            <button class="btn ghost" id="dc-sol-reload" title="Re-fetch session from Duolingo">${ICONS.reload}</button>
        </div>
    </div>
    <div class="dc-card">
        <div class="dc-btn-row">
            <button class="btn ghost ${SOL_CFG.turbo?"on":""}" id="dc-sol-turbo" title="Skip verify-waits — fires moves at max speed since data is already known-correct">${ICONS.skipall} Turbo</button>
            <button class="btn ghost ${SOL_CFG.flipped?"on":""}" id="dc-sol-flip">${ICONS.flip} Flip Board</button>
            <button class="btn ghost ${SOL_CFG.autoContinue?"on":""}" id="dc-sol-cont">${ICONS.reload} Auto Continue</button>
            <span style="flex:1;display:flex;align-items:center;justify-content:flex-end;font-size:11px;color:rgba(255,255,255,0.2);font-family:'SF Pro Rounded','Nunito',system-ui,sans-serif;">${done} / ${total||0}</span>
        </div>
    </div>
    ${!ch.length
        ? `<div class="dc-card"><div class="dc-empty">No session loaded<br>Start a Duolingo chess lesson</div></div>`
        : `<div class="dc-card"><div class="dc-ch-list">${ch.map((c,i)=>{
            const isCur=i===done,isDn=i<done;
            const clr=SRC_CLR[c.source]??SRC_CLR.none;
            const numCls=isCur?"current":isDn?"done":"pending";
            const badge=isDn?ICONS.check:String(i+1);
            const moves=c.steps.map(s=>`<span class="${s.kind==="enemy"?"mv-enemy":"mv-player"}">${s.kind==="enemy"?"opp:":"our:"} ${esc(s.move)}</span>`).join("  ");
            return `<div class="dc-ch-item ${isCur?"current":""} ${isDn?"done":""}">
                <div class="dc-ch-num ${numCls}">${badge}</div>
                <div class="dc-ch-body">
                    <span class="dc-ch-src" style="color:${clr.fg};background:${clr.bg}">${esc(c.source)}</span>
                    <div class="dc-ch-moves">${moves||'<span class="mv-enemy">no moves</span>'}</div>
                </div>
            </div>`;
        }).join("")}</div></div>`
    }`;
    }
 
    // ── TAB: LOG ──────────────────────────────────────────────────────────────────
    function tabLog() {
        if (!SOL_STATE.log.length) return `<div class="dc-card"><div class="dc-empty">No activity yet</div></div>`;
        const rows = [...SOL_STATE.log].reverse().map(e => `
        <div class="dc-log-entry">
            <span class="dc-log-time">${e.time}</span>
            <span class="dc-log-src ${e.source}">${esc(e.source)}</span>
            <span class="dc-log-msg">${esc(e.msg)}</span>
        </div>`).join("");
        return `<div class="dc-card"><div style="padding:8px 10px;">${rows}</div></div>`;
    }
 
    // ── TAB: SETTINGS ────────────────────────────────────────────────────────────
    function tabCfg() {
        function sw(id, checked) {
            return `<label class="dc-sw"><input type="checkbox" id="${id}"${checked?" checked":""}><div class="dc-sw-t"></div><div class="dc-sw-k"></div></label>`;
        }
 
        function step(dn, up, val) {
            return `<div class="dc-stepper"><button id="${dn}">−</button><div class="dc-stepper-val" id="${val}">?</div><button id="${up}">+</button></div>`;
        }
 
        function engBtn(id, meta, isOn, isReady) {
            const icon = meta.iconUrl ?
                `<img class="dc-eng-icon" src="${meta.iconUrl}" alt="${meta.name}" style="background:rgba(0,0,0,0.3);padding:3px;">` :
                `<div class="dc-eng-icon" style="display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.06);">${meta.iconSVG}</div>`;
            return `<button class="dc-eng-btn${isOn?" on":""}" id="dc-eng-${id}">
            ${icon}
            <div class="dc-eng-info">
                <div class="dc-eng-name">${meta.name}</div>
                <div class="dc-eng-sub">${meta.sub}</div>
            </div>
            <div class="dc-eng-badge ${isReady?"ready":""}"></div>
        </button>`;
        }
 
        const sfReady = BOT_S.stockfishReady;
        const jceReady = BOT_S.jceReady;
 
        return `
    <div class="dc-section">
        <div class="dc-section-label">Engine</div>
        <div class="dc-card">
            <div class="dc-eng-grid" style="grid-template-columns:1fr 1fr;">
                ${engBtn("stockfish",ENGINE_META.stockfish, BOT_CFG.engine==="stockfish", sfReady)}
                ${engBtn("jce",      ENGINE_META.jce,       BOT_CFG.engine==="jce",       jceReady)}
            </div>
            <div style="display:flex;gap:7px;padding:0 10px 10px;">
                <button class="btn ghost fill" id="dc-load-sf">${ICONS.reload} Load Engine</button>
                <button class="btn ghost fill" id="dc-load-jce">${ICONS.reload} Load Engine</button>
            </div>
        </div>
    </div>
 
    <div class="dc-section">
        <div class="dc-section-label">Engine Config</div>
        <div class="dc-card">
            <div class="dc-setting-row">
                <div>
                    <div class="dc-setting-label">JCE Level</div>
                    <div class="dc-setting-desc">js-chess-engine strength (0 – 4)</div>
                </div>
                ${step("dc-jd","dc-ju","dc-jv")}
            </div>
            <div class="dc-setting-row">
                <div>
                    <div class="dc-setting-label">Stockfish Depth</div>
                    <div class="dc-setting-desc">stockfish.online depth (1 – 15)</div>
                </div>
                ${step("dc-sd","dc-su","dc-sv")}
            </div>
        </div>
    </div>
 
    <div class="dc-section">
        <div class="dc-section-label">Timing (ms)</div>
        <div class="dc-card">
            <div class="dc-setting-row">
                <div class="dc-setting-label">Bot click delay</div>
                ${step("dc-bcd","dc-bcu","dc-bcv")}
            </div>
            <div class="dc-setting-row">
                <div class="dc-setting-label">Bot move delay</div>
                ${step("dc-bmd","dc-bmu","dc-bmv")}
            </div>
            <div class="dc-setting-row">
                <div class="dc-setting-label">Solver enemy wait</div>
                ${step("dc-sed","dc-seu","dc-sev")}
            </div>
        </div>
    </div>
 
    <div class="dc-section">
        <div class="dc-section-label">Misc</div>
        <div class="dc-card">
            <div class="dc-setting-row">
                <div>
                    <div class="dc-setting-label">Post moves to API</div>
                    <div class="dc-setting-desc">Send move to Duolingo server</div>
                </div>
                ${sw("dc-pm",BOT_CFG.postMoves)}
            </div>
        </div>
    </div>`;
    }
 
    // ── RENDER ────────────────────────────────────────────────────────────────────
    function renderPanel() {
        if (!_panel) return;
        const pane = _panel.querySelector("#dc-pane");
        const tabsEl = _panel.querySelector("#dc-tabs");
        const statusEl = _panel.querySelector("#dc-statusbar");
        if (!pane) return;
 
 
        // Unlocked — show everything normally
        if (tabsEl) tabsEl.style.display = "";
        if (statusEl) statusEl.style.display = "";
        _panel.querySelectorAll(".dc-tab").forEach(t => t.classList.toggle("on", t.dataset.tab === _activeTab));
        if (_activeTab === "hub") pane.innerHTML = tabHub();
        else if (_activeTab === "bot") pane.innerHTML = tabBot();
        else if (_activeTab === "solver") {
            pane.innerHTML = tabSolver();
            // Auto-fetch if no session yet
            if (!SOL_STATE.challenges.length && !SOL_STATE._fetching) {
                SOL_STATE._fetching = true;
                _fetchSession().finally(() => { SOL_STATE._fetching = false; });
            }
        }
        else if (_activeTab === "log") pane.innerHTML = tabLog();
        else if (_activeTab === "cfg") pane.innerHTML = tabCfg();
        wirePanel();
        updateStatusBar();
    }
 
    function updateStatusBar() {
        const bar = _panel?.querySelector("#dc-statusbar");
        if (!bar) return;
        const st = BOT_S.status;
        bar.innerHTML = `<span class="dc-status-dot ${st}"></span><span class="dc-status-txt">${esc(st.replace("_"," "))}</span>${BOT_S.lastMove?`<span class="dc-status-move">${esc(BOT_S.lastMove)}</span>`:""}`;
    }
 
    function wirePanel() {
        const p = _panel;
        const $ = id => p.querySelector("#" + id);
        const on = (id, fn) => $(id)?.addEventListener("click", fn);
        const chk = (id, obj, key) => {
            const el = $(id);
            if (el) {
                el.addEventListener("change", e => {
                    obj[key] = e.target.checked;
                    saveSettings();
                });
            }
        };
 
        function step(dn, up, val, obj, key, inc, min, max) {
            const el = $(val);
            if (el) el.textContent = obj[key];
            on(dn, () => {
                obj[key] = Math.max(min, obj[key] - inc);
                saveSettings();
                const v = $(val);
                if (v) v.textContent = obj[key];
            });
            on(up, () => {
                obj[key] = Math.min(max, obj[key] + inc);
                saveSettings();
                const v = $(val);
                if (v) v.textContent = obj[key];
            });
        }
 
        // Hub
        on("dc-h-play", () => {
            BOT_CFG.autoPlay = true;
            saveSettings();
            takeTurn();
        });
        on("dc-h-solve", () => solveNext().catch(e => addLog("solver", "err: " + e.message)));
        on("dc-h-auto", () => {
            BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
            saveSettings();
            renderPanel();
        });
        on("dc-h-cont", () => {
            SOL_CFG.autoContinue = !SOL_CFG.autoContinue;
            saveSettings();
            renderPanel();
        });
 
        // Bot
        on("dc-bot-play", () => {
            BOT_CFG.autoPlay = true;
            saveSettings();
            takeTurn();
        });
        on("dc-bot-auto", () => {
            BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
            saveSettings();
            renderPanel();
        });
        on("dc-bot-flip", () => {
            BOT_CFG.flipped = !BOT_CFG.flipped;
            saveSettings();
            renderPanel();
        });
 
        // Solver
        on("dc-sol-next", () => {
            if (!SOL_STATE.solving) solveNext().catch(e => addLog("solver", "err: " + e.message));
        });
        on("dc-sol-all", () => {
            if (!SOL_STATE.solving) solveAll().catch(e => addLog("solver", "err: " + e.message));
        });
        on("dc-sol-reload", () => {
            addLog("solver", "Fetching session...");
            _fetchSession().then(ok => {
                if (!ok) addLog("solver", "Could not fetch session — try navigating to a chess lesson first");
            });
        });
        on("dc-sol-flip", () => {
            SOL_CFG.flipped = !SOL_CFG.flipped;
            saveSettings();
            renderPanel();
        });
        on("dc-sol-cont", () => {
            SOL_CFG.autoContinue = !SOL_CFG.autoContinue;
            saveSettings();
            renderPanel();
        });
 
        // Engine buttons
        p.querySelectorAll(".dc-eng-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const eng = btn.id.replace("dc-eng-", "");
                if (["jce", "stockfish"].includes(eng)) {
                    BOT_CFG.engine = eng;
                    saveSettings();
                    renderPanel();
                }
            });
        });
        on("dc-load-jce", () => {
            loadJCE().then(() => renderPanel());
        });
        on("dc-load-sf", () => {
            loadStockfish().then(() => renderPanel());
        });
 
        // Settings steppers
        step("dc-jd", "dc-ju", "dc-jv", BOT_CFG, "jceLevel", 1, 0, 4);
        step("dc-sd", "dc-su", "dc-sv", BOT_CFG, "stockfishDepth", 1, 1, 15);
        step("dc-bcd", "dc-bcu", "dc-bcv", BOT_CFG, "clickDelay", 50, 50, 2000);
        step("dc-bmd", "dc-bmu", "dc-bmv", BOT_CFG, "moveDelay", 100, 100, 5000);
        step("dc-sed", "dc-seu", "dc-sev", SOL_CFG, "enemyDelay", 100, 500, 8000);
        chk("dc-pm", BOT_CFG, "postMoves");
        on("dc-sol-turbo", () => {
            SOL_CFG.turbo = !SOL_CFG.turbo;
            saveSettings();
            addLog("solver", SOL_CFG.turbo ? "Turbo ON — known-correct moves fire at max speed" : "Turbo OFF — verify-wait mode");
            renderPanel();
        });
    }
 
    // ══════════════════════════════════════════════════════════════════════════════
    //  CREATE PANEL
    // ══════════════════════════════════════════════════════════════════════════════
 
    function injectCSS() {
        if (document.getElementById("dc-style")) return;
        const s = document.createElement("style");
        s.id = "dc-style";
        s.textContent = STYLE;
        document.head.appendChild(s);
    }
 
    function createPanel() {
        injectCSS();
 
        if (_panel) {
            _panel.remove();
            _panel = null;
        }
 
        _panel = document.createElement("div");
        _panel.id = "dc-panel";
 
        const tabsHTML = TABS.map(t => `<button class="dc-tab${t.id===_activeTab?" on":""}" data-tab="${t.id}">${t.icon} ${t.label}</button>`).join("");
 
        _panel.innerHTML = `
        <div id="dc-bar">
            <div id="dc-wordmark">
                <img class="dc-avatar" src="https://i.ibb.co/gZpNbsPP/cosmic.jpg" alt="">
                <span class="dc-title-text">DuoChess</span>
                <span class="dc-ver-badge">1.0.0</span>
            </div>
            <button class="dc-winbtn" id="dc-minimize" title="Minimize">${ICONS.minus}</button>
        </div>
        <div id="dc-tabs">${tabsHTML}</div>
        <div id="dc-pane"></div>
        <div id="dc-statusbar" class="dc-status-bar"></div>`;
 
        document.body.appendChild(_panel);
 
        $i("dc-minimize")?.addEventListener("click", () => {
            const pane = _panel.querySelector("#dc-pane");
            const tabs = _panel.querySelector("#dc-tabs");
            const bar = _panel.querySelector("#dc-statusbar");
            const hidden = pane.style.display === "none";
            pane.style.display = hidden ? "" : "none";
            if (tabs) tabs.style.display = hidden ? "" : "none";
            if (bar) bar.style.display = hidden ? "" : "none";
        });
 
        _panel.querySelectorAll(".dc-tab").forEach(t => t.addEventListener("click", () => {
            if (t.dataset.tab === _activeTab) return;
            const pane = _panel.querySelector("#dc-pane");
            // Phase 1: fade + shrink out
            pane.style.transition = "opacity .1s ease,transform .1s ease";
            pane.style.opacity = "0";
            pane.style.transform = "scale(0.97) translateY(5px)";
            setTimeout(() => {
                // Phase 2: swap content
                _activeTab = t.dataset.tab;
                renderPanel();
                // Phase 3: fade in (renderPanel replaces pane node's innerHTML but keeps the element)
                const p2 = _panel.querySelector("#dc-pane");
                p2.style.transition = "none";
                p2.style.opacity = "0";
                p2.style.transform = "scale(0.97) translateY(5px)";
                requestAnimationFrame(() => {
                    p2.style.transition = "opacity .15s ease,transform .15s ease";
                    p2.style.opacity = "1";
                    p2.style.transform = "scale(1) translateY(0)";
                });
            }, 100);
        }));
        makeDraggable(_panel, _panel.querySelector("#dc-bar"));
        renderPanel();
    }
 
    function $i(id) {
        return _panel?.querySelector("#" + id);
    }
 
    function makeDraggable(el, handle) {
        let sx = 0,
            sy = 0,
            drag = false;
        handle.addEventListener("pointerdown", e => {
            if (e.target.closest(".dc-winbtn") || e.target.closest(".dc-tab")) return;
            drag = true;
            const r = el.getBoundingClientRect();
            el.style.bottom = "auto";
            el.style.right = "auto";
            el.style.left = r.left + "px";
            el.style.top = r.top + "px";
            sx = e.clientX - r.left;
            sy = e.clientY - r.top;
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        handle.addEventListener("pointermove", e => {
            if (!drag) return;
            el.style.left = Math.max(0, Math.min(e.clientX - sx, window.innerWidth - el.offsetWidth)) + "px";
            el.style.top = Math.max(0, Math.min(e.clientY - sy, window.innerHeight - el.offsetHeight)) + "px";
        });
        handle.addEventListener("pointerup", () => {
            drag = false;
        });
    }
 
    // ── KEYBOARD ──────────────────────────────────────────────────────────────────
    // (Alt+C toggle removed)
 
    // ══════════════════════════════════════════════════════════════════════════════
    //  AUTO-PLAY POLLING LOOP
    //  Polls canvas every 600ms — triggers takeTurn when board changes & it's our turn.
    //  Covers WebSocket moves & any API response the fetch hook might miss.
    // ══════════════════════════════════════════════════════════════════════════════
 
    let _pollHash = null;
    let _pollRunning = false;
 
    async function _fetchMatchState() {
        if (!BOT_S.matchId) return;
        const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "0";
        const hdrs = {};
        if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
        try {
            const res = await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}`, {
                method: "GET",
                headers: hdrs
            });
            if (!res.ok) return;
            const data = await res.json();
            onMatchData(data);
        } catch (_) {}
    }
 
    async function _autoPollLoop() {
        if (_pollRunning) return;
        _pollRunning = true;
        addLog("sys", "Auto-poll loop started");
        while (true) {
            await sleep(600);
            if (!BOT_CFG.autoPlay || !BOT_S.matchId) {
                // still loop but skip action
                continue;
            }
            // detect board change via canvas hash
            const h = canvasHash();
            if (h !== null && h !== _pollHash) {
                _pollHash = h;
                // board changed — check if it's our turn now
                if (BOT_S.status === "waiting") {
                    await _fetchMatchState();
                }
            }
            // safety net: if it's our turn but bot isn't acting, kick it
            if (BOT_S.status === "our_turn" && BOT_CFG.autoPlay) {
                if (BOT_S.status !== "thinking" && BOT_S.status !== "playing") {
                    setTimeout(takeTurn, BOT_CFG.thinkDelay);
                }
            }
        }
    }
 
 
    // ══════════════════════════════════════════════════════════════════════════════
 
    // Manual session inject — call from console: DuoChess.injectSession(data)
    window._dcInjectSession = function(data) {
        processSession(data);
        addLog("solver", "[manual] injected session: " + (data?.challenges?.length ?? "?") + " challenges");
        renderPanel();
    };
 
    window.DuoChess = {
        solve,
        solveNext,
        solveAll,
        playNow: () => {
            BOT_CFG.autoPlay = true;
            takeTurn();
        },
        setLevel: l => {
            BOT_CFG.jceLevel = Number(l);
            saveSettings();
            renderPanel();
        },
        setStockfishDepth: d => {
            BOT_CFG.stockfishDepth = Number(d);
            saveSettings();
            renderPanel();
        },
        setEngine: e => {
            BOT_CFG.engine = e;
            saveSettings();
            renderPanel();
        },
        getBestMove,
        setFlipped: v => {
            SOL_CFG.flipped = Boolean(v);
            saveSettings();
            renderPanel();
        },
        setAutoContinue: v => {
            SOL_CFG.autoContinue = Boolean(v);
            saveSettings();
            renderPanel();
        },
        panel: () => {
            if (!_panel) createPanel();
            _panel.classList.remove("dc-hidden");
        },
        injectSession: window._dcInjectSession,
        fetchSession: _fetchSession,
        state: {
            bot: BOT_S,
            solver: SOL_STATE
        },
        config: {
            bot: BOT_CFG,
            solver: SOL_CFG
        },
    };
 
    // ══════════════════════════════════════════════════════════════════════════════
    //  BOOT
    // ══════════════════════════════════════════════════════════════════════════════
 
    function _boot() {
        loadChessJS();
        loadStockfish();
        loadJCE();
        _autoPollLoop();
        if (document.body) {
            createPanel();
            addLog("sys", "DuoChess V1 ready");
        } else {
            document.addEventListener("DOMContentLoaded", () => {
                createPanel();
                addLog("sys", "DuoChess V1 ready");
            });
        }
    }
 
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _boot);
    else _boot();
 
})();
