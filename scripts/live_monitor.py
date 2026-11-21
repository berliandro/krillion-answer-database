#!/usr/bin/env python3
"""Live harvester heartbeat. Samples answer files every second and shows
real-time lines/second — not cumulative totals.

Run:  python scripts/live_monitor.py
Open: http://127.0.0.1:8767
"""
import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HISTORY = deque(maxlen=120)  # 2 minutes of 1-second samples
lock = threading.Lock()


def sample():
    files = sorted(DATA.glob("answers*.jsonl"))
    per_file = {}
    total = 0
    newest = 0.0
    for p in files:
        n = 0
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
            n = sum(1 for ln in text.splitlines() if ln.strip())
        except OSError:
            pass
        per_file[p.name] = n
        total += n
        try:
            newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    with lock:
        HISTORY.append((time.time(), total))
        hist = list(HISTORY)
    return {"total": total, "per_file": per_file, "newest_mtime": newest, "hist": hist}


def rates(hist):
    """Return lines/sec over the last 1s, 10s, 60s from real samples."""
    now = time.time()
    out = {}
    for window in (1, 5, 10, 60):
        baseline = None
        for ts, n in reversed(hist):
            if ts <= now - window:
                baseline = (ts, n)
                break
        if baseline is None:
            baseline = hist[0] if hist else (now, 0)
        dt = max(0.001, now - baseline[0])
        out[f"r{window}"] = round(max(0, hist[-1][1] - baseline[1]) / dt, 2) if hist else 0
    return out


def snapshot():
    s = sample()
    r = rates(s["hist"])
    age = time.time() - s["newest_mtime"] if s["newest_mtime"] else None
    status = "NO DATA"
    if age is not None:
        if age < 20 and r["r10"] > 0:
            status = "LIVE"
        elif age < 120:
            status = "IDLE"
        else:
            status = "STALLED"
    return {
        "time": time.strftime("%H:%M:%S"),
        "total": s["total"],
        "per_file": s["per_file"],
        "rates": r,
        "seconds_since_write": round(age, 1) if age is not None else None,
        "status": status,
        "history": [{"t": round(ts, 1), "n": n} for ts, n in s["hist"]],
    }


def sampler():
    while True:
        sample()
        time.sleep(1)


HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harvester Live Monitor</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#0b0f1a;color:#e8ecf5;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:6vh 20px 60px}
h1{font-size:1.4rem;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:#8b95ab;font-size:.88rem;margin:0 0 24px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:99px;font-size:.78rem;font-weight:700;border:1px solid #2a3350;background:#151b2b}
.dot{width:8px;height:8px;border-radius:50%;background:#8b95ab}
.LIVE .dot{background:#3ddc84;box-shadow:0 0 0 4px #3ddc8422;animation:pulse 1s ease-in-out infinite}
.STALLED .dot{background:#ff6b6b}
.IDLE .dot{background:#ffc857}
@keyframes pulse{50%{box-shadow:0 0 0 8px #3ddc8400}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.metric{background:#151b2b;border:1px solid #2a3350;border-radius:12px;padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.22)}
.metric .k{color:#8b95ab;font-size:.74rem;text-transform:uppercase;letter-spacing:.06em}
.metric .v{font-size:1.7rem;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.metric .u{font-size:.8rem;color:#8b95ab;font-weight:400}
.chart{height:150px;background:#151b2b;border:1px solid #2a3350;border-radius:12px;padding:10px;display:flex;align-items:flex-end;gap:2px;overflow:hidden}
.bar{flex:1;background:linear-gradient(180deg,#5b7cfa,#5b7cfa44);border-radius:2px 2px 0 0;min-height:1px;transition:height .25s ease}
.bar.zero{background:#2a3350}
.files{margin-top:18px;color:#9fb0d8;font-size:.85rem;font-variant-numeric:tabular-nums}
.files div{padding:4px 0;border-bottom:1px solid #1a2236}
</style></head>
<body><div class="wrap">
<h1>Harvester Live Monitor</h1>
<p class="sub">Samples the answer files once per second. Real-time rate, not cumulative totals. <span id="clock"></span></p>
<span class="pill" id="pill"><span class="dot"></span><span id="status">CONNECTING</span></span>
<div class="grid">
  <div class="metric"><div class="k">Lines added / sec</div><div class="v" id="r1">—</div></div>
  <div class="metric"><div class="k">Last 10 sec</div><div class="v" id="r10">—</div></div>
  <div class="metric"><div class="k">Last 60 sec</div><div class="v" id="r60">—</div></div>
  <div class="metric"><div class="k">Since last write</div><div class="v" id="age">—<span class="u"> s</span></div></div>
</div>
<div class="chart" id="chart"></div>
<div class="files" id="files"></div>
</div>
<script>
let lastTotal = null;
async function tick(){
  try{
    const d = await (await fetch('/api/live',{cache:'no-store'})).json();
    document.getElementById('status').textContent = d.status;
    document.getElementById('pill').className = 'pill ' + d.status;
    document.getElementById('r1').textContent = d.rates.r1;
    document.getElementById('r10').textContent = d.rates.r10;
    document.getElementById('r60').textContent = d.rates.r60;
    document.getElementById('age').innerHTML = d.seconds_since_write + '<span class="u"> s</span>';
    document.getElementById('clock').textContent = 'Sample ' + d.time;
    document.getElementById('files').innerHTML = Object.entries(d.per_file)
      .map(([k,v])=>`<div>${k}: ${v.toLocaleString()}</div>`).join('');
    const h = d.history.slice(-90);
    const vals = h.map((x,i)=> i? Math.max(0,x.n-h[i-1].n) : 0);
    const max = Math.max(1,...vals);
    document.getElementById('chart').innerHTML = vals.map(v=>
      `<div class="bar ${v?'':'zero'}" style="height:${Math.max(1,v/max*100)}%"></div>`).join('');
  }catch(e){document.getElementById('status').textContent='OFFLINE';}
}
tick(); setInterval(tick,1000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/live":
            body = json.dumps(snapshot()).encode()
            ctype = "application/json; charset=utf-8"
        elif self.path in ("/", "/index.html"):
            body = HTML.encode()
            ctype = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=sampler, daemon=True).start()
    print("Live monitor at http://127.0.0.1:8767")
    ThreadingHTTPServer(("127.0.0.1", 8767), Handler).serve_forever()
