const gh = require('./gh-storage');
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors, body:'' };
  const { eventId, type, domain } = event.queryStringParameters || {};
  if (!eventId || !type) return { statusCode:400, headers:cors, body: JSON.stringify({error:'Missing params'}) };
  const path = type === 'maia'
    ? `data/reports/${eventId}/maia.html`
    : `data/reports/${eventId}/company-${domain}.html`;
  try {
    const html = await gh.getFile(path);
    if (!html) return { statusCode:404, headers:cors, body: JSON.stringify({found:false}) };
    return { statusCode:200, headers:{...cors,'Content-Type':'application/json'}, body: JSON.stringify({found:true, html}) };
  } catch(e) {
    return { statusCode:200, headers:cors, body: JSON.stringify({found:false, error:e.message}) };
  }
};
