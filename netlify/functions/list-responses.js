const gh = require('./gh-storage');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  const { adminPassword, eventId, email } = event.queryStringParameters || {};
  // Allow public access when email is provided (respondent polling for their own report)
  const isPublicPoll = email && !adminPassword;
  if (!isPublicPoll && adminPassword !== process.env.ADMIN_PASSWORD)
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unauthorized' }) };

  try {
    let responses = eventId ? await gh.getResponses(eventId) : [];
    // For public polls, only return this respondent's reports
    if (isPublicPoll && email) {
      responses = responses.filter(r => r.respondent?.email === email && r.reportHtml);
    }
    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, responses }) };
  } catch (err) {
    return { statusCode: 200, headers: { ...cors(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, responses: [], note: err.message }) };
  }
};
function cors() { return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,OPTIONS' }; }
