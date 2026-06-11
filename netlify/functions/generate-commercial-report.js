// generate-commercial-report.js
// Reporte interno Scanda: oportunidades mapeadas a oferta MAIA
// POST /.netlify/functions/generate-commercial-report

const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    const { leads, eventConfig, company, domain, isSingle } = JSON.parse(event.body);
    const questions = eventConfig.questions || [];

    // Build respondent summaries
    const respondents = leads.map(lead => {
      const resp = lead.respondent || {};
      const lines = questions.map(q => {
        const ans = lead.answers?.[q.id];
        if (ans === null || ans === undefined) return null;
        let val = '';
        if (q.type === 'scale') val = `${ans}/5`;
        else if (q.type === 'multi-open' && typeof ans === 'object' && !Array.isArray(ans)) {
          const sel = Object.entries(ans).filter(([k,v])=>k!=='_open'&&v).map(([k])=>k);
          if (ans._open) sel.push(ans._open);
          val = sel.join(' · ');
        }
        else if (Array.isArray(ans)) val = ans.join(' · ');
        else val = String(ans);
        return val ? `  ${q.label}: ${val}` : null;
      }).filter(Boolean).join('\n');
      return `${resp.name} (${resp.role} · ${resp.industry}):\n${lines}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `Eres un consultor senior de Grupo Scanda preparando el análisis interno de oportunidad comercial para un prospecto.

PORTAFOLIO MAIA / SCANDA — ofertas disponibles:

1. IA VALUE DISCOVERY (3-5 semanas, $30-80K USD)
   Diagnóstico estratégico: sesiones con líderes, análisis de procesos, detección de oportunidades con ROI, validación de datos.
   Entregable: portafolio priorizado de casos de uso con factibilidad técnica e impacto estimado.
   Ideal para: empresas que no saben por dónde empezar, quieren validar antes de invertir, o tienen múltiples dolores sin priorizar.

2. DATA READY & BUSINESS INSIGHTS ($50-200K USD)
   Integración y transformación de datos: ambientes híbridos, calidad de datos, MDM, capa semántica unificada.
   Entregable: base de datos limpia, gobernada y lista para BI y agentes de IA.
   Ideal para: empresas con datos dispersos, duplicados, en silos o sin confiabilidad.

3. CORPORATE AI ASSISTANTS ($40-150K USD)
   Agentes de IA entrenados con conocimiento, procesos y gobernanza del cliente: copilotos, reportes automáticos, asistencia en decisiones.
   Ideal para: empresas con datos listos que quieren activar IA en el trabajo diario de sus equipos.

4. FACTORY DATA 360 — Manufactura (modelo renta $8-25K USD/mes)
   Plataforma de digitalización de planta: sensores, máquinas, datos humanos, SPC, trazabilidad, alertas en tiempo real.
   Ideal para: plantas con captura manual de datos, sin visibilidad operativa en tiempo real.

5. FACTORY INSIGHTS 360 — Manufactura ($15-40K USD/mes)
   Consultoría continua de expertos en producción, mantenimiento, calidad y planeación: interpretan datos, detectan desviaciones, priorizan mejoras.
   Ideal para: plantas con datos disponibles pero sin capacidad de interpretar y actuar sobre ellos.

6. GEMELOS DIGITALES — Manufactura ($80-250K USD)
   Réplica digital interactiva de la planta: inventario digital, semáforos de riesgo, predicción de fallas, visualización para Industria 4.0.
   Ideal para: plantas que quieren visualización total y base para transformación digital avanzada.

GENERA el siguiente HTML (sin markdown, sin explicaciones):

<div class="comm-section">
  <h2>Resumen de oportunidad</h2>
  <p>[2-3 oraciones: tamaño de la oportunidad, urgencia del cliente, nivel de madurez y receptividad]</p>
</div>

<div class="comm-section">
  <h2>Score de calificación comercial</h2>
  <!-- Tabla HTML con 5 criterios: Urgencia (1-10), Presupuesto (confirmado/en proceso/sin definir), Madurez de datos (1-5), Número de decisores involucrados, Temperatura del cliente (ALTA/MEDIA/BAJA) -->
  <!-- Score global 0-100 calculado: Urgencia*4 + Presupuesto(confirmado=25,proceso=15,sin=5) + Madurez*4 + Decisores*5 + Temperatura(alta=20,media=12,baja=5) -->
</div>

<div class="comm-section">
  <h2>Oportunidades mapeadas a oferta MAIA</h2>
  <!-- Para cada dolor/brecha detectada, mapear a la oferta MAIA correspondiente con: nombre del dolor, oferta recomendada, justificación de 2 líneas, inversión estimada, probabilidad de cierre (ALTA/MEDIA/BAJA) -->
</div>

<div class="comm-section">
  <h2>Secuencia de entrada recomendada</h2>
  <!-- Propuesta de 3 pasos ordenados cronológicamente: cuál vender primero, cuándo y por qué. Incluye la lógica: ej. "Primero IA Value Discovery para construir confianza, luego Data Ready, luego Assistants" -->
</div>

<div class="comm-section">
  <h2>Potencial de cartera estimado</h2>
  <!-- Tabla: oferta, rango de inversión, probabilidad, valor esperado. Total al final. -->
</div>

<div class="comm-section comm-next">
  <h2>Próximos pasos comerciales</h2>
  <!-- Lista concreta: quién contactar primero, qué proponer en la siguiente reunión, qué material enviar, fecha sugerida para seguimiento -->
</div>

REGLAS: Solo HTML. Ejecutivo y directo. Usa datos reales de las respuestas. Incluye nombres cuando sea relevante.`;

    const userMessage = `Empresa: ${company}
Respondentes: ${leads.length}
Evento: ${eventConfig.eventName}

DATOS DEL DIAGNÓSTICO:
${respondents}`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let aiContent = msg.content[0].text
      .replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

    const fullHtml = buildHTML(company, leads, aiContent, eventConfig.eventName);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, reportHtml: fullHtml }),
    };

  } catch (err) {
    console.error('generate-commercial-report error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

function buildHTML(company, leads, aiContent, eventName) {
  const now = new Date().toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
  const roles = leads.map(l => l.respondent?.role).filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oportunidad Comercial · ${company} · MAIA Scanda</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=DM+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f0f4f8;color:#1a2332;padding:32px 16px}
.page{max-width:780px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
/* Header */
.hdr{background:linear-gradient(135deg,#0b1a30,#1a3a6b);padding:32px 40px;color:#fff}
.hdr-eyebrow{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#fbbf24;margin-bottom:6px}
.hdr-confidential{font-size:11px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.3);border-radius:4px;padding:3px 10px;display:inline-block;color:#fbbf24;font-family:'DM Mono',monospace;margin-bottom:12px}
.hdr h1{font-size:24px;font-weight:800;margin-bottom:6px}
.hdr-sub{font-size:13px;opacity:.65;margin-bottom:20px}
.hdr-meta{display:flex;gap:28px;padding-top:16px;border-top:1px solid rgba(255,255,255,.12);flex-wrap:wrap}
.hdr-meta-item .ml{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin-bottom:2px;font-family:'DM Mono',monospace}
.hdr-meta-item .mv{font-size:14px;font-weight:700}
/* Content */
.content{padding:0 40px 32px}
/* Sections */
.comm-section{padding:20px 0;border-bottom:1px solid #f1f5f9}
.comm-section:last-child{border-bottom:none}
.comm-section h2{font-size:17px;font-weight:800;color:#0b1a30;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;display:flex;align-items:center;gap:8px}
.comm-section p{font-size:14px;line-height:1.8;color:#374151}
.comm-section table{width:100%;border-collapse:collapse;font-size:13px;margin-top:4px}
.comm-section table th{background:#0b1a30;color:#fff;padding:9px 14px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.04em}
.comm-section table td{padding:10px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top;line-height:1.5}
.comm-section table tr:nth-child(even) td{background:#f8fafc}
.comm-section table tr:last-child td{border-bottom:none;font-weight:700;background:#f0fdf9;color:#065f46}
.comm-section ul{padding-left:0;list-style:none;margin-top:4px}
.comm-section ul li{padding:6px 0;display:flex;align-items:flex-start;gap:8px;font-size:14px;color:#374151;line-height:1.6}
.comm-section ul li::before{content:'→';color:#0d9488;flex-shrink:0;font-weight:700}
/* Offer badges */
.offer-badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:10px;font-family:'DM Mono',monospace;font-weight:700;margin-bottom:6px}
.ob-discovery{background:#dbeafe;color:#1e40af}
.ob-data{background:#ede9fe;color:#5b21b6}
.ob-assistant{background:#d1fae5;color:#065f46}
.ob-factory{background:#fef3c7;color:#92400e}
.ob-insights{background:#fee2e2;color:#991b1b}
.ob-gemelos{background:#fce7f3;color:#9d174d}
/* Score */
.score-circle{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;margin:0 auto 8px;border:4px solid}
.score-hi{background:#d1fae5;border-color:#059669;color:#065f46}
.score-md{background:#fef3c7;border-color:#d97706;color:#92400e}
.score-lo{background:#fee2e2;border-color:#dc2626;color:#991b1b}
/* Next steps */
.comm-next{background:#f0f4ff;border-radius:10px;padding:20px!important;border:1px solid #c7d2fe!important;border-bottom:1px solid #c7d2fe!important}
.comm-next h2{color:#3730a3!important;border-bottom-color:#c7d2fe!important}
/* Action bar */
.abar{background:#fff;padding:16px 40px;display:flex;justify-content:flex-end;gap:10px;border-top:2px solid #fbbf24}
.abtn{padding:9px 18px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;border:1px solid}
.abtn-dl{background:rgba(0,151,255,.08);color:#0597ff;border-color:rgba(0,151,255,.3)}
.abtn-pr{background:#0b1a30;color:#fff;border-color:#0b1a30}
@media print{.abar{display:none}body{background:#fff;padding:0}.page{border-radius:0;box-shadow:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="page">

<div class="hdr">
  <div class="hdr-eyebrow">MAIA by Grupo Scanda · Análisis Interno de Oportunidad Comercial</div>
  <div class="hdr-confidential">🔒 USO INTERNO EXCLUSIVO — NO COMPARTIR CON EL CLIENTE</div>
  <h1>${company}</h1>
  <div class="hdr-sub">Oportunidades mapeadas al portafolio MAIA basadas en el diagnóstico de ${leads.length} directivo${leads.length>1?'s':''}</div>
  <div class="hdr-meta">
    <div class="hdr-meta-item"><div class="ml">Fecha</div><div class="mv">${now}</div></div>
    <div class="hdr-meta-item"><div class="ml">Respondentes</div><div class="mv">${leads.length} directivo${leads.length>1?'s':''}</div></div>
    <div class="hdr-meta-item"><div class="ml">Evento</div><div class="mv">${eventName}</div></div>
    <div class="hdr-meta-item"><div class="ml">Roles</div><div class="mv">${roles.slice(0,60)}${roles.length>60?'…':''}</div></div>
  </div>
</div>

<div class="content">
  ${aiContent}
</div>

<div class="abar">
  <button class="abtn abtn-dl" onclick="downloadHTML()">⬇ Descargar HTML</button>
  <button class="abtn abtn-pr" onclick="window.print()">🖨 Imprimir / PDF</button>
</div>

</div>
<script>
function downloadHTML(){
  const b=new Blob([document.documentElement.outerHTML],{type:'text/html;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);
  a.download='Comercial-${company.replace(/[^a-zA-Z0-9]/g,'-')}.html';a.click();
}
</script>
</body>
</html>`;
}
