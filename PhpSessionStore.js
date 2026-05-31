const fs = require('fs');
const path = require('path');

class PhpSessionStore {
  constructor(apiUrl, apiKey) {
    this.apiUrl = apiUrl.replace(/\/$/, ''); // remove trailing slash
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  async sessionExists({ session }) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      const exists = json.success === true && !!json.session_data;
      console.log(`[Store] sessionExists(${session}): ${exists}`);
      return exists;
    } catch (err) {
      console.error('[Store] sessionExists error:', err.message);
      return false;
    }
  }

  async save({ session, data }) {
    // Defensive check: data must be a non‑empty Buffer
    if (!data || !Buffer.isBuffer(data) || data.length === 0) {
      console.error(`[Store] save() called with invalid data for ${session}`);
      throw new Error('Invalid session data');
    }
    try {
      const base64 = data.toString('base64');
      const res = await fetch(`${this.apiUrl}/v1/whatsapp/session-save`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ session_id: session, session_data: base64 }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Save failed');
      console.log(`[Store] save(${session}) succeeded`);
    } catch (err) {
      console.error('[Store] save error:', err.message);
      throw err;
    }
  }

  async extract({ session, path: destPath }) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      if (!json.success || !json.session_data) {
        console.log(`[Store] extract(${session}): no session found`);
        return;
      }
      const buffer = Buffer.from(json.session_data, 'base64');
      fs.writeFileSync(destPath, buffer);
      console.log(`[Store] extract(${session}): written to ${destPath}`);
    } catch (err) {
      console.error('[Store] extract error:', err.message);
    }
  }

  async delete({ session }) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/whatsapp/session-delete`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      console.log(`[Store] delete(${session}):`, json.success);
    } catch (err) {
      console.error('[Store] delete error:', err.message);
    }
  }
}

module.exports = PhpSessionStore;