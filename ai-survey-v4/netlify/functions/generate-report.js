const Anthropic = require("@anthropic-ai/sdk");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: "Method not allowed" };
  }

  try {
    const { answers, respondent, eventConfig } = JSON.parse(event.body);
    let { systemPrompt, reportTemplate, questions, eventName, eventId } = eventConfig;

    // If prompt/template missing, try to fetch from store-event-config
    if ((!systemPrompt || !reportTemplate) && eventId) {
      try {
        const fs = require("fs");
        const STORE_PATH = "/tmp/event-configs.json";
        const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
        if (store[eventId]) {
          systemPrompt = systemPrompt || store[eventId].systemPrompt;
          reportTemplate = reportTemplate || store[eventId].reportTemplate;
        }
      } catch(_) {}
    }

    // Final fallback defaults
    if (!systemPrompt) systemPrompt = "Eres un consultor experto en IA de Grupo Scanda. Analiza las respuestas del cuestionario y genera un reporte ejecutivo de madurez en IA con: 1) Score 0-100, 2) Tier (Observador/Explorador/Adoptador/Líder), 3) Análisis personalizado, 4) Benchmark vs LATAM, 5) Top 3 iniciativas recomendadas, 6) CTA para AI Discovery. Responde SOLO con el HTML del reporte.";
    if (!reportTemplate) reportTemplate = "<div style='font-family:Arial;background:#0a1628;color:#f0f4f8;padding:32px;border-radius:12px;max-width:600px;margin:0 auto'><h2 style='color:#0edda9;text-align:center'>Score: {{SCORE}}/100</h2><div style='background:#0e203d;border-radius:8px;padding:16px;margin:16px 0'><b style='color:#0edda9'>Tier:</b> {{TIER}}</div><div style='margin:16px 0'><b style='color:#0edda9'>Análisis:</b><p style='color:#b0c4d8;margin-top:8px'>{{ANALISIS}}</p></div><div style='background:#0e203d;border-radius:8px;padding:16px;margin:16px 0'><b style='color:#5fa8ff'>Benchmark LATAM:</b><p style='color:#b0c4d8;margin-top:8px'>{{BENCHMARK}}</p></div><div style='margin:16px 0'><b style='color:#0edda9'>Top 3 Iniciativas:</b>{{INICIATIVAS}}</div><div style='background:rgba(14,221,169,0.1);border:1px solid rgba(14,221,169,0.3);border-radius:8px;padding:20px;text-align:center;margin-top:24px'><p style='color:#f0f4f8;font-weight:700'>¿Quieres un plan de acción real?</p><a href='https://grupoScanda.com/discovery' style='display:inline-block;background:#0edda9;color:#050d1a;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:12px'>AGENDAR AI DISCOVERY →</a></div></div>";

    // Build the user message with structured answers
    const answersText = questions.map((q, i) => {
      const ans = answers[q.id];
      let formattedAns = ans;
      if (Array.isArray(ans)) formattedAns = ans.join(", ");
      return `**${q.label}**\nRespuesta: ${formattedAns || "No respondida"}`;
    }).join("\n\n");

    const userMessage = `
Respondente:
- Nombre: ${respondent.name}
- Empresa: ${respondent.company}
- Cargo: ${respondent.role}
- Industria: ${respondent.industry}
- Email: ${respondent.email}

Evento: ${eventName}

RESPUESTAS DEL CUESTIONARIO:
${answersText}

---
TEMPLATE DEL REPORTE (respeta esta estructura HTML, llena las variables {{...}}):
${reportTemplate}

INSTRUCCIÓN FINAL: Responde ÚNICAMENTE con el HTML del reporte completo, sin markdown, sin explicaciones, sin bloques de código. Solo el HTML puro.
`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const reportHtml = message.content[0].text;

    // Save response to Netlify Blobs if available
    try {
      const { getStore } = require("@netlify/blobs");
      const store = getStore({ name: "survey-responses", consistency: "strong" });
      const responseKey = `${eventConfig.eventId}/${Date.now()}_${respondent.email.replace(/[^a-z0-9]/gi, "_")}`;
      await store.set(responseKey, JSON.stringify({
        respondent,
        answers,
        eventId: eventConfig.eventId,
        eventName,
        reportHtml,
        timestamp: new Date().toISOString(),
      }));
    } catch (blobErr) {
      console.log("Blobs not available, skipping persistence:", blobErr.message);
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, reportHtml }),
    };
  } catch (err) {
    console.error("generate-report error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
