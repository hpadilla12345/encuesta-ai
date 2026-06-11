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
    let { systemPrompt, reportTemplate, questions, eventName, eventId } = eventConfig;

    if (!systemPrompt) systemPrompt = "Eres un consultor experto en IA de Grupo Scanda. Analiza las respuestas del AI Maturity Assessment basado en el framework Gartner (7 dimensiones, escala 1-5). Genera un reporte ejecutivo con: Score global, nivel Gartner, análisis de brechas por dimensión, top 3 iniciativas recomendadas y próximos pasos. Llena TODAS las variables {{...}} del template. Responde SOLO con el HTML puro sin markdown.";
    if (!reportTemplate) reportTemplate = "<div style='font-family:Arial;background:#0a1628;color:#f0f4f8;padding:32px;border-radius:12px;max-width:600px;margin:0 auto'><h2 style='color:#0edda9;text-align:center'>Score Gartner: {{SCORE_GARTNER}}/5.0</h2><h3 style='color:#0edda9;text-align:center'>{{NIVEL_GARTNER}}</h3><p>{{ANALISIS_POSICION}}</p><h3 style='color:#0edda9'>Brechas críticas</h3><p>{{BRECHAS}}</p><h3 style='color:#0edda9'>Top 3 iniciativas</h3><p>{{INICIATIVAS}}</p></div>";

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
      max_tokens: 1500,
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
