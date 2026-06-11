// process-event-reports.js
// Pre-genera y cachea en GitHub: reporte por empresa + oportunidades MAIA
// POST /.netlify/functions/process-event-reports

const Anthropic = require('@anthropic-ai/sdk');
const gh = require('./gh-storage');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    const { eventId, eventConfig, adminPassword } = JSON.parse(event.body);
    if (adminPassword !== process.env.ADMIN_PASSWORD)
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized' }) };

    // Load all responses for this event
    const responses = await gh.getResponses(eventId);
    if (!responses?.length)
      return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, message: 'No responses to process' }) };

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const results = { maia: false, companies: [] };

    // ── 1. MAIA OPPORTUNITIES REPORT (all leads) ─────────────────────────────
    try {
      const maiaHtml = await generateMAIAReport(client, responses, eventConfig);
      const fullHtml = wrapHTML(maiaHtml, eventConfig.eventName, responses.length, 'maia');
      await gh.saveFile(`data/reports/${eventId}/maia.html`, fullHtml, `reports: generate MAIA opportunities for ${eventId}`);
      results.maia = true;
    } catch (e) { console.error('MAIA report failed:', e.message); }

    // ── 2. COMPANY REPORTS (grouped by domain) ───────────────────────────────
    const byDomain = {};
    responses.forEach(r => {
      const email = r.respondent?.email || '';
      const domain = email.split('@')[1]?.toLowerCase() || '';
      if (domain && !['gmail.com','hotmail.com','yahoo.com','outlook.com'].includes(domain)) {
        if (!byDomain[domain]) byDomain[domain] = [];
        byDomain[domain].push(r);
      }
    });

    for (const [domain, leads] of Object.entries(byDomain)) {
      if (leads.length === 0) continue;
      try {
        const company = leads[0].respondent?.company || domain;
        const companyHtml = await generateCompanyReport(client, leads, company, eventConfig);
        const fullHtml = wrapCompanyHTML(companyHtml, company, leads, eventConfig.eventName);
        await gh.saveFile(`data/reports/${eventId}/company-${domain}.html`, fullHtml, `reports: generate company report for ${domain}`);
        results.companies.push(domain);
      } catch (e) { console.error(`Company report failed for ${domain}:`, e.message); }
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, results }),
    };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: err.message }) };
  }
};

// ── MAIA PROMPT ───────────────────────────────────────────────────────────────
async function generateMAIAReport(client, responses, eventConfig) {
  const questions = eventConfig.questions || [];
  const respondents = responses.map(r => {
    const resp = r.respondent || {};
    const lines = questions.map(q => {
      const ans = r.answers?.[q.id];
      if (!ans && ans !== 0) return null;
      let val = q.type === 'scale' ? `${ans}/5`
        : typeof ans === 'object' && !Array.isArray(ans)
          ? Object.entries(ans).filter(([k,v])=>k!=='_open'&&v).map(([k])=>k).concat(ans._open?[ans._open]:[]).join(' · ')
          : Array.isArray(ans) ? ans.join(' · ') : String(ans);
      return val ? `  ${q.label}: ${val}` : null;
    }).filter(Boolean).join('\n');
    return `${resp.name} | ${resp.company} | ${resp.role} | ${resp.industry}\n${lines}`;
  }).join('\n\n---\n\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    system: `Eres consultor senior de Grupo Scanda. Analiza el grupo completo de respondentes y genera un reporte interno de oportunidades comerciales mapeadas al portafolio MAIA.

PORTAFOLIO MAIA:
1. IA VALUE DISCOVERY ($30-80K USD, 3-5 sem): diagnóstico estratégico, portafolio de casos de uso priorizados. Para empresas que no saben por dónde empezar.
2. DATA READY & BUSINESS INSIGHTS ($50-200K): integración de datos, MDM, capa semántica. Para empresas con datos dispersos o sin confiabilidad.
3. CORPORATE AI ASSISTANTS ($40-150K): agentes IA con conocimiento del cliente, copilotos, automatización. Para empresas con datos listos.
4. FACTORY DATA 360 ($8-25K/mes): digitalización de planta, sensores, SPC, trazabilidad. Para manufactura con captura manual.
5. FACTORY INSIGHTS 360 ($15-40K/mes): consultoría continua de planta para interpretar datos y priorizar mejoras.
6. GEMELOS DIGITALES ($80-250K): réplica digital de planta, semáforos, predicción de fallas.

GENERA SOLO HTML con estas secciones:
<div class="comm-section"><h2>Resumen ejecutivo de oportunidad</h2><p>[tamaño del mercado captado en este evento, urgencia general, perfil del grupo]</p></div>
<div class="comm-section"><h2>Score de calificación del evento</h2>[tabla HTML: respondentes, empresas únicas, urgencia promedio, % con presupuesto, temperatura general]</div>
<div class="comm-section"><h2>Oportunidades por empresa</h2>[para cada empresa: nombre, roles, dolor principal, oferta MAIA recomendada, inversión estimada, prioridad ALTA/MEDIA/BAJA]</div>
<div class="comm-section"><h2>Mapa de oferta MAIA</h2>[qué ofertas aplican y cuántas empresas las necesitan — tabla: Oferta | Empresas | Inversión total estimada]</div>
<div class="comm-section"><h2>Secuencia de seguimiento recomendada</h2>[ordenar por prioridad: quién contactar primero, qué proponer, en qué plazo]</div>
<div class="comm-section comm-next"><h2>Potencial de cartera total</h2>[tabla: Oferta | Rango inversión | Empresas | Probabilidad | Valor esperado — con TOTAL al final]</div>

REGLAS: Solo HTML. Usa datos reales. Menciona nombres de empresas y personas. Ejecutivo y directo.`,
    messages: [{ role: 'user', content: `Evento: ${eventConfig.eventName}\n${responses.length} respondentes\n\n${respondents}` }],
  });
  return msg.content[0].text.replace(/^```html?\s*/i,'').replace(/```\s*$/i,'').trim();
}

// ── COMPANY PROMPT ────────────────────────────────────────────────────────────
async function generateCompanyReport(client, leads, company, eventConfig) {
  const questions = eventConfig.questions || [];
  const respondents = leads.map(r => {
    const resp = r.respondent || {};
    const lines = questions.map(q => {
      const ans = r.answers?.[q.id];
      if (!ans && ans !== 0) return null;
      let val = q.type === 'scale' ? `${ans}/5`
        : typeof ans === 'object' && !Array.isArray(ans)
          ? Object.entries(ans).filter(([k,v])=>k!=='_open'&&v).map(([k])=>k).concat(ans._open?[ans._open]:[]).join(' · ')
          : Array.isArray(ans) ? ans.join(' · ') : String(ans);
      return val ? `  ${q.label}: ${val}` : null;
    }).filter(Boolean).join('\n');
    return `${resp.name} (${resp.role}):\n${lines}`;
  }).join('\n\n---\n\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `Eres consultor senior de Scanda preparando el reporte por empresa para el Workshop de Discovery.

GENERA SOLO HTML:
<div class="cr-section"><h2>Resumen ejecutivo</h2><p>[problema central, receptividad, temperatura ALTA/MEDIA/BAJA]</p></div>
<div class="cr-section"><h2>Los dolores más repetidos</h2>[lista con frecuencia y citas textuales por nombre]</div>
<div class="cr-section"><h2>Dónde hay consenso</h2>[puntos donde todos coinciden]</div>
<div class="cr-section"><h2>Dónde hay disparidad</h2>[visiones distintas entre roles]</div>
<div class="cr-section"><h2>Casos de uso sugeridos</h2>[top 3 con ROI estimado y plazo]</div>
<div class="cr-section cr-recommendation"><h2>Recomendación para el Workshop</h2><p>[cómo enfocar la sesión]</p></div>

REGLAS: Usa nombres reales. Cita textualmente. Solo HTML.`,
    messages: [{ role: 'user', content: `Empresa: ${company}\n${leads.length} respondentes\n\n${respondents}` }],
  });
  return msg.content[0].text.replace(/^```html?\s*/i,'').replace(/```\s*$/i,'').trim();
}

// ── HTML WRAPPERS ─────────────────────────────────────────────────────────────
function wrapHTML(aiContent, eventName, count, type) {
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  const title = type === 'maia' ? 'Oportunidades MAIA' : 'Reporte por Empresa';
  const bg = type === 'maia' ? '#fbbf24' : '#818cf8';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · ${eventName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:#f0f4f8;color:#1a2332;padding:32px 16px}
.page{max-width:780px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.hdr{background:linear-gradient(135deg,#0b1a30,#1a3a6b);padding:28px 36px;color:#fff}
.hdr-ey{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:${bg};margin-bottom:6px}
.hdr-warn{font-size:11px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.3);border-radius:4px;padding:3px 10px;display:inline-block;color:#fbbf24;font-family:'DM Mono',monospace;margin-bottom:10px}
.hdr h1{font-size:20px;font-weight:800;margin-bottom:4px}.hdr-sub{font-size:12px;opacity:.6}
.content{padding:4px 36px 28px}
.comm-section{padding:18px 0;border-bottom:1px solid #f1f5f9}.comm-section:last-child{border-bottom:none}
.comm-section h2{font-size:16px;font-weight:800;color:#0b1a30;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
.comm-section p,.comm-section li{font-size:14px;line-height:1.8;color:#374151}
.comm-section table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.comm-section table th{background:#0b1a30;color:#fff;padding:8px 12px;text-align:left;font-size:11px}
.comm-section table td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.comm-section table tr:nth-child(even) td{background:#f8fafc}
.comm-section table tr:last-child td{font-weight:700;background:#f0fdf9;color:#065f46}
.comm-section ul{padding-left:0;list-style:none}
.comm-section ul li{padding:5px 0;display:flex;gap:8px;font-size:14px;color:#374151}
.comm-section ul li::before{content:"→";color:#0d9488;flex-shrink:0;font-weight:700}
.cr-section{padding:18px 0;border-bottom:1px solid #f1f5f9}.cr-section:last-child{border-bottom:none}
.cr-section h2{font-size:16px;font-weight:800;color:#0b1a30;margin-bottom:10px}
.cr-recommendation{background:#f0f4ff;border-radius:8px;padding:14px 16px!important}
.comm-next{background:#f0f4ff!important;border-radius:8px;padding:14px!important}
.abar{padding:14px 36px;display:flex;justify-content:space-between;align-items:center;border-top:2px solid ${bg};background:#fff}
.abar-meta{font-size:11px;color:#94a3b8;font-family:'DM Mono',monospace}
.abtn{padding:8px 16px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;border:1px solid;margin-left:8px}
.abtn-dl{background:rgba(0,151,255,.08);color:#0597ff;border-color:rgba(0,151,255,.3)}
.abtn-pr{background:#0b1a30;color:#fff;border-color:#0b1a30}
@media print{.abar{display:none}body{background:#fff;padding:0}.page{border-radius:0;box-shadow:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="page">
<div class="hdr">
  <div class="hdr-ey">MAIA by Grupo Scanda · ${title}</div>
  <div class="hdr-warn">🔒 USO INTERNO — NO COMPARTIR CON EL CLIENTE</div>
  <h1>${eventName}</h1>
  <div class="hdr-sub">Generado el ${now} · ${count} respondentes</div>
</div>
<div class="content">${aiContent}</div>
<div class="abar">
  <div class="abar-meta">Generado el ${now}</div>
  <div>
    <button class="abtn abtn-dl" onclick="dl()">⬇ Descargar</button>
    <button class="abtn abtn-pr" onclick="window.print()">🖨 Imprimir</button>
  </div>
</div>
</div>
<script>function dl(){const b=new Blob([document.documentElement.outerHTML],{type:'text/html;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='${title.replace(/ /g,'-')}.html';a.click()}</script>
</body></html>`;
}

function wrapCompanyHTML(aiContent, company, leads, eventName) {
  const roles = leads.map(l=>l.respondent?.role).filter(Boolean).join(' · ');
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  return wrapHTML(aiContent, `${company} — ${eventName}`, leads.length, 'company')
    .replace('🔒 USO INTERNO — NO COMPARTIR CON EL CLIENTE',
             `${company} · ${leads.length} respondente${leads.length>1?'s':''} · ${roles}`);
}
