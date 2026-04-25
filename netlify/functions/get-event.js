const fs = require("fs");
const STORE_PATH = "/tmp/survey-events.json";

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); } catch (_) { return {}; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  const { slug, eventId } = event.queryStringParameters || {};
  const lookup = slug || eventId;

  if (!lookup) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "Missing slug or eventId" }) };
  }

  // 1. Try GitHub data/events.json FIRST (fuente de verdad, incluye logo)
  try {
    const OWNER = process.env.GITHUB_REPO_OWNER || "hpadilla12345";
    const REPO  = process.env.GITHUB_REPO_NAME  || "enciesta-ai";
    const TOKEN = process.env.GITHUB_TOKEN;

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/data/events.json`, { headers });
    if (r.ok) {
      const d = await r.json();
      const events = JSON.parse(Buffer.from(d.content, "base64").toString("utf8"));
      const ev = events.find(e => e.slug === lookup || e.eventId === lookup);
      if (ev) {
        return { statusCode: 200, headers: { ...cors(), "Content-Type": "application/json" },
          body: JSON.stringify({ success: true, event: ev, storage: "github" }) };
      }
    }
  } catch (_) {}

  // 2. Try /tmp store
  try {
    const store = readStore();
    let ev = store[lookup];
    if (!ev && store[`slug:${lookup}`]) ev = store[store[`slug:${lookup}`]];
    if (ev) return { statusCode: 200, headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, event: ev, storage: "tmp" }) };
  } catch (_) {}

  // 3. Hardcoded fallback AmCham (sin logo — solo si todo lo demás falla)
  if (lookup === "amcham-mty" || lookup === "demo" || lookup === "evt_amcham_mty_0521") {
    const AMCHAM = {
      eventId: "evt_amcham_mty_0521",
      eventName: "AmCham Monterrey · Comité Manufactura · 21 Mayo 2026",
      slug: "amcham-mty",
      heroDesc: "Diagnóstico rápido de madurez en Inteligencia Artificial para empresas de manufactura. Responde 8 preguntas y recibe tu reporte personalizado al instante.",
      active: true, ccAdmin: true,
      questions: [
        { id:"q1", type:"single", required:true, label:"¿Cuál es el giro principal de tu empresa?", options:["Manufactura discreta (autopartes, maquinaria, electrónica)","Manufactura de proceso (química, alimentos, farmacéutica)","Logística y cadena de suministro","Servicios industriales / MRO","Otro"] },
        { id:"q1b", type:"single", required:true, label:"¿Cuántas personas trabajan en tu planta o empresa?", options:["Menos de 100 empleados","100 – 500 empleados","500 – 2,000 empleados","Más de 2,000 empleados"] },
        { id:"q2", type:"single", required:true, label:"¿En qué etapa de madurez digital se encuentra tu empresa? (Framework Gartner)", sub:"Independiente = sin integración digital · Agéntico = IA autónoma tomando decisiones", options:["Independiente — sistemas y maquinaria aislados, datos en papel o silos","Conectado — equipos conectados a red, datos centralizados básicos","Informado — dashboards y KPIs en tiempo real, análisis descriptivo","Predictivo — machine learning activo, mantenimiento predictivo, alertas automáticas","Agéntico — IA autónoma tomando decisiones y ejecutando acciones sin intervención humana"] },
        { id:"q3", type:"multi", required:true, label:"¿En qué áreas tienen o están considerando casos de uso de IA? (Selecciona todos los que apliquen)", options:["Mantenimiento predictivo de equipos","Control de calidad y visión artificial","Optimización de producción / scheduling","Gestión de inventario y cadena de suministro","Seguridad industrial y cumplimiento normativo","Eficiencia energética","Atención a clientes y pedidos","Finanzas y costos de producción","Recursos Humanos / talento de planta"] },
        { id:"q3b", type:"open", required:false, label:"Otro caso de uso de IA que estés considerando (opcional):", placeholder:"Describe brevemente..." },
        { id:"q4", type:"single", required:true, label:"¿Cómo capturan el dato de producción hoy en piso?", options:["Manual — papel, Excel, entrada humana","Semi-automatizado — algunos sensores pero procesamiento manual","MES / SCADA conectado con datos en tiempo real","Data Lake / plataforma industrial de datos centralizada"] },
        { id:"q5", type:"single", required:true, label:"¿Cuál es la principal barrera para adoptar IA en tu empresa?", options:["Falta de estrategia o visión clara desde dirección","Calidad o disponibilidad de datos de planta","Presupuesto insuficiente","Falta de talento o conocimiento interno","Infraestructura tecnológica / conectividad OT-IT","Resistencia cultural al cambio"] },
        { id:"q6", type:"scale", required:true, label:"¿Qué tan urgente sientes la presión competitiva de adoptar IA?", sub:"1 = Sin presión · 10 = Urgencia crítica, competidores ya nos están ganando", min:1, max:10 },
        { id:"q7", type:"single", required:true, label:"¿Cuánto planea invertir tu empresa en IA en los próximos 12 meses?", options:["No está presupuestado aún","Menos de $50,000 USD","$50,000 – $200,000 USD","$200,000 – $500,000 USD","Más de $500,000 USD"] }
      ],
      systemPrompt: "Eres un consultor senior de IA de Grupo Scanda especializado en manufactura industrial LATAM. Analiza las respuestas del Comité Manufactura AmCham Monterrey.\n\nBENCHMARKS GARTNER 2025-2026:\n- 27% de plantas en LATAM tienen edge computing desplegado\n- 84% planea aumentar inversión IIoT los próximos 2 años\n- <5% usan IA compuesta en producción hoy\n- 68% captura datos de produccióm manual o semi-manual\n- Mantenimiento predictivo = 23-40% reducción en paros no programados\n- Gap líderes vs rezagados en adopción IA manufactura: 3.2 años\n\nFRAMEWORK GARTNER INDUSTRIAL AI:\n- Tradicional (0-25): sin integración digital\n- Conectado (26-50): conectividad básica\n- Analítico (51-70): dashboards tiempo real\n- Inteligente (71-100): ML en producción\n\nSCORE 0-100: etapa(25%)+piso(20%)+casos(15%)+inversión(15%)+urgencia(10%)+barrera(10%)+tamaño(5%)\n\nResponde ÚNICAMENTE con el HTML del reporte usando el template. Sin markdown."
    };
    return { statusCode: 200, headers: { ...cors(), "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, event: AMCHAM, storage: "hardcoded" }) };
  }

  return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: "Event not found" }) };
};

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}
