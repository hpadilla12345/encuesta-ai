// generate-summary.js
// Genera reporte consolidado por evento con conclusiones IA
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
    const ghH = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // 1. Leer evento
    const evRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/data/events.json`, { headers: ghH });
    const evData = await evRes.json();
    const events = JSON.parse(Buffer.from(evData.content.replace(/\n/g,''), 'base64').toString('utf8'));
    const ev = events.find(e => e.slug === slug || e.eventId === slug);
    if (!ev) return {
      statusCode: 404,
      headers: { ...cors, 'Content-Type': 'text/html' },
      body: '<h2 style="font-family:sans-serif;padding:40px">Evento no encontrado</h2>'
    };

    // 2. Leer respuestas
    let responses = [];
    try {
      const rRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/data/responses/${ev.eventId}.json`,
        { headers: ghH }
      );
      if (rRes.ok) {
        const rData = await rRes.json();
        responses = JSON.parse(Buffer.from(rData.content.replace(/\n/g,''), 'base64').toString('utf8'));
      }
    } catch (_) {}

    // 3. Estadisticas
    const stats = buildStats(ev, responses);

    // 4. Conclusiones con IA
    let aiSummary = null;
    if (responses.length > 0 && process.env.ANTHROPIC_API_KEY) {
      aiSummary = await generateAISummary(ev, responses, stats);
    }

    // 5. HTML final
    const html = buildHTML(ev, responses, stats, aiSummary);
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── ESTADÍSTICAS ──────────────────────────────────────────────────────────────
function buildStats(ev, responses) {
  const total = responses.length;
  const qStats = {};
  for (const q of (ev.questions || [])) {
    if (q.type === 'scale') {
      const vals = responses.map(r => Number(r.answers?.[q.id])).filter(v => !isNaN(v) && v > 0);
      qStats[q.id] = {
        type: 'scale', label: q.label,
        avg: vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : 0,
        dist: [1,2,3,4,5,6,7,8,9,10].map(n => ({ val:n, cnt: vals.filter(v=>v===n).length })),
      };
    } else if (q.type === 'multi' || q.type === 'single') {
      const counts = {};
      for (const r of responses) {
        const ans = r.answers?.[q.id];
        const list = Array.isArray(ans) ? ans : (ans ? [ans] : []);
        list.forEach(a => { if(a) counts[a] = (counts[a]||0)+1; });
      }
      qStats[q.id] = {
        type: q.type, label: q.label,
        opts: Object.entries(counts).sort((a,b)=>b[1]-a[1])
          .map(([opt,cnt]) => ({ opt, cnt, pct: total ? Math.round(cnt/total*100) : 0 })),
      };
    } else if (q.type === 'open') {
      qStats[q.id] = {
        type: 'open', label: q.label,
        answers: responses.map(r => r.answers?.[q.id]).filter(Boolean),
      };
    }
  }
  return { total, qStats };
}

// ── IA: ANÁLISIS EJECUTIVO ────────────────────────────────────────────────────
async function generateAISummary(ev, responses, stats) {
  try {
    const questions = ev.questions || [];
    let respSummary = '';
    for (const q of questions) {
      const st = stats.qStats[q.id];
      if (!st) continue;
      respSummary += `\nPREGUNTA: ${q.label}\n`;
      if (st.type === 'scale') {
        respSummary += `Promedio del grupo: ${st.avg}/10\n`;
        respSummary += `Distribución: ${st.dist.filter(d=>d.cnt>0).map(d=>`${d.val}(${d.cnt} personas)`).join(', ')}\n`;
      } else if (st.type === 'multi' || st.type === 'single') {
        respSummary += st.opts.map(o => `- ${o.opt}: ${o.cnt} de ${stats.total} empresas (${o.pct}%)`).join('\n') + '\n';
      } else if (st.type === 'open') {
        respSummary += st.answers.map(a => `- "${a}"`).join('\n') + '\n';
      }
    }

    const systemPrompt = `Eres un analista senior de transformación digital e inteligencia artificial en manufactura LATAM.

Analiza los resultados agregados de un diagnóstico de madurez en IA aplicado a empresas manufactureras en un evento de American Chamber of Commerce México.

Genera un análisis ejecutivo en HTML con EXACTAMENTE este formato (solo el contenido, sin html/head/body):

<div class="ai-section">
  <h3>Diagnóstico ejecutivo del grupo</h3>
  <p>[3-4 oraciones sobre el estado general. Nivel Gartner predominante, qué significa competitivamente y qué oportunidad representa.]</p>
</div>
<div class="ai-section">
  <h3>Principales necesidades detectadas</h3>
  <p>[Los 2-3 casos de uso de IA más demandados y por qué son prioritarios para este sector.]</p>
</div>
<div class="ai-section">
  <h3>Barreras críticas a resolver</h3>
  <p>[Las barreras más frecuentes y cómo se interrelacionan.]</p>
</div>
<div class="ai-section">
  <h3>Señales del mercado</h3>
  <p>[Urgencia percibida, intención de inversión y qué dice del momento de adopción de IA en el noreste de México.]</p>
</div>
<div class="ai-section">
  <h3>Recomendaciones para el Comité</h3>
  <p>[2-3 recomendaciones concretas para AmCham sobre cómo apoyar a sus miembros en la adopción de IA.]</p>
</div>

REGLAS: Tono ejecutivo y directo. Español formal. Sin lenguaje comercial. Sin mencionar marcas ni proveedores. Usa solo cifras reales del diagnóstico.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Evento: ${ev.eventName}\nParticipantes: ${stats.total}\n\nRESULTADOS:\n${respSummary}` }],
      }),
    });

    const data = await res.json();
    return (data.content?.[0]?.text || '').trim();
  } catch (err) {
    console.error('AI error:', err.message);
    return null;
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function bbar(pct, color) {
  return `<div style="flex:1;background:#e8ecf0;border-radius:999px;height:20px;overflow:hidden"><div style="width:${Math.max(pct,2)}%;height:100%;background:${color};border-radius:999px"></div></div>`;
}

function buildHTML(ev, responses, stats, aiSummary) {
  const { total, qStats } = stats;
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  const colors = ['#1a3a6b','#0d9488','#7c3aed','#dc2626','#d97706','#065f46','#1e40af','#831843','#374151'];
  const questions = ev.questions || [];

  let qSections = '';
  questions.forEach((q, qi) => {
    const col = colors[qi % colors.length];
    const st = qStats[q.id];
    if (!st) return;

    if (st.type === 'scale') {
      const maxCnt = Math.max(...st.dist.map(d=>d.cnt), 1);
      const bars = st.dist.map(d => {
        const h = Math.round((d.cnt/maxCnt)*56);
        const bg = d.val>=8?'#dc2626':d.val>=6?'#d97706':'#10b981';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
          <div style="font-size:11px;color:#374151;font-weight:700;min-height:15px">${d.cnt||''}</div>
          <div style="width:26px;height:${Math.max(h,3)}px;background:${d.cnt?bg:'#e8ecf0'};border-radius:3px 3px 0 0"></div>
          <div style="font-size:11px;color:#64748b;font-family:monospace">${d.val}</div>
        </div>`;
      }).join('');
      qSections += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:14px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi+1}</div>
        <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:8px">${q.label}</div>
        <div style="font-size:30px;font-weight:800;color:${col};margin-bottom:14px">${st.avg} <span style="font-size:13px;color:#94a3b8;font-weight:400">/ 10 promedio</span></div>
        <div style="display:flex;align-items:flex-end;gap:5px;height:76px">${bars}</div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#94a3b8;margin-top:3px"><span>Sin presión</span><span>Urgencia crítica</span></div>
      </div>`;

    } else if (st.type === 'multi' || st.type === 'single') {
      const rows = st.opts.map(o => {
        const label = o.opt.split('—')[0].split('–')[0].trim();
        const short = label.length > 50 ? label.slice(0,50)+'…' : label;
        return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:200px;font-size:12px;color:#374151;text-align:right;flex-shrink:0;line-height:1.3">${short}</div>
          ${bbar(o.pct, col)}
          <div style="width:26px;font-size:12px;font-weight:700;color:${col};text-align:right">${o.cnt}</div>
          <div style="width:32px;font-size:11px;color:#94a3b8">${o.pct}%</div>
        </div>`;
      }).join('');
      qSections += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:14px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi+1}</div>
        <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:16px">${q.label}</div>
        ${rows || '<div style="color:#94a3b8;font-size:13px">Sin respuestas aún</div>'}
      </div>`;

    } else if (st.type === 'open' && st.answers.length) {
      const items = st.answers.map(a =>
        `<div style="background:#f8fafc;border-left:3px solid ${col};border-radius:0 6px 6px 0;padding:8px 12px;margin-bottom:6px;font-size:13px;color:#374151">${a}</div>`
      ).join('');
      qSections += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:14px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${col};font-weight:700;margin-bottom:4px;font-family:monospace">Pregunta ${qi+1}</div>
        <div style="font-size:15px;font-weight:700;color:#0b1a30;margin-bottom:14px">${q.label}</div>
        ${items}
      </div>`;
    }
  });

  const pRows = responses.map(r => {
    const resp = r.respondent || {};
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:500">${resp.name||'—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px">${resp.company||'—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${resp.role||'—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${resp.industry||'—'}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;text-align:center;color:#94a3b8">${(r.timestamp||'').slice(0,10)}</td>
    </tr>`;
  }).join('');

  const aiBlock = aiSummary ? `
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:14px">
    <div style="background:linear-gradient(135deg,#0b1a30,#1a3a6b);padding:18px 24px;display:flex;align-items:center;gap:12px">
      <div style="font-size:22px">🤖</div>
      <div>
        <div style="font-size:13px;font-weight:700;color:#fff">Análisis ejecutivo generado con IA</div>
        <div style="font-size:11px;color:rgba(255,255,255,.6)">Claude Sonnet · Basado en ${total} respuestas del grupo</div>
      </div>
    </div>
    <div style="padding:24px">
      <style>
        .ai-section{margin-bottom:20px}.ai-section:last-child{margin-bottom:0}
        .ai-section h3{font-size:12px;font-weight:700;color:#0b1a30;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
        .ai-section p{font-size:14px;color:#374151;line-height:1.75}
      </style>
      ${aiSummary}
    </div>
  </div>` : `<div style="background:#f8fafc;border:1px dashed #e2e8f0;border-radius:12px;padding:20px;text-align:center;margin-bottom:14px;color:#94a3b8;font-size:13px">
    ${total===0?'Sin respuestas aún para generar el análisis.':'Análisis IA no disponible en este momento.'}
  </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico IA · ${ev.eventName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:#f5f7fa;color:#1a2332}@media print{body{background:#fff}.no-print{display:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style>
</head>
<body>

<div style="background:linear-gradient(135deg,#0b1a30 0%,#1a3a6b 60%,#005b52 100%);color:#fff;padding:40px 56px;position:relative">
  ${ev.clientLogo?`<div style="position:absolute;top:28px;right:56px"><img src="${ev.clientLogo}" alt="Logo" style="height:40px;width:auto;object-fit:contain"></div>`:''}
  <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#a7f3d0;margin-bottom:12px">Diagnóstico · Madurez en Inteligencia Artificial</div>
  <h1 style="font-size:26px;font-weight:700;margin-bottom:6px;max-width:580px">${ev.eventName}</h1>
  <p style="font-size:13px;opacity:.65;margin-bottom:24px">${ev.heroDesc||''}</p>
  <div style="display:flex;gap:28px;flex-wrap:wrap;padding-top:18px;border-top:1px solid rgba(255,255,255,.15)">
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Participantes</div><div style="font-size:22px;font-weight:700">${total}</div></div>
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Generado</div><div style="font-size:22px;font-weight:700">${now}</div></div>
    <div><div style="font-size:10px;text-transform:uppercase;opacity:.5;letter-spacing:.08em;margin-bottom:2px">Metodología</div><div style="font-size:22px;font-weight:700">Framework Gartner</div></div>
  </div>
</div>

<div style="max-width:860px;margin:0 auto;padding:28px 40px">
  ${aiBlock}
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:14px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#0d9488;font-weight:700;margin-bottom:4px;font-family:monospace">Participantes</div>
    <div style="font-size:17px;font-weight:700;color:#0b1a30;margin-bottom:16px">Empresas que respondieron el diagnóstico</div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#0b1a30">
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Nombre</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Empresa</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Cargo</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#fff;font-weight:600">Industria</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#fff;font-weight:600">Fecha</th>
      </tr></thead>
      <tbody>${pRows||'<tr><td colspan="5" style="padding:20px;text-align:center;color:#94a3b8">Sin respuestas aún</td></tr>'}</tbody>
    </table>
  </div>
  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#0d9488;font-weight:700;margin-bottom:12px;font-family:monospace">Resultados por pregunta</div>
  ${qSections}
</div>

<div style="background:#0b1a30;color:rgba(255,255,255,.5);text-align:center;padding:22px;font-size:12px;line-height:1.8">
  <strong style="color:#fff">Grupo Scanda / MAIA · Data Intelligence</strong><br>
  Reporte generado automáticamente · ${ev.eventName}
</div>

<div class="no-print" style="position:fixed;bottom:20px;right:20px;display:flex;gap:8px">
  <button onclick="window.print()" style="background:#0b1a30;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2)">🖨 Imprimir / Guardar</button>
  <button onclick="location.reload()" style="background:#0d9488;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2)">🔄 Actualizar</button>
</div>

</body>
</html>`;
}
