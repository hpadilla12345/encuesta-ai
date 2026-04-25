// get-event: now just validates eventId format — actual event config 
// is embedded in the survey URL as a param or passed directly from admin localStorage
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    body: JSON.stringify({ success: false, error: "Use embedded config" }),
  };
};
