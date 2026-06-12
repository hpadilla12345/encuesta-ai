// resend-batch.js — resends reports for responses after a cutoff time
const gh = require('./gh-storage');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };

  const { adminPassword, eventId, after } = event.queryStringParameters || {};
  if (adminPassword !== process.env.ADMIN_PASSWORD)
    return { statusCode:401, headers:cors, body: JSON.stringify({ error:'Unauthorized' }) };

  try {
    const responses = await gh.getResponses(eventId || 'evt_1781153414991_7v7i4');
    const cutoff = after || '2026-06-11T19:00';
    const pending = responses.filter(r => r.timestamp >= cutoff && r.reportHtml && r.respondent?.email);

    const results = [];
    for (const r of pending) {
      const { respondent, reportHtml, eventName } = r;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || 'ai@encuestas.hpm.one',
            to: [respondent.email],
            subject: `Tu Reporte de Madurez IA · ${eventName || 'AI Maturity Assessment'}`,
            html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${reportHtml}</body></html>`,
          }),
        });
        const data = await res.json();
        results.push({
          name: respondent.name,
          email: respondent.email,
          timestamp: r.timestamp,
          ok: res.ok,
          id: data.id,
          error: data.message,
        });
      } catch(e) {
        results.push({ name: respondent.name, email: respondent.email, ok: false, error: e.message });
      }
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sent: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length, results }),
    };
  } catch(err) {
    return { statusCode:500, headers:cors, body: JSON.stringify({ error: err.message }) };
  }
};
