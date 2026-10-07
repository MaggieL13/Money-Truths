// Money Truths report stylesheet. Dark theme.

export const CSS = `
:root{
  --bg:#111014;--surface:#1a171e;--raised:#221d27;--border:#3a303e;--border-soft:#2c2531;
  --text:#f4edf5;--muted:#b7aeb9;--dim:#7d7381;
  --violet:#9a78d1;--violet-soft:#2a2233;--gold:#e0bd72;
  --good:#aee3bc;--good-bg:#21382a;--warn:#f3d796;--warn-bg:#3d341e;--bad:#ffb5bb;--bad-bg:#3b2327;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1100px;margin:auto;padding:28px 24px 48px}
h1{font-size:40px;line-height:1;margin:4px 0 8px;letter-spacing:-.02em}
h2{font-size:17px;margin:0 0 14px;font-weight:650}
p{margin:0}
.eyebrow{color:var(--gold);font-weight:750;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.muted{color:var(--muted)}.tiny{font-size:12px}
.gold{color:var(--gold)}.bad{color:var(--bad)}
.label{color:var(--muted);font-size:12px;letter-spacing:.02em}
b{font-weight:650}

.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:22px}
.mock{border:1px dashed var(--violet);color:var(--violet);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;white-space:nowrap}

.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:16px}
.hero{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
.hero .card{margin:0}
.side{display:grid;gap:16px;align-content:start}
.side .card{margin:0}
.huge{font-size:44px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin:6px 0 14px;font-variant-numeric:tabular-nums}
.big{font-size:26px;font-weight:750;margin:4px 0;font-variant-numeric:tabular-nums}
.stack{display:flex;height:12px;border-radius:999px;overflow:hidden;gap:2px;background:var(--raised)}
.stack span{min-width:4px}
.legend{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:0}
.legend b{color:var(--text);font-variant-numeric:tabular-nums}
.free{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid var(--border-soft);margin-top:14px;padding-top:12px}
.free b{font-size:20px;color:var(--good);font-variant-numeric:tabular-nums}
.earmark{font-size:12px;color:var(--muted);margin-top:4px}

.wall-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.wall-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
.wall-nums>div{background:var(--raised);border-radius:12px;padding:12px}
.wall-nums b{display:block;font-size:22px;font-variant-numeric:tabular-nums;margin-top:2px}
.meter{height:10px;background:var(--bad-bg);border-radius:999px;overflow:hidden;margin-bottom:8px}
.meter span{display:block;height:100%;background:var(--violet);border-radius:999px}

.rows{list-style:none;padding:0;margin:0}
.rows li{display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--border-soft)}
.rows li:has(.when){grid-template-columns:56px 1fr auto}
.right{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.rows li:last-child{border-bottom:0}
.rows li.dim{opacity:.5}
.grow{flex:1;min-width:0}
.when{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.when.guess{font-style:italic}
.amt{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;flex:none}
.pill.paid,.pill.ok{background:var(--good-bg);color:var(--good)}
.pill.upcoming,.pill.wait{background:var(--warn-bg);color:var(--warn)}
.pill.overdue,.pill.disputed,.pill.bad{background:var(--bad-bg);color:var(--bad)}
.pill.debt{background:var(--violet-soft);color:#cdb8f0}
.pill.arch{background:transparent;color:var(--dim);border:1px dashed var(--border)}
.pill.muted{background:var(--raised);color:var(--dim)}

.strip{display:grid;grid-template-columns:repeat(var(--days),minmax(0,1fr));gap:2px;height:120px}
.day{display:flex;flex-direction:column;align-items:center;gap:4px;border-radius:6px;cursor:default}
.day.today{background:var(--violet-soft);outline:1px solid var(--violet)}
.day.past .dnum{color:var(--dim)}
.bar-slot{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
.bar{width:70%;border-radius:4px 4px 2px 2px}
.bar.paid{background:var(--good);opacity:.55}
.bar.upcoming{background:var(--warn)}
.bar.overdue,.bar.disputed{background:var(--bad)}
.dnum{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:640px){.dnum.minor{visibility:hidden}}
.keys{display:flex;flex-wrap:wrap;gap:6px 16px;margin:12px 0 4px;color:var(--muted)}
.k{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.k.paid{background:var(--good);opacity:.55}.k.upcoming{background:var(--warn)}.k.overdue{background:var(--bad)}
details{margin-top:10px}
summary{cursor:pointer;color:var(--violet);font-weight:600;font-size:13px;padding:6px 0}

.count{display:inline-block;background:var(--raised);color:var(--muted);border-radius:999px;padding:0 8px;font-size:12px;margin-left:6px;vertical-align:2px}
.issues{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.issues li{display:flex;gap:12px;align-items:flex-start;background:var(--raised);border-radius:12px;padding:12px}
.sev{width:8px;height:8px;border-radius:50%;margin-top:7px;flex:none}
.issues .high .sev{background:var(--bad);box-shadow:0 0 0 4px var(--bad-bg)}
.issues .medium .sev{background:var(--warn)}
.issues .low .sev{background:var(--dim)}
.issues .high{border:1px solid #5a2f36}

.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.two .card{margin:0}
.debts{list-style:none;padding:0;margin:0;display:grid;gap:14px}
.debts li{padding-bottom:14px;border-bottom:1px solid var(--border-soft)}
.debts li:last-child{border-bottom:0;padding-bottom:0}
.debts li.priority{border:1px solid var(--gold);border-radius:12px;padding:12px;background:#1f1a14}
.debt-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.debt-meta{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-variant-numeric:tabular-nums;font-size:13px}
.bank{font-size:10px;font-weight:750;padding:2px 8px;border-radius:999px;white-space:nowrap}
.util,.prog{height:8px;background:var(--raised);border-radius:999px;overflow:hidden}
.util span{display:block;height:100%;background:var(--violet);border-radius:999px}
.util span.hot{background:var(--warn)}
.util span.maxed{background:var(--bad)}
.prog span{display:block;height:100%;background:var(--good);border-radius:999px}

.notes blockquote{display:flex;gap:12px;margin:0 0 12px;padding:12px 14px;background:var(--raised);border-left:3px solid var(--violet);border-radius:0 12px 12px 0}
.notes blockquote:last-child{margin-bottom:0}
.icon{font-size:18px;line-height:1.3}
.notes cite{display:block;font-style:normal;color:var(--muted);font-size:12px;margin-top:4px}

footer{text-align:center;margin-top:28px;display:grid;gap:8px}
.law{color:var(--gold);font-size:12px;letter-spacing:.02em}

.good{color:var(--good)}
a{color:inherit}
.periods{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--border-soft)}
.seg{display:flex;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:3px}
.seg a{text-decoration:none;padding:6px 12px;border-radius:999px;color:var(--muted);font-weight:600;font-size:13px;white-space:nowrap}
.seg a:hover{color:var(--text);background:var(--raised)}
.seg a.cur{color:var(--text);min-width:132px;text-align:center}
.seg a.on{background:var(--violet-soft);color:#e3d6fa}
.search{display:flex;flex:1;min-width:220px;gap:6px}
.search input{flex:1;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:999px;color:var(--text);padding:8px 14px;font:inherit}
.search input:focus{outline:2px solid var(--violet);outline-offset:1px;border-color:transparent}
.search button{background:var(--violet);color:#16121b;border:0;border-radius:999px;padding:8px 16px;font:inherit;font-weight:700;cursor:pointer}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.tiles>div{background:var(--raised);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:2px}
.tiles b{font-size:20px;font-variant-numeric:tabular-nums}
.hbars{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.hbars li{display:grid;grid-template-columns:150px 1fr auto;gap:12px;align-items:center}
.hl{font-size:13px}
.ht{height:10px;background:var(--raised);border-radius:999px;overflow:hidden}
.ht span{display:block;height:100%;background:var(--violet);border-radius:999px}
.hv{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.chips a{text-decoration:none;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--raised);color:var(--muted)}
.chips a.on{background:var(--violet-soft);color:#e3d6fa}
.pill.neutral{background:var(--raised);color:var(--text)}
.note-line{color:var(--dim);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
mark{background:#4a3a1c;color:var(--warn);border-radius:3px;padding:0 2px}
.empty p{margin-top:4px}
.k.in{background:#ad8838}.k.out{background:#9a78d1}
.ychart{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px;height:200px;margin:8px 0 10px}
.mg{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;border-radius:8px;padding-top:4px}
.mg:hover,.mg:focus-visible{background:var(--raised)}
.mg.now{outline:1px solid var(--violet)}
.bars{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px}
.b{width:34%;max-width:16px;border-radius:4px 4px 0 0;min-height:0}
.b.in{background:#ad8838}.b.out{background:#9a78d1}
.ml{font-size:11px;color:var(--muted)}
.mg.none .ml{color:var(--dim)}
.tip{display:none;position:absolute;bottom:calc(100% - 20px);left:50%;transform:translateX(-50%);background:#0b0a0d;border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:12px;white-space:nowrap;z-index:3;font-variant-numeric:tabular-nums;pointer-events:none}
.mg:hover .tip,.mg:focus-visible .tip{display:block}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 8px;border-bottom:1px solid var(--border-soft);text-align:left}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td a{color:#cdb8f0}
@media (max-width:760px){
  .tiles{grid-template-columns:1fr 1fr}
  .hbars li{grid-template-columns:96px 1fr auto;gap:8px}
  .seg a.cur{min-width:0}
  .search{flex-basis:100%}
  .periods{position:static;border-bottom:0;padding:0}
  main{padding:18px 16px 40px}
  h1{font-size:32px}
  .huge{font-size:36px}
  .hero,.two{grid-template-columns:1fr}
  .wall-nums{grid-template-columns:1fr}
  .top{flex-direction:column}
}
.gen{color:var(--dim);font-size:12px;margin-top:4px}
.recon{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.recon li{display:grid;grid-template-columns:1fr auto;gap:4px 12px;background:var(--raised);border-radius:12px;padding:12px;border-left:3px solid var(--bad)}
.recon .amt{font-size:16px}
.splits{margin:6px 0 0;padding:0;list-style:none;font-size:12px;color:var(--muted)}
.splits li{display:flex;justify-content:space-between;gap:8px;border:0;padding:2px 0}
.subhead{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 4px}
.subhead:first-of-type{margin-top:0}
`;
