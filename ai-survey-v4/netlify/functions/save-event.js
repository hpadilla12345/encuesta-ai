const https = require("https");

// We'll use a free JSONbin.io as storage backend — no config needed beyond an API key
// Or better: store events in a Netlify Edge Config or just return them to be stored client-side
// 
// SIMPLEST SOLUTION: Store event config as a base64 param in the URL itself
// The "database" is the admin's localStorage + the URL contains the event slug
// For a survey platform with <100 events this is perfectly fine

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const { adminPassword, eventData } = body;

    if (adminPassword !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Generate eventId if new
    if (!eventData.eventId) {
      eventData.eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }
    eventData.updatedAt = new Date().toISOString();

    // Try Blobs first, fall back gracefully
    try {
      const { getStore } = require("@netlify/blobs");
      const store = getStore({ name: "survey-events", consistency: "strong" });
      await store.set(eventData.eventId, JSON.stringify(eventData));

      let index = [];
      try { index = await store.get("__index__", { type: "json" }) || []; } catch (_) {}
      const existing = index.findIndex(e => e.eventId === eventData.eventId);
      const summary = { eventId: eventData.eventId, eventName: eventData.eventName, slug: eventData.slug, active: eventData.active, createdAt: eventData.createdAt || eventData.updatedAt, updatedAt: eventData.updatedAt };
      if (existing >= 0) index[existing] = summary; else index.push(summary);
      await store.set("__index__", JSON.stringify(index));

      return { statusCode: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ success: true, eventId: eventData.eventId, storage: "blobs" }) };
    } catch (blobErr) {
      // Blobs not available — return eventData so admin stores it locally
      console.log("Blobs unavailable, using client storage:", blobErr.message);
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, eventId: eventData.eventId, storage: "local", eventData }),
      };
    }
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
}
