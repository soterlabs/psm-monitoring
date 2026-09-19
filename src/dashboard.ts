export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sky LitePSM Monitor</title>
  <style>
    :root { color-scheme: dark; --bg:#0a0f14; --panel:#111a22; --muted:#8ba0b2; --text:#eef5f7; --line:#243441; --ok:#42d392; --warning:#f4c152; --critical:#ff8a4c; --exceeded:#ff5263; }
    * { box-sizing:border-box } body { margin:0; background:radial-gradient(circle at 20% 0,#142535 0,transparent 38%),var(--bg); color:var(--text); font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; min-height:100vh }
    main { width:min(900px,calc(100% - 32px)); margin:0 auto; padding:64px 0 }
    header { display:flex; align-items:start; justify-content:space-between; gap:24px; margin-bottom:36px }
    h1 { margin:0 0 6px; font:700 clamp(25px,5vw,42px)/1.1 system-ui,sans-serif; letter-spacing:-.03em } p { margin:0; color:var(--muted) }
    .badge { padding:8px 12px; border:1px solid currentColor; border-radius:999px; font-weight:700; text-transform:uppercase; letter-spacing:.08em }
    .ok { color:var(--ok) }.warning { color:var(--warning) }.critical { color:var(--critical) }.exceeded { color:var(--exceeded) }.unknown { color:var(--muted) }
    .panel { background:color-mix(in srgb,var(--panel) 94%,transparent); border:1px solid var(--line); border-radius:16px; padding:clamp(20px,4vw,34px); box-shadow:0 24px 80px #0006 }
    .label { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.1em }
    .balance { margin:8px 0 24px; font:700 clamp(28px,7vw,60px)/1 system-ui,sans-serif; letter-spacing:-.04em }
    .balance small { color:var(--muted); font-size:.35em; letter-spacing:0 }
    .track { position:relative; height:18px; background:#26323c; border-radius:999px; overflow:hidden; margin-bottom:10px }
    .fill { height:100%; min-width:2px; width:0; background:currentColor; border-radius:inherit; transition:width .5s ease }
    .markers { display:flex; justify-content:space-between; color:var(--muted); font-size:12px }
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:12px; overflow:hidden; margin-top:28px }
    .cell { background:var(--panel); padding:18px }.value { display:block; margin-top:5px; font-size:17px; overflow-wrap:anywhere }
    footer { margin-top:20px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; color:var(--muted); font-size:12px } a { color:inherit }
    #error { margin-top:18px; padding:12px; border:1px solid var(--critical); color:var(--critical); border-radius:8px; display:none }
    @media(max-width:650px){ main{padding:36px 0}.grid{grid-template-columns:1fr}header{display:block}.badge{display:inline-block;margin-top:18px} }
  </style>
</head>
<body><main>
  <header><div><h1>Sky LitePSM · USDC</h1><p>Ethereum mainnet balance against the 4B operational limit</p></div><div id="badge" class="badge unknown">loading</div></header>
  <section class="panel">
    <div class="label">PSM + pocket balance</div><div class="balance"><span id="balance">—</span> <small>USDC</small></div>
    <div id="track" class="track unknown"><div id="fill" class="fill"></div></div>
    <div class="markers"><span>0</span><span id="util">—</span><span id="limit">4B limit</span></div>
    <div class="grid">
      <div class="cell"><span class="label">Remaining</span><span id="remaining" class="value">—</span></div>
      <div class="cell"><span class="label">Latest block</span><span id="block" class="value">—</span></div>
      <div class="cell"><span class="label">Last checked</span><span id="checked" class="value">—</span></div>
    </div>
    <div id="error"></div>
  </section>
  <footer><span id="pocket">Pocket —</span><span><a href="/api/status">JSON</a> · <a href="/metrics">Prometheus</a></span></footer>
</main><script>
const money = n => new Intl.NumberFormat('en-US',{maximumFractionDigits:2,notation:'compact'}).format(Number(n));
const full = n => new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(Number(n));
async function update(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();if(!d.snapshot)throw new Error(d.error?.message||'No reading yet');const s=d.snapshot, level=d.fresh?s.status:'unknown';
  badge.textContent=d.fresh?s.status:'stale';badge.className='badge '+level;track.className='track '+level;fill.style.width=Math.min(s.utilizationPercent,100)+'%';
  balance.textContent=full(s.totalBalanceUsdc);util.textContent=s.utilizationPercent.toFixed(2)+'% used';limit.textContent=money(s.limitUsdc)+' limit';
  remaining.textContent=(Number(s.remainingUsdc)<0?'Exceeded by ':'')+money(Math.abs(Number(s.remainingUsdc)))+' USDC';block.textContent='#'+Number(s.blockNumber).toLocaleString('en-US');
  checked.textContent=new Date(s.checkedAt).toLocaleString();pocket.textContent='Pocket '+s.pocketAddress.slice(0,8)+'…'+s.pocketAddress.slice(-6);
  error.style.display=d.error?'block':'none';error.textContent=d.error?'Last RPC error: '+d.error.message:'';
}catch(e){badge.textContent='unavailable';badge.className='badge unknown';error.style.display='block';error.textContent=e.message}}update();setInterval(update,30000);
</script></body></html>`;
