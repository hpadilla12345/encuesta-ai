const Anthropic = require('@anthropic-ai/sdk');
const gh = require('./gh-storage');

function formatAnswer(ans, qType) {
  if (ans === null || ans === undefined) return 'No respondida';
  if (qType === 'scale') return `${ans}/5`;
  if (qType === 'multi-open' && typeof ans === 'object' && !Array.isArray(ans)) {
    const sel = Object.entries(ans).filter(([k,v]) => k !== '_open' && v === true).map(([k]) => k);
    const custom = ans._open ? `"${ans._open}"` : '';
    return [...sel, custom].filter(Boolean).join(' · ') || 'No respondida';
  }
  if (Array.isArray(ans)) return ans.join(' · ') || 'No respondida';
  return String(ans) || 'No respondida';
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };
  if (event.httpMethod !== 'POST') return { statusCode:405, headers:cors, body:'Method not allowed' };

  try {
    const { answers, respondent, eventConfig } = JSON.parse(event.body);
    let { questions, eventName, eventId } = eventConfig;

    // Always fetch fresh template + prompt from GitHub
    let systemPrompt = null, reportTemplate = null;
    try {
      const owner = process.env.GITHUB_REPO_OWNER || 'hpadilla12345';
      const repo  = process.env.GITHUB_REPO_NAME  || 'encuesta-ai';
      const token = process.env.GITHUB_TOKEN;
      const r = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/data/events.json`,
        { headers: { Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' } }
      );
      if (r.ok) {
        const d = await r.json();
        const events = JSON.parse(Buffer.from(d.content,'base64').toString('utf8'));
        const ev = events.find(e => e.eventId === eventId || e.slug === eventId);
        if (ev) {
          systemPrompt   = ev.systemPrompt   || null;
          reportTemplate = ev.reportTemplate || null;
          questions      = ev.questions      || questions;
        }
      }
    } catch(ghErr) { console.log('GitHub fallback:', ghErr.message); }

    if (!systemPrompt)   systemPrompt   = eventConfig.systemPrompt   || 'Eres consultor senior de IA del CoE de Grupo Scanda.';
    if (!reportTemplate) reportTemplate = eventConfig.reportTemplate || '<div style="padding:32px;font-family:Arial"><h2>Score: {{SCORE_GARTNER}}/5.0 · {{NIVEL_GARTNER}}</h2><p>{{ANALISIS_POSICION}}</p><p>{{BRECHAS}}</p><p>{{INICIATIVAS}}</p></div>';

    // Build answers summary
    const answersText = (questions || []).map(q => {
      const fmt = formatAnswer(answers[q.id], q.type);
      return `${q.label}: ${fmt}`;
    }).join('\n');

    // Ask Claude ONLY for variable values (JSON) — fast, ~800 tokens output
    const jsonPrompt = systemPrompt + '\n\nResponde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin texto extra) con estas claves:\n' +
      '{"SCORE":"[entero 0-100]","SCORE_GARTNER":"[X.X]","NIVEL_GARTNER":"[nivel en español]",' +
      '"DIMENSIONES_BARRAS":"[HTML con 7 barras, una por dimensión en español, usa colores: 1=#ef4444, 2=#f59e0b, 3=#0d9488, 4=#059669, 5=#0597ff]",' +
      '"ANALISIS_POSICION":"[4-5 oraciones ejecutivas en texto plano]",' +
      '"BENCHMARK":"[3 oraciones comparando con industria real del respondente en texto plano]",' +
      '"BRECHAS":"[HTML: 3 items con clase brecha-item, cada uno con icono, titulo con score, descripcion con componente CoE que resuelve]",' +
      '"INDUSTRIA_IA":"[HTML: bloque Track A con 3-4 casos de su industria + bloque Track B con 2 casos, con resultados en %]",' +
      '"INICIATIVAS":"[HTML: 3 iniciativas con titulo, descripcion 2 lineas, chips de ROI/plazo/patron CoE]",' +
      '"RUTA_COE":"[HTML: 3 pasos secuenciales hacia el CoE segun nivel de madurez del respondente]",' +
      '"CTA_URL":"' + (eventConfig.ctaUrl || 'https://gruposcanda.com/discovery') + '",' +
      '"CTA_TEXT":"' + (eventConfig.ctaText || 'AGENDA TU AI DISCOVERY →') + '"}';

    const userMessage = `Respondente:
- Nombre: ${respondent.name}
- Empresa: ${respondent.company}
- Cargo: ${respondent.role}
- Email: ${respondent.email}
- Industria: ${respondent.industry || '—'}

Evento: ${eventName}

RESPUESTAS:
${answersText}

Genera el JSON con los valores de todas las variables.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: jsonPrompt,
      messages: [{ role:'user', content: userMessage }],
    });

    // Parse JSON response
    let raw = message.content[0].text.trim();
    raw = raw.replace(/^```json?\s*/i,'').replace(/```\s*$/i,'').trim();
    let vars;
    try { vars = JSON.parse(raw); }
    catch(e) {
      // Extract JSON object even if there's extra text
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) vars = JSON.parse(match[0]);
      else throw new Error('No se pudo parsear la respuesta de Claude: ' + raw.slice(0,200));
    }

    // Fill template with variable values
    let reportHtml = reportTemplate;
    Object.entries(vars).forEach(([key, val]) => {
      reportHtml = reportHtml.split(`{{${key}}}`).join(val || '');
    });
    // Also fill respondent variables
    reportHtml = reportHtml.split('{{NOMBRE}}').join(respondent.name || '');
    reportHtml = reportHtml.split('{{EMPRESA}}').join(respondent.company || '');
    reportHtml = reportHtml.split('{{CARGO}}').join(respondent.role || '');

    // Save to GitHub
    const responseData = { respondent, answers, eventId, eventName, reportHtml, timestamp: new Date().toISOString() };
    try { await gh.saveResponse(eventId, responseData); } catch(ghErr) { console.log('Save failed:', ghErr.message); }

    // Send email directly from server — always complete HTML, not affected by browser timeout
    const resendEmail = eventConfig.ctaUrl || null;
    fetch(`${process.env.URL || 'https://encuesta-ia.netlify.app'}/.netlify/functions/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: respondent.email,
        name: respondent.name,
        company: respondent.company,
        eventName,
        reportHtml,
        ccAdmin: true,
      }),
    }).catch(e => console.log('Email send failed (non-fatal):', e.message));

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type':'application/json' },
      body: JSON.stringify({ success:true, reportHtml }),
    };

  } catch(err) {
    console.error('generate-report error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type':'application/json' },
      body: JSON.stringify({ success:false, error: err.message || 'Error generando reporte' }),
    };
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST,OPTIONS' };
}
