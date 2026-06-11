// generate-company-report.js
// Genera reporte consolidado por empresa (multi-respondente)
// Estilo Apollocom: dolores, temperatura, consenso/disparidad, casos de uso
// POST /.netlify/functions/generate-company-report

const Anthropic = require('@anthropic-ai/sdk');
const gh = require('./gh-storage');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  try {
    const { leads, eventConfig, company, domain } = JSON.parse(event.body);
    if (!leads?.length) throw new Error('No hay respuestas para esta empresa');

    const questions = eventConfig.questions || [];

    // ── Build structured input per respondent ──────────────────────────────
    const respondents = leads.map(lead => {
      const resp = lead.respondent || {};
      const answerLines = questions.map(q => {
        const ans = lead.answers?.[q.id];
        if (ans === null || ans === undefined) return null;
        let formatted = '';
        if (q.type === 'scale') formatted = `${ans}/5`;
        else if (q.type === 'multi-open' && typeof ans === 'object' && !Array.isArray(ans)) {
          const sel = Object.entries(ans).filter(([k,v]) => k !== '_open' && v).map(([k]) => k);
          if (ans._open) sel.push(`"${ans._open}"`);
          formatted = sel.join(' · ') || 'No respondida';
        }
        else if (Array.isArray(ans)) formatted = ans.join(' · ') || 'No respondida';
        else formatted = String(ans);
        return `  ${q.label}: ${formatted}`;
      }).filter(Boolean).join('\n');

      return `RESPONDENTE: ${resp.name || '?'} · ${resp.role || '?'} · ${resp.industry || '?'}
${answerLines}`;
    }).join('\n\n---\n\n');

    // ── Time lost summary (scale averages) ────────────────────────────────
    const scaleQs = questions.filter(q => q.type === 'scale');
    const scaleAvgs = scaleQs.map(q => {
      const vals = leads.map(l => Number(l.answers?.[q.id])).filter(v => !isNaN(v) && v > 0);
      const avg = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : '—';
      return `${q.label}: ${avg}/5 (${vals.length} respuestas)`;
    }).join('\n');

    // ── System prompt ─────────────────────────────────────────────────────
    const systemPrompt = `Eres un consultor senior del CoE-IA de Grupo Scanda analizando las respuestas de múltiples directivos de la misma empresa.

Tu objetivo es generar un reporte ejecutivo consolidado para el equipo comercial de Scanda — NO para el cliente.
Este reporte sirve para preparar el Workshop de Discovery con la empresa.

GENERA el siguiente HTML exacto (sin markdown, sin explicaciones):

<div class="cr-executive">
  <div class="cr-kpis">
    <!-- 3-4 KPIs clave: tiempo perdido estimado, temperatura, número de respondentes, áreas cubiertas -->
  </div>
  
  <div class="cr-section">
    <h2>Resumen ejecutivo</h2>
    <p>[3-4 oraciones: problema central consensuado, quiénes son los respondentes, nivel de sofisticación de las respuestas, receptividad al cambio]</p>
  </div>

  <div class="cr-section">
    <h2>Los dolores más repetidos</h2>
    <!-- Para cada dolor mencionado por 2+ personas: nombre del dolor, cuántos lo mencionan, qué dijo cada uno con su nombre/área -->
  </div>

  <div class="cr-section">
    <h2>Dónde hay consenso</h2>
    <!-- Lista de puntos donde todos o casi todos coinciden -->
  </div>

  <div class="cr-section">
    <h2>Dónde hay disparidad</h2>
    <!-- Diferencias de perspectiva entre roles/áreas — muestra las dos visiones lado a lado -->
  </div>

  <div class="cr-section">
    <h2>Casos de uso sugeridos</h2>
    <!-- Top 3 casos de uso con mayor ROI potencial basados en los dolores expresados -->
    <!-- Para cada uno: nombre, justificación basada en las respuestas, ROI estimado -->
  </div>

  <div class="cr-section cr-recommendation">
    <h2>Recomendación para el Workshop de Discovery</h2>
    <p>[Cómo enfocar la sesión, a quién involucrar, qué quick win presentar primero para generar credibilidad]</p>
  </div>
</div>

REGLAS:
- Usa los nombres reales de los respondentes (Hilda, Myrna, etc.)
- Cita textualmente sus palabras más reveladoras entre comillas
- La "Temperatura del cliente" es: ALTA si respuestas específicas y cuantificadas, MEDIA si respuestas generales, BAJA si respuestas vagas
- Sé directo y ejecutivo — esto lo leerá el consultor de Scanda antes del Workshop
- Solo HTML puro, sin markdown`;

    const userMessage = `Empresa: ${company}
Dominio: ${domain}
Respondentes: ${leads.length}
Evento: ${eventConfig.eventName}

RESPUESTAS POR DIRECTIVO:
${respondents}

${scaleAvgs ? `PROMEDIOS DE ESCALA:\n${scaleAvgs}` : ''}

Genera el reporte consolidado ejecutivo.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let reportHtml = msg.content[0].text;
    reportHtml = reportHtml.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

    // Wrap in full page HTML with styles
    const fullHtml = buildFullHTML(company, leads, reportHtml, eventConfig.eventName);

    // Save to GitHub cache
    const { eventId } = eventConfig;
    if (eventId && domain) {
      const gh = require('./gh-storage');
      gh.saveFile(`data/reports/${eventId}/company-${domain}.html`, fullHtml, `cache: company report ${domain}`)
        .catch(e => console.log('Cache save failed (non-fatal):', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, reportHtml: fullHtml }),
    };

  } catch (err) {
    console.error('generate-company-report error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

function buildFullHTML(company, leads, aiContent, eventName) {
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  const roles = leads.map(l => l.respondent?.role).filter(Boolean);
  const areas = [...new Set(leads.map(l => l.respondent?.industry).filter(Boolean))];
  const names = leads.map(l => l.respondent?.name).filter(Boolean);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reporte por Empresa · ${company} · CoE-IA Scanda</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f8fafc;color:#1a2332;padding:32px 16px}
.page{max-width:760px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
/* Header */
.page-hdr{background:linear-gradient(135deg,#0b1a30,#1a3a6b);color:#fff;padding:32px 40px}
.hdr-eyebrow{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#a7f3d0;margin-bottom:8px}
.hdr-tag{font-size:13px;opacity:.6;margin-bottom:10px;font-style:italic}
.hdr-company{font-size:28px;font-weight:800;margin-bottom:6px}
.hdr-desc{font-size:13px;opacity:.65;line-height:1.6;max-width:520px;margin-bottom:20px}
.hdr-meta{display:flex;gap:32px;padding-top:16px;border-top:1px solid rgba(255,255,255,.15);flex-wrap:wrap}
.hdr-meta-item .ml{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin-bottom:2px;font-family:'DM Mono',monospace}
.hdr-meta-item .mv{font-size:15px;font-weight:700}
/* AI Content area */
.ai-content{padding:0 40px 32px}
/* KPI row */
.cr-kpis{display:flex;gap:14px;flex-wrap:wrap;padding:24px 0 20px;border-bottom:1px solid #e2e8f0;margin-bottom:8px}
.cr-kpi{flex:1;min-width:130px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center}
.cr-kpi .kn{font-family:'DM Mono',monospace;font-size:22px;font-weight:800;color:#0b1a30;line-height:1;margin-bottom:4px}
.cr-kpi .kl{font-size:11px;color:#64748b;line-height:1.3}
/* Sections */
.cr-section{padding:20px 0;border-bottom:1px solid #f1f5f9}
.cr-section:last-child{border-bottom:none}
.cr-section h2{font-size:18px;font-weight:800;color:#0b1a30;margin-bottom:12px}
.cr-section p,.cr-section li{font-size:14px;line-height:1.8;color:#374151}
.cr-section ul{padding-left:0;list-style:none}
.cr-section ul li{padding:6px 0;display:flex;align-items:flex-start;gap:8px}
.cr-section ul li::before{content:'✓';color:#0d9488;flex-shrink:0;font-weight:700}
/* Temperatura badge */
.temp-badge{display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;font-family:'DM Mono',monospace}
.temp-alta{background:#d1fae5;color:#065f46}
.temp-media{background:#fef3c7;color:#78350f}
.temp-baja{background:#fee2e2;color:#991b1b}
/* Dolor items */
.dolor-item{margin-bottom:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0}
.dolor-title{font-size:14px;font-weight:700;color:#0b1a30;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.dolor-freq{font-family:'DM Mono',monospace;font-size:11px;padding:2px 8px;border-radius:4px;background:#0b1a30;color:#a7f3d0}
.dolor-quotes{font-size:12px;color:#64748b;line-height:1.6;margin-top:8px}
.dolor-area-tag{font-size:10px;background:#e2e8f0;color:#475569;padding:2px 7px;border-radius:4px;font-family:'DM Mono',monospace}
/* Disparidad */
.disparity-card{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:12px}
.disp-side{padding:14px 16px;font-size:13px;line-height:1.6}
.disp-left{background:#eff6ff;border-right:3px solid #3b82f6}
.disp-right{background:#fff7ed}
.disp-label{font-size:10px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:4px}
/* Casos de uso */
.caso-item{padding:14px 16px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:10px}
.caso-title{font-size:14px;font-weight:700;color:#0b1a30;margin-bottom:4px}
.caso-desc{font-size:13px;color:#374151;line-height:1.6;margin-bottom:8px}
.caso-chips{display:flex;gap:6px;flex-wrap:wrap}
.caso-chip{font-size:10px;font-family:'DM Mono',monospace;padding:2px 9px;border-radius:20px;font-weight:600}
.chip-roi{background:#d1fae5;color:#065f46}
.chip-track{background:#0b1a30;color:#a7f3d0}
/* Recomendación */
.cr-recommendation{background:#f0f4ff!important;border-radius:10px;padding:16px 20px!important}
.cr-recommendation h2{color:#3730a3!important}
.cr-recommendation p{color:#374151}
/* Individual responses */
.indv-section{padding:24px 40px 32px;border-top:2px solid #e2e8f0;background:#f8fafc}
.indv-title{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#64748b;margin-bottom:20px}
.person-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:14px;overflow:hidden}
.person-hdr{background:#0b1a30;padding:12px 18px;display:flex;justify-content:space-between;align-items:center}
.person-name{font-size:14px;font-weight:700;color:#fff}
.person-meta{font-size:11px;color:rgba(255,255,255,.6)}
.person-answers{padding:14px 18px}
.pa-row{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;line-height:1.6}
.pa-row:last-child{border-bottom:none}
.pa-label{font-size:10px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin-bottom:3px}
.pa-value{color:#374151}
/* Action bar */
.action-bar{background:#fff;padding:16px 40px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e2e8f0}
.abtn{padding:9px 18px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;border:1px solid}
.abtn-dl{background:rgba(0,151,255,.08);color:#0597ff;border-color:rgba(0,151,255,.3)}
.abtn-pr{background:#0b1a30;color:#fff;border-color:#0b1a30}
@media print{.action-bar{display:none}body{background:#fff;padding:0}.page{border-radius:0;box-shadow:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="page">

<!-- HEADER -->
<div class="page-hdr">
  <div class="hdr-eyebrow">Scanda · CoE-IA · Reporte por Empresa</div>
  <div class="hdr-tag">AI Process Discovery — Reporte Ejecutivo de Diagnóstico</div>
  <div class="hdr-company">${company}</div>
  <div class="hdr-desc">Consolidado de las respuestas al diagnóstico de madurez en IA de ${leads.length} participante${leads.length>1?'s':''} de ${company}, con análisis ejecutivo de dolores, consensos, disparidades y casos de uso sugeridos.</div>
  <div class="hdr-meta">
    <div class="hdr-meta-item"><div class="ml">Fecha del reporte</div><div class="mv">${now}</div></div>
    <div class="hdr-meta-item"><div class="ml">Participantes</div><div class="mv">${leads.length} directivo${leads.length>1?'s':''}</div></div>
    <div class="hdr-meta-item"><div class="ml">Evento</div><div class="mv">${eventName}</div></div>
    <div class="hdr-meta-item"><div class="ml">Roles</div><div class="mv">${roles.slice(0,3).join(' · ')}${roles.length>3?' +'+( roles.length-3):''}</div></div>
  </div>
</div>

<!-- AI CONTENT -->
<div class="ai-content">
  ${aiContent}
</div>

<!-- INDIVIDUAL RESPONSES -->
<div class="indv-section">
  <div class="indv-title">Anexo · Respuestas individuales</div>
  ${leads.map(lead => {
    const resp = lead.respondent || {};
    const qRows = (eventConfig.questions || []).map(q => {
      const ans = lead.answers?.[q.id];
      if (ans === null || ans === undefined) return '';
      let val = '';
      if (q.type === 'scale') val = `${ans}/5`;
      else if (q.type === 'multi-open' && typeof ans === 'object' && !Array.isArray(ans)) {
        const sel = Object.entries(ans).filter(([k,v])=>k!=='_open'&&v).map(([k])=>k);
        if (ans._open) sel.push(ans._open);
        val = sel.join(' · ');
      }
      else if (Array.isArray(ans)) val = ans.join(' · ');
      else val = String(ans);
      if (!val) return '';
      return `<div class="pa-row"><div class="pa-label">${q.label.slice(0,60)}${q.label.length>60?'…':''}</div><div class="pa-value">${val}</div></div>`;
    }).filter(Boolean).join('');

    return `<div class="person-card">
      <div class="person-hdr">
        <div class="person-name">${resp.name || '—'}</div>
        <div class="person-meta">${resp.role || '—'} · ${resp.industry || '—'} · ${(lead.timestamp||'').slice(0,10)}</div>
      </div>
      <div class="person-answers">${qRows || '<div style="color:#94a3b8;font-size:13px;padding:8px 0">Sin respuestas registradas</div>'}</div>
    </div>`;
  }).join('')}
</div>

<!-- ACTION BAR -->
<div class="action-bar">
  <button class="abtn abtn-dl" onclick="downloadHTML()">⬇ Descargar HTML</button>
  <button class="abtn abtn-pr" onclick="window.print()">🖨 Imprimir / PDF</button>
</div>

</div>
<script>
function downloadHTML(){
  const blob=new Blob([document.documentElement.outerHTML],{type:'text/html;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='Reporte-Empresa-${company.replace(/[^a-zA-Z0-9]/g,'-')}.html';
  a.click();
}
</script>
</body>
</html>`;
}
