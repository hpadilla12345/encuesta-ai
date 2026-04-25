const gh = require('./gh-storage');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  const adminPassword = event.queryStringParameters?.adminPassword;
  if (adminPassword !== process.env.ADMIN_PASSWORD)
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unauthorized' }) };

  try {
    const events = await gh.getEvents();
    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, events, storage: 'github' }) };
  } catch (err) {
    // Si aún no existe data/events.json, retorna vacío
    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, events: [], storage: 'github', note: err.message }) };
  }
};
function cors() { return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,OPTIONS' }; }
