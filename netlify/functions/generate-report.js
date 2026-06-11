const Anthropic = require('@anthropic-ai/sdk');
const gh = require('./gh-storage');

// Helper: format any answer type to readable string
function formatAnswer(ans, qType) {
  if (ans === null || ans === undefined) return 'No respondida';
  // scale: number
  if (qType === 'scale') return `${ans}/5`;
  // multi-open: object {opt: true, _open: "custom"}
  if (qType === 'multi-open' && typeof ans === 'object' && !Array.isArray(ans)) {
    const selected = Object.entries(ans)
      .filter(([k, v]) => k !== '_open' && v === true)
      .map(([k]) => k);
    const custom = ans._open ? `+ "${ans._open}"` : '';
    return [...selected, custom].filter(Boolean).join(' · ') || 'No respondida';
  }
  // multi: array
  if (Array.isArray(ans)) return ans.join(' · ') || 'No respondida';
  // single / open / text
  return String(ans) || 'No respondida';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method not allowed' };

  try {
    const { answers, respondent, eventConfig } = JSON.parse(event.body);
    let { questions, eventName, eventId } = eventConfig;

    // SIEMPRE lee systemPrompt y reportTemplate frescos de GitHub para garantizar template actual
    let systemPrompt = null;
    let reportTemplate = null;
    try {
      const owner = process.env.GITHUB_REPO_OWNER || 'hpadilla12345';
      const repo  = process.env.GITHUB_REPO_NAME  || 'encuesta-ai';
      const token = process.env.GITHUB_TOKEN;
      const r = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/data/events.json`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
      );
      if (r.ok) {
        const d = await r.json();
        const events = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
        const ev = events.find(e => e.eventId === eventId || e.slug === eventId);
        if (ev) {
          systemPrompt    = ev.systemPrompt    || null;
          reportTemplate  = ev.reportTemplate  || null;
          questions       = ev.questions       || questions;
        }
      }
    } catch(ghErr) {
      console.log('GitHub fetch fallback:', ghErr.message);
    }

    // Fallbacks solo si GitHub no respondió
    if (!systemPrompt) systemPrompt = eventConfig.systemPrompt || 'Eres consultor senior de IA del CoE de Grupo Scanda. Analiza el AI Maturity Assessment (Gartner 7D, escala 1-5) y genera el reporte llenando todas las variables {{...}} del template. Solo HTML.';
    if (!reportTemplate) reportTemplate = eventConfig.reportTemplate || '<div style="font-family:Arial;padding:32px;color:#1a2332"><h2>Score: {{SCORE_GARTNER}}/5.0 · {{NIVEL_GARTNER}}</h2><p>{{ANALISIS_POSICION}}</p><p>{{BRECHAS}}</p><p>{{INICIATIVAS}}</p></div>';

    // Replace CTA values
    const { ctaText, ctaUrl } = eventConfig;
    if (ctaText) {
      reportTemplate = reportTemplate
        .replace(/AGENDAR MI SESIÓN →/g, ctaText)
        .replace(/AGENDA TU AI DISCOVERY →/g, ctaText);
    }
    if (ctaUrl) {
      reportTemplate = reportTemplate
        .replace(/https:\/\/calendly\.com\/[^\s"']*/g, ctaUrl)
        .replace(/https:\/\/gruposcanda\.com\/discovery/g, ctaUrl);
    }

    // Build answers text — handle all question types correctly
    const answersText = (questions || []).map(q => {
      const ans = answers[q.id];
      const formatted = formatAnswer(ans, q.type);
      return `**${q.label}**\nRespuesta: ${formatted}`;
    }).join('\n\n');

    const userMessage = `Respondente:
- Nombre: ${respondent.name}
- Empresa: ${respondent.company}
- Cargo: ${respondent.role}
- Email: ${respondent.email}
- Industria: ${respondent.industry || '—'}

Evento: ${eventName}

RESPUESTAS AL ASSESSMENT:
${answersText}

---
TEMPLATE (llena todas las variables {{...}}):
${reportTemplate}

Responde ÚNICAMENTE con el HTML completo del reporte. Sin markdown, sin explicaciones.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let reportHtml = message.content[0].text;
    reportHtml = reportHtml.replace(/^```html?\s*/i, '').replace(/```\s*$/i, '').trim();

    // Save to GitHub
    const responseData = {
      respondent,
      answers,
      eventId,
      eventName,
      reportHtml,
      timestamp: new Date().toISOString(),
    };

    try {
      await gh.saveResponse(eventId, responseData);
    } catch (ghErr) {
      console.log('GitHub save failed (non-fatal):', ghErr.message);
    }

    return {
      statusCode: 200,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, reportHtml }),
    };

  } catch (err) {
    console.error('generate-report error:', err);
    return {
      statusCode: 500,
      headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message || 'Error generando reporte' }),
    };
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
