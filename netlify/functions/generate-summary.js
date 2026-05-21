// generate-summary.js
// Genera el HTML de reporte consolidado por evento
// GET /.netlify/functions/generate-summary?evento=amcham-mty

const OWNER = process.env.GITHUB_REPO_OWNER || 'hpadilla12345';
const REPO  = process.env.GITHUB_REPO_NAME  || 'encuesta-ai';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const slug = event.queryStringParameters?.evento || event.queryStringParameters?.slug;
  if (!slug) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing ?evento= param' }) };

  try {
    const TOKEN = process.env.GITHUB_TOKEN;
    const ghHeaders = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // 1. Get event config
    const evRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/data/events.json`, { headers: ghHeaders });
    const evData = await evRes.json();
    const events = JSON.parse(Buffer.from(evData.content, 'base64').toString('utf8'));
    const ev = events.find(e => e.slug === slug || e.eventId === slug);
    if (!ev) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Event not found' }) };

    // 2. Get responses
    const respFile = `data/responses/${ev.eventId}.json`;
    let responses = [];
    try {
      const rRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${respFile}`, { headers: ghHeaders });
      if (rRes.ok) {
        const rData = await rRes.json();
        responses = JSON.parse(Buffer.from(rData.content, 'base64').toString('utf8'));
      }
    } catch (_) {}

    // 3. Build analytics
    const analytics = buildAnalytics(ev, responses);

    // 4. Generate HTML
    const html = buildHTML(ev, responses, analytics);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};

function buildAnalytics(ev, responses) {
  const questions = ev.questions || [];
  const total = responses.length;

  // Per-question breakdown
  const qStats = {};
  for (const q of questions) {
    if (q.type === 'scale') {
      const vals = responses.map(r => Number(r.answers?.[q.id])).filter(v => !isNaN(v));
      qStats[q.id] = {
        type: 'scale',
        label: q.label,
        avg: vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : 0,
        distribution: [1,2,3,4,5,6,7,8,9,10].map(n => ({
          val: n,
          count: vals.filter(v => v === n).length,
        })),
      };
    } else if (q.type === 'multi') {
      const counts = {};
      for (const r of responses) {
        const ans = r.answers?.[q.id] || [];
        const list = Array.isArray(ans) ? ans : [ans];
        for (const a of list) { counts[a] = (counts[a] || 0) + 1; }
      }
      qStats[q.id] = {
        type: 'multi',
        label: q.label,
        options: Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([opt,cnt])=>({ opt, cnt, pct: total ? Math.round(cnt/total*100) : 0 })),
      };
    } else if (q.type === 'single') {
      const counts = {};
      for (const r of responses) {
        const ans = r.answers?.[q.id];
        if (ans) counts[ans] = (counts[ans] || 0) + 1;
      }
      qStats[q.id] = {
        type: 'single',
        label: q.label,
        options: Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([opt,cnt])=>({ opt, cnt, pct: total ? Math.round(cnt/total*100) : 0 })),
      };
    } else if (q.type === 'open') {
      qStats[q.id] = {
        type: 'open',
        label: q.label,
        answers: responses.map(r => r.answers?.[q.id]).filter(Boolean),
      };
    }
  }

  return { total, qStats };
}

function bar(pct, color) {
  return `<div style="flex:1;background:#e8ecf0;border-radius:999px;height:20px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:999px"></div></div>`;
}

function buildHTML(ev, responses, analytics) {
  const { total, qStats } = analytics;
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  const colors = ['#1a3a6b','#0d9488','#7c3aed','#dc2626','#d97706','#065f46','#1e40af','#831843','#374151'];

  let qSections = '';
  let qi = 0;
  for (const [qid, stat] of Object.entries(qStats)) {
    const col = colors[qi % colors.length];
    qi++;

    if (stat.type === 'multi' || stat.type === 'single') {
      const rows = stat.options.map(o => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:200px;font-size:12px;color:#374151;text-align:right;flex-shrink:0">${o.opt.split('—')[0].split('–')[0].trim().slice(0,45)}${o.opt.length>45?'…':''}</div>
          ${bar(o.pct, col)}
          <div style="width:40px;font-size:12px;font-weight:700;color:${col};text-align:right">${o.cnt}</div>
          <div style="width:36px;font-size:11px;color:#94a3b8">${o.pct}%</div>
        </div>`).join('');
      qSections += `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi}</div>
          <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:16px">${stat.label}</div>
          ${rows}
        </div>`;
    } else if (stat.type === 'scale') {
      const maxCnt = Math.max(...stat.distribution.map(d=>d.count), 1);
      const bars = stat.distribution.map(d => {
        const h = Math.round((d.count/maxCnt)*60);
        const bg = d.val >= 8 ? '#dc2626' : d.val >= 6 ? '#d97706' : '#10b981';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <div style="font-size:11px;color:#374151;font-weight:700">${d.count||''}</div>
          <div style="width:28px;height:${Math.max(h,4)}px;background:${d.count?bg:'#e8ecf0'};border-radius:4px 4px 0 0"></div>
          <div style="font-size:12px;color:#64748b;font-family:monospace">${d.val}</div>
        </div>`;
      }).join('');
      qSections += `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi}</div>
          <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:6px">${stat.label}</div>
          <div style="font-size:28px;font-weight:800;color:${col};margin-bottom:16px">${stat.avg} <span style="font-size:14px;color:#94a3b8">/ 10 promedio</span></div>
          <div style="display:flex;align-items:flex-end;gap:6px;height:80px">${bars}</div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-top:4px"><span>Sin presión</span><span>Urgencia crítica</span></div>
        </div>`;
    } else if (stat.type === 'open' && stat.answers.length) {
      const items = stat.answers.map(a => `<div style="background:#f8fafc;border-left:3px solid ${col};border-radius:0 6px 6px 0;padding:8px 12px;margin-bottom:6px;font-size:13px;color:#374151">${a}</div>`).join('');
      qSections += `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi}</div>
          <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:16px">${stat.label}</div>
          ${items || '<div style="color:#94a3b8;font-size:13px">Sin respuestas abiertas</div>'}
        </div>`;
    }
  }

  // Participants list (anonymized — just company + role)
  const participantRows = responses.map((r,i) => {
    const resp = r.respondent || {};
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px">${resp.company || '—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${resp.role || '—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${resp.industry || '—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;color:#64748b">${(r.timestamp||'').slice(0,10)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico IA · ${ev.eventName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#f5f7fa;color:#1a2332}
  @media print{body{background:#fff}.no-print{display:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>

<!-- HEADER -->
<div style="background:linear-gradient(135deg,#0b1a30 0%,#1a3a6b 60%,#005b52 100%);color:#fff;padding:40px 56px;position:relative">
  <div style="position:absolute;top:28px;right:56px">
    <img src="${ev.clientLogo || ''}" alt="Grupo Scanda" style="height:40px;width:auto;object-fit:contain;${ev.clientLogo?'':'display:none'}">
  </div>
  <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#a7f3d0;margin-bottom:14px">Diagnóstico · Madurez en Inteligencia Artificial</div>
  <h1 style="font-size:28px;font-weight:700;margin-bottom:8px;max-width:600px">${ev.eventName}</h1>
  <p style="font-size:14px;opacity:.7;margin-bottom:28px">${ev.heroDesc || ''}</p>
  <div style="display:flex;gap:32px;flex-wrap:wrap;padding-top:20px;border-top:1px solid rgba(255,255,255,.15)">
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Participantes</div><div style="font-size:20px;font-weight:700">${total}</div></div>
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Reporte generado</div><div style="font-size:20px;font-weight:700">${now}</div></div>
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Metodología</div><div style="font-size:20px;font-weight:700">Framework Gartner</div></div>
  </div>
</div>

<!-- CONTENT -->
<div style="max-width:860px;margin:0 auto;padding:32px 40px">

  <!-- Participants table -->
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:20px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#0d9488;font-weight:700;margin-bottom:4px;font-family:monospace">Participantes</div>
    <div style="font-size:18px;font-weight:700;color:#0b1a30;margin-bottom:16px">Empresas que contestaron el diagnóstico</div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#0b1a30">
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600;border-radius:6px 0 0 0">Empresa</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Cargo</th>
          <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Industria</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;color:#fff;font-weight:600;border-radius:0 6px 0 0">Fecha</th>
        </tr>
      </thead>
      <tbody>${participantRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#94a3b8">Sin respuestas aún</td></tr>'}</tbody>
    </table>
  </div>

  <!-- Q&A sections -->
  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#0d9488;font-weight:700;margin-bottom:12px;font-family:monospace">Resultados por pregunta</div>
  ${qSections}

</div>

<!-- FOOTER -->
<div style="background:#0b1a30;color:rgba(255,255,255,.5);text-align:center;padding:24px;font-size:12px;line-height:1.8">
  <strong style="color:#fff">Grupo Scanda / MAIA · Data Intelligence</strong><br>
  Reporte generado automáticamente · ${ev.eventName}<br>
  <span style="opacity:.5">Este documento es de uso interno y distribución restringida.</span>
</div>

<div class="no-print" style="position:fixed;bottom:20px;right:20px;display:flex;gap:8px">
  <button onclick="window.print()" style="background:#0b1a30;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:'Inter',sans-serif">🖨 Imprimir / Guardar</button>
  <button onclick="location.reload()" style="background:#0d9488;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:'Inter',sans-serif">🔄 Actualizar datos</button>
</div>

</body>
</html>`;
}
